/**
 * @fileoverview Notes shell coordinator: Chrome Bar, Workbench split sash, Settings popover, SSE stream, and Hangar/host sync.
 */
(function (win) {
  const doc = win.document;
  const ui = win.AgyUI;
  const Notes = (win.Notes = win.Notes || {});
  const URLSearchParamsCtor = win.URLSearchParams || URLSearchParams;

  let sseSub = null;
  let fallbackEs = null;
  let unsubWorkspace = null;
  const cleanups = [];

  function clampSplitRatio(val) {
    const num = Number(val);
    return Number.isFinite(num) ? Math.min(0.72, Math.max(0.26, num)) : 0.44;
  }

  function connectSse() {
    disconnectSse();
    if (!Notes.state.hostVisible) {
      return;
    }
    if (typeof win.AgyShell?.subscribeStateSyncEvents === 'function') {
      sseSub = win.AgyShell.subscribeStateSyncEvents({
        url: '/api/events',
        immediate: true,
        pauseWhenHidden: true,
        getConversationId: () => Notes.state.rawConversationId,
        onStateEvent: (st, ver) => Notes.applyServerState(st, ver),
      });
      return;
    }
    const ESCtor = win.EventSource;
    if (typeof ESCtor !== 'function') {
      return;
    }
    try {
      const params = new URLSearchParamsCtor(win.location?.search || '');
      const token = params.get('token') || win.__AGY_TOKEN__ || '';
      const qp = new URLSearchParamsCtor();
      if (token) {
        qp.set('token', token);
      }
      if (Notes.state.conversationId) {
        qp.set('conversationId', Notes.state.conversationId);
      }
      qp.set('clientId', `notes-${Date.now().toString(36)}`);
      const es = new ESCtor(`/api/events?${qp.toString()}`);
      const onSseEvent = (ev) => {
        try {
          const parsed = JSON.parse(ev.data);
          Notes.applyServerState(parsed?.state ?? parsed, parsed?.version);
        } catch {}
      };
      es.onmessage = onSseEvent;
      es.addEventListener?.('state', onSseEvent);
      es.addEventListener?.('state_changed', onSseEvent);
      fallbackEs = es;
    } catch {}
  }

  function disconnectSse() {
    if (sseSub) {
      sseSub.close?.();
      sseSub = null;
    }
    if (fallbackEs) {
      try {
        fallbackEs.close?.();
      } catch {}
      fallbackEs = null;
    }
  }

  function switchSurface(nextSurface) {
    if (!nextSurface || nextSurface === Notes.state.surface) {
      return;
    }
    Notes.flushPendingScratchpadSave?.();
    Notes.state.surface = nextSurface;
    Notes.renderAll();
  }

  function renderChromeAndSettings() {
    const { state } = Notes;
    const appEl = doc.getElementById('notes-app');
    if (!appEl) {
      return;
    }

    const colorStyle = state.settings.cardColorStyle || 'wash';
    const wbMode = state.settings.workbenchMode || 'split';
    const splitRatio = clampSplitRatio(state.settings.workbenchSplitRatio);

    appEl.dataset.colorStyle = colorStyle;
    appEl.dataset.workbench = wbMode;
    appEl.style.setProperty('--notes-split-ratio', splitRatio.toFixed(3));

    const activeCount = Notes.filterVisibleCards('active').length;
    const countEl = doc.getElementById('stash-tab-count');
    if (countEl) {
      countEl.textContent = String(activeCount);
    }

    for (const tabBtn of doc.querySelectorAll('#main-tabs .agy-tab')) {
      const isAct = tabBtn.dataset.surface === state.surface;
      tabBtn.classList.toggle('active', isAct);
      tabBtn.setAttribute('aria-selected', String(isAct));
    }

    doc.getElementById('surface-stash')?.classList.toggle('hidden', state.surface !== 'stash');
    doc.getElementById('surface-scratchpad')?.classList.toggle('hidden', state.surface !== 'scratchpad');

    ui.createToggleGroup(
      doc.getElementById('workbench-toggle'),
      [
        { id: 'split', label: 'Workbench', count: activeCount, title: 'Side-by-side Stash + Scratchpad' },
        { id: 'stash', label: 'Focus Stash', title: 'Full-width Prompt Stash board' },
        { id: 'scratchpad', label: 'Focus Pad', title: 'Full-width Scratchpad' },
      ],
      {
        activeId: wbMode,
        onChange: async (id) => {
          Notes.flushPendingScratchpadSave?.();
          state.settings.workbenchMode = id;
          if (id === 'stash' || id === 'scratchpad') {
            state.surface = id;
          }
          Notes.renderAll();
          try {
            await Notes.mutate('settings-update', { workbenchMode: id });
          } catch (err) {
            ui.showToast(err?.message || 'Failed to update workbench mode', { error: true });
          }
        },
      }
    );

    ui.createToggleGroup(
      doc.getElementById('color-style-toggle'),
      [
        { id: 'wash', label: 'Wash' },
        { id: 'stripe', label: 'Stripe' },
        { id: 'bold', label: 'Sticky' },
      ],
      {
        activeId: colorStyle,
        onChange: async (id) => {
          state.settings.cardColorStyle = id;
          appEl.dataset.colorStyle = id;
          try {
            await Notes.mutate('settings-update', { cardColorStyle: id });
          } catch (err) {
            ui.showToast(err?.message || 'Failed to update color style', { error: true });
          }
        },
      }
    );

    ui.createToggleGroup(
      doc.getElementById('enter-mode-toggle'),
      [
        { id: 'stash', label: 'Enter' },
        { id: 'newline', label: 'Ctrl+↵' },
      ],
      {
        activeId: state.settings.enterBehavior || 'stash',
        onChange: async (id) => {
          state.settings.enterBehavior = id;
          Notes.renderStashTab?.();
          try {
            await Notes.mutate('settings-update', { enterBehavior: id });
          } catch (err) {
            ui.showToast(err?.message || 'Failed to update submit chord', { error: true });
          }
        },
      }
    );

    const mcpRead = Boolean(state.settings.mcpRead);
    const mcpWrite = Boolean(state.settings.mcpWrite);
    ui.syncSwitchState(doc.getElementById('mcp-read-switch'), mcpRead);
    ui.syncSwitchState(doc.getElementById('mcp-write-switch'), mcpWrite);

    const tokBadge = doc.getElementById('mcp-token-badge');
    if (tokBadge) {
      const estTok = (mcpRead ? 380 : 0) + (mcpWrite ? 460 : 0);
      tokBadge.textContent = estTok === 0 ? '0 tok' : `~${estTok} tok`;
      tokBadge.className = `agy-badge ${estTok === 0 ? 'off' : 'ok'}`;
    }
  }

  function installPopoverFallback(settingsBtn, settingsPopover) {
    if (!settingsBtn || !settingsPopover) {
      return;
    }
    const proto = win.HTMLElement?.prototype;
    if (proto && Object.hasOwn(proto, 'popover') && typeof settingsPopover.showPopover === 'function') {
      return;
    }
    settingsPopover.showPopover = () => settingsPopover.classList.add(':popover-open');
    settingsPopover.hidePopover = () => settingsPopover.classList.remove(':popover-open');
    settingsPopover.togglePopover = (force) => {
      if (force === undefined) {
        return settingsPopover.classList.toggle(':popover-open');
      }
      return settingsPopover.classList.toggle(':popover-open', Boolean(force));
    };
    const onBtnClick = () => settingsPopover.togglePopover();
    const onOutsideDown = (ev) => {
      if (!settingsPopover.classList.contains(':popover-open')) {
        return;
      }
      if (!settingsPopover.contains?.(ev.target) && !settingsBtn.contains?.(ev.target)) {
        settingsPopover.hidePopover();
      }
    };
    const onEsc = (ev) => {
      if (ev.key === 'Escape' && settingsPopover.classList.contains(':popover-open')) {
        ev.preventDefault?.();
        settingsPopover.hidePopover();
        settingsBtn.focus?.();
      }
    };
    settingsBtn.addEventListener('click', onBtnClick);
    doc.addEventListener?.('pointerdown', onOutsideDown);
    doc.addEventListener?.('keydown', onEsc);
    cleanups.push(() => {
      settingsBtn.removeEventListener('click', onBtnClick);
      doc.removeEventListener?.('pointerdown', onOutsideDown);
      doc.removeEventListener?.('keydown', onEsc);
    });
  }

  Notes.renderAll = function renderAll() {
    renderChromeAndSettings();
    Notes.renderStashTab?.();
    Notes.renderScratchpadTab?.();
  };

  async function boot() {
    doc.getElementById('icon-stash').innerHTML = ui.iconSvg('note_stack', 15);
    doc.getElementById('icon-pad').innerHTML = ui.iconSvg('edit_note', 15);
    const settingsBtn = doc.getElementById('settings-btn');
    const settingsPopover = doc.getElementById('settings-popover');
    const exportStashBtn = doc.getElementById('export-stash-btn');
    if (settingsBtn) {
      settingsBtn.innerHTML = ui.iconSvg('settings', 16);
    }
    if (exportStashBtn) {
      exportStashBtn.innerHTML = `${ui.iconSvg('download', 14)}<span>Export Stash (.md)</span>`;
    }

    installPopoverFallback(settingsBtn, settingsPopover);
    Notes.mountCombineModal?.();
    Notes.mountStashTab?.(doc.getElementById('surface-stash'));
    Notes.mountScratchpadTab?.(doc.getElementById('surface-scratchpad'));

    doc.getElementById('main-tabs')?.addEventListener('click', (ev) => {
      const target = ev.target?.nodeType === 1 ? ev.target : ev.target?.parentElement;
      const tab = target?.closest?.('[data-surface]');
      if (tab?.dataset?.surface) {
        switchSurface(tab.dataset.surface);
      }
    });

    const workbenchSash = doc.getElementById('workbench-sash');
    let pendingRatio = null;
    workbenchSash?.addEventListener('split-resize', (ev) => {
      const ratio = clampSplitRatio(ev.detail?.ratio);
      pendingRatio = ratio;
      Notes.state.settings.workbenchSplitRatio = ratio;
      doc.getElementById('notes-app')?.style.setProperty('--notes-split-ratio', ratio.toFixed(3));
    });
    workbenchSash?.addEventListener('split-resize-end', async () => {
      if (pendingRatio === null) {
        return;
      }
      const ratioToSave = Number(pendingRatio.toFixed(3));
      pendingRatio = null;
      try {
        await Notes.mutate('settings-update', { workbenchSplitRatio: ratioToSave });
      } catch (err) {
        ui.showToast(err?.message || 'Failed to save split ratio', { error: true });
      }
    });

    doc.getElementById('mcp-read-switch')?.addEventListener('change', async (ev) => {
      const checked = Boolean(ev.detail?.checked);
      Notes.state.settings.mcpRead = checked;
      renderChromeAndSettings();
      try {
        await Notes.mutate('settings-update', { mcpRead: checked });
      } catch (err) {
        ui.showToast(err?.message || 'Failed to update Agent Read', { error: true });
      }
    });
    doc.getElementById('mcp-write-switch')?.addEventListener('change', async (ev) => {
      const checked = Boolean(ev.detail?.checked);
      Notes.state.settings.mcpWrite = checked;
      renderChromeAndSettings();
      try {
        await Notes.mutate('settings-update', { mcpWrite: checked });
      } catch (err) {
        ui.showToast(err?.message || 'Failed to update Agent Write', { error: true });
      }
    });

    exportStashBtn?.addEventListener('click', () => {
      settingsPopover?.hidePopover?.();
      const menuAnchor = settingsBtn || exportStashBtn;
      Notes.openExportMenu?.(menuAnchor, () => {
        const cards = Notes.filterVisibleCards('all');
        const scopeLabel = Notes.state.stashFilter === 'all'
          ? 'All Notes'
          : Notes.state.stashFilter === 'chat'
            ? Notes.state.conversationTitle || 'This Chat'
            : Notes.state.projectName || Notes.state.workspaceName || 'Project';
        const content = Notes.exportStashMarkdown(cards, scopeLabel);
        return { filename: 'notes-stash.md', content };
      });
    });

    if (typeof win.sidecar?.onWorkspaceChange === 'function') {
      unsubWorkspace = win.sidecar.onWorkspaceChange((uris) => {
        Notes.flushPendingScratchpadSave?.();
        Notes.refreshContext({ workspaceUris: Array.isArray(uris) ? uris : [] }).catch(() => {});
      });
    }

    const onHostMessage = (ev) => {
      if (ev?.source && win.parent && ev.source !== win.parent && ev.source !== win) {
        return;
      }
      const d = ev?.data;
      if (!d || typeof d !== 'object') {
        return;
      }
      if (d.type === 'conversation-change') {
        Notes.flushPendingScratchpadSave?.();
        const nextConv = String(d.payload?.conversationId ?? d.conversationId ?? '').trim();
        Notes.state.rawConversationId = nextConv;
        Notes.state.isNewConversation = nextConv === '_new';
        Notes.state.conversationId = Notes.isRealConversationId(nextConv) ? nextConv : '';
        Notes.renderAll();
        Notes.refreshContext({ conversationId: nextConv }).catch(() => {});
      } else if (d.type === 'workspace-change' && typeof win.sidecar?.onWorkspaceChange !== 'function') {
        Notes.flushPendingScratchpadSave?.();
        const pl = d.payload || {};
        const uris = Array.isArray(pl.workspaceUris) ? pl.workspaceUris : Array.isArray(pl.uris) ? pl.uris : [];
        Notes.refreshContext({ workspaceUris: uris }).catch(() => {});
      } else if (d.type === 'sidecar-visibility') {
        const vis = typeof d.payload?.visible === 'boolean'
          ? d.payload.visible
          : typeof d.visible === 'boolean'
            ? d.visible
            : null;
        if (vis !== null && vis !== Notes.state.hostVisible) {
          if (!vis) {
            Notes.flushPendingScratchpadSave?.();
            Notes.state.hostVisible = false;
            disconnectSse();
          } else {
            Notes.state.hostVisible = true;
            connectSse();
            Notes.refreshContext().catch(() => {});
          }
        }
      } else if (d.type === 'theme-change' && d.payload && !win.AgyShell) {
        const mode = d.payload.mode || (d.payload.isDark === false ? 'light' : 'dark');
        doc.documentElement.dataset.theme = mode;
        for (const [k, v] of Object.entries(d.payload.cssVariables || {})) {
          doc.documentElement.style?.setProperty?.(k, v);
        }
      }
    };
    const onDocVisibility = () => {
      if (doc.hidden) {
        Notes.flushPendingScratchpadSave?.();
      }
    };
    const onPageHide = () => {
      Notes.flushPendingScratchpadSave?.();
      disconnectSse();
    };

    win.addEventListener?.('message', onHostMessage);
    doc.addEventListener?.('visibilitychange', onDocVisibility);
    win.addEventListener?.('pagehide', onPageHide);
    cleanups.push(() => {
      win.removeEventListener?.('message', onHostMessage);
      doc.removeEventListener?.('visibilitychange', onDocVisibility);
      win.removeEventListener?.('pagehide', onPageHide);
    });

    Notes.renderAll();

    let initUris = [];
    if (typeof win.sidecar?.getWorkspaceUris === 'function') {
      try {
        const fetched = await win.sidecar.getWorkspaceUris();
        if (Array.isArray(fetched)) {
          initUris = fetched;
        }
      } catch {}
    }
    try {
      await Notes.refreshContext({ workspaceUris: initUris });
    } catch {}
    connectSse();
  }

  Notes.connectSse = connectSse;
  Notes.disconnectSse = disconnectSse;
  Notes.destroy = () => {
    Notes.flushPendingScratchpadSave?.();
    disconnectSse();
    Notes.unmountScratchpadTab?.();
    Notes.closeSwatchMenu?.();
    Notes.closeCombineModal?.();
    ui.closeContextMenu?.(false);
    doc.querySelector?.('.agy-toast')?.remove?.();
    unsubWorkspace?.();
    unsubWorkspace = null;
    while (cleanups.length > 0) {
      const fn = cleanups.pop();
      fn?.();
    }
  };

  Notes.bootPromise = boot();
})(typeof window !== 'undefined' ? window : globalThis);
