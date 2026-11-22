/**
 * @fileoverview Prompt Stash surface: IME-safe auto-sizing composer, Onyx color/tag filters, cards, drag-reorder, and batch bar.
 */
(function (win) {
  const doc = win.document;
  const ui = win.AgyUI;
  const Notes = (win.Notes = win.Notes || {});
  const EventCtor = win.Event || Event;
  const setTimer = typeof win.setTimeout === 'function' ? win.setTimeout.bind(win) : setTimeout;

  const DRAG_THRESHOLD_PX = 5;
  const AUTO_SCROLL_EDGE_PX = 36;
  const AUTO_SCROLL_MAX_STEP = 12;

  let rootEl = null;
  let els = null;
  let lastComposerCompEnd = null;
  let activeDragCleanup = null;
  let isDraggingCard = false;
  let deferredRenderAfterDrag = false;
  let editingDraftText = null;

  const prefersReducedMotion = () => Boolean(win.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches);

  function startInlineCardEdit(card) {
    Notes.state.editingId = card.id;
    editingDraftText = null;
    renderStashTab();
  }

  const supportsFieldSizing = () => Boolean(win.CSS?.supports?.('field-sizing', 'content'));

  function autoResizeFallback(textarea, maxPx = 112) {
    if (!textarea || supportsFieldSizing()) {
      return;
    }
    textarea.style.height = 'auto';
    if (textarea.scrollHeight > 0) {
      textarea.style.height = `${Math.min(maxPx, textarea.scrollHeight)}px`;
    }
  }

  function isImeBlockedEnter(ev, lastCompEnd) {
    if (ev.isComposing || ev.keyCode === 229) {
      return true;
    }
    return lastCompEnd !== null && typeof ev.timeStamp === 'number' && Math.abs(ev.timeStamp - lastCompEnd) < 50;
  }

  function submitFormSafe(form) {
    if (typeof form?.requestSubmit === 'function') {
      form.requestSubmit();
      return;
    }
    form?.dispatchEvent?.(new EventCtor('submit', { bubbles: true, cancelable: true }));
  }

  function renderCardBodyHtml(text, isActive = false) {
    const md = win.NotesMarkdown;
    if (typeof md?.renderMarkdownHtml === 'function') {
      return md.renderMarkdownHtml(text, {
        interactiveTasks: Boolean(isActive),
        tagColors: Notes.state.tagColors,
      });
    }
    if (typeof md?.renderCardInlineHtml === 'function') {
      return md.renderCardInlineHtml(text, Notes.state.tagColors);
    }
    return ui.escHtml(text);
  }

  function applyStashSmartKeys(ev, textarea, lastCompEnd, newlineChord, onChanged) {
    const md = win.NotesMarkdown;
    if (!md || ev.isComposing || ev.keyCode === 229) {
      return false;
    }
    if (ev.key === 'Tab' && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
      if (typeof md.isListLineAtSelection !== 'function' || typeof md.applyEditorTabIndent !== 'function') {
        return false;
      }
      if (!md.isListLineAtSelection(textarea.value, textarea.selectionStart, textarea.selectionEnd)) {
        return false;
      }
      const indented = md.applyEditorTabIndent(
        textarea.value,
        textarea.selectionStart,
        textarea.selectionEnd,
        Boolean(ev.shiftKey)
      );
      if (!indented) {
        return false;
      }
      ev.preventDefault?.();
      textarea.value = indented.value;
      textarea.selectionStart = indented.start;
      textarea.selectionEnd = indented.end;
      textarea.setSelectionRange?.(indented.start, indented.end);
      onChanged?.();
      return true;
    }
    if (isImeBlockedEnter(ev, lastCompEnd)) {
      return false;
    }
    const isNewlineEnter = ev.key === 'Enter'
      && !ev.ctrlKey
      && !ev.metaKey
      && !ev.altKey
      && (newlineChord === 'shift' ? Boolean(ev.shiftKey) : !ev.shiftKey);
    if (isNewlineEnter && typeof md.applyEditorListEnter === 'function') {
      const next = md.applyEditorListEnter(textarea.value, textarea.selectionStart, textarea.selectionEnd);
      if (next) {
        ev.preventDefault?.();
        textarea.value = next.value;
        textarea.selectionStart = next.cursor;
        textarea.selectionEnd = next.cursor;
        textarea.setSelectionRange?.(next.cursor, next.cursor);
        onChanged?.();
        return true;
      }
    }
    return false;
  }

  function renderComposerState() {
    if (!els) {
      return;
    }
    const { state } = Notes;
    const draftTags = Notes.parseHashtags(els.composerInput.value);
    const autoColor = draftTags.map((t) => Notes.getTagColor(t)).find((c) => c && c !== 'none') || '';
    const resolvedHue = state.composerColor !== 'auto'
      ? state.composerColor === 'none'
        ? ''
        : state.composerColor
      : autoColor;

    for (const p of Notes.PALETTE) {
      els.composerForm.classList.remove(`notes-hue-${p.id}`);
    }
    els.composerForm.classList.toggle('has-hue', Boolean(resolvedHue));
    if (resolvedHue) {
      els.composerForm.classList.add(`notes-hue-${resolvedHue}`);
    }

    const colorLabel = state.composerColor === 'auto'
      ? resolvedHue
        ? `Auto (${resolvedHue})`
        : 'Auto'
      : state.composerColor === 'none'
        ? 'No color'
        : state.composerColor;
    const dotCls = resolvedHue ? `notes-swatch-dot notes-hue-${resolvedHue}` : 'notes-swatch-dot is-none';
    els.composerColorBtn.innerHTML = `<span class="${dotCls}" aria-hidden="true"></span><span>${ui.escHtml(colorLabel)}</span>`;

    const hasProject = Boolean(state.workspacePath);
    const isGeneralTarget = !hasProject || state.composerTarget === 'global';
    const projLabel = state.projectName || state.workspaceName || 'Project';
    const targetIcon = isGeneralTarget ? ui.iconSvg('globe', 12) : ui.iconSvg('folder', 12);
    const targetText = isGeneralTarget ? 'General' : projLabel;
    els.composerTargetBtn.innerHTML = `${targetIcon}<span class="notes-target-name">${ui.escHtml(targetText)}</span>`;
    els.composerTargetBtn.disabled = !hasProject;
    els.composerTargetBtn.classList.toggle('is-general', isGeneralTarget);
    els.composerTargetBtn.title = !hasProject
      ? 'Saving as General note (no project open)'
      : isGeneralTarget
        ? `Saving as General note (unattached) — click to save to ${projLabel}`
        : `Saving to Project: ${projLabel} — click to save as General note`;

    if (state.enterBehavior !== state.settings.enterBehavior) {
      state.enterBehavior = state.settings.enterBehavior;
    }
    const basePlaceholder = isGeneralTarget
      ? 'Park a general prompt or #tag…'
      : state.stashFilter === 'chat'
        ? 'Park a prompt for this chat…'
        : 'Park a prompt or #tag…';
    if (state.settings.enterBehavior === 'stash') {
      els.composerInput.placeholder = `${basePlaceholder} (Enter)`;
      els.composerHint.title = 'Enter to stash · Shift+Enter for newline';
      els.composerHint.innerHTML = '<span class="notes-hint-full">Enter to stash · Shift+Enter newline</span><span class="notes-hint-short">↵ stash · ⇧↵ line</span>';
    } else {
      els.composerInput.placeholder = `${basePlaceholder} (Ctrl+Enter)`;
      els.composerHint.title = 'Ctrl+Enter to stash · Enter for newline';
      els.composerHint.innerHTML = '<span class="notes-hint-full">Ctrl+Enter to stash · Enter newline</span><span class="notes-hint-short">Ctrl+↵ stash · ↵ line</span>';
    }
  }

  function syncComposerExpanded() {
    if (!els) {
      return;
    }
    const val = els.composerInput.value || '';
    const hasCustomTarget = Boolean(Notes.state.workspacePath) && Notes.state.composerTarget === 'global';
    const isFocusedInside = doc.activeElement === els.composerInput
      || Boolean(els.composerForm.contains?.(doc.activeElement));
    const expanded = isFocusedInside
      || val.includes('\n')
      || val.length > 34
      || Notes.state.composerColor !== 'auto'
      || hasCustomTarget;
    els.composerForm.classList.toggle('is-expanded', expanded);
    renderComposerState();
  }

  function openTagColorPicker(ev, tag) {
    ev.preventDefault?.();
    ev.stopPropagation?.();
    Notes.openSwatchPicker(ev, {
      title: `Tag color: #${tag}`,
      currentValue: Notes.getTagColor(tag) || 'none',
      allowAuto: false,
      onSelect: async (nextColor) => {
        try {
          await Notes.mutate('tag-set-color', { tag, color: nextColor });
        } catch (err) {
          ui.showToast(err?.message || 'Failed to update tag color', { error: true });
        }
      },
    });
  }

  function getTransformOffset(el) {
    const tr = win.getComputedStyle?.(el)?.transform;
    if (!tr || tr === 'none') {
      return { x: 0, y: 0 };
    }
    const m2d = tr.match(/^matrix\(([^)]+)\)$/);
    if (m2d) {
      const parts = m2d[1].split(',');
      return { x: parseFloat(parts[4]) || 0, y: parseFloat(parts[5]) || 0 };
    }
    const m3d = tr.match(/^matrix3d\(([^)]+)\)$/);
    if (m3d) {
      const parts = m3d[1].split(',');
      return { x: parseFloat(parts[12]) || 0, y: parseFloat(parts[13]) || 0 };
    }
    return { x: 0, y: 0 };
  }

  function getLayoutRect(el) {
    const raw = el?.getBoundingClientRect?.() || { left: 0, top: 0, width: 0, height: 0 };
    const off = getTransformOffset(el);
    const width = Number(raw.width) || 0;
    const height = Number(raw.height) || 0;
    const left = (Number(raw.left) || 0) - off.x;
    const top = (Number(raw.top) || 0) - off.y;
    const right = (Number.isFinite(raw.right) ? raw.right - off.x : left + width);
    const bottom = (Number.isFinite(raw.bottom) ? raw.bottom - off.y : top + height);
    return { left, right, width, top, bottom, height };
  }

  function getDomCardElements() {
    return [...(els?.cardList?.querySelectorAll?.('.notes-card[data-card-id]') || [])];
  }

  function snapshotVisualRects(excludeCardId = '') {
    const map = new Map();
    for (const el of getDomCardElements()) {
      const cid = el.dataset?.cardId || '';
      if (!cid || cid === excludeCardId) {
        continue;
      }
      const r = el.getBoundingClientRect?.();
      if (r && (Number(r.height) || 0) > 0) {
        map.set(cid, { left: Number(r.left) || 0, top: Number(r.top) || 0 });
      }
    }
    return map;
  }

  function playFlipAnimation(firstRects, excludeCardId = '') {
    if (prefersReducedMotion()) {
      return;
    }
    for (const el of getDomCardElements()) {
      const cid = el.dataset?.cardId || '';
      const first = cid && cid !== excludeCardId ? firstRects.get(cid) : null;
      if (!first || typeof el.animate !== 'function') {
        continue;
      }
      const last = el.getBoundingClientRect?.();
      if (!last) {
        continue;
      }
      const dx = first.left - (Number(last.left) || 0);
      const dy = first.top - (Number(last.top) || 0);
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) {
        continue;
      }
      el.animate(
        [
          { transform: `translate3d(${Math.round(dx)}px, ${Math.round(dy)}px, 0)` },
          { transform: 'translate3d(0, 0, 0)' },
        ],
        { duration: 180, easing: 'cubic-bezier(0.2, 0, 0, 1)' }
      );
    }
  }

  function findDropTarget(cardId, clientX, clientY, hasClientX) {
    const allBoxes = [];
    for (const el of getDomCardElements()) {
      const cid = el.dataset.cardId;
      const box = getLayoutRect(el);
      if (!cid || box.height <= 0) {
        continue;
      }
      allBoxes.push({ el, cid, ...box });
    }
    if (allBoxes.length < 2) {
      return null;
    }

    const rows = [];
    for (const box of allBoxes) {
      const prevRow = rows[rows.length - 1];
      const overlapThreshold = prevRow ? Math.min(prevRow.minHeight, box.height) * 0.35 : 0;
      if (prevRow && box.top < prevRow.bottom - overlapThreshold) {
        prevRow.items.push(box);
        prevRow.top = Math.min(prevRow.top, box.top);
        prevRow.bottom = Math.max(prevRow.bottom, box.bottom);
        prevRow.minHeight = Math.min(prevRow.minHeight, box.height);
      } else {
        rows.push({ items: [box], top: box.top, bottom: box.bottom, minHeight: box.height });
      }
    }

    const selfBox = allBoxes.find((b) => b.cid === cardId);
    const insideSelfX = !hasClientX || (selfBox && clientX >= selfBox.left && clientX <= selfBox.right);
    if (selfBox && clientY >= selfBox.top && clientY <= selfBox.bottom && insideSelfX) {
      return null;
    }

    const isMultiColGrid = rows.some((r) => r.items.length > 1);
    let chosenRow = rows[0];
    let bestRowDist = Infinity;
    for (const row of rows) {
      const dist = clientY < row.top ? row.top - clientY : clientY > row.bottom ? clientY - row.bottom : 0;
      if (dist < bestRowDist) {
        bestRowDist = dist;
        chosenRow = row;
      }
    }

    const candidates = chosenRow.items
      .filter((it) => it.cid !== cardId)
      .sort((a, b) => a.left - b.left);
    if (candidates.length === 0) {
      return null;
    }

    let chosen = candidates[candidates.length - 1];
    if (candidates.length > 1 && hasClientX) {
      let idx = 0;
      while (idx < candidates.length - 1) {
        const splitX = (candidates[idx].right + candidates[idx + 1].left) / 2;
        if (clientX <= splitX) {
          chosen = candidates[idx];
          break;
        }
        idx += 1;
      }
    } else {
      chosen = candidates[0];
    }

    const useHorizMid = (isMultiColGrid || chosenRow.items.length > 1) && hasClientX && chosen.width > 0;
    const placeAfter = useHorizMid
      ? clientX >= chosen.left + chosen.width / 2
      : clientY >= chosen.top + chosen.height / 2;
    return { targetEl: chosen.el, placeAfter };
  }

  function createDragGhost(cardNode, rect) {
    const ghost = cardNode.cloneNode(true);
    ghost.removeAttribute?.('id');
    delete ghost.dataset?.cardId;
    for (const childWithId of ghost.querySelectorAll?.('[id]') || []) {
      childWithId.removeAttribute('id');
    }
    ghost.classList.remove('is-drag-placeholder', 'is-dragging-card');
    ghost.classList.add('notes-card-drag-ghost');
    ghost.setAttribute('aria-hidden', 'true');
    const width = Math.max(180, Math.round(Number(rect.width) || 280));
    const height = Math.max(44, Math.round(Number(rect.height) || 64));
    ghost.style.width = `${width}px`;
    ghost.style.height = `${height}px`;
    return ghost;
  }

  function applyOptimisticCardOrder(orderedIds) {
    const rank = new Map(orderedIds.map((id, index) => [id, (index + 1) * 1000]));
    for (const card of Notes.state.cards) {
      if (card && rank.has(card.id)) {
        card.order = rank.get(card.id);
      }
    }
  }

  function bindCardDrag(cardNode, cardId) {
    cardNode.addEventListener('pointerdown', (downEv) => {
      if (downEv.button !== undefined && downEv.button !== 0) {
        return;
      }
      const rawTarget = downEv.target?.nodeType === 1 ? downEv.target : downEv.target?.parentElement;
      const fromHandle = Boolean(rawTarget?.closest?.('.notes-drag-handle'));
      if (!fromHandle && rawTarget?.closest?.('button, input, textarea, a[href], [data-inline-tag], .notes-edit-box')) {
        return;
      }
      if (fromHandle) {
        downEv.preventDefault?.();
        downEv.stopPropagation?.();
      }
      activeDragCleanup?.();

      const hasStartX = Number.isFinite(downEv.clientX);
      const startX = hasStartX ? downEv.clientX : 0;
      const startY = Number(downEv.clientY) || 0;
      let lastClientY = startY;
      let started = false;
      let initialOrderedIds = [];
      let startRect = null;
      let hostEl = null;
      let grabOffsetX = 0;
      let grabOffsetY = 0;
      let ghostEl = null;
      let rafId = null;

      const updateGhostTransform = (clientX, clientY, hasClientX) => {
        if (!ghostEl) {
          return;
        }
        const hostRect = hostEl?.getBoundingClientRect?.() || { left: 0, top: 0 };
        const rawX = (hasClientX ? clientX : Number(startRect?.left) || 0) - grabOffsetX - (Number(hostRect.left) || 0);
        const rawY = clientY - grabOffsetY - (Number(hostRect.top) || 0);
        const scale = prefersReducedMotion() ? '' : ' scale(1.02)';
        ghostEl.style.transform = `translate3d(${Math.round(rawX)}px, ${Math.round(rawY)}px, 0)${scale}`;
      };

      const stepAutoScroll = () => {
        if (!started || !els?.cardList) {
          rafId = null;
          return;
        }
        const listRect = els.cardList.getBoundingClientRect?.();
        const listHeight = Number(listRect?.height) || 0;
        if (listHeight > 0 && els.cardList.scrollHeight > els.cardList.clientHeight) {
          const topDist = lastClientY - (Number(listRect.top) || 0);
          const botDist = (Number(listRect.bottom) || 0) - lastClientY;
          if (topDist >= 0 && topDist < AUTO_SCROLL_EDGE_PX) {
            const ratio = 1 - topDist / AUTO_SCROLL_EDGE_PX;
            els.cardList.scrollTop -= Math.ceil(AUTO_SCROLL_MAX_STEP * ratio);
          } else if (botDist >= 0 && botDist < AUTO_SCROLL_EDGE_PX) {
            const ratio = 1 - botDist / AUTO_SCROLL_EDGE_PX;
            els.cardList.scrollTop += Math.ceil(AUTO_SCROLL_MAX_STEP * ratio);
          }
        }
        if (typeof win.requestAnimationFrame === 'function') {
          rafId = win.requestAnimationFrame(stepAutoScroll);
        }
      };

      const beginDragSession = (clientX, clientY, hasClientX) => {
        started = true;
        isDraggingCard = true;
        cardNode._suppressClickUntil = Date.now() + 250;
        win.getSelection?.()?.removeAllRanges?.();
        initialOrderedIds = getDomCardElements().map((el) => el.dataset.cardId);
        startRect = getLayoutRect(cardNode);
        grabOffsetX = hasStartX ? startX - startRect.left : (startRect.width || 260) / 2;
        grabOffsetY = startY - startRect.top;
        hostEl = doc.getElementById('notes-app') || doc.body;
        ghostEl = createDragGhost(cardNode, startRect);
        hostEl?.appendChild?.(ghostEl);
        cardNode.classList.add('is-drag-placeholder');
        els?.cardList?.classList?.add?.('is-dragging-cards');
        doc.body?.classList?.add?.('dragging-notes-card');
        updateGhostTransform(clientX, clientY, hasClientX);
        if (typeof win.requestAnimationFrame === 'function') {
          rafId = win.requestAnimationFrame(stepAutoScroll);
        }
      };

      const restoreInitialDomOrder = () => {
        if (!started || !els?.cardList || initialOrderedIds.length === 0) {
          return;
        }
        const firstRects = snapshotVisualRects(cardId);
        const byId = new Map(getDomCardElements().map((el) => [el.dataset.cardId, el]));
        for (const id of initialOrderedIds) {
          const node = byId.get(id);
          if (node) {
            els.cardList.appendChild(node);
          }
        }
        playFlipAnimation(firstRects, cardId);
      };

      const finishVisualCleanup = () => {
        ghostEl?.remove?.();
        ghostEl = null;
        cardNode?.classList?.remove?.('is-drag-placeholder', 'is-dragging-card');
        els?.cardList?.classList?.remove?.('is-dragging-cards');
        doc.body?.classList?.remove?.('dragging-notes-card');
        isDraggingCard = false;
        if (deferredRenderAfterDrag) {
          deferredRenderAfterDrag = false;
          renderStashTab();
        }
      };

      const detachListeners = () => {
        if (rafId !== null && typeof win.cancelAnimationFrame === 'function') {
          win.cancelAnimationFrame(rafId);
        }
        rafId = null;
        win.removeEventListener?.('pointermove', onMove);
        win.removeEventListener?.('pointerup', onEnd);
        win.removeEventListener?.('pointercancel', onCancel);
        win.removeEventListener?.('keydown', onKeyDown, true);
        if (activeDragCleanup === onCancel) {
          activeDragCleanup = null;
        }
      };

      const onMove = (moveEv) => {
        const hasClientX = Number.isFinite(moveEv.clientX);
        const clientX = hasClientX ? moveEv.clientX : 0;
        const clientY = Number(moveEv.clientY) || 0;
        lastClientY = clientY;
        if (!started) {
          const dx = hasClientX && hasStartX ? clientX - startX : 0;
          const dy = clientY - startY;
          if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) {
            return;
          }
          beginDragSession(clientX, clientY, hasClientX);
        }
        updateGhostTransform(clientX, clientY, hasClientX);

        const hit = findDropTarget(cardId, clientX, clientY, hasClientX);
        if (!hit || !els?.cardList) {
          return;
        }
        const refNode = hit.placeAfter ? hit.targetEl.nextElementSibling : hit.targetEl;
        if (refNode === cardNode || (!hit.placeAfter && cardNode.nextElementSibling === hit.targetEl)) {
          return;
        }
        const firstRects = snapshotVisualRects(cardId);
        els.cardList.insertBefore(cardNode, refNode || null);
        playFlipAnimation(firstRects, cardId);
      };

      const onCancel = () => {
        detachListeners();
        if (started) {
          restoreInitialDomOrder();
        }
        finishVisualCleanup();
      };

      const onKeyDown = (keyEv) => {
        if (started && keyEv.key === 'Escape') {
          keyEv.preventDefault?.();
          keyEv.stopPropagation?.();
          onCancel();
        }
      };

      const onEnd = async () => {
        detachListeners();
        if (!started) {
          finishVisualCleanup();
          return;
        }
        cardNode._suppressClickUntil = Date.now() + 250;
        const finalDomIds = getDomCardElements().map((el) => el.dataset.cardId);
        const didChange = finalDomIds.length === initialOrderedIds.length
          && finalDomIds.some((id, idx) => id !== initialOrderedIds[idx]);

        const scopeIds = Notes.filterVisibleCards('active').map((c) => c.id);
        const movedSet = new Set(finalDomIds);
        let cursor = 0;
        const mergedIds = scopeIds.map((id) => {
          if (!movedSet.has(id)) {
            return id;
          }
          const nextId = finalDomIds[cursor];
          cursor += 1;
          return nextId;
        });

        if (didChange) {
          applyOptimisticCardOrder(mergedIds);
        }

        if (!prefersReducedMotion() && ghostEl && typeof ghostEl.animate === 'function') {
          const destRect = cardNode.getBoundingClientRect?.() || { left: 0, top: 0 };
          const hostRect = hostEl?.getBoundingClientRect?.() || { left: 0, top: 0 };
          const toX = Math.round((Number(destRect.left) || 0) - (Number(hostRect.left) || 0));
          const toY = Math.round((Number(destRect.top) || 0) - (Number(hostRect.top) || 0));
          const fromTransform = ghostEl.style.transform || `translate3d(${toX}px, ${toY}px, 0)`;
          const settleAnim = ghostEl.animate(
            [
              { transform: fromTransform },
              { transform: `translate3d(${toX}px, ${toY}px, 0) scale(1)` },
            ],
            { duration: 140, easing: 'cubic-bezier(0.2, 0, 0, 1)' }
          );
          if (settleAnim?.finished?.finally) {
            settleAnim.finished.catch(() => {}).finally(finishVisualCleanup);
          } else {
            finishVisualCleanup();
          }
        } else {
          finishVisualCleanup();
        }

        if (!didChange) {
          return;
        }
        try {
          await Notes.mutate('stash-reorder', { orderedIds: mergedIds });
        } catch (err) {
          ui.showToast(err?.message || 'Failed to reorder cards', { error: true });
          Notes.renderAll?.();
        }
      };

      activeDragCleanup = onCancel;
      win.addEventListener?.('pointermove', onMove);
      win.addEventListener?.('pointerup', onEnd);
      win.addEventListener?.('pointercancel', onCancel);
      win.addEventListener?.('keydown', onKeyDown, true);
    });
  }

  function buildCardEditElement(card) {
    const { state } = Notes;
    const editId = `edit-card-${card.id}`;
    const initialVal = editingDraftText ?? card.text;
    const label = ui.el('label', { for: editId, className: 'sr-only' }, 'Edit prompt card');
    const editArea = ui.el('textarea', {
      id: editId,
      className: 'agy-input notes-edit-textarea',
      rows: '3',
      dataset: { editInput: card.id },
    }, initialVal);
    editArea.value = initialVal;

    let lastEditCompEnd = null;
    let saving = false;
    editArea.addEventListener('compositionend', (ev) => {
      lastEditCompEnd = ev.timeStamp;
    });
    editArea.addEventListener('input', () => {
      editingDraftText = editArea.value;
      autoResizeFallback(editArea, 180);
    });

    const saveEdit = async () => {
      if (saving) {
        return;
      }
      const nextText = editArea.value.trim();
      const latestCard = Notes.state.cards.find((c) => c && c.id === card.id) || card;
      if (!nextText || nextText === latestCard.text) {
        state.editingId = '';
        editingDraftText = null;
        Notes.renderAll?.();
        return;
      }
      saving = true;
      state.editingId = '';
      editingDraftText = null;
      if (nextText.split('\n').length <= 7 && nextText.length <= 320) {
        state.expandedCardIds.delete(card.id);
      }
      try {
        await Notes.mutate('stash-update', { id: card.id, text: nextText });
      } catch (err) {
        ui.showToast(err?.message || 'Failed to update card', { error: true });
        Notes.renderAll?.();
      } finally {
        saving = false;
      }
    };

    const cancelEdit = () => {
      if (saving) {
        return;
      }
      state.editingId = '';
      editingDraftText = null;
      Notes.renderAll?.();
    };

    editArea.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') {
        ev.preventDefault?.();
        cancelEdit();
        return;
      }
      if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) {
        ev.preventDefault?.();
        saveEdit();
        return;
      }
      const editMode = state.settings.enterBehavior || 'stash';
      if (ev.key === 'Enter' && editMode === 'stash' && !ev.shiftKey && !ev.ctrlKey && !ev.metaKey) {
        ev.preventDefault?.();
        if (isImeBlockedEnter(ev, lastEditCompEnd)) {
          return;
        }
        saveEdit();
        return;
      }
      const nlChord = editMode === 'stash' ? 'shift' : 'plain';
      applyStashSmartKeys(ev, editArea, lastEditCompEnd, nlChord, () => {
        editingDraftText = editArea.value;
        autoResizeFallback(editArea, 180);
      });
    });

    const box = ui.el(
      'div',
      { className: 'notes-edit-box' },
      label,
      editArea,
      ui.el(
        'div',
        { className: 'notes-edit-actions' },
        ui.el('button', { type: 'button', className: 'agy-btn agy-btn-xs agy-btn-ghost', dataset: { editAction: 'cancel' }, onClick: cancelEdit }, 'Cancel'),
        ui.el('button', { type: 'button', className: 'agy-btn agy-btn-xs agy-btn-primary', dataset: { editAction: 'save' }, onClick: saveEdit }, 'Save')
      )
    );
    setTimer(() => {
      editArea.focus?.();
      editArea.setSelectionRange?.(editArea.value.length, editArea.value.length);
    }, 0);
    return box;
  }

  function buildCardElement(card) {
    const { state } = Notes;
    const isSelected = state.selectedIds.has(card.id);
    const isActive = state.statusView === 'active';
    const resolvedHue = Notes.resolveCardColor(card);
    const hueCls = resolvedHue ? ` has-hue notes-hue-${resolvedHue}` : '';
    const isEditingThis = state.editingId === card.id;
    const rawLineCount = String(card.text || '').split('\n').length;
    const isLikelyTall = !isEditingThis && (rawLineCount > 7 || String(card.text || '').length > 320);
    const isCardExpanded = !isEditingThis && state.expandedCardIds.has(card.id);
    const clampCls = isLikelyTall || isCardExpanded ? ' is-card-clamped' : '';
    const expCls = isCardExpanded ? ' is-card-expanded' : '';
    const cardEl = ui.el('article', {
      className: `agy-card notes-card${hueCls}${isSelected ? ' is-selected' : ''}${clampCls}${expCls}`,
      dataset: { cardId: card.id },
    });

    if (isEditingThis) {
      cardEl.appendChild(buildCardEditElement(card));
      return cardEl;
    }

    const topRow = ui.el('div', { className: 'notes-card-top' });
    if (isActive) {
      const dragBtn = ui.el('button', {
        type: 'button',
        className: 'notes-drag-handle',
        title: 'Drag to reorder',
        'aria-label': 'Drag card to reorder',
        tabIndex: -1,
        innerHTML: ui.iconSvg('drag_indicator', 13),
      });
      bindCardDrag(cardEl, card.id);
      topRow.appendChild(dragBtn);

      const check = ui.el('input', {
        type: 'checkbox',
        className: 'notes-card-check',
        checked: isSelected,
        'aria-label': 'Select card for batch combine',
        onChange: (ev) => {
          if (ev.target.checked) {
            state.selectedIds.add(card.id);
          } else {
            state.selectedIds.delete(card.id);
          }
          renderStashTab();
        },
      });
      check.checked = isSelected;
      topRow.appendChild(check);
    }

    const bodyEl = ui.el('div', {
      className: 'notes-card-body',
      title: isActive ? 'Click to edit inline · Drag to reorder · Right-click #tag to recolor' : 'Right-click #tag to recolor tag',
      innerHTML: renderCardBodyHtml(card.text, isActive),
      onClick: (ev) => {
        if (cardEl._suppressClickUntil && Date.now() < cardEl._suppressClickUntil) {
          cardEl._suppressClickUntil = 0;
          return;
        }
        const target = ev.target?.nodeType === 1 ? ev.target : ev.target?.parentElement;
        if (target?.closest?.('input[type="checkbox"], [data-inline-tag], a[href]')) {
          return;
        }
        if (isActive) {
          startInlineCardEdit(card);
        }
      },
    });
    for (const taskBox of bodyEl.querySelectorAll?.('input[type="checkbox"]') || []) {
      if (typeof taskBox.checked !== 'boolean') {
        taskBox.checked = taskBox.hasAttribute('checked');
      }
    }
    const onCardTaskToggle = async (ev) => {
      const targetNode = ev.target?.nodeType === 1 ? ev.target : ev.target?.parentElement;
      const checkbox = targetNode?.closest?.('input[type="checkbox"][data-task-line]');
      if (!checkbox || checkbox._taskHandled || !isActive) {
        return;
      }
      checkbox._taskHandled = true;
      ev.stopPropagation?.();
      const lineIdx = Number(checkbox.dataset?.taskLine);
      const md = win.NotesMarkdown;
      if (!Number.isInteger(lineIdx) || typeof md?.toggleTaskLine !== 'function') {
        return;
      }
      const latest = Notes.state.cards.find((c) => c && c.id === card.id) || card;
      const nextText = md.toggleTaskLine(latest.text, lineIdx);
      if (nextText === latest.text) {
        return;
      }
      try {
        await Notes.mutate('stash-update', { id: card.id, text: nextText });
      } catch (err) {
        ui.showToast(err?.message || 'Failed to toggle task item', { error: true });
        renderStashTab();
      }
    };
    bodyEl.addEventListener('click', onCardTaskToggle);
    bodyEl.addEventListener('change', onCardTaskToggle);
    bodyEl.addEventListener('contextmenu', (ev) => {
      const target = ev.target?.nodeType === 1 ? ev.target : ev.target?.parentElement;
      const inlineTag = target?.closest?.('[data-inline-tag]');
      if (inlineTag?.dataset?.inlineTag) {
        openTagColorPicker(ev, inlineTag.dataset.inlineTag);
      }
    });
    topRow.appendChild(bodyEl);

    if (isActive) {
      topRow.appendChild(
        ui.el(
          'button',
          {
            type: 'button',
            className: 'agy-btn agy-btn-xs agy-btn-secondary notes-send-btn',
            dataset: { action: 'send' },
            title: 'Send to Active Chat',
            onClick: async () => {
              try {
                await Notes.dispatchCards([card], 'active');
              } catch (err) {
                ui.showToast(err?.message || 'Failed to send prompt', { error: true });
              }
            },
          },
          'Send ↵'
        )
      );
    } else {
      topRow.appendChild(
        ui.el(
          'button',
          {
            type: 'button',
            className: 'agy-btn agy-btn-xs agy-btn-outline notes-send-btn',
            dataset: { action: 'restore' },
            title: 'Restore to Active Stash',
            onClick: async () => {
              try {
                await Notes.mutate('stash-restore', { ids: [card.id] });
              } catch (err) {
                ui.showToast(err?.message || 'Failed to restore card', { error: true });
              }
            },
          },
          'Restore'
        )
      );
    }
    cardEl.appendChild(topRow);

    const expandBtnHtml = (expanded) =>
      expanded ? '<span aria-hidden="true">▴</span> Show less' : '<span aria-hidden="true">▾</span> Show more';
    const expandBtn = ui.el('button', {
      type: 'button',
      className: `notes-card-expand-btn${isLikelyTall || isCardExpanded ? '' : ' hidden'}`,
      dataset: { action: 'toggle-expand' },
      'aria-expanded': String(isCardExpanded),
      innerHTML: expandBtnHtml(isCardExpanded),
      onClick: (ev) => {
        ev.stopPropagation?.();
        const nextExp = !state.expandedCardIds.has(card.id);
        if (nextExp) {
          state.expandedCardIds.add(card.id);
        } else {
          state.expandedCardIds.delete(card.id);
        }
        cardEl.classList.toggle('is-card-expanded', nextExp);
        cardEl.classList.add('is-card-clamped');
        expandBtn.setAttribute('aria-expanded', String(nextExp));
        expandBtn.innerHTML = expandBtnHtml(nextExp);
      },
    });
    cardEl.appendChild(expandBtn);
    if (!isLikelyTall && !isCardExpanded && typeof win.requestAnimationFrame === 'function') {
      win.requestAnimationFrame(() => {
        if ((Number(bodyEl.scrollHeight) || 0) > (Number(bodyEl.clientHeight) || 0) + 4) {
          cardEl.classList.add('is-card-clamped');
          expandBtn.classList.remove('hidden');
        }
      });
    }

    const isGeneralCard = card.scope === 'global';
    const isAllView = state.stashFilter === 'all';
    const targetConvId = isActive
      ? isGeneralCard
        ? ''
        : card.originConversationId
      : card.sentToConversationId || (isGeneralCard ? '' : card.originConversationId);
    const canJump = Notes.isRealConversationId(targetConvId);
    const rawTitle = !isActive
      ? `Sent → ${card.sentToConversationTitle || card.originConversationTitle || 'Chat'}`
      : isGeneralCard
        ? 'General'
        : isAllView
          ? card.workspaceName && card.originConversationTitle
            ? `${card.workspaceName} › ${card.originConversationTitle}`
            : card.originConversationTitle || card.workspaceName || 'Project'
          : card.originConversationTitle || card.workspaceName || 'Project';
    const originIcon = !isActive
      ? 'open_in_new'
      : isGeneralCard
        ? 'globe'
        : canJump
          ? 'chat'
          : 'folder';
    const ageLabel = Notes.formatRelativeAge(isActive ? card.createdAt : card.sentAt || card.updatedAt);

    const originBtn = ui.el('button', {
      type: 'button',
      className: 'notes-origin-btn',
      disabled: !canJump,
      title: canJump ? `Jump to conversation: ${rawTitle}` : rawTitle,
      innerHTML: `${ui.iconSvg(originIcon, 11)}<span class="notes-origin-label"><span class="notes-origin-title">${ui.escHtml(rawTitle)}</span><span class="notes-origin-age"> · ${ui.escHtml(ageLabel)}</span></span>`,
      onClick: () => {
        if (canJump) {
          Notes.openConversation(targetConvId, rawTitle);
        }
      },
    });

    const openCardColorMenu = (anchor) => {
      Notes.openSwatchPicker(anchor, {
        title: 'Card color override',
        currentValue: card.color || 'auto',
        allowAuto: true,
        onSelect: async (nextColor) => {
          try {
            await Notes.mutate('stash-update', { id: card.id, color: nextColor });
          } catch (err) {
            ui.showToast(err?.message || 'Failed to update card color', { error: true });
          }
        },
      });
    };

    const mkIconBtn = (icon, title, onClick, extraCls = '') =>
      ui.el('button', {
        type: 'button',
        className: `agy-icon-btn ${extraCls}`.trim(),
        title,
        'aria-label': title,
        innerHTML: ui.iconSvg(icon, 14),
        onClick,
      });

    const secActions = ui.el('div', { className: 'notes-card-secondary-actions' });
    secActions.appendChild(mkIconBtn('palette', 'Set card color', (ev) => openCardColorMenu(ev.currentTarget), 'notes-card-palette-btn'));
    secActions.appendChild(
      mkIconBtn('open_in_new', 'Start New Chat', async () => {
        try {
          await Notes.dispatchCards([card], 'new');
        } catch (err) {
          ui.showToast(err?.message || 'Failed to start new chat', { error: true });
        }
      })
    );
    secActions.appendChild(
      mkIconBtn('content_copy', 'Copy prompt', async () => {
        await Notes.copyText(card.text);
        ui.showToast('Copied prompt to clipboard', { durationMs: 2000 });
      })
    );
    if (isActive) {
      secActions.appendChild(mkIconBtn('edit', 'Edit card', () => startInlineCardEdit(card)));
    }

    const moreBtn = mkIconBtn('more_horiz', 'More card actions', (ev) => {
      const anchorEl = ev.currentTarget;
      const canMoveWorkspace = Boolean(state.workspacePath || card.workspacePath);
      const nextScope = card.scope === 'global' ? 'workspace' : 'global';
      ui.openContextMenu(anchorEl, [
        {
          id: 'send',
          icon: 'play_arrow',
          label: isActive ? 'Send to Active Chat' : 'Re-send to Active Chat',
          onClick: () => Notes.dispatchCards([card], 'active').catch((e) => ui.showToast(e?.message || 'Dispatch failed', { error: true })),
        },
        {
          id: 'new',
          icon: 'open_in_new',
          label: 'Start New Chat',
          onClick: () => Notes.dispatchCards([card], 'new').catch((e) => ui.showToast(e?.message || 'Dispatch failed', { error: true })),
        },
        { id: 'color', icon: 'palette', label: 'Card Color…', onClick: () => openCardColorMenu(anchorEl) },
        ...(isActive
          ? [{ id: 'edit', icon: 'edit', label: 'Edit Text', onClick: () => startInlineCardEdit(card) }]
          : [{ id: 'restore', icon: 'restart_alt', label: 'Restore to Stash', onClick: () => Notes.mutate('stash-restore', { ids: [card.id] }) }]),
        {
          id: 'copy',
          icon: 'content_copy',
          label: 'Copy to Clipboard',
          onClick: async () => {
            await Notes.copyText(card.text);
            ui.showToast('Copied prompt to clipboard', { durationMs: 2000 });
          },
        },
        { separator: true },
        ...(canMoveWorkspace
          ? [{
              id: 'scope',
              icon: nextScope === 'global' ? 'globe' : 'folder',
              label: nextScope === 'global' ? 'Detach as General Note' : 'Attach to Current Project',
              onClick: () => Notes.mutate('stash-update', {
                id: card.id,
                scope: nextScope,
                ...(nextScope === 'workspace' ? { workspacePath: state.workspacePath || card.workspacePath } : {}),
              }),
            }]
          : []),
        {
          id: 'delete',
          icon: 'delete',
          label: 'Delete Card',
          danger: true,
          onClick: async () => {
            state.selectedIds.delete(card.id);
            await Notes.mutate('stash-delete', { ids: [card.id] });
          },
        },
      ]);
    }, 'notes-card-more-btn');

    cardEl.appendChild(
      ui.el(
        'div',
        { className: 'notes-card-footer' },
        ui.el('div', { className: 'notes-footer-left' }, originBtn),
        ui.el('div', { className: 'notes-card-actions' }, secActions, moreBtn)
      )
    );
    return cardEl;
  }

  function renderStashTab() {
    if (!rootEl || !els) {
      return;
    }
    if (isDraggingCard) {
      deferredRenderAfterDrag = true;
      return;
    }
    const { state } = Notes;
    const layout = state.settings.stashLayout || 'grid';
    rootEl.dataset.stashLayout = layout;

    const activeCards = Notes.filterVisibleCards('active');
    const sentCards = Notes.filterVisibleCards('sent');
    const baseCards = state.statusView === 'active' ? activeCards : sentCards;
    const presentColors = [...new Set(baseCards.map((c) => Notes.resolveCardColor(c)).filter(Boolean))];
    const allTags = [...new Set(baseCards.flatMap((c) => (Array.isArray(c.tags) ? c.tags : [])))];

    if (state.activeColorFilter && !presentColors.includes(state.activeColorFilter)) {
      state.activeColorFilter = '';
    }
    if (state.activeTag && !allTags.includes(state.activeTag)) {
      state.activeTag = '';
    }

    els.filterBar.classList.toggle('is-open-in-split', state.splitFilterOpen);
    const hasFilter = Boolean(state.query.trim() || state.activeTag || state.activeColorFilter);
    els.splitFilterBtn.classList.toggle('active', state.splitFilterOpen || hasFilter);
    els.splitFilterBtn.setAttribute('aria-pressed', String(state.splitFilterOpen));
    els.splitSentBtn.textContent = state.statusView === 'sent' ? `Active (${activeCards.length})` : `Sent (${sentCards.length})`;
    els.splitSentBtn.classList.toggle('active', state.statusView === 'sent');
    els.splitSentBtn.setAttribute('aria-pressed', String(state.statusView === 'sent'));

    renderComposerState();

    const displayProject = state.projectName || (state.workspacePath ? state.workspaceName : '');
    const chatTitle = state.isNewConversation
      ? 'New chat (send first turn to link)'
      : state.conversationTitle
        ? `Chat: ${state.conversationTitle}`
        : 'Current chat';
    ui.createToggleGroup(
      els.scopeToggle,
      [
        {
          id: 'workspace',
          label: 'Project',
          title: displayProject ? `Project: ${displayProject}` : 'Project notes',
        },
        {
          id: 'chat',
          label: 'Chat',
          title: chatTitle,
        },
        {
          id: 'all',
          label: 'All',
          title: 'All notes (every project + general)',
        },
      ],
      {
        activeId: state.stashFilter,
        onChange: (id) => {
          if (id === state.stashFilter) {
            return;
          }
          state.stashFilter = id;
          state.userPickedStashFilter = true;
          state.activeTag = '';
          state.activeColorFilter = '';
          state.selectedIds.clear();
          Notes.renderAll?.();
        },
      }
    );

    ui.createToggleGroup(
      els.statusToggle,
      [
        { id: 'active', label: 'Active', count: activeCards.length },
        { id: 'sent', label: 'Sent', count: sentCards.length },
      ],
      {
        activeId: state.statusView,
        onChange: (id) => {
          state.statusView = id;
          state.selectedIds.clear();
          Notes.renderAll?.();
        },
      }
    );

    ui.createToggleGroup(
      els.layoutToggle,
      [
        { id: 'grid', label: 'Grid', title: 'Multi-column card board' },
        { id: 'list', label: 'List', title: 'Single-column queue (680px)' },
      ],
      {
        activeId: layout,
        onChange: async (id) => {
          state.settings.stashLayout = id;
          rootEl.dataset.stashLayout = id;
          try {
            await Notes.mutate('settings-update', { stashLayout: id });
          } catch (err) {
            ui.showToast(err?.message || 'Failed to save layout', { error: true });
          }
        },
      }
    );

    const existingStripMap = new Map();
    for (const child of [...els.tagStrip.children]) {
      const key = child.dataset?.stripKey;
      if (key) {
        existingStripMap.set(key, child);
      }
    }
    const nextStripNodes = [];

    for (const cid of presentColors) {
      const key = `color:${cid}`;
      const isAct = state.activeColorFilter === cid;
      const swatchLabel = Notes.PALETTE.find((p) => p.id === cid)?.label || cid;
      let btn = existingStripMap.get(key);
      if (!btn) {
        btn = ui.el('button', { type: 'button', dataset: { stripKey: key, colorFilter: cid } });
        btn.addEventListener('click', (ev) => btn._onStripClick?.(ev));
      }
      btn.className = `notes-color-filter-btn notes-hue-${cid}${isAct ? ' active' : ''}`;
      btn.title = `Filter by ${swatchLabel} cards (matches #tags & manual overrides)`;
      btn.setAttribute('aria-label', `Filter by ${swatchLabel} color`);
      btn.setAttribute('aria-pressed', String(isAct));
      ui.clear(btn);
      btn.appendChild(ui.el('span', { className: `notes-swatch-dot notes-hue-${cid}`, 'aria-hidden': 'true' }, isAct ? '✓' : ''));
      btn._onStripClick = () => {
        state.activeColorFilter = isAct ? '' : cid;
        renderStashTab();
      };
      nextStripNodes.push(btn);
    }

    if (presentColors.length > 0 && allTags.length > 0) {
      const sep = existingStripMap.get('sep') || ui.el('span', { className: 'notes-strip-sep', 'aria-hidden': 'true', dataset: { stripKey: 'sep' } });
      nextStripNodes.push(sep);
    }
    for (const tag of allTags) {
      const key = `tag:${tag}`;
      const tc = Notes.getTagColor(tag);
      const hueCls = tc && tc !== 'none' ? ` has-hue notes-hue-${tc}` : '';
      const isTagActive = state.activeTag === tag;
      let pill = existingStripMap.get(key);
      if (!pill) {
        pill = ui.el('button', { type: 'button', dataset: { stripKey: key, tagPill: tag } }, `#${tag}`);
        pill.addEventListener('click', (ev) => pill._onStripClick?.(ev));
        pill.addEventListener('contextmenu', (ev) => openTagColorPicker(ev, tag));
      }
      pill.className = `agy-badge notes-tag-pill${hueCls}${isTagActive ? ' active' : ''}`;
      pill.title = `Click to filter #${tag} · Right-click to change tag color`;
      pill.setAttribute('aria-pressed', String(isTagActive));
      pill.textContent = `#${tag}`;
      pill._onStripClick = () => {
        state.activeTag = isTagActive ? '' : tag;
        renderStashTab();
      };
      nextStripNodes.push(pill);
    }
    ui.clear(els.tagStrip);
    for (const node of nextStripNodes) {
      els.tagStrip.appendChild(node);
    }
    els.tagStrip.classList.toggle('hidden', els.tagStrip.childElementCount === 0);

    const queryLower = state.query.trim().toLowerCase();
    const filtered = baseCards.filter((card) => {
      if (state.activeColorFilter && Notes.resolveCardColor(card) !== state.activeColorFilter) {
        return false;
      }
      if (state.activeTag && (!Array.isArray(card.tags) || !card.tags.includes(state.activeTag))) {
        return false;
      }
      if (queryLower && !String(card.text || '').toLowerCase().includes(queryLower)) {
        return false;
      }
      return true;
    });

    let preservedEditCardEl = null;
    if (state.editingId && filtered.some((c) => c.id === state.editingId)) {
      for (const child of [...els.cardList.children]) {
        if (child.dataset?.cardId === state.editingId && child.querySelector?.('.notes-edit-textarea')) {
          preservedEditCardEl = child;
          break;
        }
      }
    }
    if (preservedEditCardEl) {
      for (const child of [...els.cardList.children]) {
        if (child !== preservedEditCardEl) {
          child.remove();
        }
      }
    } else {
      ui.clear(els.cardList);
    }
    els.cardList.classList.toggle('has-selection', state.selectedIds.size > 0);

    const appendBeforeOrEnd = (node, beforePreserved) => {
      if (beforePreserved && preservedEditCardEl) {
        els.cardList.insertBefore(node, preservedEditCardEl);
      } else {
        els.cardList.appendChild(node);
      }
    };

    if (state.statusView === 'sent' && sentCards.length > 0) {
      appendBeforeOrEnd(
        ui.el(
          'div',
          { className: 'agy-card-section-bar notes-sent-header' },
          ui.el('span', {}, `Sent History (${sentCards.length})`),
          ui.el(
            'button',
            {
              type: 'button',
              id: 'clear-sent-btn',
              className: 'agy-btn agy-btn-xs agy-btn-ghost',
              onClick: async () => {
                try {
                  await Notes.mutate('stash-clear-sent', {
                    scope: state.stashFilter,
                    workspacePath: state.workspacePath,
                    allWorkspacePaths: state.allWorkspacePaths,
                    conversationId: state.conversationId,
                  });
                } catch (err) {
                  ui.showToast(err?.message || 'Failed to clear sent cards', { error: true });
                }
              },
            },
            'Clear Sent'
          )
        ),
        true
      );
    }

    if (filtered.length === 0) {
      const emptyWrap = ui.el('div', {
        innerHTML: ui.renderEmptyState({
          icon: 'note_stack',
          message: state.statusView === 'sent' ? 'No sent prompts in this scope yet.' : 'No parked prompts matching this filter.',
        }),
      });
      if (emptyWrap.firstElementChild) {
        els.cardList.appendChild(emptyWrap.firstElementChild);
      }
    } else {
      let passedPreserved = false;
      for (const card of filtered) {
        if (preservedEditCardEl && card.id === state.editingId) {
          const isSelected = state.selectedIds.has(card.id);
          const resolvedHue = Notes.resolveCardColor(card);
          const hueCls = resolvedHue ? ` has-hue notes-hue-${resolvedHue}` : '';
          preservedEditCardEl.className = `agy-card notes-card${hueCls}${isSelected ? ' is-selected' : ''}`;
          passedPreserved = true;
        } else {
          appendBeforeOrEnd(buildCardElement(card), !passedPreserved);
        }
      }
    }

    const selectedActive = activeCards.filter((c) => state.selectedIds.has(c.id));
    els.batchBar.classList.toggle('hidden', selectedActive.length < 2 || state.statusView !== 'active');
    els.batchCount.textContent = `${selectedActive.length} selected`;
  }

  function mountStashTab(containerEl) {
    if (!containerEl) {
      return;
    }
    rootEl = containerEl;
    ui.clear(rootEl);

    const composerInput = ui.el('textarea', {
      id: 'stash-composer-input',
      className: 'agy-input notes-composer-input',
      rows: '1',
      placeholder: 'Park a prompt or #tag… (Enter)',
    });
    const composerTargetBtn = ui.el('button', {
      type: 'button',
      id: 'composer-target-btn',
      className: 'notes-composer-color-btn notes-composer-target-btn',
      title: 'Save destination',
      'aria-label': 'Toggle save destination between Project and General',
    });
    const composerColorBtn = ui.el('button', {
      type: 'button',
      id: 'composer-color-btn',
      className: 'notes-composer-color-btn',
      title: 'Set card color override',
      'aria-label': 'Set card color override',
    });
    const composerHint = ui.el('span', { id: 'composer-hint', className: 'notes-composer-hint' }, 'Enter to stash · Shift+Enter newline');
    const composerForm = ui.el(
      'form',
      { id: 'stash-composer-form', className: 'notes-composer' },
      ui.el('label', { for: 'stash-composer-input', className: 'sr-only' }, 'Park a prompt or idea'),
      ui.el(
        'div',
        { className: 'notes-composer-main' },
        composerInput,
        ui.el('button', { type: 'submit', id: 'stash-composer-submit', className: 'agy-btn agy-btn-xs agy-btn-primary notes-composer-inline-submit' }, 'Stash')
      ),
      ui.el(
        'div',
        { className: 'notes-composer-footer' },
        ui.el('div', { className: 'notes-composer-footer-left' }, composerTargetBtn, composerColorBtn, composerHint),
        ui.el('button', { type: 'submit', id: 'stash-composer-footer-submit', className: 'agy-btn agy-btn-xs agy-btn-primary' }, 'Stash')
      )
    );

    const splitFilterBtn = ui.el('button', {
      type: 'button',
      id: 'split-filter-btn',
      className: 'agy-icon-btn',
      title: 'Toggle search & filters',
      'aria-label': 'Toggle search and filters',
      'aria-pressed': 'false',
      innerHTML: ui.iconSvg('search', 15),
    });
    const splitSentBtn = ui.el('button', {
      type: 'button',
      id: 'split-sent-btn',
      className: 'agy-btn agy-btn-xs agy-btn-outline',
      title: 'Toggle Sent archive',
      'aria-pressed': 'false',
    }, 'Sent (0)');

    const scopeToggle = ui.el('agy-toggle-group', {
      id: 'stash-scope-toggle',
      className: 'agy-toggle-group notes-stash-scope-toggle',
      'aria-label': 'Filter cards by scope',
    });
    const searchInput = ui.el('input', {
      type: 'search',
      id: 'search-input',
      className: 'agy-search-input',
      placeholder: 'Filter cards…',
      'aria-label': 'Filter cards',
    });
    const statusToggle = ui.el('agy-toggle-group', { id: 'status-toggle', className: 'agy-toggle-group notes-status-toggle', 'aria-label': 'Card status' });
    const layoutToggle = ui.el('agy-toggle-group', { id: 'stash-layout-toggle', className: 'agy-toggle-group notes-layout-toggle', 'aria-label': 'Stash layout' });
    const tagStrip = ui.el('div', { id: 'tag-strip', className: 'notes-tag-strip hidden' });
    const filterBar = ui.el(
      'div',
      { id: 'filter-bar', className: 'notes-filter-bar' },
      ui.el(
        'div',
        { className: 'notes-filter-row' },
        scopeToggle,
        ui.el(
          'div',
          { className: 'agy-search-box notes-search-box' },
          ui.el('span', { id: 'search-icon-slot', className: 'agy-search-icon', innerHTML: ui.iconSvg('search', 14) }),
          searchInput
        ),
        tagStrip,
        statusToggle,
        layoutToggle
      )
    );

    const cardList = ui.el('div', { id: 'card-list', className: 'notes-card-list' });
    const batchCount = ui.el('span', { id: 'batch-count', className: 'agy-count-pill' }, '0 selected');
    const batchClearBtn = ui.el('button', { type: 'button', id: 'batch-clear-btn', className: 'agy-btn agy-btn-xs agy-btn-ghost' }, 'Clear');
    const batchCopyBtn = ui.el('button', { type: 'button', id: 'batch-copy-btn', className: 'agy-btn agy-btn-xs agy-btn-outline' }, 'Copy');
    const batchCombineBtn = ui.el('button', { type: 'button', id: 'batch-combine-btn', className: 'agy-btn agy-btn-xs agy-btn-primary' }, 'Combine ↵');
    const batchBar = ui.el(
      'div',
      { id: 'batch-bar', className: 'agy-banner accent notes-batch-bar hidden' },
      batchCount,
      ui.el('div', { className: 'agy-consent-actions' }, batchClearBtn, batchCopyBtn, batchCombineBtn)
    );

    rootEl.appendChild(
      ui.el(
        'div',
        { className: 'notes-top-deck' },
        ui.el(
          'div',
          { className: 'notes-top-deck-inner' },
          ui.el('div', { className: 'notes-composer-row' }, composerForm, ui.el('div', { className: 'notes-split-tools' }, splitFilterBtn, splitSentBtn)),
          filterBar
        )
      )
    );
    rootEl.appendChild(cardList);
    rootEl.appendChild(batchBar);

    els = {
      composerForm,
      composerInput,
      composerTargetBtn,
      composerColorBtn,
      composerHint,
      splitFilterBtn,
      splitSentBtn,
      filterBar,
      scopeToggle,
      searchInput,
      statusToggle,
      layoutToggle,
      tagStrip,
      cardList,
      batchBar,
      batchCount,
    };

    composerForm.addEventListener('mousedown', (ev) => {
      const target = ev.target?.nodeType === 1 ? ev.target : ev.target?.parentElement;
      if (target === composerInput) {
        return;
      }
      ev.preventDefault?.();
      if (doc.activeElement !== composerInput) {
        composerInput.focus?.();
        composerForm.classList.add('is-expanded');
        renderComposerState();
      }
    });

    composerTargetBtn.addEventListener('click', () => {
      if (!Notes.state.workspacePath) {
        Notes.state.composerTarget = 'global';
        return;
      }
      Notes.state.composerTarget = Notes.state.composerTarget === 'global' ? 'workspace' : 'global';
      Notes.state.userPickedComposerTarget = true;
      syncComposerExpanded();
    });

    composerColorBtn.addEventListener('click', (ev) => {
      Notes.openSwatchPicker(ev.currentTarget, {
        title: 'New card color',
        currentValue: Notes.state.composerColor,
        allowAuto: true,
        onSelect: (nextColor) => {
          Notes.state.composerColor = nextColor;
          syncComposerExpanded();
        },
      });
    });

    composerInput.addEventListener('compositionend', (ev) => {
      lastComposerCompEnd = ev.timeStamp;
    });
    composerForm.addEventListener('focusin', syncComposerExpanded);
    composerForm.addEventListener('focusout', () => {
      setTimer(() => {
        if (!Notes.isSwatchMenuOpen?.()) {
          syncComposerExpanded();
        }
      }, 80);
    });
    composerInput.addEventListener('focus', syncComposerExpanded);
    composerInput.addEventListener('blur', () => {
      setTimer(() => {
        if (!Notes.isSwatchMenuOpen?.()) {
          syncComposerExpanded();
        }
      }, 80);
    });
    composerInput.addEventListener('input', () => {
      autoResizeFallback(composerInput, 112);
      syncComposerExpanded();
    });
    composerInput.addEventListener('keydown', (ev) => {
      const mode = Notes.state.settings.enterBehavior || 'stash';
      if (ev.key === 'Enter' && mode === 'stash' && !ev.shiftKey && !ev.ctrlKey && !ev.metaKey) {
        ev.preventDefault?.();
        if (isImeBlockedEnter(ev, lastComposerCompEnd)) {
          return;
        }
        submitFormSafe(composerForm);
        return;
      }
      if (ev.key === 'Enter' && mode === 'newline' && (ev.ctrlKey || ev.metaKey)) {
        ev.preventDefault?.();
        submitFormSafe(composerForm);
        return;
      }
      const nlChord = mode === 'stash' ? 'shift' : 'plain';
      applyStashSmartKeys(ev, composerInput, lastComposerCompEnd, nlChord, () => {
        autoResizeFallback(composerInput, 112);
        syncComposerExpanded();
      });
    });

    composerForm.addEventListener('submit', async (ev) => {
      ev.preventDefault?.();
      const text = composerInput.value.trim();
      if (!text) {
        return;
      }
      const hasProject = Boolean(Notes.state.workspacePath);
      const chosenColor = Notes.state.composerColor || 'auto';
      const chosenTarget = Notes.state.composerTarget || 'workspace';
      const wasUserPickedTarget = Notes.state.userPickedComposerTarget;
      const isUnscoped = !hasProject || chosenTarget === 'global';
      const targetScope = isUnscoped ? 'global' : 'workspace';
      const prevFilter = Notes.state.stashFilter;
      if (isUnscoped && prevFilter !== 'all') {
        Notes.state.stashFilter = 'all';
      } else if (!isUnscoped && prevFilter === 'chat' && !Notes.isRealConversationId(Notes.state.conversationId)) {
        Notes.state.stashFilter = 'workspace';
      }
      const switchedFilter = Notes.state.stashFilter !== prevFilter;
      composerInput.value = '';
      autoResizeFallback(composerInput, 112);
      Notes.state.composerColor = 'auto';
      Notes.state.composerTarget = hasProject ? 'workspace' : 'global';
      Notes.state.userPickedComposerTarget = false;
      Notes.state.statusView = 'active';
      syncComposerExpanded();
      if (switchedFilter) {
        Notes.renderAll?.();
      }
      try {
        await Notes.mutate('stash-add', {
          text,
          color: chosenColor,
          scope: targetScope,
          workspacePath: isUnscoped ? '' : Notes.state.workspacePath,
          workspaceName: isUnscoped ? '' : Notes.state.projectName || Notes.state.workspaceName,
          originConversationId: isUnscoped ? '' : Notes.state.conversationId,
          originConversationTitle: isUnscoped ? '' : Notes.state.conversationTitle,
        });
      } catch (err) {
        if (switchedFilter) {
          Notes.state.stashFilter = prevFilter;
        }
        composerInput.value = text;
        Notes.state.composerColor = chosenColor;
        Notes.state.composerTarget = chosenTarget;
        Notes.state.userPickedComposerTarget = wasUserPickedTarget;
        syncComposerExpanded();
        if (switchedFilter) {
          Notes.renderAll?.();
        }
        ui.showToast(err?.message || 'Failed to stash prompt', { error: true });
      }
    });

    splitFilterBtn.addEventListener('click', () => {
      Notes.state.splitFilterOpen = !Notes.state.splitFilterOpen;
      renderStashTab();
    });
    splitSentBtn.addEventListener('click', () => {
      Notes.state.statusView = Notes.state.statusView === 'sent' ? 'active' : 'sent';
      Notes.state.selectedIds.clear();
      Notes.renderAll?.();
    });
    searchInput.addEventListener('input', (ev) => {
      Notes.state.query = ev.target.value || '';
      renderStashTab();
    });

    batchClearBtn.addEventListener('click', () => {
      Notes.state.selectedIds.clear();
      renderStashTab();
    });
    batchCopyBtn.addEventListener('click', async () => {
      const selected = Notes.filterVisibleCards('active').filter((c) => Notes.state.selectedIds.has(c.id));
      if (!selected.length) {
        return;
      }
      const combined = selected.map((c, idx) => `${idx + 1}. ${c.text}`).join('\n\n');
      await Notes.copyText(combined);
      ui.showToast('Copied combined prompt to clipboard', { durationMs: 2200 });
    });
    batchCombineBtn.addEventListener('click', () => {
      const selected = Notes.filterVisibleCards('active').filter((c) => Notes.state.selectedIds.has(c.id));
      Notes.openCombineModal?.(selected);
    });

    renderStashTab();
  }

  Notes.mountStashTab = mountStashTab;
  Notes.renderStashTab = renderStashTab;
})(typeof window !== 'undefined' ? window : globalThis);
