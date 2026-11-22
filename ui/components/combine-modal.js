/**
 * @fileoverview Light-dismiss Combine & Preview modal (<dialog closedby="any"> + backdrop coordinate fallback).
 */
(function (win) {
  const doc = win.document;
  const ui = win.AgyUI;
  const Notes = (win.Notes = win.Notes || {});

  let dialogEl = null;
  let textareaEl = null;
  let pendingCards = [];
  let initialized = false;

  function showModalSafe(dialog) {
    if (typeof dialog?.showModal === 'function') {
      if (!dialog.open) {
        dialog.showModal();
      }
      return;
    }
    dialog?.setAttribute?.('open', '');
  }

  function closeModalSafe(dialog) {
    if (typeof dialog?.close === 'function') {
      if (dialog.open) {
        dialog.close();
      }
      return;
    }
    dialog?.removeAttribute?.('open');
  }

  function isModalOpen(dialog) {
    return Boolean(dialog && (dialog.open === true || dialog.hasAttribute?.('open')));
  }

  function ensureDialog() {
    if (initialized && dialogEl) {
      return dialogEl;
    }
    dialogEl = doc.getElementById('combine-dialog');
    if (!dialogEl) {
      dialogEl = ui.el(
        'dialog',
        { id: 'combine-dialog', className: 'notes-dialog', closedby: 'any', 'aria-labelledby': 'combine-dialog-title' },
        ui.el(
          'div',
          { className: 'agy-card-header notes-dialog-header' },
          ui.el('span', { id: 'combine-dialog-title', className: 'agy-card-title' }, 'Combine & Preview'),
          ui.el('button', { type: 'button', id: 'combine-close-btn', className: 'agy-icon-btn', 'aria-label': 'Close dialog' })
        ),
        ui.el('label', { for: 'combine-textarea', className: 'agy-field-help' }, 'Edit or add framing context before sending:'),
        ui.el('textarea', { id: 'combine-textarea', className: 'agy-input notes-dialog-textarea' }),
        ui.el(
          'div',
          { className: 'agy-card-actions notes-dialog-actions' },
          ui.el('button', { type: 'button', id: 'combine-cancel-btn', className: 'agy-btn agy-btn-xs agy-btn-ghost' }, 'Cancel'),
          ui.el('button', { type: 'button', id: 'combine-copy-btn', className: 'agy-btn agy-btn-xs agy-btn-outline' }, 'Copy'),
          ui.el('button', { type: 'button', id: 'combine-new-btn', className: 'agy-btn agy-btn-xs agy-btn-secondary' }, 'New Chat'),
          ui.el('button', { type: 'button', id: 'combine-send-btn', className: 'agy-btn agy-btn-xs agy-btn-primary' }, 'Send to Chat ↵')
        )
      );
      doc.body?.appendChild?.(dialogEl);
    }

    textareaEl = doc.getElementById('combine-textarea');
    const closeBtn = doc.getElementById('combine-close-btn');
    const cancelBtn = doc.getElementById('combine-cancel-btn');
    const copyBtn = doc.getElementById('combine-copy-btn');
    const newBtn = doc.getElementById('combine-new-btn');
    const sendBtn = doc.getElementById('combine-send-btn');

    if (closeBtn) {
      closeBtn.innerHTML = ui.iconSvg('close', 15);
      closeBtn.addEventListener('click', () => closeModalSafe(dialogEl));
    }
    cancelBtn?.addEventListener('click', () => closeModalSafe(dialogEl));

    const hasNativeClosedBy = Boolean(win.HTMLDialogElement?.prototype && 'closedBy' in win.HTMLDialogElement.prototype);
    if (!hasNativeClosedBy) {
      dialogEl.addEventListener('click', (event) => {
        if (event.target !== dialogEl) {
          return;
        }
        const rect = dialogEl.getBoundingClientRect?.() || { top: 0, left: 0, width: 0, height: 0 };
        const isInside = rect.width > 0
          && rect.height > 0
          && rect.top <= event.clientY
          && event.clientY <= rect.top + rect.height
          && rect.left <= event.clientX
          && event.clientX <= rect.left + rect.width;
        if (!isInside) {
          closeModalSafe(dialogEl);
        }
      });
    }

    const submitCombined = async (mode) => {
      const text = (textareaEl?.value || '').trim();
      if (!text) {
        return;
      }
      const cardsSnapshot = [...pendingCards];
      closeModalSafe(dialogEl);
      try {
        await Notes.dispatchCards(cardsSnapshot, mode, text);
      } catch (err) {
        ui.showToast(err?.message || 'Failed to dispatch combined prompt', { error: true });
      }
    };

    sendBtn?.addEventListener('click', () => submitCombined('active'));
    newBtn?.addEventListener('click', () => submitCombined('new'));
    copyBtn?.addEventListener('click', async () => {
      const text = textareaEl?.value || '';
      closeModalSafe(dialogEl);
      await Notes.copyText(text);
      ui.showToast('Copied combined prompt to clipboard', { durationMs: 2200 });
    });

    textareaEl?.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) {
        ev.preventDefault?.();
        submitCombined('active');
        return;
      }
      if (ev.key === 'Escape' && !hasNativeClosedBy) {
        ev.preventDefault?.();
        closeModalSafe(dialogEl);
        return;
      }
      const md = win.NotesMarkdown;
      if (!md || ev.isComposing || ev.keyCode === 229) {
        return;
      }
      if (ev.key === 'Tab' && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
        if (md.isListLineAtSelection?.(textareaEl.value, textareaEl.selectionStart, textareaEl.selectionEnd)) {
          const indented = md.applyEditorTabIndent?.(textareaEl.value, textareaEl.selectionStart, textareaEl.selectionEnd, Boolean(ev.shiftKey));
          if (indented) {
            ev.preventDefault?.();
            textareaEl.value = indented.value;
            textareaEl.selectionStart = indented.start;
            textareaEl.selectionEnd = indented.end;
            textareaEl.setSelectionRange?.(indented.start, indented.end);
          }
        }
        return;
      }
      if (ev.key === 'Enter' && !ev.shiftKey && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
        const next = md.applyEditorListEnter?.(textareaEl.value, textareaEl.selectionStart, textareaEl.selectionEnd);
        if (next) {
          ev.preventDefault?.();
          textareaEl.value = next.value;
          textareaEl.selectionStart = next.cursor;
          textareaEl.selectionEnd = next.cursor;
          textareaEl.setSelectionRange?.(next.cursor, next.cursor);
        }
      }
    });

    initialized = true;
    return dialogEl;
  }

  function openCombineModal(selectedCards = []) {
    const cards = Array.isArray(selectedCards) && selectedCards.length > 0
      ? selectedCards
      : Notes.filterVisibleCards('active').filter((c) => Notes.state.selectedIds.has(c.id));
    if (cards.length === 0) {
      return null;
    }
    const dialog = ensureDialog();
    pendingCards = [...cards];
    const combinedText = `Address the following items:\n\n${cards.map((c, idx) => `${idx + 1}. ${c.text}`).join('\n\n')}`;
    if (textareaEl) {
      textareaEl.value = combinedText;
    }
    if (!isModalOpen(dialog)) {
      showModalSafe(dialog);
    }
    textareaEl?.focus?.();
    return dialog;
  }

  Notes.mountCombineModal = ensureDialog;
  Notes.openCombineModal = openCombineModal;
  Notes.closeCombineModal = () => closeModalSafe(dialogEl);
})(typeof window !== 'undefined' ? window : globalThis);
