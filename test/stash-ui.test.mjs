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
const TASK_6_SCRIPTS = [
  'core.js',
  'components/swatch-picker.js',
  'components/stash-tab.js',
  'components/combine-modal.js',
  'app.js',
];

const flushAsync = async (ticks = 6) => {
  for (let i = 0; i < ticks; i += 1) {
    await new Promise((resolve) => realSetTimeout(resolve, 0));
  }
};

async function createStashTestEnv({
  conversationId = '11111111-2222-3333-4444-555555555555',
  workspaceUris = ['file:///C%3A/Users/dev/antigravity-notes/'],
  trajectories = null,
  projects = null,
  seedActions = [],
  enableMockEventSource = false,
} = {}) {
  const tmpDir = mkdtempSync(join(tmpdir(), 'notes-stash-ui-'));
  const dataDir = join(tmpDir, 'data');
  const downloadsDir = join(tmpDir, 'Downloads');
  const saveAsPath = join(tmpDir, 'picked-stash.md');
  const projectsDir = join(tmpDir, 'projects');
  const mcpConfigPath = join(tmpDir, 'mcp_config.json');
  if (Array.isArray(projects) && projects.length > 0) {
    const { mkdirSync, writeFileSync } = await import('node:fs');
    mkdirSync(projectsDir, { recursive: true });
    for (const proj of projects) {
      writeFileSync(join(projectsDir, `${proj.id}.json`), JSON.stringify(proj), 'utf8');
    }
  }
  const token = 'ui-test-token';
  const agentCalls = [];
  const lsCalls = [];
  const apiRequests = [];

  const defaultTrajectories = trajectories || {
    '11111111-2222-3333-4444-555555555555': {
      summary: 'Notes UI Thread',
      workspaces: [{ workspaceFolderAbsoluteUri: 'file:///C%3A/Users/dev/antigravity-notes/' }],
    },
    '99999999-8888-7777-6666-555555555555': {
      summary: 'Other Hangar Thread',
      workspaces: [{ workspaceFolderAbsoluteUri: 'file:///C%3A/Users/dev/antigravity-notes/' }],
    },
  };

  const { app, stateSync } = createNotesServer({
    dataDir,
    downloadsDir,
    projectsDir,
    port: 0,
    uiToken: token,
    mcpConfigPath,
    execFileFn: async () => ({ stdout: saveAsPath, stderr: '' }),
    callLsRpcFn: async (method, body) => {
      lsCalls.push({ method, body });
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
        return { conversationId: 'aaaa1111-bbbb-2222-cccc-333333333333', title: 'Spawned Stash Chat' };
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
    const htmlSource = readFileSync(indexHtmlPath, 'utf8');
    const parsed = parseHTML(htmlSource);
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

    const postedMessages = [];
    const defineWinProp = (key, value) => {
      Object.defineProperty(win, key, { configurable: true, writable: true, value });
    };
    defineWinProp('parent', {
      postMessage(msg) {
        postedMessages.push(msg);
      },
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

    let currentWorkspaceUris = [...workspaceUris];
    const wsListeners = new Set();
    defineWinProp('sidecar', {
      conversationId,
      async getWorkspaceUris() {
        return [...currentWorkspaceUris];
      },
      onWorkspaceChange(fn) {
        wsListeners.add(fn);
        return () => wsListeners.delete(fn);
      },
      ui: {
        toggleConversation(targetConvId, options) {
          postedMessages.push({
            type: 'toggle-conversation',
            payload: options ? { conversationId: targetConvId, ...options } : { conversationId: targetConvId },
          });
        },
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

    for (const scriptRel of TASK_6_SCRIPTS) {
      const fullPath = join(UI_DIR, scriptRel);
      assert.equal(existsSync(fullPath), true, `Expected ui/${scriptRel} to exist`);
      const code = readFileSync(fullPath, 'utf8');
      const runner = new Function('window', 'document', code);
      runner(win, doc);
    }

    await win.Notes?.bootPromise;
    await flushAsync();

    const emitWorkspaceChange = (nextUris) => {
      currentWorkspaceUris = [...nextUris];
      for (const fn of wsListeners) {
        fn([...currentWorkspaceUris]);
      }
    };

    return {
      win,
      doc,
      stateSync,
      agentCalls,
      lsCalls,
      apiRequests,
      postedMessages,
      sseInstances,
      emitWorkspaceChange,
      cleanup,
    };
  } catch (err) {
    await cleanup();
    throw err;
  }
}

describe('Task 6 — Responsive AgyUI Shell, Chrome Bar, Settings Popover & Workbench Sash', () => {
  it('renders chrome bar primitives, opens headless Settings popover cleanly, updates MCP switches/badge, and persists workbench sash ratio', async () => {
    const env = await createStashTestEnv();
    try {
      const { win, doc, stateSync, lsCalls } = env;
      const chromeBar = doc.querySelector('.agy-chrome-bar');
      assert.ok(chromeBar, 'Expected .agy-chrome-bar');

      const mainTabs = doc.getElementById('main-tabs');
      assert.ok(mainTabs, 'Expected #main-tabs');
      assert.equal(doc.querySelector('.notes-pad-full-label')?.textContent, 'Scratchpad');
      assert.equal(doc.querySelector('.notes-pad-short-label')?.textContent, 'Pad');

      const workbenchToggle = doc.getElementById('workbench-toggle');
      assert.ok(workbenchToggle, 'Expected #workbench-toggle');
      const wbButtons = [...workbenchToggle.querySelectorAll('.agy-toggle-item')];
      assert.deepEqual(
        wbButtons.map((b) => b.dataset.toggleId),
        ['split', 'stash', 'scratchpad']
      );

      const workbenchSash = doc.getElementById('workbench-sash');
      assert.ok(workbenchSash, 'Expected #workbench-sash');
      assert.equal(workbenchSash.getAttribute('direction'), 'horizontal');
      assert.equal(workbenchSash.getAttribute('min-ratio'), '0.26');
      assert.equal(workbenchSash.getAttribute('max-ratio'), '0.72');

      assert.equal(doc.getElementById('scope-inline'), null, 'Global scope switcher removed from top chrome bar');
      assert.equal(doc.getElementById('scope-trigger'), null, 'Compact scope trigger removed from top chrome bar');

      const stashScopeToggle = doc.getElementById('stash-scope-toggle');
      assert.ok(stashScopeToggle, 'Expected #stash-scope-toggle inside Stash filter bar');
      assert.deepEqual(
        [...stashScopeToggle.querySelectorAll('.agy-toggle-item')].map((b) => b.dataset.toggleId),
        ['workspace', 'chat', 'all']
      );
      assert.deepEqual(
        [...stashScopeToggle.querySelectorAll('.agy-toggle-item')].map((b) => b.textContent.trim()),
        ['Project', 'Chat', 'All']
      );

      // Settings trigger & popover accessibility attributes (no aria-haspopup or role="menu")
      const settingsBtn = doc.getElementById('settings-btn');
      const settingsPopover = doc.getElementById('settings-popover');
      assert.equal(settingsBtn.getAttribute('popovertarget'), 'settings-popover');
      assert.equal(settingsBtn.hasAttribute('aria-haspopup'), false);
      assert.equal(settingsPopover.getAttribute('popover'), 'auto');
      assert.equal(settingsPopover.hasAttribute('role'), false);

      // Headless popover fallback toggles .\:popover-open without shadowing .popover IDL
      assert.equal(settingsPopover.classList.contains(':popover-open'), false);
      settingsBtn.click();
      assert.equal(settingsPopover.classList.contains(':popover-open'), true);

      const colorStyleToggle = doc.getElementById('color-style-toggle');
      assert.deepEqual(
        [...colorStyleToggle.querySelectorAll('.agy-toggle-item')].map((b) => b.dataset.toggleId),
        ['wash', 'stripe', 'bold']
      );
      const enterModeToggle = doc.getElementById('enter-mode-toggle');
      assert.deepEqual(
        [...enterModeToggle.querySelectorAll('.agy-toggle-item')].map((b) => b.dataset.toggleId),
        ['stash', 'newline']
      );

      const mcpBadge = doc.getElementById('mcp-token-badge');
      assert.equal(mcpBadge.textContent, '0 tok');

      const readSwitchBtn = doc.querySelector('#mcp-read-switch button[role="switch"]') || doc.getElementById('mcp-read-switch');
      readSwitchBtn.click();
      await flushAsync();
      assert.equal(stateSync.getState().settings.mcpRead, true);
      assert.equal(mcpBadge.textContent, '~380 tok');
      assert.equal(lsCalls.some((c) => c.method === 'RefreshMcpServers'), true);

      const writeSwitchBtn = doc.querySelector('#mcp-write-switch button[role="switch"]') || doc.getElementById('mcp-write-switch');
      writeSwitchBtn.click();
      await flushAsync();
      assert.equal(stateSync.getState().settings.mcpWrite, true);
      assert.equal(mcpBadge.textContent, '~840 tok');

      // Sash resize updates CSS variable and persists workbenchSplitRatio on resize end
      workbenchSash.dispatchEvent(new win.CustomEvent('split-resize', { detail: { ratio: 0.36 }, bubbles: true }));
      assert.equal(doc.getElementById('notes-app').style.getPropertyValue('--notes-split-ratio'), '0.360');
      workbenchSash.dispatchEvent(new win.CustomEvent('split-resize-end', { bubbles: true }));
      await flushAsync();
      assert.equal(stateSync.getState().settings.workbenchSplitRatio, 0.36);
    } finally {
      await env.cleanup();
    }
  });
});

describe('Task 6 — IME-Safe Quick-Capture Composer & Composer Color Override', () => {
  it('blocks Enter during IME composition / keyCode 229 / 50ms post-composition window, supports Enter vs Ctrl+Enter modes, and applies composer color override', async () => {
    const env = await createStashTestEnv();
    try {
      const { win, doc, stateSync } = env;
      const form = doc.getElementById('stash-composer-form');
      const label = doc.querySelector('label[for="stash-composer-input"]');
      const input = doc.getElementById('stash-composer-input');
      assert.ok(form, 'Expected #stash-composer-form');
      assert.ok(label?.classList.contains('sr-only'), 'Expected .sr-only label for composer');
      assert.ok(input?.classList.contains('agy-input'), 'Expected composer textarea to carry .agy-input');

      input.value = 'Draft prompt during IME #later';
      input.dispatchEvent(new win.Event('input', { bubbles: true }));

      // 1. isComposing: true -> must NOT submit
      input.dispatchEvent(
        new win.KeyboardEvent('keydown', { key: 'Enter', isComposing: true, keyCode: 13, timeStamp: 1000, bubbles: true, cancelable: true })
      );
      await flushAsync();
      assert.equal(stateSync.getState().cards.length, 0);

      // 2. keyCode: 229 -> must NOT submit
      input.dispatchEvent(
        new win.KeyboardEvent('keydown', { key: 'Enter', isComposing: false, keyCode: 229, timeStamp: 1100, bubbles: true, cancelable: true })
      );
      await flushAsync();
      assert.equal(stateSync.getState().cards.length, 0);

      // 3. Within 50ms of compositionend -> must NOT submit
      const compEnd = new win.Event('compositionend', { bubbles: true });
      Object.defineProperty(compEnd, 'timeStamp', { value: 2000 });
      input.dispatchEvent(compEnd);

      const postCompEnter = new win.KeyboardEvent('keydown', { key: 'Enter', isComposing: false, keyCode: 13, bubbles: true, cancelable: true });
      Object.defineProperty(postCompEnter, 'timeStamp', { value: 2030 });
      input.dispatchEvent(postCompEnter);
      await flushAsync();
      assert.equal(stateSync.getState().cards.length, 0);

      // 4. Clean Enter > 50ms after compositionend -> submits!
      const cleanEnter = new win.KeyboardEvent('keydown', { key: 'Enter', isComposing: false, keyCode: 13, bubbles: true, cancelable: true });
      Object.defineProperty(cleanEnter, 'timeStamp', { value: 2200 });
      input.dispatchEvent(cleanEnter);
      await flushAsync();
      assert.equal(stateSync.getState().cards.length, 1);
      assert.equal(stateSync.getState().cards[0].text, 'Draft prompt during IME #later');
      assert.equal(input.value, '');

      // 5. Switch to Ctrl+Enter mode ('newline') + pick explicit composer color override ('violet')
      doc.querySelector('#enter-mode-toggle [data-toggle-id="newline"]').click();
      await flushAsync();
      assert.equal(stateSync.getState().settings.enterBehavior, 'newline');

      const colorBtn = doc.getElementById('composer-color-btn');
      colorBtn.click();
      const swatchMenu = doc.querySelector('.notes-swatch-menu');
      assert.ok(swatchMenu, 'Expected swatch picker menu to open');
      swatchMenu.querySelector('[data-swatch-id="violet"]').click();
      assert.equal(form.classList.contains('notes-hue-violet'), true);

      input.value = 'Multi-line prompt with override';
      input.dispatchEvent(new win.Event('input', { bubbles: true }));

      // Plain Enter in 'newline' mode must NOT submit
      const plainEnter = new win.KeyboardEvent('keydown', { key: 'Enter', isComposing: false, keyCode: 13, bubbles: true, cancelable: true });
      Object.defineProperty(plainEnter, 'timeStamp', { value: 3000 });
      input.dispatchEvent(plainEnter);
      await flushAsync();
      assert.equal(stateSync.getState().cards.length, 1);

      // Ctrl+Enter submits with violet color override and resets composer color to 'auto'
      const ctrlEnter = new win.KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, isComposing: false, keyCode: 13, bubbles: true, cancelable: true });
      Object.defineProperty(ctrlEnter, 'timeStamp', { value: 3100 });
      input.dispatchEvent(ctrlEnter);
      await flushAsync();
      assert.equal(stateSync.getState().cards.length, 2);
      assert.equal(stateSync.getState().cards[0].color, 'violet');
      assert.equal(win.Notes.state.composerColor, 'auto');

      // Clicking/mousedown on #composer-hint or composer footer must prevent blur and keep .is-expanded open
      const hintEl = doc.getElementById('composer-hint');
      assert.ok(hintEl.querySelector('.notes-hint-short'), 'Expected compact responsive hint span');
      assert.ok(hintEl.querySelector('.notes-hint-full'), 'Expected full responsive hint span');
      const hintDownEv = new win.MouseEvent('mousedown', { bubbles: true, cancelable: true });
      hintEl.dispatchEvent(hintDownEv);
      assert.equal(hintDownEv.defaultPrevented, true, 'mousedown on #composer-hint must call preventDefault() so input stays focused');
      assert.equal(doc.getElementById('stash-composer-form').classList.contains('is-expanded'), true);
    } finally {
      await env.cleanup();
    }
  });
});

describe('Task 6 — Tag Swatch Recoloring, Color Filter Dots, Card Color Styles & Grid/List Toggle', () => {
  it('recolors #tags globally on right-click, filters both #tag-colored and untagged manual cards by color dot, and switches color style & layout', async () => {
    const env = await createStashTestEnv({
      seedActions: [
        {
          action: 'stash-add',
          payload: {
            text: 'Fix race condition in stream #bug',
            workspacePath: 'c:/Users/dev/antigravity-notes',
            originConversationId: '11111111-2222-3333-4444-555555555555',
          },
        },
        {
          action: 'stash-add',
          payload: {
            text: 'Untagged manual emerald note',
            color: 'emerald',
            workspacePath: 'c:/Users/dev/antigravity-notes',
            originConversationId: '11111111-2222-3333-4444-555555555555',
          },
        },
        {
          action: 'stash-add',
          payload: {
            text: 'Explore MCP schema #mcp',
            workspacePath: 'c:/Users/dev/antigravity-notes',
            originConversationId: '11111111-2222-3333-4444-555555555555',
          },
        },
      ],
    });
    try {
      const { win, doc, stateSync, apiRequests } = env;
      assert.equal(doc.querySelectorAll('#card-list .notes-card').length, 3);

      // Right-click #bug pill in #tag-strip -> recolor #bug from 'rose' to 'emerald'
      const bugPill = doc.querySelector('#tag-strip [data-tag-pill="bug"]');
      assert.ok(bugPill, 'Expected #bug tag pill in #tag-strip');
      bugPill.dispatchEvent(new win.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 60, clientY: 90 }));

      const swatchMenu = doc.querySelector('.notes-swatch-menu');
      assert.ok(swatchMenu, 'Expected openSwatchPicker menu on #tag contextmenu');
      swatchMenu.querySelector('[data-swatch-id="emerald"]').click();
      await flushAsync();

      assert.equal(
        apiRequests.some((r) => r.pathname === '/api/mutate' && r.body?.action === 'tag-set-color' && r.body?.payload?.tag === 'bug' && r.body?.payload?.color === 'emerald'),
        true
      );
      assert.equal(stateSync.getState().tagColors.bug, 'emerald');

      // Clicking emerald color filter dot matches BOTH #bug card AND untagged manual emerald card (2 cards, excluding #mcp cyan card)
      const emeraldDotBtn = doc.querySelector('#tag-strip [data-color-filter="emerald"]');
      assert.ok(emeraldDotBtn, 'Expected emerald color filter dot');
      assert.equal(emeraldDotBtn.getAttribute('aria-pressed'), 'false');
      emeraldDotBtn.click();
      assert.equal(emeraldDotBtn.getAttribute('aria-pressed'), 'true');
      const filteredCards = [...doc.querySelectorAll('#card-list .notes-card')];
      assert.equal(filteredCards.length, 2);

      // Switching color-style-toggle updates data-color-style on #notes-app
      doc.querySelector('#color-style-toggle [data-toggle-id="bold"]').click();
      await flushAsync();
      assert.equal(doc.getElementById('notes-app').dataset.colorStyle, 'bold');
      assert.equal(stateSync.getState().settings.cardColorStyle, 'bold');

      // Switching stash-layout-toggle updates data-stash-layout="grid|list" on #surface-stash
      const stashSurface = doc.getElementById('surface-stash');
      assert.equal(stashSurface.dataset.stashLayout, 'grid');
      doc.querySelector('#stash-layout-toggle [data-toggle-id="list"]').click();
      await flushAsync();
      assert.equal(stashSurface.dataset.stashLayout, 'list');
      assert.equal(stateSync.getState().settings.stashLayout, 'list');

      // Auto-clear stale color/tag filters when the last matching card is recolored or sent (Finding #1)
      emeraldDotBtn.click(); // clear emerald filter first so all 3 cards show
      assert.equal(doc.querySelectorAll('#card-list .notes-card').length, 3);

      // Filter by cyan dot (matches only the #mcp card), then recolor #mcp to violet -> cyan disappears from presentColors -> filter auto-clears!
      const cyanDotBtn = doc.querySelector('#tag-strip [data-color-filter="cyan"]');
      assert.ok(cyanDotBtn, 'Expected cyan color filter dot');
      cyanDotBtn.click();
      assert.equal(doc.querySelectorAll('#card-list .notes-card').length, 1);

      const mcpPill = doc.querySelector('#tag-strip [data-tag-pill="mcp"]');
      mcpPill.dispatchEvent(new win.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 60, clientY: 90 }));
      doc.querySelector('.notes-swatch-menu [data-swatch-id="violet"]').click();
      await flushAsync();
      assert.equal(win.Notes.state.activeColorFilter, '');
      assert.equal(doc.querySelectorAll('#card-list .notes-card').length, 3, 'Recoloring last cyan card must auto-clear stale cyan filter');

      // Filter by #mcp tag pill, then send the #mcp card -> #mcp disappears from active tags -> activeTag auto-clears!
      doc.querySelector('#tag-strip [data-tag-pill="mcp"]').click();
      assert.equal(win.Notes.state.activeTag, 'mcp');
      assert.equal(doc.querySelectorAll('#card-list .notes-card').length, 1);
      doc.querySelector('#card-list .notes-card .notes-send-btn').click();
      await flushAsync();
      assert.equal(win.Notes.state.activeTag, '');
      assert.equal(doc.querySelectorAll('#card-list .notes-card').length, 2, 'Sending last #mcp card must auto-clear stale #mcp tag filter');
    } finally {
      await env.cleanup();
    }
  });
});

describe('Task 6 — Single Send + Undo Toast, Multi-Select Combine Dialog & Hangar Conversation Sync', () => {
  it('dispatches single card with Undo restore, combines multi-selected cards in <dialog closedby="any"> with backdrop light-dismiss, and re-filters on Hangar conversation-change', async () => {
    const env = await createStashTestEnv({
      seedActions: [
        {
          action: 'stash-add',
          payload: {
            text: 'First prompt for thread 1 #later',
            workspacePath: 'c:/Users/dev/antigravity-notes',
            originConversationId: '11111111-2222-3333-4444-555555555555',
            originConversationTitle: 'Notes UI Thread',
          },
        },
        {
          action: 'stash-add',
          payload: {
            text: 'Second prompt for thread 1 #mcp',
            workspacePath: 'c:/Users/dev/antigravity-notes',
            originConversationId: '11111111-2222-3333-4444-555555555555',
            originConversationTitle: 'Notes UI Thread',
          },
        },
        {
          action: 'stash-add',
          payload: {
            text: 'Prompt parked in other Hangar thread #idea',
            workspacePath: 'c:/Users/dev/antigravity-notes',
            originConversationId: '99999999-8888-7777-6666-555555555555',
            originConversationTitle: 'Other Hangar Thread',
          },
        },
      ],
    });
    try {
      const { win, doc, stateSync, agentCalls, apiRequests } = env;
      // All 3 workspace cards visible in Repo scope
      assert.equal(doc.querySelectorAll('#card-list .notes-card').length, 3);

      // 1. Single card Send + Undo toast (stash-restore)
      const firstCardEl = doc.querySelector('#card-list .notes-card');
      const sendBtn = firstCardEl.querySelector('.notes-send-btn');
      sendBtn.click();
      await flushAsync();

      assert.equal(agentCalls.some((c) => c.args[0] === 'send-message'), true);
      assert.equal(doc.querySelectorAll('#card-list .notes-card').length, 2);

      const undoBtn = doc.querySelector('.agy-toast .notes-undo-btn');
      assert.ok(undoBtn, 'Expected Undo button inside .agy-toast');
      undoBtn.click();
      await flushAsync();

      assert.equal(
        apiRequests.some((r) => r.pathname === '/api/mutate' && r.body?.action === 'stash-restore'),
        true
      );
      assert.equal(doc.querySelectorAll('#card-list .notes-card').length, 3);

      // 2. Multi-select the 2 thread-1 cards (indices 1 & 2, since newest seed is at index 0) -> Batch bar -> Combine <dialog closedby="any">
      const checkboxes = [...doc.querySelectorAll('#card-list .notes-card-check')];
      checkboxes[1].checked = true;
      checkboxes[1].dispatchEvent(new win.Event('change', { bubbles: true }));
      checkboxes[2].checked = true;
      checkboxes[2].dispatchEvent(new win.Event('change', { bubbles: true }));

      const batchBar = doc.getElementById('batch-bar');
      assert.equal(batchBar.classList.contains('hidden'), false);
      assert.equal(doc.getElementById('batch-count').textContent, '2 selected');

      const combineDialog = doc.getElementById('combine-dialog');
      assert.equal(combineDialog.getAttribute('closedby'), 'any');
      assert.equal(combineDialog.getAttribute('aria-labelledby'), 'combine-dialog-title');

      doc.getElementById('batch-combine-btn').click();
      assert.equal(combineDialog.hasAttribute('open'), true);
      const combineTextarea = doc.getElementById('combine-textarea');
      assert.match(combineTextarea.value, /1\./);
      assert.match(combineTextarea.value, /2\./);

      // Backdrop click outside dialog rect closes dialog via fallback
      combineDialog.getBoundingClientRect = () => ({ top: 100, left: 100, width: 300, height: 220 });
      combineDialog.dispatchEvent(new win.MouseEvent('click', { clientX: 20, clientY: 20, bubbles: true }));
      assert.equal(combineDialog.hasAttribute('open'), false);

      // Re-open, edit combined prompt, and dispatch to New Chat
      doc.getElementById('batch-combine-btn').click();
      assert.equal(combineDialog.hasAttribute('open'), true);
      combineTextarea.value = 'Custom combined framing:\n- Item A\n- Item B';
      doc.getElementById('combine-new-btn').click();
      await flushAsync();

      assert.equal(combineDialog.hasAttribute('open'), false);
      assert.equal(
        agentCalls.some((c) => c.args[0] === 'new-conversation' && c.args.includes('Custom combined framing:\n- Item A\n- Item B')),
        true
      );
      assert.equal(stateSync.getState().cards.filter((c) => c.status === 'sent').length, 2);

      // 3. Switch Scope to 'chat' ("This Chat") and verify Hangar conversation-change postMessage re-filtering
      let flushCalled = 0;
      win.Notes.flushPendingScratchpadSave = () => {
        flushCalled += 1;
      };

      doc.querySelector('#stash-scope-toggle [data-toggle-id="chat"]').click();
      await flushAsync();
      // Active cards in thread 11111... is now 0 (the 2 thread-1 cards were sent; the remaining active card belongs to 99999...)
      assert.equal(doc.querySelectorAll('#card-list .notes-card').length, 0);

      const msgEv = new win.Event('message');
      msgEv.data = {
        type: 'conversation-change',
        payload: { conversationId: '99999999-8888-7777-6666-555555555555' },
      };
      msgEv.source = win.parent;
      win.dispatchEvent(msgEv);
      await flushAsync();

      assert.equal(flushCalled >= 1, true, 'Expected flushPendingScratchpadSave before conversation switch');
      const cardsInOtherThread = [...doc.querySelectorAll('#card-list .notes-card')];
      assert.equal(cardsInOtherThread.length, 1);
      assert.match(cardsInOtherThread[0].textContent, /Prompt parked in other Hangar thread/);
    } finally {
      await env.cleanup();
    }
  });
});

describe('Task 6 — Inline Card Edit, Pointer Drag-Reorder, Origin Jump, Sent Archive & Export Stash', () => {
  it('supports inline card edit, pointer drag-reorder, origin-chat jump, Sent history Clear Sent, and Markdown export', async () => {
    const env = await createStashTestEnv({
      seedActions: [
        {
          action: 'stash-add',
          payload: {
            text: 'Bottom card initially #later',
            workspacePath: 'c:/Users/dev/antigravity-notes',
            originConversationId: '11111111-2222-3333-4444-555555555555',
            originConversationTitle: 'Notes UI Thread',
          },
        },
        {
          action: 'stash-add',
          payload: {
            text: 'Top card initially #bug',
            workspacePath: 'c:/Users/dev/antigravity-notes',
            originConversationId: '11111111-2222-3333-4444-555555555555',
            originConversationTitle: 'Notes UI Thread',
          },
        },
      ],
    });
    try {
      const { win, doc, stateSync, postedMessages } = env;
      let cards = [...doc.querySelectorAll('#card-list .notes-card')];
      assert.equal(cards.length, 2);
      const topId = cards[0].dataset.cardId;
      const bottomId = cards[1].dataset.cardId;

      // 1. Click card body -> inline edit -> Save
      cards[0].querySelector('.notes-card-body').click();
      const editInput = doc.querySelector('#card-list .notes-edit-textarea');
      assert.ok(editInput, 'Expected inline edit textarea');
      editInput.value = 'Edited top card text #bug #mcp';
      doc.querySelector('#card-list [data-edit-action="save"]').click();
      await flushAsync();
      assert.equal(stateSync.getState().cards.find((c) => c.id === topId).text, 'Edited top card text #bug #mcp');

      // 2. Pointer drag-reorder via .notes-drag-handle
      cards = [...doc.querySelectorAll('#card-list .notes-card')];
      cards[0].getBoundingClientRect = () => ({ top: 100, bottom: 160, height: 60, left: 0, width: 280 });
      cards[1].getBoundingClientRect = () => ({ top: 166, bottom: 226, height: 60, left: 0, width: 280 });
      const dragHandle = cards[0].querySelector('.notes-drag-handle');
      assert.ok(dragHandle, 'Expected .notes-drag-handle on active card');
      dragHandle.dispatchEvent(new win.PointerEvent('pointerdown', { button: 0, clientY: 120, pointerId: 1, bubbles: true }));
      win.dispatchEvent(new win.PointerEvent('pointermove', { clientY: 215, pointerId: 1, bubbles: true }));
      win.dispatchEvent(new win.PointerEvent('pointerup', { clientY: 215, pointerId: 1, bubbles: true }));
      await flushAsync();

      const reorderedDomIds = [...doc.querySelectorAll('#card-list .notes-card')].map((el) => el.dataset.cardId);
      assert.deepEqual(reorderedDomIds, [bottomId, topId]);

      // 3. Origin conversation pill jump
      doc.querySelector('#card-list .notes-origin-btn').click();
      assert.equal(
        postedMessages.some((m) => m.type === 'toggle-conversation' && m.payload?.conversationId === '11111111-2222-3333-4444-555555555555'),
        true
      );

      // 4. Export Stash (.md) from Settings -> opens 3-item Export menu (Save As..., Save to Downloads, Copy as Markdown)
      doc.getElementById('export-stash-btn').click();
      const dlItem = doc.querySelector('.agy-context-menu [data-menu-action="downloads"]');
      assert.ok(dlItem, 'Expected Save to Downloads item in Export menu');
      assert.ok(doc.querySelector('.agy-context-menu [data-menu-action="save-as"]'), 'Expected Save As… item in Export menu');
      assert.ok(doc.querySelector('.agy-context-menu [data-menu-action="copy-md"]'), 'Expected Copy as Markdown item in Export menu');
      dlItem.click();
      await flushAsync();
      assert.equal(win.Notes.state.lastDownload?.filename, 'notes-stash.md');
      assert.match(win.Notes.state.lastDownload?.content || '', /Edited top card text/);
      assert.equal(existsSync(win.Notes.state.lastDownload?.path || ''), true, 'Expected notes-stash.md written to Downloads');
      assert.match(doc.querySelector('.agy-toast')?.textContent || '', /Saved .*notes-stash\.md/);
      assert.ok(doc.querySelector('.agy-toast [data-action="copy-export-path"]'), 'Expected Copy Path button in export toast');

      // 5. Mark one sent, switch to Sent view, and Clear Sent
      doc.querySelector('#card-list .notes-send-btn').click();
      await flushAsync();
      doc.querySelector('#status-toggle [data-toggle-id="sent"]').click();
      assert.equal(doc.querySelectorAll('#card-list .notes-card').length, 1);
      doc.getElementById('clear-sent-btn').click();
      await flushAsync();
      assert.equal(stateSync.getState().cards.filter((c) => c.status === 'sent').length, 0);
    } finally {
      await env.cleanup();
    }
  });

  it('connects EventSource to /api/events, applies live SSE state broadcasts, recolors inline #tag spans, and pauses SSE on sidecar-visibility=false', async () => {
    const env = await createStashTestEnv({ enableMockEventSource: true });
    try {
      const { win, doc, sseInstances } = env;
      assert.equal(sseInstances.length, 1);
      assert.match(sseInstances[0].url, /\/api\/events\?/);

      // Push live named 'state' event over SSE (StateSync emits `event: state\ndata: ...\n\n`, which does NOT fire .onmessage)
      sseInstances[0].dispatchSseEvent('state', {
        data: JSON.stringify({
          version: 3,
          state: {
            ...win.Notes.state,
            tagColors: { perf: 'amber' },
            cards: [
              {
                id: 'sse-card-1',
                text: 'Investigate flamegraph spike #perf',
                tags: ['perf'],
                color: 'auto',
                scope: 'workspace',
                workspacePath: 'c:/Users/dev/antigravity-notes',
                workspaceName: 'antigravity-notes',
                originConversationId: '11111111-2222-3333-4444-555555555555',
                originConversationTitle: 'Notes UI Thread',
                status: 'active',
                order: 1000,
                createdAt: Date.now(),
                updatedAt: Date.now(),
              },
            ],
          },
        }),
      });

      const inlineTag = doc.querySelector('#card-list [data-inline-tag="perf"]');
      assert.ok(inlineTag, 'Expected inline #perf tag span from SSE state');
      assert.equal(inlineTag.classList.contains('notes-hue-amber'), true);

      // Right-click inline #perf span inside card body -> recolor to blue
      inlineTag.dispatchEvent(new win.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 50, clientY: 80 }));
      doc.querySelector('.notes-swatch-menu [data-swatch-id="blue"]').click();
      await flushAsync();
      assert.equal(win.Notes.state.tagColors.perf, 'blue');

      // Hangar sidecar-visibility=false flushes Scratchpad and closes SSE stream
      let flushed = false;
      win.Notes.flushPendingScratchpadSave = () => {
        flushed = true;
      };
      const hideEv = new win.Event('message');
      hideEv.data = { type: 'sidecar-visibility', payload: { visible: false } };
      hideEv.source = win.parent;
      win.dispatchEvent(hideEv);
      assert.equal(flushed, true);
      assert.equal(sseInstances[0].closed, true);
    } finally {
      await env.cleanup();
    }
  });

  it('hit-tests 2D horizontal + vertical card boxes during multi-column Grid pointer drag-reorder (Finding #2)', async () => {
    const env = await createStashTestEnv({
      seedActions: [
        {
          action: 'stash-add',
          payload: {
            text: 'Row 2 Col 1 card C',
            workspacePath: 'c:/Users/dev/antigravity-notes',
            originConversationId: '11111111-2222-3333-4444-555555555555',
          },
        },
        {
          action: 'stash-add',
          payload: {
            text: 'Row 1 Col 2 card B',
            workspacePath: 'c:/Users/dev/antigravity-notes',
            originConversationId: '11111111-2222-3333-4444-555555555555',
          },
        },
        {
          action: 'stash-add',
          payload: {
            text: 'Row 1 Col 1 card A',
            workspacePath: 'c:/Users/dev/antigravity-notes',
            originConversationId: '11111111-2222-3333-4444-555555555555',
          },
        },
      ],
    });
    try {
      const { win, doc, apiRequests } = env;
      const stub2ColGridRects = () => {
        const current = [...doc.querySelectorAll('#card-list .notes-card')];
        // Row 0: col 1 (10..270, 100..170), col 2 (280..540, 100..170); Row 1: col 1 (10..270, 180..250)
        current[0].getBoundingClientRect = () => ({ left: 10, right: 270, width: 260, top: 100, bottom: 170, height: 70 });
        current[1].getBoundingClientRect = () => ({ left: 280, right: 540, width: 260, top: 100, bottom: 170, height: 70 });
        current[2].getBoundingClientRect = () => ({ left: 10, right: 270, width: 260, top: 180, bottom: 250, height: 70 });
        return current;
      };

      let cards = stub2ColGridRects();
      const [idA, idB, idC] = cards.map((el) => el.dataset.cardId);
      const countReorders = () =>
        apiRequests.filter((r) => r.pathname === '/api/mutate' && r.body?.action === 'stash-reorder').length;

      // 0a. Moving trailing solo card C slightly inside C's own rect (clientX=22, clientY=200) must NOT snap up to Row 0 or reorder
      cards[2].querySelector('.notes-drag-handle').dispatchEvent(
        new win.PointerEvent('pointerdown', { button: 0, clientX: 20, clientY: 200, pointerId: 10, bubbles: true })
      );
      win.dispatchEvent(new win.PointerEvent('pointermove', { clientX: 22, clientY: 200, pointerId: 10, bubbles: true }));
      assert.equal(doc.querySelector('.notes-card-drag-ghost'), null, 'Below 5px threshold must not spawn drag ghost');
      win.dispatchEvent(new win.PointerEvent('pointerup', { clientX: 22, clientY: 200, pointerId: 10, bubbles: true }));
      await flushAsync();
      assert.equal(countReorders(), 0, 'Moving inside trailing solo card C must not trigger stash-reorder');
      assert.deepEqual(
        [...doc.querySelectorAll('#card-list .notes-card')].map((el) => el.dataset.cardId),
        [idA, idB, idC]
      );

      // 0b. Moving trailing solo card C into the empty second column on Row 1 (clientX=310, clientY=200) must ALSO NOT snap up to Row 0 or reorder
      cards = stub2ColGridRects();
      cards[2].querySelector('.notes-drag-handle').dispatchEvent(
        new win.PointerEvent('pointerdown', { button: 0, clientX: 20, clientY: 200, pointerId: 11, bubbles: true })
      );
      win.dispatchEvent(new win.PointerEvent('pointermove', { clientX: 310, clientY: 200, pointerId: 11, bubbles: true }));
      assert.ok(doc.querySelector('.notes-card-drag-ghost'), 'Expected floating drag ghost past 5px threshold');
      assert.equal(cards[2].classList.contains('is-drag-placeholder'), true);
      win.dispatchEvent(new win.PointerEvent('pointerup', { clientX: 310, clientY: 200, pointerId: 11, bubbles: true }));
      await flushAsync();
      assert.equal(doc.querySelector('.notes-card-drag-ghost'), null, 'Ghost cleaned up on pointerup');
      assert.equal(countReorders(), 0, 'Hovering empty column beside trailing solo card C must not trigger stash-reorder');
      assert.deepEqual(
        [...doc.querySelectorAll('#card-list .notes-card')].map((el) => el.dataset.cardId),
        [idA, idB, idC]
      );

      // 0c. Pressing Escape mid-drag restores initial DOM order and cancels reorder mutation
      cards = stub2ColGridRects();
      cards[2].querySelector('.notes-drag-handle').dispatchEvent(
        new win.PointerEvent('pointerdown', { button: 0, clientX: 20, clientY: 200, pointerId: 12, bubbles: true })
      );
      win.dispatchEvent(new win.PointerEvent('pointermove', { clientX: 310, clientY: 120, pointerId: 12, bubbles: true }));
      assert.deepEqual(
        [...doc.querySelectorAll('#card-list .notes-card')].map((el) => el.dataset.cardId),
        [idA, idC, idB],
        'Expected live slot preview before Escape'
      );
      win.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      await flushAsync();
      assert.equal(countReorders(), 0, 'Escape cancel must not trigger stash-reorder');
      assert.deepEqual(
        [...doc.querySelectorAll('#card-list .notes-card')].map((el) => el.dataset.cardId),
        [idA, idB, idC],
        'Escape cancel must restore original DOM order'
      );

      // 1. Drag Row 1 card C up onto LEFT half of Row 0 Col 2 (card B, clientX=310 < midpoint 410, clientY=120) -> live-swaps BEFORE card B: [A, C, B]
      cards = stub2ColGridRects();
      cards[2].querySelector('.notes-drag-handle').dispatchEvent(
        new win.PointerEvent('pointerdown', { button: 0, clientX: 20, clientY: 200, pointerId: 1, bubbles: true })
      );
      win.dispatchEvent(new win.PointerEvent('pointermove', { clientX: 310, clientY: 120, pointerId: 1, bubbles: true }));
      assert.deepEqual(
        [...doc.querySelectorAll('#card-list .notes-card')].map((el) => el.dataset.cardId),
        [idA, idC, idB],
        'Expected live slot swap before Col 2 card B without targeting Col 1 card A'
      );
      win.dispatchEvent(new win.PointerEvent('pointerup', { clientX: 310, clientY: 120, pointerId: 1, bubbles: true }));
      await flushAsync();

      assert.deepEqual(
        [...doc.querySelectorAll('#card-list .notes-card')].map((el) => el.dataset.cardId),
        [idA, idC, idB]
      );

      // 2. Re-stub rects on [A, C, B] and drag Row 1 Col 1 (card A, from card body!) onto RIGHT half of Row 1 Col 2 (card C, clientX=490 >= midpoint 410, clientY=120) -> inserts AFTER card C: [C, A, B]
      cards = stub2ColGridRects();
      cards[0].querySelector('.notes-card-body').dispatchEvent(
        new win.PointerEvent('pointerdown', { button: 0, clientX: 20, clientY: 120, pointerId: 2, bubbles: true })
      );
      win.dispatchEvent(new win.PointerEvent('pointermove', { clientX: 490, clientY: 120, pointerId: 2, bubbles: true }));
      assert.deepEqual(
        [...doc.querySelectorAll('#card-list .notes-card')].map((el) => el.dataset.cardId),
        [idC, idA, idB],
        'Expected live slot swap after Col 2 card C'
      );
      win.dispatchEvent(new win.PointerEvent('pointerup', { clientX: 490, clientY: 120, pointerId: 2, bubbles: true }));
      cards[0].querySelector('.notes-card-body').click();
      assert.equal(doc.querySelector('#card-list .notes-edit-textarea'), null, 'Post-drag click suppression must prevent accidental inline edit');
      await flushAsync();

      assert.deepEqual(
        [...doc.querySelectorAll('#card-list .notes-card')].map((el) => el.dataset.cardId),
        [idC, idA, idB]
      );
    } finally {
      await env.cleanup();
    }
  });

  it('switches scope from unsaved _new chat to workspace or global on composer submit so newly stashed cards are immediately visible', async () => {
    const env = await createStashTestEnv({ conversationId: '_new' });
    try {
      const { win, doc, emitWorkspaceChange } = env;
      doc.querySelector('#stash-scope-toggle [data-toggle-id="chat"]').click();
      assert.equal(win.Notes.state.stashFilter, 'chat');
      assert.equal(win.Notes.state.conversationId, '');

      const input = doc.getElementById('stash-composer-input');
      const form = doc.getElementById('stash-composer-form');
      input.value = 'Parked from unsaved _new chat #idea';
      input.dispatchEvent(new win.Event('input', { bubbles: true }));
      form.dispatchEvent(new win.Event('submit', { bubbles: true, cancelable: true }));
      await flushAsync();

      assert.equal(win.Notes.state.stashFilter, 'workspace', 'Expected stashFilter to switch from _new chat to workspace');
      assert.equal(
        doc.querySelector('#stash-scope-toggle [data-toggle-id="workspace"]').classList.contains('active'),
        true,
        'Stash scope toggle must sync to Project'
      );
      const wsCards = [...doc.querySelectorAll('#card-list .notes-card')];
      assert.equal(wsCards.length, 1);
      assert.match(wsCards[0].textContent, /Parked from unsaved _new chat/);

      // Repeat with no workspace open -> switches from _new chat to all filter
      emitWorkspaceChange([]);
      await flushAsync();
      doc.querySelector('#stash-scope-toggle [data-toggle-id="chat"]').click();
      assert.equal(win.Notes.state.stashFilter, 'chat');

      input.value = 'Parked with no folder open in _new chat #later';
      input.dispatchEvent(new win.Event('input', { bubbles: true }));
      form.dispatchEvent(new win.Event('submit', { bubbles: true, cancelable: true }));
      await flushAsync();

      assert.equal(win.Notes.state.stashFilter, 'all', 'Expected stashFilter to switch from _new chat to all when no workspace is open');
      const allCards = [...doc.querySelectorAll('#card-list .notes-card')];
      assert.equal(allCards.length, 2, 'All scope shows both the newly parked General card and the earlier workspace card');
      assert.match(allCards[0].textContent, /Parked with no folder open in _new chat/);
    } finally {
      await env.cleanup();
    }
  });

  it('implements Project | Chat | All zoom-out hierarchy with detached General capture and zero All-workspaces chip', async () => {
    const env = await createStashTestEnv({
      workspaceUris: [
        'file:///C%3A/Users/dev/antigravity-notes/',
        'file:///C%3A/Users/dev/antigravity-sidecar-kit/',
      ],
      projects: [
        {
          id: 'proj-toolkit',
          name: 'Antigravity Toolkit',
          projectResources: {
            resources: [
              { gitFolder: { folderUri: 'file:///c%3A/Users/dev/antigravity-notes' } },
              { gitFolder: { folderUri: 'file:///c%3A/Users/dev/antigravity-sidecar-kit' } },
            ],
          },
        },
      ],
      seedActions: [
        {
          action: 'stash-add',
          payload: {
            text: 'Current project card #todo',
            scope: 'workspace',
            workspacePath: 'c:/Users/dev/antigravity-notes',
            workspaceName: 'antigravity-notes',
            originConversationId: '11111111-2222-3333-4444-555555555555',
            originConversationTitle: 'Notes Build Thread',
          },
        },
        {
          action: 'stash-add',
          payload: {
            text: 'Other project card #perf',
            scope: 'workspace',
            workspacePath: 'c:/Users/dev/IdeaProjects/other-project',
            workspaceName: 'other-project',
            originConversationId: '99999999-2222-3333-4444-555555555555',
            originConversationTitle: 'Other Repo Thread',
          },
        },
      ],
    });
    try {
      const { win, doc, stateSync } = env;

      // 1. In Project filter, hover title shows exact Project name and only current project card is visible
      assert.equal(win.Notes.state.stashFilter, 'workspace');
      assert.equal(
        doc.querySelector('#stash-scope-toggle [data-toggle-id="workspace"]').getAttribute('title'),
        'Project: Antigravity Toolkit'
      );
      assert.equal(doc.querySelectorAll('#card-list .notes-card').length, 1);

      // 2. Switch Stash filter to All -> pure view filter! Shows every project's cards while keeping composer target defaulted to Project
      doc.querySelector('#stash-scope-toggle [data-toggle-id="all"]').click();
      assert.equal(win.Notes.state.stashFilter, 'all');
      assert.equal(win.Notes.state.composerTarget, 'workspace', 'Viewing All must NOT implicitly flip composer target away from Project');
      assert.equal(doc.querySelector('#tag-strip [data-strip-key="all-ws"]'), null, 'All workspaces pill must not exist');
      assert.equal(doc.querySelectorAll('#card-list .notes-card').length, 2, 'All filter must show cards from every project immediately');

      // 3. Stashing while viewing All WITHOUT toggling target saves to the active Project (Antigravity Toolkit)
      const input = doc.getElementById('stash-composer-input');
      const form = doc.getElementById('stash-composer-form');
      input.value = 'Project idea typed while browsing All #todo';
      input.dispatchEvent(new win.Event('input', { bubbles: true }));
      form.dispatchEvent(new win.Event('submit', { bubbles: true, cancelable: true }));
      await flushAsync();

      const projWhileAllCard = stateSync.getState().cards.find((c) => c.text.includes('Project idea typed while browsing All'));
      assert.equal(projWhileAllCard.scope, 'workspace', 'Stashing while browsing All saves to Project by default');
      assert.equal(projWhileAllCard.workspaceName, 'Antigravity Toolkit');

      // 4. Explicitly clicking #composer-target-btn toggles destination to General (unattached to project or chat)
      doc.querySelector('#stash-scope-toggle [data-toggle-id="workspace"]').click();
      assert.equal(win.Notes.state.stashFilter, 'workspace');
      const targetBtn = doc.getElementById('composer-target-btn');
      assert.ok(targetBtn, 'Expected #composer-target-btn in composer footer');
      assert.match(targetBtn.textContent, /Antigravity Toolkit/);
      targetBtn.click();
      assert.equal(win.Notes.state.composerTarget, 'global');
      assert.match(targetBtn.textContent, /General/);

      input.value = 'General cross-project reminder #idea';
      input.dispatchEvent(new win.Event('input', { bubbles: true }));
      form.dispatchEvent(new win.Event('submit', { bubbles: true, cancelable: true }));
      await flushAsync();

      assert.equal(win.Notes.state.stashFilter, 'all', 'Submitting an explicit General card while in Project filter switches view to All so the card is visible');
      assert.equal(win.Notes.state.composerTarget, 'workspace', 'Composer target resets to Project after submit');
      const allVisible = [...doc.querySelectorAll('#card-list .notes-card')];
      assert.equal(allVisible.length, 4);
      const generalCardState = stateSync.getState().cards.find((c) => c.text.includes('General cross-project reminder'));
      assert.equal(generalCardState.scope, 'global');
      assert.equal(generalCardState.originConversationId, '', 'General card must not link to active chat');
      assert.equal(generalCardState.workspacePath, '', 'General card must not attach to active project');

      const generalDomCard = allVisible.find((el) => el.textContent.includes('General cross-project reminder'));
      const originLabel = generalDomCard.querySelector('.notes-origin-label')?.textContent || '';
      assert.match(originLabel, /^General · /);
      assert.equal(generalDomCard.querySelector('.notes-origin-title')?.textContent, 'General');
      assert.match(generalDomCard.querySelector('.notes-origin-age')?.textContent || '', /^ · /);
      assert.equal(generalDomCard.querySelector('.notes-origin-btn')?.disabled, true);
      assert.ok(doc.querySelector('.notes-filter-row > #tag-strip'), 'Expected #tag-strip inside .notes-filter-row for inline wide layout');

      const otherDomCard = allVisible.find((el) => el.textContent.includes('Other project card'));
      assert.match(otherDomCard.querySelector('.notes-origin-label')?.textContent || '', /other-project › Other Repo Thread/);

      // 5. Switching to Chat or Project must NOT include the detached General card
      doc.querySelector('#stash-scope-toggle [data-toggle-id="chat"]').click();
      assert.doesNotMatch(doc.getElementById('card-list').textContent, /General cross-project reminder/);

      doc.querySelector('#stash-scope-toggle [data-toggle-id="workspace"]').click();
      assert.equal(doc.querySelectorAll('#card-list .notes-card').length, 2);
      assert.doesNotMatch(doc.getElementById('card-list').textContent, /General cross-project reminder/);
    } finally {
      await env.cleanup();
    }
  });

  it('preserves mounted inline edit <textarea> and cleared/draft value across live SSE updates and prevents duplicate Save mutations', async () => {
    const env = await createStashTestEnv({
      enableMockEventSource: true,
      seedActions: [
        {
          action: 'stash-add',
          payload: {
            text: 'Second card B #later',
            workspacePath: 'c:/Users/dev/antigravity-notes',
            originConversationId: '11111111-2222-3333-4444-555555555555',
          },
        },
        {
          action: 'stash-add',
          payload: {
            text: 'First card A being edited #bug',
            workspacePath: 'c:/Users/dev/antigravity-notes',
            originConversationId: '11111111-2222-3333-4444-555555555555',
          },
        },
      ],
    });
    try {
      const { win, doc, stateSync, apiRequests, sseInstances } = env;
      const cards = [...doc.querySelectorAll('#card-list .notes-card')];
      assert.equal(cards.length, 2);
      const cardAId = cards[0].dataset.cardId;
      const cardBId = cards[1].dataset.cardId;

      cards[0].querySelector('.notes-card-body').click();
      const editArea = doc.querySelector('#card-list .notes-edit-textarea');
      assert.ok(editArea, 'Expected inline edit textarea on card A');
      assert.equal(editArea.value, 'First card A being edited #bug');

      // 1. Clear textarea to '' and dispatch live SSE update on card B + new card C
      editArea.value = '';
      editArea.dispatchEvent(new win.Event('input', { bubbles: true }));

      const serverState = stateSync.getState();
      const updatedCards = [
        {
          id: 'sse-inserted-top',
          text: 'Live SSE top card #mcp',
          tags: ['mcp'],
          color: 'auto',
          scope: 'workspace',
          workspacePath: 'c:/Users/dev/antigravity-notes',
          workspaceName: 'antigravity-notes',
          originConversationId: '11111111-2222-3333-4444-555555555555',
          originConversationTitle: 'Notes UI Thread',
          status: 'active',
          order: -5000,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
        ...serverState.cards.map((c) => (c.id === cardBId ? { ...c, text: 'Second card B updated over SSE #later' } : c)),
      ];
      sseInstances[0].dispatchSseEvent('state', {
        data: JSON.stringify({
          version: 10,
          state: { ...serverState, cards: updatedCards },
        }),
      });

      const afterClearSseArea = doc.querySelector('#card-list .notes-edit-textarea');
      assert.equal(afterClearSseArea, editArea, 'Exact <textarea> DOM node reference must survive SSE re-render');
      assert.equal(afterClearSseArea.value, '', 'Cleared empty draft value must NOT resurrect card.text');
      assert.equal(doc.querySelectorAll('#card-list .notes-card').length, 3);

      // 2. Type draft text, dispatch another SSE update, and verify draft value + DOM node survive intact
      editArea.value = 'Saved once after rapid double click #ship';
      editArea.dispatchEvent(new win.Event('input', { bubbles: true }));
      sseInstances[0].dispatchSseEvent('state', {
        data: JSON.stringify({
          version: 11,
          state: { ...serverState, tagColors: { ...serverState.tagColors, bug: 'violet' }, cards: updatedCards },
        }),
      });
      assert.equal(doc.querySelector('#card-list .notes-edit-textarea'), editArea);
      assert.equal(editArea.value, 'Saved once after rapid double click #ship');

      // 3. Gate stash-update and click Save twice rapidly -> must emit only 1 stash-update request
      const baseFetch = win.fetch.bind(win);
      let gatedStashUpdates = 0;
      let releaseSave = null;
      win.fetch = async (inputUrl, init = {}) => {
        if (typeof init?.body === 'string' && init.body.includes('"stash-update"')) {
          gatedStashUpdates += 1;
          await new Promise((resolve) => {
            releaseSave = resolve;
          });
        }
        return baseFetch(inputUrl, init);
      };

      const saveBtn = doc.querySelector('#card-list [data-edit-action="save"]');
      saveBtn.click();
      saveBtn.click();
      await flushAsync(2);

      assert.equal(gatedStashUpdates, 1, 'Rapid double Save click must invoke stash-update fetch only once');

      releaseSave?.();
      await flushAsync();
      const updateCalls = apiRequests.filter((r) => r.pathname === '/api/mutate' && r.body?.action === 'stash-update');
      assert.equal(updateCalls.length, 1, 'Rapid double Save click must fire only 1 stash-update mutation');
      assert.equal(
        stateSync.getState().cards.find((c) => c.id === cardAId)?.text,
        'Saved once after rapid double click #ship'
      );
    } finally {
      await env.cleanup();
    }
  });
});

describe('Markdown Preview Cards, Smart List Editing & Tall Card Clamping', () => {
  it('supports smart list Shift+Enter/Tab/Shift+Tab without trapping Tab on prose, renders interactive Markdown cards, and clamps tall cards with Show more/less', async () => {
    const tallText = Array.from({ length: 10 }, (_, idx) => `${idx + 1}. Detailed rollout step ${idx + 1}`).join('\n');
    const env = await createStashTestEnv({
      seedActions: [
        {
          action: 'stash-add',
          payload: {
            text: '- [ ] Wire parser #mcp\n- [x] Ship CSS',
            workspacePath: 'c:/Users/dev/antigravity-notes',
            originConversationId: '11111111-2222-3333-4444-555555555555',
          },
        },
        {
          action: 'stash-add',
          payload: {
            text: tallText,
            workspacePath: 'c:/Users/dev/antigravity-notes',
            originConversationId: '11111111-2222-3333-4444-555555555555',
          },
        },
      ],
    });
    try {
      const { win, doc, stateSync } = env;
      const input = doc.getElementById('stash-composer-input');

      // 1. Plain Tab on non-list prose must NOT preventDefault() (no keyboard focus trap)
      input.value = 'Plain prose note';
      input.selectionStart = input.value.length;
      input.selectionEnd = input.value.length;
      const proseTab = new win.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
      input.dispatchEvent(proseTab);
      assert.equal(proseTab.defaultPrevented, false, 'Plain prose Tab must not trap focus');

      // 2. Shift+Enter continues numbered list -> Tab cycles 1. -> '   a. ' -> '      i. ' -> Shift+Tab & Shift+Enter step back up
      input.value = '1. Step one';
      input.selectionStart = input.value.length;
      input.selectionEnd = input.value.length;

      const shiftEnter1 = new win.KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true, cancelable: true });
      input.dispatchEvent(shiftEnter1);
      assert.equal(shiftEnter1.defaultPrevented, true);
      assert.equal(input.value, '1. Step one\n2. ');

      const listTab1 = new win.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
      input.dispatchEvent(listTab1);
      assert.equal(listTab1.defaultPrevented, true);
      assert.equal(input.value, '1. Step one\n   a. ');

      input.value = '1. Step one\n   a. Sub one';
      input.selectionStart = input.value.length;
      input.selectionEnd = input.value.length;
      input.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true, cancelable: true }));
      assert.equal(input.value, '1. Step one\n   a. Sub one\n   b. ');

      input.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
      assert.equal(input.value, '1. Step one\n   a. Sub one\n      i. ');

      const listOutdent = new win.KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true });
      input.dispatchEvent(listOutdent);
      assert.equal(listOutdent.defaultPrevented, true);
      assert.equal(input.value, '1. Step one\n   a. Sub one\n   b. ');

      // Shift+Enter on empty '   b. ' outdents to '2. ', second Shift+Enter exits list
      input.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true, cancelable: true }));
      assert.equal(input.value, '1. Step one\n   a. Sub one\n2. ');
      input.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true, cancelable: true }));
      assert.equal(input.value, '1. Step one\n   a. Sub one\n');

      // Alphabetic list continuation in composer
      input.value = 'a. Alpha';
      input.selectionStart = input.value.length;
      input.selectionEnd = input.value.length;
      input.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true, cancelable: true }));
      assert.equal(input.value, 'a. Alpha\nb. ');

      // 3. Tall card (card 0, seeded last so ordered first) is clamped with Show more / Show less toggle
      const cards = [...doc.querySelectorAll('#card-list .notes-card')];
      assert.equal(cards.length, 2);
      const tallCard = cards.find((el) => el.textContent.includes('Detailed rollout step 10'));
      const mdCard = cards.find((el) => el.textContent.includes('Wire parser'));
      assert.ok(tallCard, 'Expected tall card');
      assert.ok(mdCard, 'Expected markdown task card');

      assert.equal(tallCard.classList.contains('is-card-clamped'), true);
      assert.equal(tallCard.classList.contains('is-card-expanded'), false);
      const tallExpandBtn = tallCard.querySelector('.notes-card-expand-btn');
      assert.equal(tallExpandBtn.classList.contains('hidden'), false);
      assert.equal(tallExpandBtn.getAttribute('aria-expanded'), 'false');
      assert.match(tallExpandBtn.textContent, /Show more/);

      const shortExpandBtn = mdCard.querySelector('.notes-card-expand-btn');
      assert.equal(shortExpandBtn.classList.contains('hidden'), true);

      tallExpandBtn.click();
      assert.equal(tallCard.classList.contains('is-card-expanded'), true);
      assert.equal(tallExpandBtn.getAttribute('aria-expanded'), 'true');
      assert.match(tallExpandBtn.textContent, /Show less/);
      assert.equal(doc.querySelector('#card-list .notes-edit-textarea'), null, 'Expand toggle must not open inline edit');

      // 4. Rendered Markdown card toggles interactive - [ ] checkbox in place, and click-to-edit opens raw Markdown
      const taskBoxes = [...mdCard.querySelectorAll('.notes-card-body input[type="checkbox"][data-task-line]')];
      assert.equal(taskBoxes.length, 2);
      assert.ok(mdCard.querySelector('.notes-inline-tag[data-inline-tag="mcp"]'), 'Expected inline #mcp pill inside rendered Markdown');

      taskBoxes[0].click();
      await flushAsync();
      assert.equal(doc.querySelector('#card-list .notes-edit-textarea'), null, 'Task checkbox click must not open inline edit');
      const updatedMdCardState = stateSync.getState().cards.find((c) => c.id === mdCard.dataset.cardId);
      assert.equal(updatedMdCardState.text, '- [x] Wire parser #mcp\n- [x] Ship CSS');

      const refreshedMdCard = doc.querySelector(`#card-list .notes-card[data-card-id="${mdCard.dataset.cardId}"]`);
      refreshedMdCard.querySelector('.notes-card-body').click();
      const rawEditor = doc.querySelector('#card-list .notes-edit-textarea');
      assert.ok(rawEditor, 'Clicking card body text must open raw Markdown inline editor');
      assert.equal(rawEditor.value, '- [x] Wire parser #mcp\n- [x] Ship CSS');
    } finally {
      await env.cleanup();
    }
  });
});

