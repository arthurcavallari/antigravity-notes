import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseHTML } from 'linkedom';
import { attachAgyUI } from 'antigravity-sidecar-kit/ui';
import { createNotesServer } from '../server.mjs';
import * as NotesMarkdown from '../ui/markdown.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const UI_DIR = join(REPO_ROOT, 'ui');
const realFetch = globalThis.fetch.bind(globalThis);
const realSetTimeout = globalThis.setTimeout.bind(globalThis);
const realClearTimeout = globalThis.clearTimeout.bind(globalThis);
const ALL_UI_SCRIPTS = [
  'core.js',
  'components/swatch-picker.js',
  'components/stash-tab.js',
  'components/combine-modal.js',
  'components/scratchpad-tab.js',
  'app.js',
];

const flushAsync = async (ticks = 8) => {
  let idx = 0;
  while (idx < ticks) {
    await new Promise((resolve) => realSetTimeout(resolve, 0));
    idx += 1;
  }
};

async function createScratchpadTestEnv({
  conversationId = '11111111-2222-3333-4444-555555555555',
  workspaceUris = ['file:///C%3A/Users/dev/antigravity-notes/'],
  seedActions = [],
  enableMockEventSource = false,
} = {}) {
  const tmpDir = mkdtempSync(join(tmpdir(), 'notes-scratchpad-ui-'));
  const dataDir = join(tmpDir, 'data');
  const downloadsDir = join(tmpDir, 'Downloads');
  const saveAsTarget = join(tmpDir, 'custom-save-as.md');
  const mcpConfigPath = join(tmpDir, 'mcp_config.json');
  const token = 'pad-test-token';
  const agentCalls = [];
  const apiRequests = [];
  const resizeObservers = [];

  const defaultTrajectories = {
    '11111111-2222-3333-4444-555555555555': {
      summary: 'Notes Scratchpad Thread',
      workspaces: [{ workspaceFolderAbsoluteUri: 'file:///C%3A/Users/dev/antigravity-notes/' }],
    },
  };

  const { app, stateSync } = createNotesServer({
    dataDir,
    downloadsDir,
    port: 0,
    uiToken: token,
    mcpConfigPath,
    execFileFn: async () => ({ stdout: saveAsTarget, stderr: '' }),
    callLsRpcFn: async (method) => {
      if (method === 'GetAllCascadeTrajectories') {
        return { trajectorySummaries: defaultTrajectories };
      }
      return { ok: true };
    },
    agentApiFn: async (args, opts) => {
      agentCalls.push({ args, opts });
      if (args[0] === 'get-conversation-metadata') {
        return { response: { metadata: { projectId: 'proj-notes' } } };
      }
      if (args[0] === 'new-conversation') {
        return { conversationId: 'bbbb1111-cccc-2222-dddd-333333333333', title: 'Spawned Pad Chat' };
      }
      return { ok: true };
    },
  });

  const server = await app.run();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  let win = null;
  const activeTimers = new Set();

  const cleanup = async () => {
    win?.Notes?.destroy?.();
    for (const tid of activeTimers) {
      realClearTimeout(tid);
    }
    activeTimers.clear();
    globalThis.fetch = realFetch;
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
    delete globalThis.EventSource;
    stateSync.stop();
    await app.close();
    rmSync(tmpDir, { recursive: true, force: true });
  };

  try {
    for (const item of seedActions) {
      const seedRes = await realFetch(`${baseUrl}/api/mutate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Sidecar-Token': token,
        },
        body: JSON.stringify(item),
      });
      assert.equal(seedRes.status, 200);
    }

    const indexHtmlPath = join(UI_DIR, 'index.html');
    assert.equal(existsSync(indexHtmlPath), true, 'Expected ui/index.html to exist');
    const parsed = parseHTML(readFileSync(indexHtmlPath, 'utf8'));
    win = parsed.window;
    const doc = parsed.document;

    const search = `?token=${encodeURIComponent(token)}${conversationId ? `&conversationId=${encodeURIComponent(conversationId)}` : ''}`;
    Object.defineProperty(win, 'location', {
      configurable: true,
      value: {
        href: `${baseUrl}/${search}`,
        origin: baseUrl,
        search,
        pathname: '/',
        protocol: 'http:',
      },
    });

    const defineWinProp = (key, value) => {
      Object.defineProperty(win, key, { configurable: true, writable: true, value });
    };

    defineWinProp('parent', {
      postMessage() {},
    });
    defineWinProp('NotesMarkdown', NotesMarkdown);
    defineWinProp('setTimeout', (fn, ms, ...rest) => {
      const id = realSetTimeout((...a) => {
        activeTimers.delete(id);
        fn(...a);
      }, ms, ...rest);
      activeTimers.add(id);
      return id;
    });
    defineWinProp('clearTimeout', (id) => {
      activeTimers.delete(id);
      realClearTimeout(id);
    });

    defineWinProp(
      'ResizeObserver',
      class MockResizeObserver {
        constructor(callback) {
          this.callback = callback;
          this.targets = new Set();
          resizeObservers.push(this);
        }
        observe(el) {
          this.targets.add(el);
        }
        unobserve(el) {
          this.targets.delete(el);
        }
        disconnect() {
          this.targets.clear();
        }
        trigger(width, height = 420) {
          const entries = [...this.targets].map((target) => ({
            target,
            contentRect: { width, height },
          }));
          this.callback(entries);
        }
      }
    );

    const sseInstances = [];
    if (enableMockEventSource) {
      defineWinProp(
        'EventSource',
        class MockEventSource {
          constructor(url) {
            this.url = url;
            this.closed = false;
            this.onmessage = null;
            this._listeners = new Map();
            sseInstances.push(this);
          }
          addEventListener(type, fn) {
            if (!this._listeners.has(type)) {
              this._listeners.set(type, new Set());
            }
            this._listeners.get(type).add(fn);
          }
          removeEventListener(type, fn) {
            this._listeners.get(type)?.delete(fn);
          }
          dispatchSseEvent(type, evObj) {
            if (type === 'message' && typeof this.onmessage === 'function') {
              this.onmessage(evObj);
            }
            for (const fn of this._listeners.get(type) || []) {
              fn(evObj);
            }
          }
          close() {
            this.closed = true;
          }
        }
      );
    }

    defineWinProp('sidecar', {
      conversationId,
      async getWorkspaceUris() {
        return [...workspaceUris];
      },
      onWorkspaceChange() {
        return () => {};
      },
      ui: {
        toggleConversation() {},
      },
    });
    defineWinProp('AgyUI', {});
    defineWinProp('Notes', {});
    defineWinProp('__NOTES_INITIAL_STATE__', structuredClone(stateSync.getState()));

    defineWinProp('fetch', async (input, init = {}) => {
      const rawUrl = typeof input === 'string' ? input : input.url;
      const resolved = new URL(rawUrl, baseUrl);
      let parsedBody = null;
      if (typeof init.body === 'string' && init.body) {
        try {
          parsedBody = JSON.parse(init.body);
        } catch {
          parsedBody = init.body;
        }
      }
      apiRequests.push({ pathname: resolved.pathname, method: init.method || 'GET', body: parsedBody });
      const headers = new Headers(init.headers || {});
      if (!headers.has('X-Sidecar-Token')) {
        headers.set('X-Sidecar-Token', token);
      }
      return realFetch(resolved.href, { ...init, headers });
    });

    attachAgyUI(win, { modules: 'all' });

    for (const scriptRel of ALL_UI_SCRIPTS) {
      const fullPath = join(UI_DIR, scriptRel);
      assert.equal(existsSync(fullPath), true, `Expected ui/${scriptRel} to exist`);
      const code = readFileSync(fullPath, 'utf8');
      const runner = new Function('window', 'document', code);
      runner(win, doc);
    }

    await win.Notes?.bootPromise;
    await flushAsync();

    return {
      win,
      doc,
      stateSync,
      agentCalls,
      apiRequests,
      sseInstances,
      resizeObservers,
      cleanup,
    };
  } catch (err) {
    await cleanup();
    throw err;
  }
}

describe('Task 7 — Zero-Clutter Sub-Tab Bar & Multi-Pad Lifecycle (pad-add, rename, drag-reorder, delete)', () => {
  it('hides #pad-substrip-row for a single pad, adds a 2nd pad on [+], supports inline rename, drag-reorders tabs, and re-hides substrip on delete', async () => {
    const env = await createScratchpadTestEnv();
    try {
      const { win, doc, stateSync, apiRequests } = env;
      doc.getElementById('tab-scratchpad').click();
      await flushAsync();

      const subRow = doc.getElementById('pad-substrip-row');
      const subStrip = doc.getElementById('pad-substrip');
      const addBtn = doc.getElementById('pad-add-btn');
      assert.ok(subRow, 'Expected #pad-substrip-row');
      assert.ok(subStrip?.classList.contains('agy-tab-strip-sub'), 'Expected .agy-tab-strip-sub');
      assert.equal(subRow.classList.contains('hidden'), true, 'Single pad must hide #pad-substrip-row');
      assert.equal(addBtn.classList.contains('hidden'), false, 'Single pad must show inline + Pad button');

      // Click [+] (#pad-add-btn) -> calls pad-add, reveals .agy-tab-strip-sub with 2 tabs, and starts inline rename
      addBtn.click();
      await flushAsync();

      assert.equal(
        apiRequests.some((r) => r.pathname === '/api/mutate' && r.body?.action === 'pad-add'),
        true,
        'Expected pad-add mutation'
      );
      assert.equal(subRow.classList.contains('hidden'), false, '2 pads must reveal #pad-substrip-row');
      assert.equal(addBtn.classList.contains('hidden'), true, 'Inline + Pad button hides when substrip is visible');

      let tabs = [...subStrip.querySelectorAll('.agy-tab[data-pad-id]')];
      assert.equal(tabs.length, 2, 'Expected 2 pad tabs in .agy-tab-strip-sub');
      const pad1Id = tabs[0].dataset.padId;
      const pad2Id = tabs[1].dataset.padId;
      assert.equal(win.Notes.state.activePadId, pad2Id);

      // Commit inline rename on newly added Pad 2 -> "API Design"
      const renameInput = subStrip.querySelector('input.agy-rename-input');
      assert.ok(renameInput, 'Expected inline rename input on newly added pad tab');
      renameInput.value = 'API Design';
      renameInput.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      await flushAsync();

      assert.equal(
        stateSync.getState().scratchpads.find((p) => p.id === pad2Id)?.title,
        'API Design'
      );

      // Double-click first tab to rename Pad 1 -> "Architecture"
      tabs = [...subStrip.querySelectorAll('.agy-tab[data-pad-id]')];
      tabs[0].dispatchEvent(new win.MouseEvent('dblclick', { bubbles: true, cancelable: true }));
      const pad1Rename = subStrip.querySelector('input.agy-rename-input');
      assert.ok(pad1Rename, 'Expected dblclick to open inline rename on Pad 1');
      pad1Rename.value = 'Architecture';
      pad1Rename.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      await flushAsync();
      assert.equal(
        stateSync.getState().scratchpads.find((p) => p.id === pad1Id)?.title,
        'Architecture'
      );

      // Drag-reorder Tab 0 past Tab 1 via AgyUI.bindTabDragController
      tabs = [...subStrip.querySelectorAll('.agy-tab[data-pad-id]')];
      subStrip.getBoundingClientRect = () => ({ left: 0, right: 260, top: 0, bottom: 30, width: 260, height: 30 });
      tabs[0].getBoundingClientRect = () => ({ left: 0, right: 100, top: 0, bottom: 30, width: 100, height: 30 });
      tabs[1].getBoundingClientRect = () => ({ left: 104, right: 204, top: 0, bottom: 30, width: 100, height: 30 });

      tabs[0].dispatchEvent(new win.PointerEvent('pointerdown', { button: 0, clientX: 20, clientY: 14, pointerId: 1, bubbles: true }));
      win.dispatchEvent(new win.PointerEvent('pointermove', { clientX: 190, clientY: 14, pointerId: 1, bubbles: true }));
      win.dispatchEvent(new win.PointerEvent('pointerup', { clientX: 190, clientY: 14, pointerId: 1, bubbles: true }));
      await flushAsync();

      assert.equal(
        apiRequests.some((r) => r.pathname === '/api/mutate' && r.body?.action === 'pad-reorder'),
        true,
        'Expected pad-reorder mutation on tab drag'
      );
      const reorderedIds = [...subStrip.querySelectorAll('.agy-tab[data-pad-id]')].map((el) => el.dataset.padId);
      assert.deepEqual(reorderedIds, [pad2Id, pad1Id]);

      // Overflow dots button (#pad-overflow-btn) stays hidden when tabs fit, reveals on horizontal overflow, and opens #pad-overflow-popover
      const overflowBtn = doc.getElementById('pad-overflow-btn');
      const overflowPopover = doc.getElementById('pad-overflow-popover');
      assert.ok(overflowBtn, 'Expected #pad-overflow-btn in #pad-substrip-row');
      assert.equal(overflowBtn.classList.contains('hidden'), true, 'Overflow dots hidden when scrollWidth <= clientWidth');

      Object.defineProperty(subStrip, 'clientWidth', { configurable: true, value: 140 });
      Object.defineProperty(subStrip, 'scrollWidth', { configurable: true, value: 360 });
      Object.defineProperty(subStrip, 'scrollLeft', { configurable: true, value: 0 });
      subStrip._updateOverflow();
      assert.equal(overflowBtn.classList.contains('hidden'), false, 'Overflow dots revealed when tabs overflow');
      assert.equal(subStrip.classList.contains('mask-right'), true, 'Expected right scroll fade mask');

      overflowBtn.click();
      assert.equal(overflowPopover.classList.contains(':popover-open'), true, 'Clicking overflow dots opens #pad-overflow-popover');
      const overflowItems = [...overflowPopover.querySelectorAll('.agy-tab-overflow-item')];
      assert.equal(overflowItems.length, 2);
      const archItem = overflowItems.find((el) => el.textContent.includes('Architecture'));
      assert.ok(archItem, 'Expected Architecture tab in overflow popover');
      archItem.click();
      assert.equal(win.Notes.state.activePadId, pad1Id, 'Clicking overflow item selects that pad');
      assert.equal(overflowPopover.classList.contains(':popover-open'), false, 'Selecting overflow item closes popover');

      // Close one pad via .agy-tab-close -> drops back to 1 pad and hides #pad-substrip-row
      const closeBtn = subStrip.querySelector(`.agy-tab[data-pad-id="${pad2Id}"] .agy-tab-close`);
      assert.ok(closeBtn, 'Expected .agy-tab-close on pad tab');
      closeBtn.click();
      await flushAsync();

      assert.equal(subRow.classList.contains('hidden'), true, 'Dropping back to 1 pad must hide #pad-substrip-row');
      assert.equal(win.Notes.listScopePads().length, 1);
    } finally {
      await env.cleanup();
    }
  });
});

describe('Task 7 — Review Focus #4: Synchronous Scratchpad Flush on <400ms Fast Switches & SSE Anti-Clobber', () => {
  it('binds { padId, content } at keystroke time, flushes synchronously on Pad/Tab/Visibility switches within <400ms, and prevents SSE clobbering', async () => {
    const env = await createScratchpadTestEnv({
      enableMockEventSource: true,
      seedActions: [
        {
          action: 'pad-add',
          payload: {
            title: 'Pad One',
            content: 'Initial 1',
            scope: 'workspace',
            workspacePath: 'c:/Users/dev/antigravity-notes',
          },
        },
        {
          action: 'pad-add',
          payload: {
            title: 'Pad Two',
            content: 'Initial 2',
            scope: 'workspace',
            workspacePath: 'c:/Users/dev/antigravity-notes',
          },
        },
      ],
    });
    try {
      const { win, doc, stateSync, apiRequests, sseInstances } = env;
      doc.getElementById('tab-scratchpad').click();
      await flushAsync();

      const pads = win.Notes.listScopePads();
      assert.equal(pads.length, 2);
      const [pad1, pad2] = pads;
      const editor = doc.getElementById('pad-editor');
      const statusEl = doc.getElementById('pad-status');

      assert.equal(win.Notes.state.activePadId, pad1.id);
      assert.equal(editor.value, 'Initial 1');

      // 1. Type into Pad 1 -> sets Saving..., does NOT wait 400ms when switching immediately to Pad 2
      const saveCallsBefore = apiRequests.filter((r) => r.body?.action === 'pad-save').length;
      editor.value = 'Unsaved fast edit for Pad 1';
      editor.dispatchEvent(new win.Event('input', { bubbles: true }));
      assert.equal(statusEl.textContent, 'Saving…');
      assert.equal(apiRequests.filter((r) => r.body?.action === 'pad-save').length, saveCallsBefore, 'Must debounce before switch');

      // Immediately click Pad 2 tab (<400ms!)
      doc.querySelector(`#pad-substrip .agy-tab[data-pad-id="${pad2.id}"]`).click();

      // Synchronously verify pad-save was dispatched with pad1.id (NOT pad2.id!)
      const pad1SaveReq = apiRequests.find(
        (r) => r.pathname === '/api/mutate' && r.body?.action === 'pad-save' && r.body?.payload?.content === 'Unsaved fast edit for Pad 1'
      );
      assert.ok(pad1SaveReq, 'Expected synchronous pad-save dispatch on pad switch');
      assert.equal(pad1SaveReq.body.payload.id, pad1.id, 'Must save against Pad 1 ID captured at keystroke time');
      assert.equal(win.Notes.state.activePadId, pad2.id);
      assert.equal(editor.value, 'Initial 2');

      // Immediately type into Pad 2 while Pad 1's save is settling -> verify Pad 1 response does NOT clobber Pad 2!
      editor.value = 'Concurrent edit in Pad 2';
      editor.dispatchEvent(new win.Event('input', { bubbles: true }));
      await flushAsync();
      assert.equal(editor.value, 'Concurrent edit in Pad 2', 'In-flight Pad 1 response must not clobber active Pad 2 editor');
      assert.equal(
        stateSync.getState().scratchpads.find((p) => p.id === pad1.id)?.content,
        'Unsaved fast edit for Pad 1'
      );

      // Push an unrelated SSE state event while Pad 2 still has a <400ms pending debounce -> must NOT clobber editor!
      sseInstances[0].dispatchSseEvent('state', {
        data: JSON.stringify({
          version: 99,
          state: stateSync.getState(),
        }),
      });
      assert.equal(editor.value, 'Concurrent edit in Pad 2', 'SSE state broadcast must not clobber unsaved pending editor value');

      // Switch main tab to Stash within <400ms -> flushes Pad 2 synchronously!
      doc.getElementById('tab-stash').click();
      await flushAsync();
      assert.equal(
        stateSync.getState().scratchpads.find((p) => p.id === pad2.id)?.content,
        'Concurrent edit in Pad 2'
      );

      // Switch back to Scratchpad (Pad 1) -> verify Pad 1 content persisted cleanly, then test visibilitychange flush
      doc.getElementById('tab-scratchpad').click();
      doc.querySelector(`#pad-substrip .agy-tab[data-pad-id="${pad1.id}"]`).click();
      assert.equal(editor.value, 'Unsaved fast edit for Pad 1');

      editor.value = 'Edited right before tab hidden';
      editor.dispatchEvent(new win.Event('input', { bubbles: true }));
      Object.defineProperty(doc, 'hidden', { configurable: true, value: true });
      doc.dispatchEvent(new win.Event('visibilitychange'));
      await flushAsync();
      assert.equal(
        stateSync.getState().scratchpads.find((p) => p.id === pad1.id)?.content,
        'Edited right before tab hidden'
      );

      // Select text in Pad 1, type another fast edit, and immediately switch Scope (Repo -> Global) within <400ms
      // Select text in Pad 1, type another fast edit, and immediately switch Scratchpad's own Project | Global toggle within <400ms
      editor.value = 'Edited right before Global scope switch';
      editor.dispatchEvent(new win.Event('input', { bubbles: true }));
      editor.selectionStart = 0;
      editor.selectionEnd = 6;
      editor.dispatchEvent(new win.Event('select', { bubbles: true }));
      assert.equal(doc.getElementById('pad-sel-slot').classList.contains('hidden'), false);

      doc.querySelector('#pad-scope-toggle [data-toggle-id="global"]').click();
      await flushAsync();
      assert.equal(
        stateSync.getState().scratchpads.find((p) => p.id === pad1.id)?.content,
        'Edited right before Global scope switch',
        'Switching Scratchpad scope within <400ms must flush workspace pad edit'
      );
      assert.equal(doc.getElementById('pad-sel-slot').classList.contains('hidden'), true, 'Scope switch must clear stale selection slot');
      assert.equal(win.Notes.listScopePads().length, 1, 'Global scope ensures its own default Scratchpad');
      assert.equal(win.Notes.listScopePads()[0].scope, 'global');

      // Promoting a snippet from Global Scratchpad creates an unattached General card and switches Stash filter to All
      assert.equal(win.Notes.state.stashFilter, 'workspace');
      editor.value = 'Global pad snippet to promote #idea';
      editor.dispatchEvent(new win.Event('input', { bubbles: true }));
      editor.selectionStart = 0;
      editor.selectionEnd = editor.value.length;
      editor.dispatchEvent(new win.Event('select', { bubbles: true }));
      doc.getElementById('pad-to-stash-btn').click();
      await flushAsync();
      assert.equal(win.Notes.state.stashFilter, 'all', 'Promoting from Global Scratchpad switches Stash filter to All so General card is visible');
      const promotedGlobal = stateSync.getState().cards.find((c) => c.text.includes('Global pad snippet to promote'));
      assert.equal(promotedGlobal?.scope, 'global');
      assert.equal(promotedGlobal?.workspacePath, '');
      assert.equal(promotedGlobal?.originConversationId, '');

      // Switching back to Project on Scratchpad restores the 2 Project pads, and changing Stash's filter (All/Chat) never hijacks Scratchpad!
      doc.querySelector('#pad-scope-toggle [data-toggle-id="workspace"]').click();
      await flushAsync();
      assert.equal(win.Notes.listScopePads().length, 2);
      assert.equal(win.Notes.listScopePads()[0].scope, 'workspace');

      doc.querySelector('#stash-scope-toggle [data-toggle-id="all"]').click();
      await flushAsync();
      assert.equal(win.Notes.state.padScope, 'workspace', 'Filtering Stash to All must NOT hijack Scratchpad scope');
      assert.equal(win.Notes.listScopePads()[0].scope, 'workspace');
    } finally {
      await env.cleanup();
    }
  });
});

describe('Task 7 — Responsive Edit | Split | Preview Modes, <680px Fallback & Interactive Checkboxes', () => {
  it('renders live Split mode side-by-side, toggles - [ ] task lines with pad-save + editor sync, and falls back to Edit below 680px', async () => {
    const env = await createScratchpadTestEnv();
    try {
      const { win, doc, stateSync, resizeObservers } = env;
      doc.getElementById('tab-scratchpad').click();
      await flushAsync();

      const padSurface = doc.getElementById('surface-scratchpad');
      const editor = doc.getElementById('pad-editor');
      const preview = doc.getElementById('pad-preview');

      assert.equal(padSurface.dataset.padMode, 'edit');
      assert.equal(editor.classList.contains('hidden'), false);
      assert.equal(preview.classList.contains('hidden'), true);

      // Switch to Split mode -> both #pad-editor and #pad-preview visible simultaneously
      doc.querySelector('#pad-mode-toggle [data-toggle-id="split"]').click();
      assert.equal(padSurface.dataset.padMode, 'split');
      assert.equal(editor.classList.contains('hidden'), false);
      assert.equal(preview.classList.contains('hidden'), false);

      // Typing Markdown live-updates #pad-preview on input
      editor.value = '# Release Checklist\n\n- [ ] Verify manifest\n- [x] Write tests';
      editor.dispatchEvent(new win.Event('input', { bubbles: true }));

      assert.match(preview.innerHTML, /<h1>Release Checklist<\/h1>/);
      const taskCheckboxes = [...preview.querySelectorAll('input[type="checkbox"][data-task-line]')];
      assert.equal(taskCheckboxes.length, 2);
      assert.equal(taskCheckboxes[0].checked, false);
      assert.equal(taskCheckboxes[1].checked, true);

      // Click first unchecked - [ ] checkbox -> toggles Markdown via toggleTaskLine + pad-save and syncs #pad-editor.value
      taskCheckboxes[0].click();
      await flushAsync();

      const expectedMd = '# Release Checklist\n\n- [x] Verify manifest\n- [x] Write tests';
      assert.equal(editor.value, expectedMd);
      const activePadId = win.Notes.state.activePadId;
      assert.equal(
        stateSync.getState().scratchpads.find((p) => p.id === activePadId)?.content,
        expectedMd
      );
      const refreshedBoxes = [...preview.querySelectorAll('input[type="checkbox"][data-task-line]')];
      assert.equal(refreshedBoxes[0].checked, true);

      // Simulate container shrinking below 680px -> gracefully falls back from 'split' to 'edit'
      assert.equal(resizeObservers.length >= 1, true, 'Expected ResizeObserver on Scratchpad container');
      for (const ro of resizeObservers) {
        ro.trigger(540, 420);
      }
      assert.equal(padSurface.dataset.padMode, 'edit');
      assert.equal(editor.classList.contains('hidden'), false);
      assert.equal(preview.classList.contains('hidden'), true);
    } finally {
      await env.cleanup();
    }
  });
});

describe('Task 7 — Zero-Jump Selection Toolbar, Promote to Stash, Snippet Dispatch & Smart Editor Keys', () => {
  it('swaps idle/selection toolbar in-place, promotes selection to #tag-colored Stash card without clearing Scratchpad, dispatches snippets, and handles smart Enter/Tab/Escape', async () => {
    const env = await createScratchpadTestEnv();
    try {
      const { win, doc, stateSync, agentCalls } = env;
      doc.getElementById('tab-scratchpad').click();
      await flushAsync();

      const toolbar = doc.getElementById('pad-toolbar');
      const idleSlot = doc.getElementById('pad-idle-slot');
      const selSlot = doc.getElementById('pad-sel-slot');
      const editor = doc.getElementById('pad-editor');

      toolbar.getBoundingClientRect = () => ({ top: 34, left: 0, width: 320, height: 34 });
      const initialHeight = toolbar.getBoundingClientRect().height;
      assert.equal(idleSlot.classList.contains('hidden'), false);
      assert.equal(selSlot.classList.contains('hidden'), true);

      const fullPadText = 'Keep this header\nAudit SSE backpressure edge cases #perf #later\nKeep this footer';
      editor.value = fullPadText;
      editor.dispatchEvent(new win.Event('input', { bubbles: true }));
      win.Notes.flushPendingScratchpadSave();
      await flushAsync();

      // Highlight middle line in #pad-editor
      const snippet = 'Audit SSE backpressure edge cases #perf #later';
      const selStart = fullPadText.indexOf(snippet);
      const selEnd = selStart + snippet.length;
      editor.selectionStart = selStart;
      editor.selectionEnd = selEnd;
      editor.dispatchEvent(new win.Event('select', { bubbles: true }));

      assert.equal(idleSlot.classList.contains('hidden'), true);
      assert.equal(selSlot.classList.contains('hidden'), false);
      assert.equal(toolbar.getBoundingClientRect().height, initialHeight, 'Expected 0px toolbar height change');

      // mousedown on #pad-sel-slot prevents blur/selection collapse
      const mdEv = new win.MouseEvent('mousedown', { bubbles: true, cancelable: true });
      selSlot.dispatchEvent(mdEv);
      assert.equal(mdEv.defaultPrevented, true, 'mousedown on #pad-sel-slot must call preventDefault()');

      // Click -> Stash: creates #perf amber Stash card in current scope WITHOUT clearing Scratchpad text
      doc.getElementById('pad-to-stash-btn').click();
      await flushAsync();

      assert.equal(editor.value, fullPadText, 'Promoting to Stash must not delete Scratchpad text');
      assert.equal(idleSlot.classList.contains('hidden'), false, 'Toolbar returns to idle slot after promotion');
      const cards = stateSync.getState().cards;
      assert.equal(cards.length, 1);
      assert.equal(cards[0].text, snippet);
      assert.deepEqual(cards[0].tags, ['perf', 'later']);
      assert.equal(stateSync.getState().tagColors.perf, 'amber');
      assert.equal(win.Notes.resolveCardColor(cards[0]), 'amber');

      // Highlight snippet again and dispatch via Send to Active Chat + New Chat
      editor.selectionStart = selStart;
      editor.selectionEnd = selEnd;
      editor.dispatchEvent(new win.Event('mouseup', { bubbles: true }));
      assert.equal(selSlot.classList.contains('hidden'), false);

      doc.getElementById('pad-send-sel-btn').click();
      await flushAsync();
      assert.equal(agentCalls.some((c) => c.args[0] === 'send-message' && c.args.includes(snippet)), true);
      assert.equal(editor.value, fullPadText);

      editor.selectionStart = selStart;
      editor.selectionEnd = selEnd;
      editor.dispatchEvent(new win.Event('keyup', { bubbles: true }));
      doc.getElementById('pad-new-chat-btn').click();
      await flushAsync();
      assert.equal(agentCalls.some((c) => c.args[0] === 'new-conversation' && c.args.includes(snippet)), true);
      assert.equal(editor.value, fullPadText);

      // Smart list/checkbox Enter continuation (with IME guard), Tab/Shift+Tab indent, Escape blur & Export .md
      editor.value = '- [ ] First item';
      editor.selectionStart = editor.value.length;
      editor.selectionEnd = editor.value.length;

      // IME composing Enter must NOT insert continuation
      editor.dispatchEvent(
        new win.KeyboardEvent('keydown', { key: 'Enter', isComposing: true, keyCode: 229, bubbles: true, cancelable: true })
      );
      assert.equal(editor.value, '- [ ] First item');

      // Clean Enter continues with `- [ ] `
      editor.dispatchEvent(
        new win.KeyboardEvent('keydown', { key: 'Enter', isComposing: false, keyCode: 13, bubbles: true, cancelable: true })
      );
      assert.equal(editor.value, '- [ ] First item\n- [ ] ');

      // Tab indents active line by 2 spaces; Shift+Tab outdents by 2 spaces
      editor.selectionStart = editor.value.length;
      editor.selectionEnd = editor.value.length;
      editor.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
      assert.equal(editor.value, '- [ ] First item\n  - [ ] ');

      editor.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }));
      assert.equal(editor.value, '- [ ] First item\n- [ ] ');

      // Second Enter on empty `- [ ] ` exits list marker
      editor.selectionStart = editor.value.length;
      editor.selectionEnd = editor.value.length;
      editor.dispatchEvent(
        new win.KeyboardEvent('keydown', { key: 'Enter', isComposing: false, keyCode: 13, bubbles: true, cancelable: true })
      );
      assert.equal(editor.value, '- [ ] First item\n');

      // Escape blurs editor
      let blurred = false;
      editor.blur = () => {
        blurred = true;
      };
      editor.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      assert.equal(blurred, true);

      // Verify Project | Global toggle precedes #pad-substrip-row inside .notes-pad-nav
      const navChildren = [...doc.querySelector('.notes-pad-nav').children];
      assert.equal(navChildren[0]?.id, 'pad-scope-toggle');
      assert.equal(navChildren[1]?.id, 'pad-substrip-row');

      // Export Markdown menu -> Save As… (native picker) + Copy as Markdown
      doc.getElementById('pad-export-btn').click();
      const saveAsBtn = doc.querySelector('.agy-context-menu [data-menu-action="save-as"]');
      assert.ok(saveAsBtn, 'Expected Save As… option in Scratchpad export menu');
      saveAsBtn.click();
      await flushAsync();
      assert.equal(win.Notes.state.lastDownload?.filename, 'custom-save-as.md');
      assert.equal(win.Notes.state.lastDownload?.content, '- [ ] First item\n');
      assert.equal(readFileSync(win.Notes.state.lastDownload.path, 'utf8'), '- [ ] First item\n');

      doc.getElementById('pad-export-btn').click();
      doc.querySelector('.agy-context-menu [data-menu-action="copy-md"]').click();
      await flushAsync();
      assert.equal(win.Notes.state.lastCopiedText, '- [ ] First item\n');
    } finally {
      await env.cleanup();
    }
  });
});

describe('Task 7 — Fix Round 1 Regressions (Pre-Ensure Flush, Save Failure Recovery & Preview Selection Isolation)', () => {
  it('preserves #pad-editor.value on 0-pad global & workspace scopes when pad-ensure resolves before in-flight pad-save finishes (Finding #1)', async () => {
    const env = await createScratchpadTestEnv();
    try {
      const { win, doc, stateSync } = env;
      doc.getElementById('tab-scratchpad').click();
      await flushAsync();

      const editor = doc.getElementById('pad-editor');
      const baseWinFetch = win.fetch.bind(win);
      const gates = [];

      win.fetch = async (input, init = {}) => {
        let parsed = null;
        if (typeof init?.body === 'string' && init.body) {
          try {
            parsed = JSON.parse(init.body);
          } catch {}
        }
        if (parsed?.action === 'pad-ensure' || parsed?.action === 'pad-save') {
          await new Promise((resolve) => {
            gates.push({ action: parsed.action, payload: parsed.payload, release: resolve });
          });
        }
        return baseWinFetch(input, init);
      };

      // 1. Switch to Global scope (0 global pads initially) -> pad-ensure is gated in flight
      doc.querySelector('#pad-scope-toggle [data-toggle-id="global"]').click();
      await flushAsync(2);
      assert.equal(gates.some((g) => g.action === 'pad-ensure'), true, 'Expected pad-ensure in flight for Global scope');
      assert.equal(win.Notes.listScopePads().length, 0);

      // Type and flush BEFORE pad-ensure resolves -> pad-save (padId: '') is now also gated in flight
      editor.value = 'Global draft typed before pad-ensure resolved';
      editor.dispatchEvent(new win.Event('input', { bubbles: true }));
      const globalSavePromise = win.Notes.flushPendingScratchpadSave();
      await flushAsync(2);
      assert.equal(gates.some((g) => g.action === 'pad-save'), true, 'Expected pad-save in flight for Global scope');

      // Release pad-ensure FIRST (returns content: "", new pad.id) while pad-save is STILL in flight!
      gates.find((g) => g.action === 'pad-ensure').release();
      await flushAsync();

      assert.equal(
        editor.value,
        'Global draft typed before pad-ensure resolved',
        'pad-ensure resolving empty pad must not blank #pad-editor.value while un-IDd global pad-save is in flight'
      );
      assert.equal(win.Notes.listScopePads()[0]?.content, 'Global draft typed before pad-ensure resolved');

      // Now release pad-save and verify server state settles cleanly
      gates.find((g) => g.action === 'pad-save').release();
      await globalSavePromise;
      await flushAsync();
      assert.equal(
        stateSync.getState().scratchpads.find((p) => p.scope === 'global')?.content,
        'Global draft typed before pad-ensure resolved'
      );

      // 2. Repeat on a brand-new 0-pad Workspace scope
      gates.length = 0;
      win.Notes.state.padScope = 'workspace';
      win.Notes.state.workspacePath = 'c:/Users/dev/brand-new-workspace';
      win.Notes.state.workspaceName = 'brand-new-workspace';
      win.Notes.renderAll();
      await flushAsync(2);
      assert.equal(gates.some((g) => g.action === 'pad-ensure'), true, 'Expected pad-ensure for new workspace');

      editor.value = 'Workspace draft typed before pad-ensure resolved';
      editor.dispatchEvent(new win.Event('input', { bubbles: true }));
      const wsSavePromise = win.Notes.flushPendingScratchpadSave();
      await flushAsync(2);

      gates.find((g) => g.action === 'pad-ensure').release();
      await flushAsync();
      assert.equal(
        editor.value,
        'Workspace draft typed before pad-ensure resolved',
        'pad-ensure resolving empty workspace pad must not blank #pad-editor.value while pad-save is in flight'
      );

      gates.find((g) => g.action === 'pad-save').release();
      await wsSavePromise;
      await flushAsync();
      assert.equal(
        stateSync.getState().scratchpads.find((p) => p.workspaceName === 'brand-new-workspace')?.content,
        'Workspace draft typed before pad-ensure resolved'
      );
    } finally {
      await env.cleanup();
    }
  });

  it('shows "Save failed" on rejected >1 MiB pad-save, restores in-memory pad content while keeping editor text, and recovers to "Saved" on trim (Finding #2)', async () => {
    const env = await createScratchpadTestEnv({
      seedActions: [
        {
          action: 'pad-add',
          payload: {
            title: 'Scratchpad',
            content: 'Persisted baseline',
            scope: 'workspace',
            workspacePath: 'c:/Users/dev/antigravity-notes',
          },
        },
      ],
    });
    try {
      const { win, doc, stateSync } = env;
      doc.getElementById('tab-scratchpad').click();
      await flushAsync();

      const editor = doc.getElementById('pad-editor');
      const statusEl = doc.getElementById('pad-status');
      const padId = win.Notes.listScopePads()[0].id;
      assert.equal(editor.value, 'Persisted baseline');
      assert.equal(statusEl.textContent, 'Saved');

      // Paste > 1 MiB (MAX_PAD_BYTES = 1,048,576) -> server rejects with 400
      const oversized = 'x'.repeat(1048577);
      editor.value = oversized;
      editor.dispatchEvent(new win.Event('input', { bubbles: true }));
      assert.equal(statusEl.textContent, 'Saving…');

      const failedReq = win.Notes.flushPendingScratchpadSave();
      await assert.rejects(failedReq, /exceeds maximum size/i);
      await flushAsync();

      assert.equal(statusEl.textContent, 'Save failed', 'Rejected pad-save must show "Save failed", never "Saved"');
      assert.equal(
        win.Notes.listScopePads()[0].content,
        'Persisted baseline',
        'In-memory state.scratchpads must revert to last persisted server content on save rejection'
      );
      assert.equal(editor.value.length, 1048577, 'Editor textarea must preserve pasted text so user can trim it');

      // Re-rendering while in Save failed state must still keep user draft in #pad-editor and "Save failed" status
      win.Notes.renderScratchpadTab();
      assert.equal(editor.value.length, 1048577);
      assert.equal(statusEl.textContent, 'Save failed');

      // Trim down to valid size and save -> clears error and returns to "Saved"
      editor.value = 'Trimmed valid note';
      editor.dispatchEvent(new win.Event('input', { bubbles: true }));
      assert.equal(statusEl.textContent, 'Saving…');
      await win.Notes.flushPendingScratchpadSave();
      await flushAsync();

      assert.equal(statusEl.textContent, 'Saved');
      assert.equal(stateSync.getState().scratchpads.find((p) => p.id === padId)?.content, 'Trimmed valid note');
      assert.equal(win.Notes.listScopePads()[0].content, 'Trimmed valid note');
    } finally {
      await env.cleanup();
    }
  });

  it('ignores DOM selections anchored outside #pad-preview in Preview mode and clears #pad-sel-slot on selection collapse in Split mode (Finding #3)', async () => {
    const env = await createScratchpadTestEnv({
      seedActions: [
        {
          action: 'stash-add',
          payload: {
            text: 'External Stash card text #later',
            workspacePath: 'c:/Users/dev/antigravity-notes',
            originConversationId: '11111111-2222-3333-4444-555555555555',
          },
        },
        {
          action: 'pad-add',
          payload: {
            title: 'Scratchpad',
            content: 'Preview paragraph inside Scratchpad',
            scope: 'workspace',
            workspacePath: 'c:/Users/dev/antigravity-notes',
          },
        },
      ],
    });
    try {
      const { win, doc } = env;
      doc.getElementById('tab-scratchpad').click();
      await flushAsync();

      const preview = doc.getElementById('pad-preview');
      const idleSlot = doc.getElementById('pad-idle-slot');
      const selSlot = doc.getElementById('pad-sel-slot');
      const stashCardBody = doc.querySelector('#card-list .notes-card-body');
      assert.ok(stashCardBody, 'Expected rendered Stash card body outside #pad-preview');

      // 1. Switch to Preview mode and select text inside #surface-stash (outside #pad-preview)
      doc.querySelector('#pad-mode-toggle [data-toggle-id="preview"]').click();
      const previewNode = preview.querySelector('p');
      assert.ok(previewNode, 'Expected rendered <p> inside #pad-preview');

      let currentSel = {
        anchorNode: stashCardBody,
        focusNode: stashCardBody,
        isCollapsed: false,
        removeAllRanges() {},
        toString() {
          return 'External Stash card text';
        },
      };
      win.getSelection = () => currentSel;

      doc.dispatchEvent(new win.Event('selectionchange'));
      assert.equal(selSlot.classList.contains('hidden'), true, 'External Stash selection must not activate #pad-sel-slot');
      assert.equal(win.Notes.state.selectedPadText, '');

      // Cross-boundary selection (anchor inside #pad-preview, focus outside in Stash) must also be ignored
      currentSel = {
        anchorNode: previewNode,
        focusNode: stashCardBody,
        isCollapsed: false,
        removeAllRanges() {},
        toString() {
          return 'Cross boundary snippet';
        },
      };
      doc.dispatchEvent(new win.Event('selectionchange'));
      assert.equal(selSlot.classList.contains('hidden'), true, 'Cross-boundary selection must not activate #pad-sel-slot');

      // 2. Switch to Split mode, select text inside #pad-preview -> activates #pad-sel-slot
      doc.querySelector('#pad-mode-toggle [data-toggle-id="split"]').click();
      const splitPreviewNode = preview.querySelector('p');
      currentSel = {
        anchorNode: splitPreviewNode,
        focusNode: splitPreviewNode,
        isCollapsed: false,
        removeAllRanges() {},
        toString() {
          return 'Preview paragraph inside Scratchpad';
        },
      };
      preview.dispatchEvent(new win.MouseEvent('mouseup', { bubbles: true }));
      assert.equal(selSlot.classList.contains('hidden'), false, 'Preview selection in Split mode must reveal #pad-sel-slot');
      assert.equal(idleSlot.classList.contains('hidden'), true);

      // Clicking outside #pad-preview collapses selection while editor is NOT focused -> selectionchange must hide #pad-sel-slot!
      currentSel = {
        anchorNode: stashCardBody,
        focusNode: stashCardBody,
        isCollapsed: true,
        removeAllRanges() {},
        toString() {
          return '';
        },
      };
      doc.dispatchEvent(new win.Event('selectionchange'));
      assert.equal(selSlot.classList.contains('hidden'), true, 'Collapsed selection in Split mode must hide #pad-sel-slot');
      assert.equal(idleSlot.classList.contains('hidden'), false);
    } finally {
      await env.cleanup();
    }
  });

  it('updates #pad-editor on Pad 2 over SSE while Pad 1 save is in flight in the same workspace, and tracks pre-ensure key transitions in .catch()', async () => {
    const env = await createScratchpadTestEnv({
      enableMockEventSource: true,
      seedActions: [
        {
          action: 'pad-add',
          payload: {
            title: 'Pad One',
            content: 'Initial 1',
            scope: 'workspace',
            workspacePath: 'c:/Users/dev/antigravity-notes',
          },
        },
        {
          action: 'pad-add',
          payload: {
            title: 'Pad Two',
            content: 'Initial 2',
            scope: 'workspace',
            workspacePath: 'c:/Users/dev/antigravity-notes',
          },
        },
      ],
    });
    try {
      const { win, doc, stateSync, sseInstances } = env;
      doc.getElementById('tab-scratchpad').click();
      await flushAsync();

      const [pad1, pad2] = win.Notes.listScopePads();
      const editor = doc.getElementById('pad-editor');
      const statusEl = doc.getElementById('pad-status');
      const baseFetch = win.fetch.bind(win);
      const saveGates = [];

      win.fetch = async (inputUrl, init = {}) => {
        let parsed = null;
        if (typeof init?.body === 'string' && init.body) {
          try {
            parsed = JSON.parse(init.body);
          } catch {}
        }
        if (parsed?.action === 'pad-save' || parsed?.action === 'pad-ensure') {
          await new Promise((resolve) => {
            saveGates.push({ action: parsed.action, payload: parsed.payload, release: resolve });
          });
        }
        return baseFetch(inputUrl, init);
      };

      // 1. Type in Pad 1 and switch to Pad 2 -> Pad 1's pad-save is now gated in flight
      editor.value = 'In-flight edit on Pad 1';
      editor.dispatchEvent(new win.Event('input', { bubbles: true }));
      doc.querySelector(`#pad-substrip .agy-tab[data-pad-id="${pad2.id}"]`).click();
      await flushAsync(2);

      assert.equal(win.Notes.state.activePadId, pad2.id);
      assert.equal(editor.value, 'Initial 2');
      assert.equal(saveGates.length, 1);
      assert.equal(saveGates[0].payload.id, pad1.id);

      // Push live SSE update modifying Pad 2's content while Pad 1's save is STILL in flight in the same workspace
      const liveState = stateSync.getState();
      sseInstances[0].dispatchSseEvent('state', {
        data: JSON.stringify({
          version: 42,
          state: {
            ...liveState,
            scratchpads: liveState.scratchpads.map((p) =>
              p.id === pad2.id ? { ...p, content: 'External SSE update for Pad 2' } : p
            ),
          },
        }),
      });

      assert.equal(
        editor.value,
        'External SSE update for Pad 2',
        'In-flight Pad 1 save in same workspace must not suppress SSE updates on active Pad 2'
      );

      saveGates[0].release();
      await flushAsync();
      saveGates.length = 0;

      // 2. Pre-pad-ensure flightKey transition: oversized pre-ensure save #1 (keyed by 'global') rejects while post-ensure save #2 (keyed by pad.id) is in flight
      doc.querySelector('#pad-scope-toggle [data-toggle-id="global"]').click();
      await flushAsync(2);
      const ensureGate = saveGates.find((g) => g.action === 'pad-ensure');
      assert.ok(ensureGate, 'Expected gated pad-ensure for Global scope');

      editor.value = 'x'.repeat(1048577);
      editor.dispatchEvent(new win.Event('input', { bubbles: true }));
      const failPreEnsureReq = win.Notes.flushPendingScratchpadSave();
      failPreEnsureReq.catch(() => {});
      await flushAsync(2);

      // Resolve pad-ensure so Global pad now has a concrete pad.id
      ensureGate.release();
      await flushAsync();
      const globalPadId = win.Notes.listScopePads()[0]?.id;
      assert.ok(globalPadId, 'Expected concrete global pad.id after pad-ensure');

      // Queue & flush valid save #2 (now keyed by globalPadId in inFlightSaves)
      editor.value = 'Valid trimmed global draft';
      editor.dispatchEvent(new win.Event('input', { bubbles: true }));
      const validPostEnsureReq = win.Notes.flushPendingScratchpadSave();
      await flushAsync(2);

      const padSaveGates = saveGates.filter((g) => g.action === 'pad-save');
      assert.equal(padSaveGates.length, 2);

      // Release oversized pre-ensure save #1 first -> rejects with 400 while save #2 is still in flight
      padSaveGates[0].release();
      await assert.rejects(failPreEnsureReq);
      await flushAsync(2);

      assert.equal(
        win.Notes.listScopePads()[0].content,
        'Valid trimmed global draft',
        'Rejected pre-ensure save #1 must detect newer post-ensure save #2 across inFlightSaves.values()'
      );

      padSaveGates[1].release();
      await validPostEnsureReq;
      await flushAsync();
      assert.equal(statusEl.textContent, 'Saved');
      assert.equal(
        stateSync.getState().scratchpads.find((p) => p.id === globalPadId)?.content,
        'Valid trimmed global draft'
      );
    } finally {
      await env.cleanup();
    }
  });

  it('switches _new chat scope on -> Stash, records persistedContentByKey via Notes.mutate without SSE, and flushes pending save on Notes.destroy()', async () => {
    const env = await createScratchpadTestEnv({
      conversationId: '_new',
      enableMockEventSource: false,
    });
    try {
      const { win, doc, stateSync } = env;
      doc.getElementById('tab-scratchpad').click();
      await flushAsync();

      const editor = doc.getElementById('pad-editor');
      const padId = win.Notes.listScopePads()[0].id;

      // 1. Promote selection to Stash while stashFilter === 'chat' in unsaved _new conversation
      doc.querySelector('#stash-scope-toggle [data-toggle-id="chat"]').click();
      assert.equal(win.Notes.state.stashFilter, 'chat');
      assert.equal(win.Notes.state.conversationId, '');

      editor.value = 'Promote snippet from _new chat #ship';
      editor.dispatchEvent(new win.Event('input', { bubbles: true }));
      await win.Notes.flushPendingScratchpadSave();
      await flushAsync();

      editor.selectionStart = 0;
      editor.selectionEnd = editor.value.length;
      editor.dispatchEvent(new win.Event('select', { bubbles: true }));
      doc.getElementById('pad-to-stash-btn').click();
      await flushAsync();

      assert.equal(win.Notes.state.stashFilter, 'workspace', 'Expected -> Stash in _new chat to switch stashFilter to workspace');
      assert.equal(doc.querySelectorAll('#card-list .notes-card').length, 1);

      // 2. Direct Notes.mutate('pad-save') with SSE disconnected must update persistedContentByKey via Notes.applyServerState wrapper
      await win.Notes.mutate('pad-save', {
        id: padId,
        content: 'Persisted via Notes.mutate while SSE disconnected',
      });
      await flushAsync();

      editor.value = 'y'.repeat(1048577);
      editor.dispatchEvent(new win.Event('input', { bubbles: true }));
      await assert.rejects(win.Notes.flushPendingScratchpadSave(), /exceeds maximum size/i);
      await flushAsync();

      assert.equal(
        win.Notes.listScopePads()[0].content,
        'Persisted via Notes.mutate while SSE disconnected',
        'persistedContentByKey must reflect direct Notes.mutate baseline even when SSE is disconnected'
      );

      // 3. Notes.destroy() flushes <400ms pending scratchpad save before unmounting
      editor.value = 'Flushed by Notes.destroy() before unmount';
      editor.dispatchEvent(new win.Event('input', { bubbles: true }));
      win.Notes.destroy();
      await flushAsync();
      assert.equal(
        stateSync.getState().scratchpads.find((p) => p.id === padId)?.content,
        'Flushed by Notes.destroy() before unmount'
      );
    } finally {
      await env.cleanup();
    }
  });

  it('translates cryptic HTTP status codes (405, 401, 502) and network failures into actionable user-facing error messages', async () => {
    const env = await createScratchpadTestEnv();
    try {
      const { win, doc } = env;
      doc.getElementById('tab-scratchpad').click();
      await flushAsync();

      const editor = doc.getElementById('pad-editor');
      const statusEl = doc.getElementById('pad-status');
      const origFetch = win.fetch.bind(win);

      // 1. Simulate launcher diagnostic fallback returning plain-text 405 Method Not Allowed
      win.fetch = async () =>
        new Response('Method Not Allowed', {
          status: 405,
          headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        });

      editor.value = 'Draft while launcher fallback active';
      editor.dispatchEvent(new win.Event('input', { bubbles: true }));
      await assert.rejects(win.Notes.flushPendingScratchpadSave(), /Notes server is paused or stopped/i);
      await flushAsync();

      const toast405 = doc.querySelector('.agy-toast')?.textContent || '';
      assert.doesNotMatch(toast405, /\bHTTP 405\b/i, 'Must not expose raw HTTP 405 status');
      assert.match(toast405, /Save failed: Notes server is paused or stopped/i);
      assert.equal(statusEl.textContent, 'Save failed');
      assert.equal(statusEl.classList.contains('is-error'), true);
      assert.match(statusEl.getAttribute('title') || '', /Notes server is paused or stopped/i);

      // 2. Simulate 401 expired session & network TypeError('Failed to fetch') via Notes.apiCall
      win.fetch = async () =>
        new Response(JSON.stringify({ error: 'Unauthorized' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        });
      await assert.rejects(win.Notes.apiCall('/api/mutate', {}), /Notes session expired/i);

      win.fetch = async () => {
        throw new TypeError('Failed to fetch');
      };
      await assert.rejects(win.Notes.apiCall('/api/mutate', {}), /Could not reach Notes server/i);

      win.fetch = origFetch;
    } finally {
      await env.cleanup();
    }
  });
});
