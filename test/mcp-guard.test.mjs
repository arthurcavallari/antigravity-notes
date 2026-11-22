import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, it } from 'node:test';
import { FallbackResponse, StandaloneSidecarApp } from 'antigravity-sidecar-kit/server';
import { StateSync, writeJsonAtomic, writeServerInfo } from 'antigravity-sidecar-kit/state-sync';
import { PALETTE_COLOR_IDS, REPO_ROOT, SIDECAR_ID, createInitialState } from '../lib/constants.mjs';
import { guardMcpRpc } from '../lib/mcp-guard.mjs';
import { READ_TOOL_NAMES, WRITE_TOOL_NAMES, buildNotesMcpTools } from '../lib/mcp-tools.mjs';
import { applyNotesAction, createStoreMutators } from '../lib/notes-store.mjs';
import { startNotesMcpStdio } from '../mcp.mjs';

const ALL_EXPECTED_TOOLS = [...READ_TOOL_NAMES, ...WRITE_TOOL_NAMES];

function createSeededState(mcpSettings = { mcpRead: false, mcpWrite: false }) {
  let state = createInitialState();
  state = applyNotesAction(
    state,
    'stash-add',
    {
      text: 'Secret API redesign #idea',
      color: 'auto',
      scope: 'workspace',
      workspacePath: 'c:/Users/test/repo-alpha',
      originConversationId: '11111111-2222-3333-4444-555555555555',
      originConversationTitle: 'Alpha Chat',
    },
    1000
  ).nextState;

  state = applyNotesAction(
    state,
    'stash-add',
    {
      text: 'Confidential launch checklist',
      color: 'amber',
      scope: 'global',
    },
    2000
  ).nextState;

  state = applyNotesAction(
    state,
    'pad-add',
    {
      scope: 'workspace',
      workspacePath: 'c:/Users/test/repo-alpha',
      title: 'Architecture Notes',
      content: 'TOP SECRET SCRATCHPAD CONTENT\n- private bullet one',
    },
    3000
  ).nextState;

  state = applyNotesAction(state, 'settings-update', mcpSettings, 4000).nextState;
  return state;
}

function parseStructuredReply(reply) {
  if (reply?.result?.structuredContent) {
    return reply.result.structuredContent;
  }
  const text = reply?.result?.content?.[0]?.text;
  return text ? JSON.parse(text) : null;
}

async function waitUntil(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 15);
    });
  }
  throw new Error('Timed out waiting for stdio MCP reply.');
}

describe('lib/mcp-tools.mjs — tool definitions & schemas', () => {
  it('exports frozen READ_TOOL_NAMES, WRITE_TOOL_NAMES, and zero-arg buildNotesMcpTools() with color enums', () => {
    assert.deepEqual(READ_TOOL_NAMES, ['list_stash', 'read_scratchpad', 'search_notes']);
    assert.deepEqual(WRITE_TOOL_NAMES, [
      'stash_prompt',
      'update_stash_card',
      'append_scratchpad',
      'replace_scratchpad',
    ]);
    assert.equal(Object.isFrozen(READ_TOOL_NAMES), true);
    assert.equal(Object.isFrozen(WRITE_TOOL_NAMES), true);

    const tools = buildNotesMcpTools();
    assert.equal(tools.length, 7);
    assert.deepEqual(
      tools.map((t) => t.name),
      ALL_EXPECTED_TOOLS
    );

    const expectedCardColorEnum = ['auto', 'none', ...PALETTE_COLOR_IDS];
    const expectedFilterColorEnum = ['all', 'none', ...PALETTE_COLOR_IDS];

    const stashTool = tools.find((t) => t.name === 'stash_prompt');
    const updateTool = tools.find((t) => t.name === 'update_stash_card');
    const listTool = tools.find((t) => t.name === 'list_stash');

    assert.deepEqual(stashTool.inputSchema.properties.color.enum, expectedCardColorEnum);
    assert.deepEqual(updateTool.inputSchema.properties.color.enum, expectedCardColorEnum);
    assert.deepEqual(listTool.inputSchema.properties.color.enum, expectedFilterColorEnum);
  });
});

describe('lib/mcp-guard.mjs — all 4 (mcpRead, mcpWrite) permission modes & privacy invariants', () => {
  it('Mode 1 (mcpRead: false, mcpWrite: false): exposes zero tools, strips/blocks get_state, and never forwards tool calls', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'notes-mcp-m1-'));
    let forwardedCalls = 0;
    let sync = null;
    sync = new StateSync({
      sidecarId: SIDECAR_ID,
      dataDir: tmpDir,
      initialState: createSeededState({ mcpRead: false, mcpWrite: false }),
      mutators: createStoreMutators(() => sync),
      mcpTools: buildNotesMcpTools(),
    });

    const invoke = (req) => guardMcpRpc(req, {
      getSettings: () => sync.getState().settings,
      forwardRpc: async (r) => {
        forwardedCalls += 1;
        return sync.handleMcp(r, {});
      },
    });

    try {
      const initRes = await invoke({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
      assert.equal(initRes.id, 1);
      assert.ok(initRes.result.protocolVersion);

      const notifRes = await invoke({ jsonrpc: '2.0', method: 'notifications/initialized' });
      assert.equal(notifRes, null);

      const listRes = await invoke({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
      assert.deepEqual(listRes.result.tools, []);

      const beforeBlockedCount = forwardedCalls;
      for (const toolName of ['get_state', ...READ_TOOL_NAMES, ...WRITE_TOOL_NAMES, 'unknown_tool']) {
        const res = await invoke({
          jsonrpc: '2.0',
          id: `call-${toolName}`,
          method: 'tools/call',
          params: { name: toolName, arguments: { text: 'attempt', query: 'secret' } },
        });
        assert.ok(res.error, `Expected error when calling ${toolName} with MCP off`);
        assert.equal(typeof res.error.code, 'number');
      }

      // Notification-shaped tools/call (missing id) must NOT bypass guardMcpRpc to mutate state
      const sneakyNotif = await invoke({
        jsonrpc: '2.0',
        method: 'tools/call',
        params: { name: 'stash_prompt', arguments: { text: 'Sneaky notification write' } },
      });
      assert.equal(sneakyNotif, null);
      assert.equal(forwardedCalls, beforeBlockedCount, 'Blocked tool calls must never reach forwardRpc');
      assert.equal(sync.getState().cards.length, 2);
    } finally {
      sync.dispose();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('Mode 2 (mcpRead: true, mcpWrite: false): allows read tools, strips/blocks get_state, and blocks all write tools', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'notes-mcp-m2-'));
    let forwardedToolCalls = 0;
    const sync = new StateSync({
      sidecarId: SIDECAR_ID,
      dataDir: tmpDir,
      initialState: createSeededState({ mcpRead: true, mcpWrite: false }),
      mcpTools: buildNotesMcpTools(),
    });

    const invoke = (req) => guardMcpRpc(req, {
      getSettings: () => sync.getState().settings,
      forwardRpc: async (r) => {
        if (r?.method === 'tools/call') {
          forwardedToolCalls += 1;
        }
        return sync.handleMcp(r, {});
      },
    });

    try {
      const listRes = await invoke({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
      assert.deepEqual(
        listRes.result.tools.map((t) => t.name),
        READ_TOOL_NAMES
      );

      // get_state and all write tools must be rejected before forwardRpc
      for (const blocked of ['get_state', ...WRITE_TOOL_NAMES]) {
        const res = await invoke({
          jsonrpc: '2.0',
          id: `blocked-${blocked}`,
          method: 'tools/call',
          params: { name: blocked, arguments: { text: 'nope', content: 'nope' } },
        });
        assert.ok(res.error, `Expected ${blocked} to be rejected in Read-Only mode`);
      }
      assert.equal(forwardedToolCalls, 0);

      // list_stash supports color, tag, scope, status, and attaches resolvedColor
      const violetRes = await invoke({
        jsonrpc: '2.0',
        id: 10,
        method: 'tools/call',
        params: { name: 'list_stash', arguments: { color: 'violet' } },
      });
      const violetData = parseStructuredReply(violetRes);
      assert.equal(violetData.ok, true);
      assert.equal(violetData.cards.length, 1);
      assert.equal(violetData.cards[0].resolvedColor, 'violet');
      assert.match(violetData.cards[0].text, /Secret API redesign/);

      const amberRes = await invoke({
        jsonrpc: '2.0',
        id: 11,
        method: 'tools/call',
        params: { name: 'list_stash', arguments: { color: 'amber' } },
      });
      assert.equal(parseStructuredReply(amberRes).cards.length, 1);

      // read_scratchpad reads workspace scratchpad
      const padRes = await invoke({
        jsonrpc: '2.0',
        id: 12,
        method: 'tools/call',
        params: {
          name: 'read_scratchpad',
          arguments: { scope: 'workspace', workspacePath: 'c:/Users/test/repo-alpha' },
        },
      });
      const padData = parseStructuredReply(padRes);
      assert.equal(padData.ok, true);
      assert.match(padData.content, /TOP SECRET SCRATCHPAD CONTENT/);

      // search_notes matches across cards and scratchpads
      const searchRes = await invoke({
        jsonrpc: '2.0',
        id: 13,
        method: 'tools/call',
        params: { name: 'search_notes', arguments: { query: 'secret' } },
      });
      const searchData = parseStructuredReply(searchRes);
      assert.equal(searchData.ok, true);
      assert.equal(searchData.cards.length, 1);
      assert.equal(searchData.scratchpads.length, 1);
    } finally {
      sync.dispose();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('Mode 3 (mcpRead: false, mcpWrite: true): allows write tools with zero read leakage, strips/blocks get_state & read tools', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'notes-mcp-m3-'));
    const seeded = createSeededState({ mcpRead: false, mcpWrite: true });
    const existingPrivateCardId = seeded.cards.find((c) => c.text.includes('Secret API redesign')).id;
    const existingPrivatePadId = seeded.scratchpads[0].id;
    let forwardedToolCalls = 0;

    const sync = new StateSync({
      sidecarId: SIDECAR_ID,
      dataDir: tmpDir,
      initialState: seeded,
      mcpTools: buildNotesMcpTools(),
    });

    const invoke = (req) => guardMcpRpc(req, {
      getSettings: () => sync.getState().settings,
      forwardRpc: async (r) => {
        if (r?.method === 'tools/call') {
          forwardedToolCalls += 1;
        }
        return sync.handleMcp(r, {});
      },
    });

    const assertZeroPrivateLeakage = (reply) => {
      const serialized = JSON.stringify(reply);
      assert.equal(serialized.includes('Secret API redesign'), false, 'Leaked private card #1 text');
      assert.equal(serialized.includes('Confidential launch checklist'), false, 'Leaked private card #2 text');
      assert.equal(serialized.includes('TOP SECRET SCRATCHPAD CONTENT'), false, 'Leaked private scratchpad text');
      assert.equal(serialized.includes('private bullet one'), false, 'Leaked private scratchpad line');
    };

    try {
      const listRes = await invoke({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
      assert.deepEqual(
        listRes.result.tools.map((t) => t.name),
        WRITE_TOOL_NAMES
      );

      for (const blocked of ['get_state', ...READ_TOOL_NAMES]) {
        const res = await invoke({
          jsonrpc: '2.0',
          id: `blocked-${blocked}`,
          method: 'tools/call',
          params: { name: blocked, arguments: { query: 'secret' } },
        });
        assert.ok(res.error, `Expected ${blocked} to be blocked in Write-Only mode`);
      }
      assert.equal(forwardedToolCalls, 0);

      // 1. stash_prompt accepts color: 'violet' and returns minimal ack without echoing other cards
      const stashRes = await invoke({
        jsonrpc: '2.0',
        id: 20,
        method: 'tools/call',
        params: {
          name: 'stash_prompt',
          arguments: {
            text: 'Audit retry backoff jitter #mcp',
            color: 'violet',
            scope: 'workspace',
            workspacePath: 'c:/Users/test/repo-alpha',
          },
        },
      });
      assertZeroPrivateLeakage(stashRes);
      const stashAck = parseStructuredReply(stashRes);
      assert.deepEqual(stashAck, {
        ok: true,
        id: stashAck.id,
        status: 'active',
        color: 'violet',
        resolvedColor: 'violet',
        tags: ['mcp'],
      });
      assert.equal(typeof stashAck.id, 'string');
      assert.ok(stashAck.id.length > 0);

      // 2. update_stash_card updates existing private card without echoing its text
      const markSentRes = await invoke({
        jsonrpc: '2.0',
        id: 21,
        method: 'tools/call',
        params: {
          name: 'update_stash_card',
          arguments: { id: existingPrivateCardId, color: 'emerald', status: 'sent' },
        },
      });
      assertZeroPrivateLeakage(markSentRes);
      assert.deepEqual(parseStructuredReply(markSentRes), {
        ok: true,
        id: existingPrivateCardId,
        status: 'sent',
      });

      const restoreRes = await invoke({
        jsonrpc: '2.0',
        id: 22,
        method: 'tools/call',
        params: {
          name: 'update_stash_card',
          arguments: { id: existingPrivateCardId, status: 'active' },
        },
      });
      assertZeroPrivateLeakage(restoreRes);
      assert.deepEqual(parseStructuredReply(restoreRes), {
        ok: true,
        id: existingPrivateCardId,
        status: 'active',
      });

      // 3. append_scratchpad appends to private pad without echoing pre-existing content
      const appendRes = await invoke({
        jsonrpc: '2.0',
        id: 23,
        method: 'tools/call',
        params: {
          name: 'append_scratchpad',
          arguments: {
            id: existingPrivatePadId,
            content: '- agent-added follow-up item',
          },
        },
      });
      assertZeroPrivateLeakage(appendRes);
      const appendAck = parseStructuredReply(appendRes);
      assert.equal(appendAck.ok, true);
      assert.equal(appendAck.id, existingPrivatePadId);
      assert.equal(appendAck.title, 'Architecture Notes');
      assert.equal(appendAck.scope, 'workspace');
      assert.equal(typeof appendAck.byteLength, 'number');
      assert.equal('content' in appendAck, false);

      const persistedAfterAppend = JSON.parse(readFileSync(join(tmpDir, 'state.json'), 'utf8'));
      const updatedPad = persistedAfterAppend.scratchpads.find((p) => p.id === existingPrivatePadId);
      assert.equal(
        updatedPad.content,
        'TOP SECRET SCRATCHPAD CONTENT\n- private bullet one\n- agent-added follow-up item'
      );

      // 4. replace_scratchpad overwrites without echoing pre-existing content
      const replaceRes = await invoke({
        jsonrpc: '2.0',
        id: 24,
        method: 'tools/call',
        params: {
          name: 'replace_scratchpad',
          arguments: {
            id: existingPrivatePadId,
            content: '# Fresh Pad\n',
          },
        },
      });
      assertZeroPrivateLeakage(replaceRes);
      const replaceAck = parseStructuredReply(replaceRes);
      assert.deepEqual(replaceAck, {
        ok: true,
        id: existingPrivatePadId,
        title: 'Architecture Notes',
        scope: 'workspace',
        byteLength: Buffer.byteLength('# Fresh Pad\n', 'utf8'),
      });

      // 5. Creating a named pad in a fresh scope preserves the requested title
      const namedCreateRes = await invoke({
        jsonrpc: '2.0',
        id: 25,
        method: 'tools/call',
        params: {
          name: 'append_scratchpad',
          arguments: {
            scope: 'global',
            title: 'Incident Runbook',
            content: 'Step 1: Isolate node',
          },
        },
      });
      assertZeroPrivateLeakage(namedCreateRes);
      const namedAck = parseStructuredReply(namedCreateRes);
      assert.equal(namedAck.title, 'Incident Runbook');
      assert.equal(namedAck.scope, 'global');
    } finally {
      sync.dispose();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('Mode 4 (mcpRead: true, mcpWrite: true): allows all 7 read+write tools while STILL stripping and blocking get_state', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'notes-mcp-m4-'));
    let sync = null;
    sync = new StateSync({
      sidecarId: SIDECAR_ID,
      dataDir: tmpDir,
      initialState: createSeededState({ mcpRead: true, mcpWrite: true }),
      mutators: createStoreMutators(() => sync),
      mcpTools: buildNotesMcpTools(),
    });

    let getStateForwarded = false;
    const invoke = (req) => guardMcpRpc(req, {
      getSettings: () => sync.getState().settings,
      forwardRpc: async (r) => {
        if (r?.method === 'tools/call' && r?.params?.name === 'get_state') {
          getStateForwarded = true;
        }
        return sync.handleMcp(r, {});
      },
    });

    try {
      const listRes = await invoke({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
      const listedNames = listRes.result.tools.map((t) => t.name);
      assert.deepEqual(listedNames, ALL_EXPECTED_TOOLS);
      assert.equal(listedNames.includes('get_state'), false, 'get_state must NEVER appear in tools/list');

      const getStateRes = await invoke({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'get_state', arguments: {} },
      });
      assert.ok(getStateRes.error, 'get_state must ALWAYS be blocked even when mcpRead & mcpWrite are both true');
      assert.equal(getStateForwarded, false);

      // Write then read round-trip with createStoreMutators active
      const addRes = await invoke({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'stash_prompt', arguments: { text: 'Verify dual-mode #ship', color: 'auto' } },
      });
      const addAck = parseStructuredReply(addRes);
      assert.equal(addAck.ok, true);
      assert.equal(addAck.resolvedColor, 'emerald');

      const readBackRes = await invoke({
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'list_stash', arguments: { tag: 'ship' } },
      });
      const readBack = parseStructuredReply(readBackRes);
      assert.equal(readBack.cards.length, 1);
      assert.equal(readBack.cards[0].id, addAck.id);

      // Concurrent append_scratchpad calls must serialize without lost updates
      await Promise.all([
        invoke({
          jsonrpc: '2.0',
          id: 5,
          method: 'tools/call',
          params: { name: 'append_scratchpad', arguments: { scope: 'global', content: 'Line A' } },
        }),
        invoke({
          jsonrpc: '2.0',
          id: 6,
          method: 'tools/call',
          params: { name: 'append_scratchpad', arguments: { scope: 'global', content: 'Line B' } },
        }),
      ]);
      const globalPadRes = await invoke({
        jsonrpc: '2.0',
        id: 7,
        method: 'tools/call',
        params: { name: 'read_scratchpad', arguments: { scope: 'global' } },
      });
      assert.equal(parseStructuredReply(globalPadRes).content, 'Line A\nLine B');

      // Cross-queue concurrency: interleaving queued UI mutators with MCP append_scratchpad while mutationQueue is busy
      await Promise.all([
        sync.mutate('stash-add', { text: 'In-flight UI mutation occupying mutationQueue' }),
        sync.mutate('pad-save', { scope: 'global', content: 'UI base edit' }),
        invoke({
          jsonrpc: '2.0',
          id: 8,
          method: 'tools/call',
          params: { name: 'append_scratchpad', arguments: { scope: 'global', content: 'MCP follow-up line' } },
        }),
      ]);
      const crossQueuePadRes = await invoke({
        jsonrpc: '2.0',
        id: 9,
        method: 'tools/call',
        params: { name: 'read_scratchpad', arguments: { scope: 'global' } },
      });
      assert.equal(
        parseStructuredReply(crossQueuePadRes).content,
        'UI base edit\nMCP follow-up line',
        'MCP append_scratchpad queued behind UI pad-save must not clobber UI edit'
      );

      // Concurrent named pad creation across UI/MCP mutator queue must not create duplicate titled pads
      await Promise.all([
        invoke({
          jsonrpc: '2.0',
          id: 10,
          method: 'tools/call',
          params: { name: 'append_scratchpad', arguments: { scope: 'global', title: 'Team Spec', content: 'Part 1' } },
        }),
        invoke({
          jsonrpc: '2.0',
          id: 11,
          method: 'tools/call',
          params: { name: 'append_scratchpad', arguments: { scope: 'global', title: 'Team Spec', content: 'Part 2' } },
        }),
      ]);
      const namedPads = sync.getState().scratchpads.filter((p) => p.title === 'Team Spec');
      assert.equal(namedPads.length, 1);
      assert.equal(namedPads[0].content, 'Part 1\nPart 2');

      // Online MCP writes must persist once via sync.mutators[action] (version + 1, never + 2) without top-level result bloat
      const verBeforeStash = sync.globalState.currentVersion;
      const singleStashRes = await invoke({
        jsonrpc: '2.0',
        id: 12,
        method: 'tools/call',
        params: { name: 'stash_prompt', arguments: { text: 'Single-persist check #mcp', color: 'cyan' } },
      });
      assert.equal(parseStructuredReply(singleStashRes).ok, true);
      assert.equal(
        sync.globalState.currentVersion,
        verBeforeStash + 1,
        'Online stash_prompt must increment StateSync version by 1 (not 2)'
      );
      const diskAfterStash = JSON.parse(readFileSync(join(tmpDir, 'state.json'), 'utf8'));
      assert.equal('result' in diskAfterStash, false, 'state.json must never contain top-level result after stash_prompt');
      assert.equal('lastAction' in diskAfterStash, false);

      const verBeforeAppend = sync.globalState.currentVersion;
      const singleAppendRes = await invoke({
        jsonrpc: '2.0',
        id: 13,
        method: 'tools/call',
        params: { name: 'append_scratchpad', arguments: { scope: 'global', content: 'Single-persist pad line' } },
      });
      assert.equal(parseStructuredReply(singleAppendRes).ok, true);
      assert.equal(
        sync.globalState.currentVersion,
        verBeforeAppend + 1,
        'Online append_scratchpad must increment StateSync version by 1 (not 2)'
      );
      const diskAfterAppend = JSON.parse(readFileSync(join(tmpDir, 'state.json'), 'utf8'));
      assert.equal('result' in diskAfterAppend, false, 'state.json must never contain top-level result after append_scratchpad');
      assert.equal('lastAction' in diskAfterAppend, false);
    } finally {
      sync.dispose();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('guards JSON-RPC batch arrays, ResponseClass-wrapped forwardRpc replies, and invalid tool arguments', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'notes-mcp-edge-'));
    const sync = new StateSync({
      sidecarId: SIDECAR_ID,
      dataDir: tmpDir,
      ResponseClass: FallbackResponse,
      initialState: createSeededState({ mcpRead: true, mcpWrite: false }),
      mcpTools: buildNotesMcpTools(),
    });

    const invoke = (req) => guardMcpRpc(req, {
      getSettings: async () => sync.getState().settings,
      forwardRpc: (r) => sync.handleMcp(r, {}),
    });

    try {
      // ResponseClass wrapper from StateSync must still strip get_state and write tools
      const wrappedList = await invoke({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
      assert.deepEqual(
        wrappedList.result.tools.map((t) => t.name),
        READ_TOOL_NAMES
      );

      // Invalid requests & empty batch array
      const invalidNull = await invoke(null);
      assert.equal(invalidNull.error.code, -32600);
      const invalidEmptyBatch = await invoke([]);
      assert.equal(invalidEmptyBatch.error.code, -32600);

      // Batch array with mixed ping, notification, get_state, and unauthorized write
      const batchReply = await invoke([
        { jsonrpc: '2.0', id: 10, method: 'ping' },
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        { jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'get_state', arguments: {} } },
        { jsonrpc: '2.0', id: 12, method: 'tools/call', params: { name: 'stash_prompt', arguments: { text: 'x' } } },
      ]);
      assert.equal(Array.isArray(batchReply), true);
      assert.equal(batchReply.length, 3, 'Notification inside batch must not produce an array item');
      assert.deepEqual(batchReply[0], { jsonrpc: '2.0', id: 10, result: {} });
      assert.ok(batchReply[1].error);
      assert.ok(batchReply[2].error);

      // Validation error on search_notes missing query
      const badSearch = await invoke({
        jsonrpc: '2.0',
        id: 13,
        method: 'tools/call',
        params: { name: 'search_notes', arguments: { query: '   ' } },
      });
      assert.equal(badSearch.error.code, -32602);
    } finally {
      sync.dispose();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('rejects scope === "workspace" without a valid workspacePath across read & write tools instead of touching Global Notes or leaking other workspaces', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'notes-mcp-ws-guard-'));
    let initial = createSeededState({ mcpRead: true, mcpWrite: true });
    initial = applyNotesAction(
      initial,
      'pad-add',
      { scope: 'global', title: 'Scratchpad', content: 'PRECIOUS GLOBAL SCRATCHPAD' },
      5000
    ).nextState;
    const wsPadId = initial.scratchpads.find((p) => p.scope === 'workspace').id;

    let sync = null;
    sync = new StateSync({
      sidecarId: SIDECAR_ID,
      dataDir: tmpDir,
      initialState: initial,
      mutators: createStoreMutators(() => sync),
      mcpTools: buildNotesMcpTools(),
    });

    const invoke = (req) => guardMcpRpc(req, {
      getSettings: () => sync.getState().settings,
      forwardRpc: (r) => sync.handleMcp(r, {}),
    });

    try {
      const missingWsCalls = [
        ['list_stash', { scope: 'workspace' }],
        ['list_stash', { scope: 'workspace', workspacePath: '   ' }],
        ['read_scratchpad', { scope: 'workspace' }],
        ['read_scratchpad', { scope: 'workspace', workspacePath: 'file:///' }],
        ['search_notes', { query: 'secret', scope: 'workspace' }],
        ['stash_prompt', { text: 'Should not become global', scope: 'workspace' }],
        ['append_scratchpad', { content: 'Should not append global', scope: 'workspace' }],
        ['replace_scratchpad', { content: 'Should not wipe global', scope: 'workspace' }],
      ];

      for (const [toolName, args] of missingWsCalls) {
        const res = await invoke({
          jsonrpc: '2.0',
          id: `ws-${toolName}`,
          method: 'tools/call',
          params: { name: toolName, arguments: args },
        });
        assert.ok(res.error, `Expected ${toolName} with scope="workspace" and missing workspacePath to fail`);
        assert.equal(res.error.code, -32602);
        assert.match(res.error.message, /workspacePath is required when scope is "workspace"/i);
      }

      // Global Scratchpad and card count must be 100% untouched
      const afterBlocked = sync.getState();
      assert.equal(afterBlocked.cards.length, 2);
      const globalPad = afterBlocked.scratchpads.find((p) => p.scope === 'global');
      assert.equal(globalPad.content, 'PRECIOUS GLOBAL SCRATCHPAD');

      // Explicit id on read_scratchpad / append_scratchpad / replace_scratchpad still works without workspacePath
      const readById = await invoke({
        jsonrpc: '2.0',
        id: 'by-id-read',
        method: 'tools/call',
        params: { name: 'read_scratchpad', arguments: { id: wsPadId, scope: 'workspace' } },
      });
      assert.equal(parseStructuredReply(readById).id, wsPadId);

      const appendById = await invoke({
        jsonrpc: '2.0',
        id: 'by-id-append',
        method: 'tools/call',
        params: { name: 'append_scratchpad', arguments: { id: wsPadId, scope: 'workspace', content: '- by id ok' } },
      });
      assert.equal(parseStructuredReply(appendById).ok, true);

      const replaceById = await invoke({
        jsonrpc: '2.0',
        id: 'by-id-replace',
        method: 'tools/call',
        params: { name: 'replace_scratchpad', arguments: { id: wsPadId, scope: 'workspace', content: 'Updated via id' } },
      });
      assert.equal(parseStructuredReply(replaceById).ok, true);
      assert.equal(sync.getState().scratchpads.find((p) => p.scope === 'global').content, 'PRECIOUS GLOBAL SCRATCHPAD');
    } finally {
      sync.dispose();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('mcp.mjs — startNotesMcpStdio online forwarding & offline hibernation guard', () => {
  it('enforces guardMcpRpc both online (/api/mcp) and offline (hibernated/crashed server) while dynamically re-reading state.json settings', async () => {
    // Importing mcp.mjs in tests must NOT hijack process.stdin
    assert.equal(process.stdin.listenerCount('data'), 0);

    const tmpDataDir = mkdtempSync(join(tmpdir(), 'notes-mcp-stdio-'));
    const initial = createSeededState({ mcpRead: true, mcpWrite: false });
    writeJsonAtomic(join(tmpDataDir, 'state.json'), initial);

    let app = new StandaloneSidecarApp({ port: 0, uiToken: 'live-notes-tok' });
    let liveSync = new StateSync({
      sidecarId: SIDECAR_ID,
      dataDir: tmpDataDir,
      uiAuthToken: 'live-notes-tok',
      initialState: initial,
      mcpTools: buildNotesMcpTools(),
    });

    app.api(
      '/api/mcp',
      async (data, ctx) => {
        const authErr = liveSync.checkAuth(data, ctx);
        if (authErr) {
          return authErr;
        }
        const reply = await guardMcpRpc(data, {
          getSettings: () => liveSync.getState().settings,
          forwardRpc: (r) => liveSync.handleMcp(r, ctx),
        });
        return reply ?? { ok: true };
      },
      'POST'
    );

    const input = new PassThrough();
    const output = new PassThrough();
    const outLines = [];
    let outBuf = '';
    output.on('data', (chunk) => {
      outBuf += chunk.toString('utf8');
      let nl = outBuf.indexOf('\n');
      while (nl !== -1) {
        const line = outBuf.slice(0, nl).trim();
        outBuf = outBuf.slice(nl + 1);
        if (line) {
          outLines.push(JSON.parse(line));
        }
        nl = outBuf.indexOf('\n');
      }
    });

    let stdio = null;
    try {
      const server = await app.run();
      const { port } = server.address();
      writeServerInfo(tmpDataDir, { port, token: 'live-notes-tok' });
      liveSync.start();

      stdio = startNotesMcpStdio({
        dataDir: tmpDataDir,
        forwardTimeoutMs: 400,
        input,
        output,
      });

      // 1. Online (mcpRead: true, mcpWrite: false)
      input.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
      input.write('{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n');
      input.write('{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"get_state","arguments":{}}}\n');
      input.write('{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"stash_prompt","arguments":{"text":"blocked online"}}}\n');
      input.write('{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"list_stash","arguments":{"color":"violet"}}}\n');

      await waitUntil(() => outLines.length >= 4);
      assert.equal(outLines.length, 4, 'notifications/initialized must emit no stdout line');
      assert.deepEqual(
        outLines[0].result.tools.map((t) => t.name),
        READ_TOOL_NAMES
      );
      assert.ok(outLines[1].error, 'get_state blocked online');
      assert.ok(outLines[2].error, 'stash_prompt blocked online when mcpWrite is false');
      assert.equal(parseStructuredReply(outLines[3]).cards.length, 1);

      // 2. Simulate Hangar hibernation / crash: stop HTTP server, leave stale dead-port server_info.json,
      //    and flip state.json settings to BOTH OFF (mcpRead: false, mcpWrite: false)
      liveSync.dispose();
      liveSync = null;
      await app.close();
      app = null;
      writeServerInfo(tmpDataDir, { port: 1, token: 'stale-dead-tok' });

      const bothOffState = applyNotesAction(
        JSON.parse(readFileSync(join(tmpDataDir, 'state.json'), 'utf8')),
        'settings-update',
        { mcpRead: false, mcpWrite: false }
      ).nextState;
      writeJsonAtomic(join(tmpDataDir, 'state.json'), bothOffState);

      input.write('{"jsonrpc":"2.0","id":5,"method":"tools/list"}\n');
      input.write('{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"get_state","arguments":{}}}\n');
      input.write('{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"list_stash","arguments":{}}}\n');
      input.write('{"jsonrpc":"2.0","id":8,"method":"tools/call","params":{"name":"stash_prompt","arguments":{"text":"blocked offline"}}}\n');

      await waitUntil(() => outLines.length >= 8);
      assert.deepEqual(outLines[4].result.tools, [], 'Offline tools/list must respect mcpRead=false, mcpWrite=false');
      assert.ok(outLines[5].error, 'Offline get_state must be blocked');
      assert.ok(outLines[6].error, 'Offline list_stash must be blocked when mcpRead=false');
      assert.ok(outLines[7].error, 'Offline stash_prompt must be blocked when mcpWrite=false');

      // 3. Dynamically enable Write-Only (mcpRead: false, mcpWrite: true) on disk WITHOUT restarting mcp.mjs
      const writeOnlyState = applyNotesAction(
        JSON.parse(readFileSync(join(tmpDataDir, 'state.json'), 'utf8')),
        'settings-update',
        { mcpRead: false, mcpWrite: true }
      ).nextState;
      writeJsonAtomic(join(tmpDataDir, 'state.json'), writeOnlyState);

      input.write('{"jsonrpc":"2.0","id":9,"method":"tools/list"}\n');
      input.write('{"jsonrpc":"2.0","id":10,"method":"tools/call","params":{"name":"list_stash","arguments":{}}}\n');
      input.write('{"jsonrpc":"2.0","id":11,"method":"tools/call","params":{"name":"stash_prompt","arguments":{"text":"Offline capture #bug","color":"violet"}}}\n');
      input.write('{malformed-json\n');
      input.write('{"jsonrpc":"2.0","id":12,"method":"ping"}\n');

      await waitUntil(() => outLines.length >= 13);
      assert.deepEqual(
        outLines[8].result.tools.map((t) => t.name),
        WRITE_TOOL_NAMES
      );
      assert.ok(outLines[9].error, 'list_stash must remain blocked in offline Write-Only mode');

      const offlineStashReply = outLines[10];
      const rawReplyStr = JSON.stringify(offlineStashReply);
      assert.equal(rawReplyStr.includes('Secret API redesign'), false);
      assert.equal(rawReplyStr.includes('TOP SECRET SCRATCHPAD CONTENT'), false);
      const offlineAck = parseStructuredReply(offlineStashReply);
      assert.deepEqual(offlineAck, {
        ok: true,
        id: offlineAck.id,
        status: 'active',
        color: 'violet',
        resolvedColor: 'violet',
        tags: ['bug'],
      });

      assert.equal(outLines[11].error.code, -32700);
      assert.deepEqual(outLines[12], { jsonrpc: '2.0', id: 12, result: {} });

      // Verify offline mutation persisted atomically to state.json alongside existing private cards
      const finalDiskState = JSON.parse(readFileSync(join(tmpDataDir, 'state.json'), 'utf8'));
      assert.equal(finalDiskState.cards.length, 3);
      assert.equal(finalDiskState.cards[0].id, offlineAck.id);
      assert.equal(finalDiskState.cards[0].color, 'violet');
      assert.equal(finalDiskState.tagColors.bug, 'rose');

      input.end();
      await stdio.closed;
      stdio = null;
    } finally {
      stdio?.close?.();
      liveSync?.dispose?.();
      if (app) {
        await app.close();
      }
      rmSync(tmpDataDir, { recursive: true, force: true });
      assert.equal(existsSync(tmpDataDir), false);
    }
  });

  it('runs mcp.mjs directly as a spawned CLI subprocess (Windows-safe isExecutedDirectly)', async () => {
    const tmpDataDir = mkdtempSync(join(tmpdir(), 'notes-mcp-cli-'));
    const seeded = createSeededState({ mcpRead: false, mcpWrite: true });
    writeJsonAtomic(join(tmpDataDir, 'state.json'), seeded);

    try {
      const stdoutText = await new Promise((resolvePromise, rejectPromise) => {
        const child = spawn(process.execPath, [join(REPO_ROOT, 'mcp.mjs')], {
          env: { ...process.env, ANTIGRAVITY_NOTES_DATA_DIR: tmpDataDir },
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
        });
        let out = '';
        let err = '';
        child.stdout.on('data', (c) => {
          out += c.toString('utf8');
        });
        child.stderr.on('data', (c) => {
          err += c.toString('utf8');
        });
        child.once('error', rejectPromise);
        child.once('close', (code) => {
          if (code !== 0) {
            rejectPromise(new Error(`mcp.mjs exited with code ${code}: ${err}`));
            return;
          }
          resolvePromise(out);
        });
        child.stdin.write('{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n');
        child.stdin.write('{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"get_state","arguments":{}}}\n');
        child.stdin.end();
      });

      const lines = stdoutText
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      assert.equal(lines.length, 2);
      assert.deepEqual(
        lines[0].result.tools.map((t) => t.name),
        WRITE_TOOL_NAMES
      );
      assert.ok(lines[1].error);
    } finally {
      rmSync(tmpDataDir, { recursive: true, force: true });
    }
  });

  it('drains in-flight stdio requests before closing bridge on close() and guards against double-close', async () => {
    const tmpDataDir = mkdtempSync(join(tmpdir(), 'notes-mcp-drain-'));
    const seeded = createSeededState({ mcpRead: true, mcpWrite: false });
    writeJsonAtomic(join(tmpDataDir, 'state.json'), seeded);
    const input = new PassThrough();
    const output = new PassThrough();
    const outLines = [];
    output.on('data', (chunk) => {
      for (const line of chunk.toString('utf8').split('\n')) {
        if (line.trim()) {
          outLines.push(JSON.parse(line));
        }
      }
    });

    let releaseSettings = null;
    const settingsGate = new Promise((resolve) => {
      releaseSettings = resolve;
    });
    const stdio = startNotesMcpStdio({
      dataDir: tmpDataDir,
      input,
      output,
      getSettings: async () => {
        await settingsGate;
        return { mcpRead: true, mcpWrite: false };
      },
    });

    try {
      input.write('{"jsonrpc":"2.0","id":77,"method":"tools/list"}\n');
      await new Promise((resolve) => setTimeout(resolve, 15));
      stdio.close();
      stdio.close();
      assert.equal(outLines.length, 0, 'Request is still gated when close() is called');
      releaseSettings();
      await stdio.closed;
      assert.equal(outLines.length, 1, 'In-flight request must finish writing reply before closed resolves');
      assert.equal(outLines[0].id, 77);
      assert.deepEqual(
        outLines[0].result.tools.map((t) => t.name),
        READ_TOOL_NAMES
      );
    } finally {
      stdio.close();
      rmSync(tmpDataDir, { recursive: true, force: true });
    }
  });
});
