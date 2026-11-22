/**
 * @fileoverview Responsive Markdown Scratchpad: zero-clutter multi-pad tabs, Edit/Split/Preview modes, and snippet promotion.
 */
(function (win) {
  const doc = win.document;
  const ui = win.AgyUI;
  const Notes = (win.Notes = win.Notes || {});
  const EventCtor = win.Event || Event;
  const setTimer = typeof win.setTimeout === 'function' ? win.setTimeout.bind(win) : setTimeout;
  const clearTimer = typeof win.clearTimeout === 'function' ? win.clearTimeout.bind(win) : clearTimeout;

  const SAVE_DEBOUNCE_MS = 400;
  const SPLIT_MIN_WIDTH_PX = 680;

  let rootEl = null;
  let els = null;
  let unmounted = false;
  let contextSettled = false;
  let measuredPadWidth = 0;
  let resizeObserver = null;
  let renderedPadId = null;
  let renderedScopeKey = null;
  let latestTabItems = [];
  let lastEditorCompEnd = null;
  let pendingSave = null;
  let saveTimer = null;
  let saveSeq = 0;
  const inFlightSaves = new Map();
  const persistedContentByKey = new Map();
  const saveErrors = new Map();
  const ensuringScopes = new Set();
  const failedScopes = new Set();
  const cleanups = [];

  function buildPadScopeKey(scope, workspacePath) {
    const wsKey = Notes.normalizeWorkspaceKey(workspacePath || '');
    if (scope === 'all' || scope === 'global' || !wsKey) {
      return 'global';
    }
    return `workspace:${wsKey}`;
  }

  function getResolvedPadScope() {
    const wsPath = Notes.state.workspacePath || '';
    const key = buildPadScopeKey(Notes.state.padScope, wsPath);
    if (key === 'global') {
      return { scope: 'global', workspacePath: '', key };
    }
    return { scope: 'workspace', workspacePath: wsPath, key };
  }

  function recordPersistedScratchpads(padsList) {
    if (!Array.isArray(padsList)) {
      return;
    }
    for (const pad of padsList) {
      if (pad && pad.id) {
        persistedContentByKey.set(pad.id, String(pad.content ?? ''));
      }
    }
  }

  function findPadInState(padId, scope, workspacePath) {
    const list = Array.isArray(Notes.state.scratchpads) ? Notes.state.scratchpads : [];
    if (padId) {
      return list.find((p) => p && p.id === padId) || null;
    }
    const wsKey = Notes.normalizeWorkspaceKey(workspacePath);
    const useGlobal = scope === 'all' || scope === 'global' || !wsKey;
    return list.find((p) => {
      if (!p) {
        return false;
      }
      return useGlobal ? p.scope === 'global' : p.scope === 'workspace' && Notes.normalizeWorkspaceKey(p.workspacePath) === wsKey;
    }) || null;
  }

  function applyOptimisticPadContent(padId, scope, workspacePath, content) {
    const targetPad = findPadInState(padId, scope, workspacePath);
    if (targetPad) {
      targetPad.content = content;
    }
  }

  function reconcileOptimisticPads() {
    const orderedFlights = [...inFlightSaves.values()].sort((a, b) => a.seq - b.seq);
    for (const entry of orderedFlights) {
      const pad = findPadInState(entry.padId, entry.scope, entry.workspacePath);
      if (pad) {
        if (!entry.padId) {
          entry.padId = pad.id;
        }
        const superseded = Boolean(
          pendingSave && (pendingSave.padId === pad.id || (!pendingSave.padId && pendingSave.scopeKey === entry.scopeKey))
        );
        if (!superseded) {
          pad.content = entry.content;
        }
      }
    }
    if (pendingSave) {
      const matchedPad = findPadInState(pendingSave.padId, pendingSave.scope, pendingSave.workspacePath);
      if (matchedPad) {
        matchedPad.content = pendingSave.content;
        if (!pendingSave.padId) {
          pendingSave.padId = matchedPad.id;
        }
      }
    }
  }

  function syncSaveStatus() {
    if (!els?.status) {
      return;
    }
    const busy = Boolean(pendingSave) || inFlightSaves.size > 0;
    if (busy) {
      els.status.textContent = 'Saving…';
      return;
    }
    const target = getResolvedPadScope();
    const pads = Notes.listScopePads();
    const activePad = pads.find((p) => p.id === Notes.state.activePadId) || pads[0] || null;
    const activeId = activePad ? activePad.id : '';
    const hasErr = Boolean((activeId && saveErrors.has(activeId)) || saveErrors.has(target.key));
    els.status.textContent = hasErr ? 'Save failed' : 'Saved';
  }

  function ensureDefaultPadIfNeeded() {
    if (unmounted || !rootEl) {
      return;
    }
    const pads = Notes.listScopePads();
    if (pads.length > 0) {
      return;
    }
    const target = getResolvedPadScope();
    if (ensuringScopes.has(target.key) || failedScopes.has(target.key)) {
      return;
    }
    ensuringScopes.add(target.key);
    Notes.mutate('pad-ensure', {
      scope: target.scope,
      workspacePath: target.workspacePath,
    })
      .catch(() => {
        failedScopes.add(target.key);
      })
      .finally(() => {
        ensuringScopes.delete(target.key);
      });
  }

  function flushPendingScratchpadSave() {
    if (saveTimer !== null) {
      clearTimer(saveTimer);
      saveTimer = null;
    }
    if (!pendingSave) {
      syncSaveStatus();
      return null;
    }
    const snapshot = pendingSave;
    pendingSave = null;
    const scopeKey = snapshot.scopeKey || buildPadScopeKey(snapshot.scope, snapshot.workspacePath);
    applyOptimisticPadContent(snapshot.padId, snapshot.scope, snapshot.workspacePath, snapshot.content);

    saveSeq += 1;
    const seq = saveSeq;
    const flightKey = snapshot.padId || scopeKey;
    const entry = {
      seq,
      padId: snapshot.padId,
      scope: snapshot.scope,
      workspacePath: snapshot.workspacePath,
      scopeKey,
      content: snapshot.content,
    };
    inFlightSaves.set(flightKey, entry);
    syncSaveStatus();

    const payload = snapshot.padId
      ? { id: snapshot.padId, content: snapshot.content }
      : { scope: snapshot.scope, workspacePath: snapshot.workspacePath, content: snapshot.content };

    const req = Notes.mutate('pad-save', payload);
    req
      .then((res) => {
        const savedPad = res?.result?.pad;
        const resolvedId = savedPad?.id || entry.padId || '';
        if (!snapshot.padId && resolvedId && !Notes.state.activePadId) {
          Notes.state.activePadId = resolvedId;
        }
        if (resolvedId) {
          persistedContentByKey.set(resolvedId, String(savedPad?.content ?? snapshot.content));
          saveErrors.delete(resolvedId);
        }
        saveErrors.delete(scopeKey);
        if (snapshot.padId) {
          saveErrors.delete(snapshot.padId);
        }
      })
      .catch((err) => {
        const resolvedPad = findPadInState(entry.padId, entry.scope, entry.workspacePath);
        const resolvedId = resolvedPad ? resolvedPad.id : entry.padId;
        const hasNewerFlight = [...inFlightSaves.values()].some(
          (f) => f.seq > seq && ((resolvedId && f.padId === resolvedId) || ((!resolvedId || !f.padId) && f.scopeKey === scopeKey))
        );
        const hasNewerPending = Boolean(
          pendingSave && ((resolvedId && pendingSave.padId === resolvedId) || ((!resolvedId || !pendingSave.padId) && pendingSave.scopeKey === scopeKey))
        );
        if (!hasNewerFlight && !hasNewerPending) {
          if (resolvedPad) {
            const baseline = persistedContentByKey.has(resolvedPad.id) ? persistedContentByKey.get(resolvedPad.id) : '';
            resolvedPad.content = baseline;
          }
          saveErrors.set(resolvedId || scopeKey, err?.message || 'Save failed');
        }
        if (!unmounted) {
          ui.showToast(err?.message || 'Failed to save scratchpad', { error: true });
        }
      })
      .finally(() => {
        const cur = inFlightSaves.get(flightKey);
        if (cur && cur.seq === seq) {
          inFlightSaves.delete(flightKey);
        }
        syncSaveStatus();
      });
    return req;
  }

  function measureScratchpadWidth() {
    const rectW = Number(rootEl?.getBoundingClientRect?.()?.width) || 0;
    if (rectW > 0) {
      return rectW;
    }
    return measuredPadWidth;
  }

  function resolveEffectivePadMode() {
    const requested = Notes.state.padMode || 'edit';
    const width = measureScratchpadWidth();
    if (requested === 'split' && width > 0 && width < SPLIT_MIN_WIDTH_PX) {
      Notes.state.padMode = 'edit';
      return 'edit';
    }
    return requested;
  }

  function renderPreviewHtml(markdownText) {
    const md = win.NotesMarkdown;
    if (typeof md?.renderMarkdownHtml === 'function') {
      return md.renderMarkdownHtml(markdownText, { interactiveTasks: true });
    }
    return ui.escHtml(markdownText);
  }

  function syncPreviewDom(markdownText) {
    if (!els?.preview) {
      return;
    }
    els.preview.innerHTML = renderPreviewHtml(markdownText);
    for (const box of els.preview.querySelectorAll('input[type="checkbox"]')) {
      if (typeof box.checked !== 'boolean') {
        box.checked = box.hasAttribute('checked');
      }
    }
  }

  function readSelectedSnippet() {
    if (!els || !rootEl) {
      return '';
    }
    const mode = rootEl.dataset.padMode || 'edit';
    if (mode !== 'preview') {
      const start = Number(els.editor.selectionStart) || 0;
      const end = Number(els.editor.selectionEnd) || 0;
      if (end > start) {
        const sub = els.editor.value.slice(start, end);
        if (sub.trim()) {
          return sub;
        }
      }
    }
    const domSel = win.getSelection?.();
    if (!domSel || domSel.isCollapsed) {
      return '';
    }
    const anchor = domSel.anchorNode;
    const focus = domSel.focusNode;
    if (anchor) {
      const anchorInside = Boolean(els.preview?.contains?.(anchor));
      const focusInside = focus ? Boolean(els.preview?.contains?.(focus)) : true;
      return anchorInside && focusInside ? String(domSel) : '';
    }
    if (focus) {
      return els.preview?.contains?.(focus) ? String(domSel) : '';
    }
    return mode === 'preview' ? String(domSel) : '';
  }

  function syncPadSelection() {
    if (!els) {
      return;
    }
    const selected = readSelectedSnippet();
    Notes.state.selectedPadText = selected;
    const hasSel = Boolean(selected.trim());
    els.toolbar.classList.toggle('has-selection', hasSel);
    els.idleSlot.classList.toggle('hidden', hasSel);
    els.selSlot.classList.toggle('hidden', !hasSel);
  }

  function clearEditorSelectionKeepText() {
    if (els?.editor) {
      const end = Number(els.editor.selectionEnd) || 0;
      els.editor.selectionStart = end;
      els.editor.selectionEnd = end;
      els.editor.setSelectionRange?.(end, end);
    }
    win.getSelection?.()?.removeAllRanges?.();
    Notes.state.selectedPadText = '';
    if (els) {
      els.toolbar.classList.remove('has-selection');
      els.idleSlot.classList.remove('hidden');
      els.selSlot.classList.add('hidden');
    }
  }

  function commitOpenTabRenameIfOutside(targetNode) {
    const openInput = els?.subStrip?.querySelector?.('input.agy-rename-input');
    if (!openInput || targetNode === openInput) {
      return;
    }
    openInput.blur?.();
    openInput.dispatchEvent?.(new EventCtor('blur'));
  }

  async function commitPadRename(padId, rawNextTitle) {
    const nextTitle = String(rawNextTitle || '').trim();
    const existing = findPadInState(padId, '', '');
    if (!nextTitle || !existing || nextTitle === existing.title) {
      renderScratchpadTab();
      return;
    }
    existing.title = nextTitle;
    renderScratchpadTab();
    try {
      await Notes.mutate('pad-rename', { id: padId, title: nextTitle });
    } catch (err) {
      ui.showToast(err?.message || 'Failed to rename scratchpad', { error: true });
      renderScratchpadTab();
    }
  }

  async function handleSelectPad(padId) {
    if (!padId || padId === Notes.state.activePadId) {
      return;
    }
    flushPendingScratchpadSave();
    clearEditorSelectionKeepText();
    Notes.state.activePadId = padId;
    renderScratchpadTab();
    const activeTabBtn = els?.subStrip?.querySelector?.(`.agy-tab[data-pad-id="${padId}"]`);
    activeTabBtn?.scrollIntoView?.({ inline: 'nearest', block: 'nearest' });
  }

  async function handleDeletePad(padId) {
    if (!padId) {
      return;
    }
    if (pendingSave && pendingSave.padId === padId) {
      if (saveTimer !== null) {
        clearTimer(saveTimer);
        saveTimer = null;
      }
      pendingSave = null;
      syncSaveStatus();
    } else {
      flushPendingScratchpadSave();
    }
    try {
      const res = await Notes.mutate('pad-delete', { id: padId });
      persistedContentByKey.delete(padId);
      saveErrors.delete(padId);
      const nextActive = res?.result?.activePadId || '';
      if (Notes.state.activePadId === padId) {
        Notes.state.activePadId = nextActive;
      }
      Notes.state.selectedPadText = '';
      renderScratchpadTab();
    } catch (err) {
      ui.showToast(err?.message || 'Failed to delete scratchpad', { error: true });
    }
  }

  async function handleReorderPads(orderedIds) {
    if (!Array.isArray(orderedIds) || orderedIds.length < 2) {
      return;
    }
    flushPendingScratchpadSave();
    try {
      await Notes.mutate('pad-reorder', { orderedIds });
    } catch (err) {
      ui.showToast(err?.message || 'Failed to reorder scratchpads', { error: true });
      renderScratchpadTab();
    }
  }

  async function handleAddPad() {
    const flushReq = flushPendingScratchpadSave();
    if (flushReq) {
      try {
        await flushReq;
      } catch {}
    }
    const target = getResolvedPadScope();
    const scopePayload = { scope: target.scope, workspacePath: target.workspacePath };
    try {
      if (Notes.listScopePads().length === 0) {
        await Notes.mutate('pad-ensure', scopePayload);
      }
      const res = await Notes.mutate('pad-add', scopePayload);
      const created = res?.result?.pad;
      if (!created?.id) {
        return;
      }
      Notes.state.activePadId = created.id;
      Notes.state.selectedPadText = '';
      if (Notes.state.padMode === 'preview') {
        Notes.state.padMode = 'edit';
      }
      renderScratchpadTab();
      const createdTab = els?.subStrip?.querySelector?.(`.agy-tab[data-pad-id="${created.id}"]`);
      if (createdTab && typeof ui.startInlineRename === 'function') {
        ui.startInlineRename(createdTab, {
          initialValue: created.title,
          onCommit: (val) => commitPadRename(created.id, val),
          onCancel: () => renderScratchpadTab(),
        });
      }
    } catch (err) {
      ui.showToast(err?.message || 'Failed to create scratchpad', { error: true });
    }
  }

  function handleEditorInput() {
    if (!els) {
      return;
    }
    const pads = Notes.listScopePads();
    const activePad = pads.find((p) => p.id === Notes.state.activePadId) || pads[0] || null;
    const target = getResolvedPadScope();
    const nextValue = els.editor.value;

    if (activePad) {
      activePad.content = nextValue;
    }
    const resolvedScope = activePad ? activePad.scope : target.scope;
    const resolvedWsPath = activePad ? activePad.workspacePath : target.workspacePath;
    pendingSave = {
      padId: activePad ? activePad.id : '',
      scope: resolvedScope,
      workspacePath: resolvedWsPath,
      scopeKey: buildPadScopeKey(resolvedScope, resolvedWsPath),
      content: nextValue,
    };

    if (rootEl?.dataset?.padMode === 'split') {
      syncPreviewDom(nextValue);
    }
    syncPadSelection();
    syncSaveStatus();

    if (saveTimer !== null) {
      clearTimer(saveTimer);
    }
    saveTimer = setTimer(() => {
      saveTimer = null;
      flushPendingScratchpadSave();
    }, SAVE_DEBOUNCE_MS);
  }

  function isImeComposingEvent(ev) {
    if (ev.isComposing || ev.keyCode === 229) {
      return true;
    }
    return lastEditorCompEnd !== null && typeof ev.timeStamp === 'number' && Math.abs(ev.timeStamp - lastEditorCompEnd) < 50;
  }

  function handleEditorKeydown(ev) {
    if (!els) {
      return;
    }
    if (ev.key === 'Escape') {
      ev.preventDefault?.();
      els.editor.blur?.();
      return;
    }
    const md = win.NotesMarkdown;
    if (ev.key === 'Tab' && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
      if (isImeComposingEvent(ev) || typeof md?.applyEditorTabIndent !== 'function') {
        return;
      }
      const indented = md.applyEditorTabIndent(
        els.editor.value,
        els.editor.selectionStart,
        els.editor.selectionEnd,
        Boolean(ev.shiftKey)
      );
      if (indented) {
        ev.preventDefault?.();
        els.editor.value = indented.value;
        els.editor.selectionStart = indented.start;
        els.editor.selectionEnd = indented.end;
        els.editor.setSelectionRange?.(indented.start, indented.end);
        handleEditorInput();
      }
      return;
    }
    if (ev.key === 'Enter' && !ev.shiftKey && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
      if (isImeComposingEvent(ev) || typeof md?.applyEditorListEnter !== 'function') {
        return;
      }
      const next = md.applyEditorListEnter(els.editor.value, els.editor.selectionStart, els.editor.selectionEnd);
      if (next) {
        ev.preventDefault?.();
        els.editor.value = next.value;
        els.editor.selectionStart = next.cursor;
        els.editor.selectionEnd = next.cursor;
        els.editor.setSelectionRange?.(next.cursor, next.cursor);
        handleEditorInput();
      }
    }
  }

  function handlePreviewTaskToggle(ev) {
    const targetNode = ev.target?.nodeType === 1 ? ev.target : ev.target?.parentElement;
    const checkbox = targetNode?.closest?.('input[type="checkbox"][data-task-line]');
    if (!checkbox || checkbox._taskHandled || !els) {
      return;
    }
    checkbox._taskHandled = true;
    const lineIdx = Number(checkbox.dataset?.taskLine);
    const md = win.NotesMarkdown;
    if (!Number.isInteger(lineIdx) || typeof md?.toggleTaskLine !== 'function') {
      return;
    }
    const pads = Notes.listScopePads();
    const activePad = pads.find((p) => p.id === Notes.state.activePadId) || pads[0] || null;
    const target = getResolvedPadScope();
    const baseContent = pendingSave && (!pendingSave.padId || pendingSave.padId === activePad?.id)
      ? pendingSave.content
      : activePad
        ? activePad.content
        : els.editor.value;
    const nextContent = md.toggleTaskLine(baseContent, lineIdx);
    if (nextContent === baseContent) {
      return;
    }
    if (pendingSave && (!pendingSave.padId || pendingSave.padId === activePad?.id)) {
      if (saveTimer !== null) {
        clearTimer(saveTimer);
        saveTimer = null;
      }
      pendingSave = null;
    }
    if (activePad) {
      activePad.content = nextContent;
    }
    els.editor.value = nextContent;
    syncPreviewDom(nextContent);

    const resolvedScope = activePad ? activePad.scope : target.scope;
    const resolvedWsPath = activePad ? activePad.workspacePath : target.workspacePath;
    pendingSave = {
      padId: activePad ? activePad.id : '',
      scope: resolvedScope,
      workspacePath: resolvedWsPath,
      scopeKey: buildPadScopeKey(resolvedScope, resolvedWsPath),
      content: nextContent,
    };
    flushPendingScratchpadSave();
  }

  async function handlePromoteSelectionToStash() {
    const snippet = Notes.state.selectedPadText.trim();
    if (!snippet) {
      return;
    }
    const isUnscoped = Notes.state.padScope === 'global' || !Notes.state.workspacePath;
    const targetScope = isUnscoped ? 'global' : 'workspace';
    const prevStashFilter = Notes.state.stashFilter;
    if (isUnscoped && prevStashFilter !== 'all') {
      Notes.state.stashFilter = 'all';
    } else if (!isUnscoped && prevStashFilter === 'chat' && !Notes.isRealConversationId(Notes.state.conversationId)) {
      Notes.state.stashFilter = 'workspace';
    }
    const switchedStashFilter = Notes.state.stashFilter !== prevStashFilter;
    clearEditorSelectionKeepText();
    if (switchedStashFilter) {
      Notes.renderAll?.();
    }
    try {
      await Notes.mutate('stash-add', {
        text: snippet,
        color: 'auto',
        scope: targetScope,
        workspacePath: isUnscoped ? '' : Notes.state.workspacePath,
        workspaceName: isUnscoped ? '' : Notes.state.projectName || Notes.state.workspaceName,
        originConversationId: isUnscoped ? '' : Notes.state.conversationId,
        originConversationTitle: isUnscoped ? '' : Notes.state.conversationTitle,
      });
      ui.showToast('Added selection to Stash', { durationMs: 2400 });
    } catch (err) {
      if (switchedStashFilter) {
        Notes.state.stashFilter = prevStashFilter;
        Notes.renderAll?.();
      }
      ui.showToast(err?.message || 'Failed to add selection to Stash', { error: true });
    }
  }

  async function handleDispatchSelection(mode) {
    const snippet = Notes.state.selectedPadText.trim();
    if (!snippet) {
      return;
    }
    clearEditorSelectionKeepText();
    try {
      await Notes.dispatchPrompt({ text: snippet, mode });
      const msg = mode === 'new' ? 'Started new chat from selection' : 'Sent selection to active chat';
      ui.showToast(msg, { durationMs: 2400 });
    } catch (err) {
      ui.showToast(err?.message || 'Failed to dispatch selection', { error: true });
    }
  }

  function buildScratchpadExportPayload() {
    flushPendingScratchpadSave();
    const pads = Notes.listScopePads();
    const activePad = pads.find((p) => p.id === Notes.state.activePadId) || pads[0] || null;
    const rawTitle = activePad?.title || 'scratchpad';
    const slug = rawTitle
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'scratchpad';
    const filename = `${slug}.md`;
    const content = activePad ? activePad.content : els?.editor?.value || '';
    return { filename, content };
  }

  function handleExportMarkdown(ev) {
    const anchor = ev?.currentTarget || els?.exportBtn;
    Notes.openExportMenu?.(anchor, buildScratchpadExportPayload);
  }

  function renderScratchpadTab() {
    if (!rootEl || !els) {
      return;
    }
    reconcileOptimisticPads();
    if (contextSettled || Notes.state.surface === 'scratchpad') {
      ensureDefaultPadIfNeeded();
    }

    const effectiveMode = resolveEffectivePadMode();
    rootEl.dataset.padMode = effectiveMode;

    const pads = Notes.listScopePads();
    let activePad = pads.find((p) => p.id === Notes.state.activePadId) || null;
    if (!activePad && pads.length > 0) {
      activePad = pads[0];
      Notes.state.activePadId = activePad.id;
    } else if (!activePad) {
      Notes.state.activePadId = '';
    }

    const hasMulti = pads.length >= 2;
    els.subRow.classList.toggle('hidden', !hasMulti);
    els.addInlineBtn.classList.toggle('hidden', hasMulti);

    if (hasMulti) {
      const tabItems = pads.map((pad) => ({
        id: pad.id,
        label: pad.title,
        title: pad.title,
        icon: null,
        active: pad.id === activePad?.id,
        closable: true,
        renamable: true,
        closeTitle: `Delete ${pad.title}`,
        dataset: { padId: pad.id },
      }));
      latestTabItems = tabItems;
      ui.reconcileTabStrip(els.subStrip, tabItems, {
        idDatasetKey: 'padId',
        onSelect: (id) => handleSelectPad(id),
        onClose: (id) => handleDeletePad(id),
        onRename: (id, nextVal) => commitPadRename(id, nextVal),
        bindDrag: (btn) => {
          ui.bindTabDragController?.(btn, {
            stripEl: els.subStrip,
            tabSelector: '.agy-tab[data-pad-id]',
            idDatasetKey: 'padId',
            getReorderIds: () => Notes.listScopePads().map((p) => p.id),
            onReorder: (orderedIds) => handleReorderPads(orderedIds),
          });
        },
      });
      els.subStrip._updateOverflow?.();
    } else {
      latestTabItems = [];
      ui.clear(els.subStrip);
      els.overflowBtn?.classList?.add?.('hidden');
      els.overflowPopover?.hidePopover?.();
    }

    const hasProject = Boolean(Notes.state.workspacePath);
    const displayProject = Notes.state.projectName || (hasProject ? Notes.state.workspaceName : '');
    const activePadScope = Notes.state.padScope === 'global' || !hasProject ? 'global' : 'workspace';
    ui.createToggleGroup(
      els.scopeToggle,
      [
        {
          id: 'workspace',
          label: 'Project',
          disabled: !hasProject,
          title: displayProject ? `Project: ${displayProject}` : 'Open a project folder to use Project Scratchpad',
        },
        {
          id: 'global',
          label: 'Global',
          title: 'Global Scratchpad (shared across all projects)',
        },
      ],
      {
        activeId: activePadScope,
        onChange: (nextPadScope) => {
          if (nextPadScope === 'workspace' && !Notes.state.workspacePath) {
            return;
          }
          if (nextPadScope === Notes.state.padScope) {
            return;
          }
          flushPendingScratchpadSave();
          clearEditorSelectionKeepText();
          Notes.state.padScope = nextPadScope;
          Notes.state.userPickedPadScope = true;
          Notes.state.activePadId = '';
          renderScratchpadTab();
        },
      }
    );

    ui.createToggleGroup(
      els.modeToggle,
      [
        { id: 'edit', label: 'Edit' },
        { id: 'split', label: 'Split', title: 'Side-by-side Edit + Live Preview (>= 680px)' },
        { id: 'preview', label: 'Preview' },
      ],
      {
        activeId: effectiveMode,
        onChange: (nextMode) => {
          Notes.state.padMode = nextMode;
          clearEditorSelectionKeepText();
          renderScratchpadTab();
          if (nextMode === 'edit' || nextMode === 'split') {
            els.editor.focus?.();
          }
        },
      }
    );

    const target = getResolvedPadScope();
    const activeId = activePad ? activePad.id : '';
    const prevRenderedId = renderedPadId;
    const prevScopeKey = renderedScopeKey;
    const isSameScopeInitialBind = prevRenderedId === '' && prevScopeKey === target.key && Boolean(activeId);
    const switchedPad = (prevRenderedId !== activeId || prevScopeKey !== target.key) && !isSameScopeInitialBind;
    renderedPadId = activeId;
    renderedScopeKey = target.key;

    if (isSameScopeInitialBind && saveErrors.has(target.key)) {
      saveErrors.set(activeId, saveErrors.get(target.key));
      saveErrors.delete(target.key);
    }
    if (switchedPad && prevRenderedId !== null) {
      Notes.state.selectedPadText = '';
      if (activeId) {
        saveErrors.delete(activeId);
      }
      saveErrors.delete(target.key);
    }

    const hasPendingForActive = Boolean(
      pendingSave && ((activeId && pendingSave.padId === activeId) || (!pendingSave.padId && pendingSave.scopeKey === target.key))
    );
    const hasInFlightForActive = [...inFlightSaves.values()].some(
      (e) => (activeId && e.padId === activeId) || (!e.padId && e.scopeKey === target.key)
    );
    const hasErrorForActive = Boolean((activeId && saveErrors.has(activeId)) || saveErrors.has(target.key));
    const hasLocalUnsaved = hasPendingForActive || hasInFlightForActive || hasErrorForActive;
    const activeContent = activePad ? String(activePad.content ?? '') : '';
    if ((switchedPad || !hasLocalUnsaved) && els.editor.value !== activeContent) {
      els.editor.value = activeContent;
    }

    els.editor.classList.toggle('hidden', effectiveMode === 'preview');
    els.preview.classList.toggle('hidden', effectiveMode === 'edit');
    if (effectiveMode === 'preview' || effectiveMode === 'split') {
      syncPreviewDom(els.editor.value);
    }

    syncSaveStatus();
    const hasSel = Boolean(Notes.state.selectedPadText.trim());
    els.toolbar.classList.toggle('has-selection', hasSel);
    els.idleSlot.classList.toggle('hidden', hasSel);
    els.selSlot.classList.toggle('hidden', !hasSel);
  }

  function unmountScratchpadTab() {
    unmounted = true;
    if (saveTimer !== null) {
      clearTimer(saveTimer);
      saveTimer = null;
    }
    pendingSave = null;
    inFlightSaves.clear();
    saveErrors.clear();
    resizeObserver?.disconnect?.();
    resizeObserver = null;
    while (cleanups.length > 0) {
      const fn = cleanups.pop();
      fn?.();
    }
  }

  function mountScratchpadTab(containerEl) {
    if (!containerEl) {
      return;
    }
    unmountScratchpadTab();
    unmounted = false;
    rootEl = containerEl;
    renderedPadId = null;
    renderedScopeKey = null;
    recordPersistedScratchpads(Notes.state.scratchpads);
    ui.clear(rootEl);

    const scopeToggle = ui.el('agy-toggle-group', {
      id: 'pad-scope-toggle',
      className: 'agy-toggle-group notes-pad-scope-toggle',
      'aria-label': 'Scratchpad scope',
    });
    const navSep = ui.el('span', { className: 'notes-pad-nav-sep', 'aria-hidden': 'true' });
    const subStrip = ui.el('agy-tab-strip', {
      id: 'pad-substrip',
      className: 'agy-tab-strip agy-tab-strip-sub',
      role: 'tablist',
      'aria-label': 'Scratchpad pages',
    });
    const overflowBtn = ui.el('button', {
      type: 'button',
      id: 'pad-overflow-btn',
      className: 'agy-icon-btn agy-tab-overflow-btn hidden',
      title: 'All Tabs',
      'aria-label': 'More tabs',
      innerHTML: ui.iconSvg('more_horiz', 15),
    });
    const overflowPopover = ui.el('div', {
      id: 'pad-overflow-popover',
      popover: 'auto',
      className: 'agy-tab-overflow-popover',
    });
    const proto = win.HTMLElement?.prototype;
    if (!proto || !Object.hasOwn(proto, 'popover') || typeof overflowPopover.showPopover !== 'function') {
      overflowPopover.showPopover = () => overflowPopover.classList.add(':popover-open');
      overflowPopover.hidePopover = () => overflowPopover.classList.remove(':popover-open');
      const baseMatches = overflowPopover.matches?.bind(overflowPopover);
      overflowPopover.matches = (sel) => {
        if (sel === ':popover-open') {
          return overflowPopover.classList.contains(':popover-open');
        }
        return Boolean(baseMatches?.(sel));
      };
      const onOutsideOverflow = (ev) => {
        if (!overflowPopover.classList.contains(':popover-open')) {
          return;
        }
        if (!overflowPopover.contains?.(ev.target) && !overflowBtn.contains?.(ev.target)) {
          overflowBtn.setAttribute('aria-expanded', 'false');
          overflowPopover.hidePopover();
        }
      };
      doc.addEventListener?.('pointerdown', onOutsideOverflow);
      cleanups.push(() => doc.removeEventListener?.('pointerdown', onOutsideOverflow));
    }
    const addSubBtn = ui.el('button', {
      type: 'button',
      id: 'pad-add-sub-btn',
      className: 'agy-icon-btn agy-tab-add',
      title: 'New Scratchpad page',
      'aria-label': 'New Scratchpad page',
      innerHTML: ui.iconSvg('add', 15),
    });
    const subRow = ui.el('div', { id: 'pad-substrip-row', className: 'notes-pad-substrip-row hidden' }, navSep, subStrip, overflowBtn, addSubBtn);
    const addInlineBtn = ui.el('button', {
      type: 'button',
      id: 'pad-add-btn',
      className: 'agy-btn agy-btn-xs agy-btn-ghost has-icon notes-pad-add-inline',
      title: 'Add another named pad',
      innerHTML: `${ui.iconSvg('add', 14)}<span class="notes-pad-add-label">Pad</span>`,
    });
    const navBar = ui.el('div', { className: 'notes-pad-nav' }, scopeToggle, subRow, addInlineBtn);

    const modeToggle = ui.el('agy-toggle-group', {
      id: 'pad-mode-toggle',
      className: 'agy-toggle-group notes-pad-mode-toggle',
      'aria-label': 'Editor mode',
    });
    const status = ui.el('span', { id: 'pad-status', className: 'notes-pad-status' }, 'Saved');
    const exportBtn = ui.el('button', {
      type: 'button',
      id: 'pad-export-btn',
      className: 'agy-icon-btn notes-pad-export-btn',
      title: 'Export Markdown…',
      'aria-label': 'Export Markdown',
      innerHTML: ui.iconSvg('download', 15),
    });
    const idleSlot = ui.el('div', { id: 'pad-idle-slot', className: 'notes-pad-slot' }, status);

    const toStashBtn = ui.el(
      'button',
      {
        type: 'button',
        id: 'pad-to-stash-btn',
        className: 'agy-btn agy-btn-xs agy-btn-secondary',
        title: 'Promote selection to Stash',
      },
      '→ Stash'
    );
    const sendSelBtn = ui.el(
      'button',
      {
        type: 'button',
        id: 'pad-send-sel-btn',
        className: 'agy-btn agy-btn-xs agy-btn-primary',
        title: 'Send selection to Active Chat',
      },
      'Send ↵'
    );
    const newChatBtn = ui.el('button', {
      type: 'button',
      id: 'pad-new-chat-btn',
      className: 'agy-icon-btn',
      title: 'Start New Chat with selection',
      'aria-label': 'Start New Chat with selection',
      innerHTML: ui.iconSvg('open_in_new', 14),
    });
    const selSlot = ui.el('div', { id: 'pad-sel-slot', className: 'notes-pad-slot hidden' }, toStashBtn, sendSelBtn, newChatBtn);
    const toolbar = ui.el('div', { id: 'pad-toolbar', className: 'agy-toolbar notes-pad-toolbar' }, modeToggle, idleSlot, selSlot, exportBtn);
    const padHeader = ui.el('div', { className: 'notes-pad-header' }, navBar, toolbar);

    const editorLabel = ui.el('label', { for: 'pad-editor', className: 'sr-only' }, 'Scratchpad Markdown editor');
    const editor = ui.el('textarea', {
      id: 'pad-editor',
      className: 'notes-pad-editor',
      spellcheck: 'false',
      placeholder: 'Write rough notes, checklists (- [ ]), or prompt drafts…',
    });
    const preview = ui.el('div', { id: 'pad-preview', className: 'notes-pad-preview hidden' });
    const workarea = ui.el('div', { className: 'notes-pad-workarea' }, editorLabel, editor, preview);

    rootEl.appendChild(padHeader);
    rootEl.appendChild(overflowPopover);
    rootEl.appendChild(workarea);

    els = {
      subRow,
      subStrip,
      overflowBtn,
      overflowPopover,
      addSubBtn,
      toolbar,
      scopeToggle,
      modeToggle,
      idleSlot,
      selSlot,
      status,
      addInlineBtn,
      exportBtn,
      toStashBtn,
      sendSelBtn,
      newChatBtn,
      editor,
      preview,
    };

    const stripScroll = ui.setupStripScroll?.(
      subStrip,
      overflowBtn,
      () => latestTabItems,
      (id) => handleSelectPad(id),
      overflowPopover,
      null,
      null,
      {
        idDatasetKey: 'padId',
        renderItemIcon: () => ui.iconSvg('edit_note', 14),
      }
    );
    if (stripScroll?.disconnect) {
      cleanups.push(() => stripScroll.disconnect());
    }

    addInlineBtn.addEventListener('click', handleAddPad);
    addSubBtn.addEventListener('click', handleAddPad);
    exportBtn.addEventListener('click', handleExportMarkdown);

    selSlot.addEventListener('mousedown', (ev) => ev.preventDefault?.());
    toStashBtn.addEventListener('click', handlePromoteSelectionToStash);
    sendSelBtn.addEventListener('click', () => handleDispatchSelection('active'));
    newChatBtn.addEventListener('click', () => handleDispatchSelection('new'));

    editor.addEventListener('compositionend', (ev) => {
      lastEditorCompEnd = ev.timeStamp;
    });
    editor.addEventListener('input', handleEditorInput);
    editor.addEventListener('keydown', handleEditorKeydown);
    for (const evName of ['select', 'keyup', 'mouseup']) {
      editor.addEventListener(evName, syncPadSelection);
    }
    preview.addEventListener('mouseup', syncPadSelection);
    preview.addEventListener('click', handlePreviewTaskToggle);
    preview.addEventListener('change', handlePreviewTaskToggle);

    const onOutsideRenameInteraction = (ev) => {
      commitOpenTabRenameIfOutside(ev.target);
    };
    const onDocSelectionChange = () => {
      const mode = rootEl?.dataset?.padMode || 'edit';
      const selVisible = Boolean(els?.selSlot && !els.selSlot.classList.contains('hidden'));
      if (doc.activeElement === editor || mode === 'preview' || mode === 'split' || selVisible) {
        syncPadSelection();
      }
    };
    const onWinResize = () => {
      if (Notes.state.padMode === 'split') {
        renderScratchpadTab();
      }
    };

    doc.addEventListener?.('pointerdown', onOutsideRenameInteraction, true);
    doc.addEventListener?.('click', onOutsideRenameInteraction, true);
    doc.addEventListener?.('selectionchange', onDocSelectionChange);
    win.addEventListener?.('resize', onWinResize);
    cleanups.push(() => {
      doc.removeEventListener?.('pointerdown', onOutsideRenameInteraction, true);
      doc.removeEventListener?.('click', onOutsideRenameInteraction, true);
      doc.removeEventListener?.('selectionchange', onDocSelectionChange);
      win.removeEventListener?.('resize', onWinResize);
    });

    if (typeof win.ResizeObserver === 'function') {
      resizeObserver = new win.ResizeObserver((entries) => {
        for (const entry of entries || []) {
          const width = Number(entry?.contentRect?.width) || 0;
          if (width > 0) {
            measuredPadWidth = width;
          }
        }
        if (Notes.state.padMode === 'split' && measuredPadWidth > 0 && measuredPadWidth < SPLIT_MIN_WIDTH_PX) {
          Notes.state.padMode = 'edit';
          renderScratchpadTab();
        }
        subStrip._updateOverflow?.();
      });
      resizeObserver.observe(rootEl);
    }

    renderScratchpadTab();
  }

  if (typeof Notes.applyServerState === 'function' && !Notes.applyServerState._wrappedByScratchpad) {
    const baseApplyServerState = Notes.applyServerState;
    const wrappedApplyServerState = function wrappedApplyServerState(next, version) {
      if (next && Array.isArray(next.scratchpads)) {
        recordPersistedScratchpads(next.scratchpads);
      }
      return baseApplyServerState(next, version);
    };
    wrappedApplyServerState._wrappedByScratchpad = true;
    Notes.applyServerState = wrappedApplyServerState;
  }

  if (typeof Notes.refreshContext === 'function' && !Notes.refreshContext._wrappedByScratchpad) {
    const baseRefreshContext = Notes.refreshContext;
    const wrappedRefresh = async function wrappedRefreshContext(...args) {
      try {
        return await baseRefreshContext(...args);
      } finally {
        contextSettled = true;
        ensureDefaultPadIfNeeded();
      }
    };
    wrappedRefresh._wrappedByScratchpad = true;
    Notes.refreshContext = wrappedRefresh;
  }

  Notes.mountScratchpadTab = mountScratchpadTab;
  Notes.unmountScratchpadTab = unmountScratchpadTab;
  Notes.renderScratchpadTab = renderScratchpadTab;
  Notes.flushPendingScratchpadSave = flushPendingScratchpadSave;
})(typeof window !== 'undefined' ? window : globalThis);
