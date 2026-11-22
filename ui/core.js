/**
 * @fileoverview Shared Notes UI state, Onyx color resolution, API/SSE client, Undo toast, and host navigation helpers.
 */
(function (win) {
  const doc = win.document;
  const ui = (win.AgyUI = win.AgyUI || {});
  const Notes = (win.Notes = win.Notes || {});
  const URLSearchParamsCtor = win.URLSearchParams || URLSearchParams;
  const setTimer = typeof win.setTimeout === 'function' ? win.setTimeout.bind(win) : setTimeout;

  ui.registerIcons?.({
    note_stack:
      'M200-120q-33 0-56.5-23.5T120-200v-440h80v440h440v80H200Zm160-160q-33 0-56.5-23.5T280-360v-400q0-33 23.5-56.5T360-840h400q33 0 56.5 23.5T840-760v400q0 33-23.5 56.5T760-280H360Zm0-80h400v-400H360v400Zm80-80h240v-60H440v60Zm0-110h240v-60H440v60Zm0-110h240v-60H440v60Z',
    edit_note:
      'M160-400v-80h280v80H160Zm0-160v-80h440v80H160Zm0-160v-80h440v80H160Zm360 560v-123l221-220q9-9 20-13t22-4q12 0 23 4.5t20 13.5l37 37q8 9 12.5 20t4.5 22q0 11-4 22.5T863-380L643-160H520Zm300-263-37-37 37 37ZM580-220h38l121-122-18-19-19-18-122 121v38Z',
    content_copy:
      'M360-240q-33 0-56.5-23.5T280-320v-480q0-33 23.5-56.5T360-880h360q33 0 56.5 23.5T800-800v480q0 33-23.5 56.5T720-240H360Zm0-80h360v-480H360v480ZM200-80q-33 0-56.5-23.5T120-160v-560h80v560h440v80H200Z',
    edit:
      'M200-200h57l391-391-57-57-391 391v57Zm-80 80v-170l528-527q12-11 26.5-17t30.5-6q16 0 31 6t26 18l55 56q12 11 17.5 26t5.5 30q0 16-5.5 30.5T817-647L290-120H120Z',
    more_horiz:
      'M240-400q-33 0-56.5-23.5T160-480q0-33 23.5-56.5T240-560q33 0 56.5 23.5T320-480q0 33-23.5 56.5T240-400Zm240 0q-33 0-56.5-23.5T400-480q0-33 23.5-56.5T480-560q33 0 56.5 23.5T560-480q0 33-23.5 56.5T480-400Zm240 0q-33 0-56.5-23.5T640-480q0-33 23.5-56.5T720-560q33 0 56.5 23.5T800-480q0 33-23.5 56.5T720-400Z',
    palette:
      'M480-80q-82 0-155-31.5t-127.5-86Q143-252 111.5-325T80-480q0-83 32.5-156t88-127Q256-817 330-848.5T488-880q80 0 151 27.5t124.5 76q53.5 48.5 85 115T880-518q0 115-70 176.5T640-280h-74q-9 0-12.5 5t-3.5 11q0 12 15 34.5t15 51.5q0 50-27.5 74T480-80Zm0-400Zm-220 40q26 0 43-17t17-43q0-26-17-43t-43-17q-26 0-43 17t-17 43q0 26 17 43t43 17Zm120-160q26 0 43-17t17-43q0-26-17-43t-43-17q-26 0-43 17t-17 43q0 26 17 43t43 17Zm200 0q26 0 43-17t17-43q0-26-17-43t-43-17q-26 0-43 17t-17 43q0 26 17 43t43 17Zm120 160q26 0 43-17t17-43q0-26-17-43t-43-17q-26 0-43 17t-17 43q0 26 17 43t43 17Z',
    drag_indicator:
      'M360-160q-33 0-56.5-23.5T280-240q0-33 23.5-56.5T360-320q33 0 56.5 23.5T440-240q0 33-23.5 56.5T360-160Zm240 0q-33 0-56.5-23.5T520-240q0-33 23.5-56.5T600-320q33 0 56.5 23.5T680-240q0 33-23.5 56.5T600-160ZM360-400q-33 0-56.5-23.5T280-480q0-33 23.5-56.5T360-560q33 0 56.5 23.5T440-480q0 33-23.5 56.5T360-400Zm240 0q-33 0-56.5-23.5T520-480q0-33 23.5-56.5T600-560q33 0 56.5 23.5T680-480q0 33-23.5 56.5T600-400ZM360-640q-33 0-56.5-23.5T280-720q0-33 23.5-56.5T360-800q33 0 56.5 23.5T440-720q0 33-23.5 56.5T360-640Zm240 0q-33 0-56.5-23.5T520-720q0-33 23.5-56.5T600-800q33 0 56.5 23.5T680-720q0 33-23.5 56.5T600-640Z',
  });

  const PALETTE = Object.freeze([
    { id: 'rose', label: 'Rose' },
    { id: 'amber', label: 'Amber' },
    { id: 'emerald', label: 'Emerald' },
    { id: 'blue', label: 'Blue' },
    { id: 'violet', label: 'Violet' },
    { id: 'cyan', label: 'Cyan' },
  ]);
  const PALETTE_SET = new Set(PALETTE.map((item) => item.id));
  const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
  const INVALID_CONV_IDS = new Set(['_new', 'null', 'undefined', 'none']);
  const KEYWORD_TAG_COLORS = Object.freeze({
    bug: 'rose',
    fix: 'rose',
    urgent: 'rose',
    hotfix: 'rose',
    warn: 'amber',
    blocked: 'amber',
    perf: 'amber',
    done: 'emerald',
    ready: 'emerald',
    ship: 'emerald',
    later: 'blue',
    todo: 'blue',
    idea: 'violet',
    design: 'violet',
    ux: 'violet',
    mcp: 'cyan',
    api: 'cyan',
  });
  const HASHTAG_RE = /(?:^|[\s([{"'*~])#([a-z][a-z0-9_-]{0,31})(?=$|[\s.,;:!?)\]}"'*~])/gi;

  const defaultSettings = () => ({
    enterBehavior: 'stash',
    cardColorStyle: 'wash',
    stashLayout: 'grid',
    workbenchMode: 'split',
    workbenchSplitRatio: 0.44,
    mcpRead: false,
    mcpWrite: false,
  });

  const urlConv = new URLSearchParamsCtor(win.location?.search || '').get('conversationId') || '';
  const initialRawConv = String(win.sidecar?.conversationId || urlConv || '').trim();
  const isRealConv = (id) => Boolean(id && typeof id === 'string' && !INVALID_CONV_IDS.has(id.trim().toLowerCase()));

  const state = (Notes.state = {
    version: 0,
    settings: defaultSettings(),
    tagColors: {},
    cards: [],
    scratchpads: [],
    rawConversationId: initialRawConv,
    conversationId: isRealConv(initialRawConv) ? initialRawConv : '',
    conversationTitle: '',
    isNewConversation: initialRawConv === '_new',
    workspacePath: '',
    workspaceName: 'Global',
    projectId: '',
    projectName: '',
    allWorkspacePaths: [],
    workspaceUris: [],
    hostVisible: true,
    surface: 'stash',
    stashFilter: 'workspace',
    userPickedStashFilter: false,
    composerTarget: 'workspace',
    userPickedComposerTarget: false,
    padScope: 'workspace',
    userPickedPadScope: false,
    statusView: 'active',
    activeTag: '',
    activeColorFilter: '',
    query: '',
    composerColor: 'auto',
    selectedIds: new Set(),
    expandedCardIds: new Set(),
    editingId: '',
    splitFilterOpen: false,
    activePadId: '',
    padMode: 'edit',
    selectedPadText: '',
    lastCopiedText: '',
    lastDownload: null,
  });
  Object.defineProperty(state, 'scope', {
    configurable: true,
    enumerable: true,
    get() {
      return state.stashFilter;
    },
    set(val) {
      state.stashFilter = val === 'global' ? 'all' : val;
    },
  });

  function inferDefaultTagColor(tag) {
    const clean = String(tag || '').trim().replace(/^#+/, '').toLowerCase();
    if (Object.hasOwn(KEYWORD_TAG_COLORS, clean)) {
      return KEYWORD_TAG_COLORS[clean];
    }
    let hash = 0;
    let idx = 0;
    while (idx < clean.length) {
      hash = ((hash << 5) - hash + clean.charCodeAt(idx)) | 0;
      idx += 1;
    }
    return PALETTE[Math.abs(hash) % PALETTE.length].id;
  }

  function getTagColor(tag, tagColors = state.tagColors) {
    const clean = String(tag || '').trim().replace(/^#+/, '').toLowerCase();
    if (!clean || UNSAFE_KEYS.has(clean)) {
      return '';
    }
    if (tagColors && typeof tagColors === 'object' && Object.hasOwn(tagColors, clean)) {
      const explicit = tagColors[clean];
      return explicit === 'none' ? 'none' : PALETTE_SET.has(explicit) ? explicit : '';
    }
    return inferDefaultTagColor(clean);
  }

  function parseHashtags(text) {
    if (typeof text !== 'string' || !text) {
      return [];
    }
    const clean = text
      .replace(/\r\n?/g, '\n')
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/`[^`]*`/g, ' ')
      .replace(/^\s{0,3}#{1,6}\s+.*$/gm, ' ')
      .replace(/\]\([^)\s]*\)/g, '] ')
      .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, ' ');
    const found = new Set();
    HASHTAG_RE.lastIndex = 0;
    let match = HASHTAG_RE.exec(clean);
    while (match !== null) {
      const lower = match[1].toLowerCase();
      if (!UNSAFE_KEYS.has(lower)) {
        found.add(lower);
      }
      match = HASHTAG_RE.exec(clean);
    }
    return [...found];
  }

  function resolveCardColor(card, tagColors = state.tagColors) {
    if (!card || typeof card !== 'object' || card.color === 'none') {
      return '';
    }
    if (card.color && card.color !== 'auto') {
      return PALETTE_SET.has(card.color) ? card.color : '';
    }
    const tags = Array.isArray(card.tags) ? card.tags : [];
    for (const rawTag of tags) {
      const hue = getTagColor(rawTag, tagColors);
      if (hue && hue !== 'none' && PALETTE_SET.has(hue)) {
        return hue;
      }
    }
    return '';
  }

  function normalizeWorkspaceKey(raw) {
    if (typeof raw !== 'string' || !raw.trim()) {
      return '';
    }
    let val = raw.trim();
    if (/^file:\/\//i.test(val)) {
      try {
        val = decodeURIComponent(val.replace(/^file:\/\/\/?/i, '/'));
      } catch {
        val = val.replace(/^file:\/\/\/?/i, '/');
      }
    }
    val = val.replace(/%3a/gi, ':').replace(/\\/g, '/').replace(/^\/([a-zA-Z]:)/, '$1');
    val = val.replace(/\/{2,}/g, '/').replace(/\/+$/, '');
    return val.toLowerCase();
  }

  function compareCards(a, b) {
    if (a.status === 'sent' && b.status === 'sent') {
      const sentDiff = (Number(b.sentAt) || 0) - (Number(a.sentAt) || 0);
      return sentDiff !== 0 ? sentDiff : (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0);
    }
    const orderDiff = (Number(a.order) || 0) - (Number(b.order) || 0);
    return orderDiff !== 0 ? orderDiff : (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0);
  }

  function filterVisibleCards(status = state.statusView, overrides = {}) {
    const scope = overrides.scope ?? state.stashFilter;
    const convId = overrides.conversationId ?? state.conversationId;
    const wsKeys = new Set();
    const primaryKey = normalizeWorkspaceKey(overrides.workspacePath ?? state.workspacePath);
    if (primaryKey) {
      wsKeys.add(primaryKey);
    }
    for (const p of overrides.allWorkspacePaths ?? state.allWorkspacePaths) {
      const k = normalizeWorkspaceKey(p);
      if (k) {
        wsKeys.add(k);
      }
    }
    const matched = (Array.isArray(state.cards) ? state.cards : []).filter((card) => {
      if (!card || (status && status !== 'all' && card.status !== status)) {
        return false;
      }
      if (scope === 'workspace') {
        if (card.scope !== 'workspace') {
          return false;
        }
        const ck = normalizeWorkspaceKey(card.workspacePath);
        return wsKeys.size === 0 ? ck === '' : Boolean(ck && wsKeys.has(ck));
      }
      if (scope === 'chat') {
        return Boolean(card.scope !== 'global' && isRealConv(convId) && card.originConversationId === convId);
      }
      return true;
    });
    return [...matched].sort(compareCards);
  }

  function listScopePads(overrides = {}) {
    const scope = overrides.scope ?? state.padScope;
    const wsPath = overrides.workspacePath ?? state.workspacePath;
    const wsKeys = new Set();
    const primaryKey = normalizeWorkspaceKey(wsPath);
    if (primaryKey) {
      wsKeys.add(primaryKey);
    }
    const candidateRoots = overrides.allWorkspacePaths
      ?? (overrides.workspacePath !== undefined ? [] : state.allWorkspacePaths);
    const rootsIncludePrimary = Array.isArray(candidateRoots)
      && candidateRoots.some((p) => normalizeWorkspaceKey(p) === primaryKey);
    if (overrides.allWorkspacePaths || rootsIncludePrimary) {
      for (const p of candidateRoots) {
        const k = normalizeWorkspaceKey(p);
        if (k) {
          wsKeys.add(k);
        }
      }
    }
    const useGlobal = scope === 'all' || scope === 'global' || wsKeys.size === 0;
    const matched = (Array.isArray(state.scratchpads) ? state.scratchpads : []).filter((pad) => {
      if (!pad) {
        return false;
      }
      if (useGlobal) {
        return pad.scope === 'global';
      }
      const pk = normalizeWorkspaceKey(pad.workspacePath);
      return pad.scope === 'workspace' && Boolean(pk && wsKeys.has(pk));
    });
    return [...matched].sort((a, b) => {
      const diff = (Number(a.order) || 0) - (Number(b.order) || 0);
      return diff !== 0 ? diff : (Number(a.createdAt) || 0) - (Number(b.createdAt) || 0);
    });
  }

  function exportStashMarkdown(cards, scopeLabel = '') {
    const label = String(scopeLabel || '').trim();
    const heading = label ? `# Prompt Stash — ${label}` : '# Prompt Stash';
    if (!Array.isArray(cards) || cards.length === 0) {
      return `${heading}\n\n_No stashed prompts._\n`;
    }
    const lines = [heading, ''];
    cards.forEach((card, idx) => {
      const statusText = card.status === 'sent' ? 'Sent' : 'Active';
      const tagsText = Array.isArray(card.tags) && card.tags.length ? ` · ${card.tags.map((t) => `#${t}`).join(' ')}` : '';
      const originText = card.originConversationTitle ? ` · ${card.originConversationTitle}` : '';
      lines.push(`## ${idx + 1}. ${statusText}${tagsText}${originText}`, '', String(card.text || '').trim(), '');
    });
    return `${lines.join('\n').trimEnd()}\n`;
  }

  function formatRelativeAge(ts) {
    const num = Number(ts);
    if (!Number.isFinite(num) || num <= 0) {
      return 'now';
    }
    const sec = Math.max(0, Math.floor((Date.now() - num) / 1000));
    if (sec < 45) {
      return 'now';
    }
    if (sec < 3600) {
      return `${Math.floor(sec / 60)}m`;
    }
    if (sec < 86400) {
      return `${Math.floor(sec / 3600)}h`;
    }
    return `${Math.floor(sec / 86400)}d`;
  }

  function applyServerState(next, version) {
    if (!next || typeof next !== 'object') {
      return;
    }
    if (typeof version === 'number') {
      state.version = version;
    }
    if (next.settings && typeof next.settings === 'object') {
      state.settings = { ...defaultSettings(), ...next.settings };
    }
    if (next.tagColors && typeof next.tagColors === 'object') {
      state.tagColors = { ...next.tagColors };
    }
    if (Array.isArray(next.cards)) {
      state.cards = next.cards
        .filter((c) => Boolean(c) && typeof c === 'object' && !Array.isArray(c))
        .map((c) => ({ ...c, tags: Array.isArray(c.tags) ? [...c.tags] : [] }));
    }
    if (Array.isArray(next.scratchpads)) {
      state.scratchpads = next.scratchpads
        .filter((p) => Boolean(p) && typeof p === 'object' && !Array.isArray(p))
        .map((p) => ({ ...p }));
    }
    Notes.renderAll?.();
  }

  async function apiCall(path, body = {}, init = {}) {
    return ui.apiCall(path, body, init);
  }

  async function mutate(action, payload = {}) {
    const merged = {
      ...payload,
      ...(state.conversationId && payload.conversationId === undefined ? { conversationId: state.conversationId } : {}),
    };
    const res = await apiCall('/api/mutate', { action, payload: merged });
    if (res?.state) {
      Notes.applyServerState(res.state, res.version);
    }
    return res;
  }

  async function dispatchPrompt({ text, mode = 'active', title, conversationId, workspacePath } = {}) {
    return apiCall('/api/dispatch', {
      text,
      mode,
      ...(title ? { title } : {}),
      conversationId: conversationId ?? state.conversationId,
      conversationTitle: state.conversationTitle,
      workspacePath: workspacePath ?? state.workspacePath,
    });
  }

  function showUndoToast(label, cardIds = []) {
    const ids = Array.isArray(cardIds) ? cardIds.filter(Boolean) : [];
    const toast = ui.showToast(label, { durationMs: 5500 });
    if (!toast || ids.length === 0) {
      return toast;
    }
    const undoBtn = ui.el(
      'button',
      {
        type: 'button',
        className: 'agy-btn agy-btn-xs agy-btn-outline notes-undo-btn',
        onClick: async () => {
          toast.remove?.();
          try {
            await mutate('stash-restore', { ids });
          } catch (err) {
            ui.showToast(err?.message || 'Failed to restore card', { error: true });
          }
        },
      },
      'Undo'
    );
    const closeBtn = toast.querySelector?.('.agy-toast-close') || null;
    toast.insertBefore(undoBtn, closeBtn);
    return toast;
  }

  async function dispatchCards(cardsToSend, mode = 'active', overrideText = '') {
    const list = Array.isArray(cardsToSend) ? cardsToSend.filter(Boolean) : [];
    if (list.length === 0 && !overrideText.trim()) {
      return null;
    }
    const text = overrideText.trim()
      ? overrideText
      : list.length === 1
        ? list[0].text
        : `Address the following items:\n\n${list.map((c, idx) => `${idx + 1}. ${c.text}`).join('\n\n')}`;
    const res = await dispatchPrompt({ text, mode });
    const ids = list.map((c) => c.id).filter(Boolean);
    for (const id of ids) {
      state.selectedIds.delete(id);
    }
    if (ids.length > 0) {
      await mutate('stash-mark-sent', {
        ids,
        sentToConversationId: res?.conversationId || state.conversationId,
        sentToConversationTitle: res?.conversationTitle || state.conversationTitle,
        sentMode: res?.mode || mode,
      });
      const noun = ids.length === 1 ? 'item' : 'items';
      const label = (res?.mode || mode) === 'new' ? `Started new chat (${ids.length} ${noun})` : `Sent to active chat (${ids.length} ${noun})`;
      showUndoToast(label, ids);
    }
    return res;
  }

  async function copyText(text) {
    const value = String(text ?? '');
    state.lastCopiedText = value;
    try {
      if (win.navigator?.clipboard?.writeText) {
        await win.navigator.clipboard.writeText(value);
        return true;
      }
    } catch {}
    try {
      const temp = doc.createElement('textarea');
      temp.value = value;
      temp.className = 'sr-only';
      doc.body?.appendChild?.(temp);
      temp.select?.();
      doc.execCommand?.('copy');
      temp.remove?.();
    } catch {}
    return true;
  }

  function downloadMarkdown(filename, content) {
    const safeName = String(filename || 'notes.md');
    const safeBody = String(content ?? '');
    state.lastDownload = { filename: safeName, content: safeBody, mode: 'blob' };
    try {
      const URLCtor = win.URL || URL;
      const BlobCtor = win.Blob || (typeof Blob === 'function' ? Blob : null);
      if (BlobCtor && typeof URLCtor?.createObjectURL === 'function') {
        const blob = new BlobCtor([safeBody], { type: 'text/markdown;charset=utf-8' });
        const href = URLCtor.createObjectURL(blob);
        const link = doc.createElement('a');
        link.href = href;
        link.download = safeName;
        doc.body?.appendChild?.(link);
        link.click?.();
        link.remove?.();
        setTimer(() => URLCtor.revokeObjectURL?.(href), 250);
      }
    } catch {}
  }

  function showSavedPathToast(savedPath) {
    const toast = ui.showToast(`Saved ${savedPath}`, { durationMs: 6000 });
    if (!toast || !savedPath) {
      return toast;
    }
    const copyPathBtn = ui.el(
      'button',
      {
        type: 'button',
        className: 'agy-btn agy-btn-xs agy-btn-outline notes-undo-btn',
        dataset: { action: 'copy-export-path' },
        onClick: async () => {
          await copyText(savedPath);
          ui.showToast('Copied file path to clipboard', { durationMs: 2200 });
        },
      },
      'Copy Path'
    );
    const closeBtn = toast.querySelector?.('.agy-toast-close') || null;
    toast.insertBefore(copyPathBtn, closeBtn);
    return toast;
  }

  async function exportMarkdownFile({ filename, content, mode = 'downloads' } = {}) {
    const safeName = String(filename || 'notes.md');
    const safeBody = String(content ?? '');
    state.lastDownload = { filename: safeName, content: safeBody, mode, path: '' };
    const res = await apiCall('/api/export', {
      filename: safeName,
      content: safeBody,
      mode,
      workspacePath: state.workspacePath,
    });
    if (res?.cancelled) {
      return res;
    }
    if (res?.saved && res?.path) {
      state.lastDownload = {
        filename: res.filename || safeName,
        content: safeBody,
        mode,
        path: res.path,
      };
      showSavedPathToast(res.path);
    }
    return res;
  }

  function openExportMenu(anchorEl, getExportPayload) {
    if (!anchorEl || typeof getExportPayload !== 'function') {
      return;
    }
    ui.openContextMenu(anchorEl, [
      {
        id: 'save-as',
        icon: 'folder',
        label: 'Save As…',
        onClick: async () => {
          try {
            const payload = getExportPayload();
            await exportMarkdownFile({ ...payload, mode: 'save-as' });
          } catch (err) {
            ui.showToast(err?.message || 'Failed to save Markdown file', { error: true });
          }
        },
      },
      {
        id: 'downloads',
        icon: 'download',
        label: 'Save to Downloads',
        onClick: async () => {
          try {
            const payload = getExportPayload();
            await exportMarkdownFile({ ...payload, mode: 'downloads' });
          } catch (err) {
            ui.showToast(err?.message || 'Failed to export to Downloads', { error: true });
          }
        },
      },
      { separator: true },
      {
        id: 'copy-md',
        icon: 'content_copy',
        label: 'Copy as Markdown',
        onClick: async () => {
          const payload = getExportPayload();
          const safeName = String(payload?.filename || 'notes.md');
          const safeBody = String(payload?.content ?? '');
          state.lastDownload = { filename: safeName, content: safeBody, mode: 'clipboard', path: '' };
          await copyText(safeBody);
          ui.showToast('Copied Markdown to clipboard', { durationMs: 2200 });
        },
      },
    ]);
  }

  function openConversation(conversationId, title = '') {
    if (!isRealConv(conversationId)) {
      return false;
    }
    const cleanId = conversationId.trim();
    if (typeof win.AgyShell?.toggleConversation === 'function') {
      win.AgyShell.toggleConversation(cleanId);
    } else if (typeof win.sidecar?.ui?.toggleConversation === 'function') {
      win.sidecar.ui.toggleConversation(cleanId);
    } else {
      win.parent?.postMessage?.({ type: 'toggle-conversation', payload: { conversationId: cleanId } }, '*');
    }
    ui.showToast(`Switched to "${title || cleanId}"`, { durationMs: 2200 });
    return true;
  }

  async function refreshContext(overrides = {}) {
    const rawConv = overrides.conversationId !== undefined ? String(overrides.conversationId || '').trim() : state.rawConversationId;
    state.rawConversationId = rawConv;
    state.isNewConversation = rawConv === '_new';
    state.conversationId = isRealConv(rawConv) ? rawConv : '';
    if (Array.isArray(overrides.workspaceUris)) {
      state.workspaceUris = [...overrides.workspaceUris];
    }
    const res = await apiCall('/api/context', {
      conversationId: rawConv,
      workspaceUris: state.workspaceUris,
    });
    state.workspacePath = res.workspacePath || '';
    state.workspaceName = res.workspaceName || (state.workspacePath ? state.workspacePath.split('/').pop() : 'Global');
    state.projectId = res.projectId || '';
    state.projectName = res.projectName || (state.workspacePath ? state.workspaceName : '');
    state.allWorkspacePaths = Array.isArray(res.allWorkspacePaths) ? res.allWorkspacePaths : [];
    if (isRealConv(res.conversationId)) {
      state.conversationId = res.conversationId;
    }
    state.conversationTitle = res.conversationTitle || '';
    state.isNewConversation = Boolean(res.isNewConversation);
    if (!state.userPickedStashFilter) {
      state.stashFilter = state.workspacePath ? 'workspace' : 'all';
    }
    if (!state.userPickedComposerTarget) {
      state.composerTarget = state.workspacePath ? 'workspace' : 'global';
    } else if (!state.workspacePath) {
      state.composerTarget = 'global';
    }
    if (!state.userPickedPadScope) {
      state.padScope = state.workspacePath ? 'workspace' : 'global';
    } else if (!state.workspacePath) {
      state.padScope = 'global';
    }
    Notes.renderAll?.();
    return res;
  }

  Notes.PALETTE = PALETTE;
  Notes.PALETTE_SET = PALETTE_SET;
  Notes.isRealConversationId = isRealConv;
  Notes.inferDefaultTagColor = inferDefaultTagColor;
  Notes.getTagColor = getTagColor;
  Notes.parseHashtags = parseHashtags;
  Notes.resolveCardColor = resolveCardColor;
  Notes.normalizeWorkspaceKey = normalizeWorkspaceKey;
  Notes.filterVisibleCards = filterVisibleCards;
  Notes.listScopePads = listScopePads;
  Notes.exportStashMarkdown = exportStashMarkdown;
  Notes.formatRelativeAge = formatRelativeAge;
  Notes.applyServerState = applyServerState;
  Notes.apiCall = apiCall;
  Notes.mutate = mutate;
  Notes.dispatchPrompt = dispatchPrompt;
  Notes.dispatchCards = dispatchCards;
  Notes.showUndoToast = showUndoToast;
  Notes.copyText = copyText;
  Notes.downloadMarkdown = downloadMarkdown;
  Notes.exportMarkdownFile = exportMarkdownFile;
  Notes.openExportMenu = openExportMenu;
  Notes.openConversation = openConversation;
  Notes.refreshContext = refreshContext;
  Notes.mountScratchpadTab ||= () => {};
  Notes.renderScratchpadTab ||= () => {};
  Notes.flushPendingScratchpadSave ||= () => {};
  Notes.renderAll ||= () => {};

  if (win.__NOTES_INITIAL_STATE__) {
    Notes.applyServerState(win.__NOTES_INITIAL_STATE__, 0);
  }
})(typeof window !== 'undefined' ? window : globalThis);
