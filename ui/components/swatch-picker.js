/**
 * @fileoverview Accessible 6-swatch Onyx color picker with Auto (#tag) and None options.
 */
(function (win) {
  const doc = win.document;
  const ui = win.AgyUI;
  const Notes = (win.Notes = win.Notes || {});

  let activeSwatchMenu = null;
  let cleanupListeners = null;

  function closeSwatchMenu() {
    if (activeSwatchMenu) {
      activeSwatchMenu.remove?.();
      activeSwatchMenu = null;
    }
    if (cleanupListeners) {
      cleanupListeners();
      cleanupListeners = null;
    }
  }

  function openSwatchPicker(anchorOrEv, { title = 'Choose color', currentValue = 'auto', allowAuto = false, onSelect } = {}) {
    closeSwatchMenu();
    ui.closeContextMenu?.(false);

    const menu = ui.el('div', {
      className: 'notes-swatch-menu',
      role: 'dialog',
      'aria-label': title,
    });
    menu.appendChild(ui.el('div', { className: 'notes-swatch-menu-hdr' }, title));

    const grid = ui.el('div', { className: 'notes-swatch-grid' });
    for (const sw of Notes.PALETTE || []) {
      const isAct = currentValue === sw.id;
      const dot = ui.el(
        'span',
        { className: `notes-swatch-dot notes-hue-${sw.id}`, 'aria-hidden': 'true' },
        isAct ? '✓' : ''
      );
      const cell = ui.el(
        'button',
        {
          type: 'button',
          className: `notes-swatch-cell notes-hue-${sw.id}${isAct ? ' active' : ''}`,
          dataset: { swatchId: sw.id },
          title: sw.label,
          'aria-label': sw.label,
          'aria-pressed': String(isAct),
          onClick: () => {
            closeSwatchMenu();
            onSelect?.(sw.id);
          },
        },
        dot
      );
      grid.appendChild(cell);
    }
    menu.appendChild(grid);

    const footer = ui.el('div', { className: 'notes-swatch-footer' });
    if (allowAuto) {
      const isAuto = currentValue === 'auto';
      footer.appendChild(
        ui.el(
          'button',
          {
            type: 'button',
            className: `agy-btn agy-btn-xs ${isAuto ? 'agy-btn-primary' : 'agy-btn-outline'}`,
            dataset: { swatchId: 'auto' },
            'aria-pressed': String(isAuto),
            onClick: () => {
              closeSwatchMenu();
              onSelect?.('auto');
            },
          },
          'Auto (#tag)'
        )
      );
    }

    const isNone = currentValue === 'none';
    footer.appendChild(
      ui.el(
        'button',
        {
          type: 'button',
          className: `agy-btn agy-btn-xs ${isNone ? 'agy-btn-primary' : 'agy-btn-outline'}`,
          dataset: { swatchId: 'none' },
          'aria-pressed': String(isNone),
          onClick: () => {
            closeSwatchMenu();
            onSelect?.('none');
          },
        },
        'None'
      )
    );
    menu.appendChild(footer);
    doc.body?.appendChild?.(menu);

    let x = anchorOrEv?.clientX;
    let y = anchorOrEv?.clientY;
    if ((x === undefined || y === undefined) && typeof anchorOrEv?.getBoundingClientRect === 'function') {
      const rect = anchorOrEv.getBoundingClientRect();
      x = rect.left;
      y = rect.bottom + 4;
    }
    const vw = typeof win.innerWidth === 'number' && win.innerWidth > 0 ? win.innerWidth : 320;
    const vh = typeof win.innerHeight === 'number' && win.innerHeight > 0 ? win.innerHeight : 680;
    const clampedX = Math.max(6, Math.min(Number(x) || 12, Math.max(6, vw - 204)));
    const clampedY = Math.max(6, Math.min(Number(y) || 48, Math.max(6, vh - 120)));
    menu.style.left = `${clampedX}px`;
    menu.style.top = `${clampedY}px`;
    activeSwatchMenu = menu;

    const onPointerDown = (ev) => {
      if (ev === anchorOrEv) {
        return;
      }
      if (activeSwatchMenu && !activeSwatchMenu.contains?.(ev.target)) {
        closeSwatchMenu();
      }
    };
    const onKeyDown = (ev) => {
      if (ev.key === 'Escape' && activeSwatchMenu) {
        ev.preventDefault?.();
        ev.stopPropagation?.();
        closeSwatchMenu();
      }
    };
    doc.addEventListener?.('pointerdown', onPointerDown, true);
    doc.addEventListener?.('keydown', onKeyDown, true);
    cleanupListeners = () => {
      doc.removeEventListener?.('pointerdown', onPointerDown, true);
      doc.removeEventListener?.('keydown', onKeyDown, true);
    };
    return menu;
  }

  Notes.openSwatchPicker = openSwatchPicker;
  Notes.closeSwatchMenu = closeSwatchMenu;
  Notes.isSwatchMenuOpen = () => Boolean(activeSwatchMenu);
})(typeof window !== 'undefined' ? window : globalThis);
