import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, it } from 'node:test';
import { runSidecarSetup } from 'antigravity-sidecar-kit/setup';
import { writeJsonAtomic } from 'antigravity-sidecar-kit/state-sync';
import { DEFAULT_PORT, MAX_PAD_BYTES, REPO_ROOT, createInitialState } from '../lib/constants.mjs';
import { MCP_SERVER_NAME } from '../lib/mcp-config.mjs';
import { READ_TOOL_NAMES, WRITE_TOOL_NAMES } from '../lib/mcp-tools.mjs';
import { applyNotesAction } from '../lib/notes-store.mjs';
import { LAUNCHER_CONFIG, startNotesLauncher } from '../launch.mjs';
import { startNotesMcpStdio } from '../mcp.mjs';
import { createNotesServer } from '../server.mjs';
import { parseSetupFlags, runNotesSetup } from '../setup.mjs';

const UI_ROUTE_FILES = [
  ['/', 'index.html'],
  ['/index.html', 'index.html'],
  ['/styles.css', 'styles.css'],
  ['/components.css', 'components.css'],
  ['/core.js', 'core.js'],
  ['/markdown.js', 'markdown.js'],
  ['/app.js', 'app.js'],
  ['/components/swatch-picker.js', 'components/swatch-picker.js'],
  ['/components/stash-tab.js', 'components/stash-tab.js'],
  ['/components/combine-modal.js', 'components/combine-modal.js'],
  ['/components/scratchpad-tab.js', 'components/scratchpad-tab.js'],
];

function createTempUiFixture(rootDir) {
  const uiDir = join(rootDir, 'ui-fixture');
  mkdirSync(join(uiDir, 'components'), { recursive: true });
  writeFileSync(
    join(uiDir, 'index.html'),
    '<!doctype html><html><head><link rel="stylesheet" href="/styles.css"><script type="module" src="/markdown.js"></script><script defer src="/app.js"></script></head><body>Notes</body></html>',
    'utf8'
  );
  for (const [, relFile] of UI_ROUTE_FILES) {
    const full = join(uiDir, relFile);
    if (!existsSync(full)) {
      writeFileSync(full, `/* fixture ${relFile} */\n`, 'utf8');
    }
  }
  return uiDir;
}

async function postJson(baseUrl, path, body, token = '', extraHeaders = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { 'X-Sidecar-Token': token } : {}),
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  return { status: res.status, json, text };
}

describe('server.mjs — createNotesServer routes, auth, SSE, 1 MiB payloads & guarded MCP', () => {
  it('serves all static UI routes, shell/AgyUI bundles, and enforces token & loopback origin checks across all APIs', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'notes-srv-routes-'));
    const uiDir = createTempUiFixture(tmpDir);
    const dataDir = join(tmpDir, 'data');
    const token = 'notes-test-secret-token';

    const { app, stateSync } = createNotesServer({
      dataDir,
      uiDir,
      port: 0,
      uiToken: token,
    });

    try {
      const server = await app.run();
      const baseUrl = `http://127.0.0.1:${server.address().port}`;

      // All static UI routes + token injection into index.html
      for (const [routePath] of UI_ROUTE_FILES) {
        const res = await fetch(`${baseUrl}${routePath}`);
        assert.equal(res.status, 200, `Expected 200 for ${routePath}`);
        const text = await res.text();
        if (routePath === '/' || routePath === '/index.html') {
          assert.match(text, /token=notes-test-secret-token/);
        }
      }

      // AgyShell & AgyUI routes
      for (const assetRoute of ['/compiled_tailwind.css', '/shell.css', '/shell.js', '/ui.css', '/ui.js', '/preload.js']) {
        const res = await fetch(`${baseUrl}${assetRoute}`);
        assert.equal(res.status, 200, `Expected 200 for ${assetRoute}`);
      }

      // Missing/wrong token -> 401 across every API endpoint (including /mcp and /api/mcp!)
      const sseUnauth = await fetch(`${baseUrl}/api/events`);
      assert.equal(sseUnauth.status, 401);

      for (const apiPath of ['/api/mutate', '/api/context', '/api/dispatch', '/api/mcp', '/mcp']) {
        const missingTok = await postJson(baseUrl, apiPath, {});
        assert.equal(missingTok.status, 401, `Expected 401 without token on ${apiPath}`);
        const wrongTok = await postJson(baseUrl, apiPath, {}, 'wrong-token');
        assert.equal(wrongTok.status, 401, `Expected 401 with wrong token on ${apiPath}`);
      }

      // Non-loopback Origin -> 403
      const badOrigin = await postJson(baseUrl, '/api/context', {}, token, {
        Origin: 'https://evil.example.com',
      });
      assert.equal(badOrigin.status, 403);
    } finally {
      stateSync.stop();
      await app.close();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('streams SSE on /api/events, supports /api/mutate (1 MiB Scratchpad & settings-update -> syncMcpRegistration), /api/context, and /api/dispatch', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'notes-srv-api-'));
    const dataDir = join(tmpDir, 'data');
    const mcpConfigPath = join(tmpDir, 'mcp_config.json');
    const token = 'api-tok-123';
    const lsCalls = [];
    const agentCalls = [];

    const { app, stateSync } = createNotesServer({
      dataDir,
      port: 0,
      uiToken: token,
      mcpConfigPath,
      callLsRpcFn: async (method, body) => {
        lsCalls.push({ method, body });
        if (method === 'GetAllCascadeTrajectories') {
          return {
            trajectorySummaries: {
              'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee': {
                summary: 'Notes Architecture Thread',
                workspaces: [{ workspaceFolderAbsoluteUri: 'file:///C%3A/Users/dev/antigravity-notes/' }],
              },
            },
          };
        }
        return { ok: true };
      },
      agentApiFn: async (args, opts) => {
        agentCalls.push({ args, opts });
        if (args[0] === 'get-conversation-metadata') {
          return { response: { metadata: { projectId: 'proj-alpha' } } };
        }
        if (args[0] === 'SimulateUpstreamError') {
          return { error: 'Simulated upstream failure' };
        }
        if (args.includes('TRIGGER_AGENT_FAIL')) {
          return { error: 'agentapi backend unreachable' };
        }
        return { conversationId: '12345678-1234-1234-1234-123456789abc' };
      },
    });

    const sseAbort = new AbortController();
    try {
      const server = await app.run();
      const baseUrl = `http://127.0.0.1:${server.address().port}`;

      // Open live SSE stream and read initial state event
      const sseEvents = [];
      const sseRes = await fetch(`${baseUrl}/api/events?token=${token}&clientId=test-sse-1`, {
        signal: sseAbort.signal,
      });
      assert.equal(sseRes.status, 200);
      const reader = sseRes.body.getReader();
      const decoder = new TextDecoder();
      let sseBuf = '';
      const readNextSseState = async () => {
        while (true) {
          const idx = sseBuf.indexOf('\n\n');
          if (idx !== -1) {
            const chunk = sseBuf.slice(0, idx);
            sseBuf = sseBuf.slice(idx + 2);
            const dataLine = chunk.split('\n').find((l) => l.startsWith('data: '));
            if (dataLine) {
              const parsed = JSON.parse(dataLine.slice(6));
              sseEvents.push(parsed);
              return parsed;
            }
          }
          const { value, done } = await reader.read();
          if (done) {
            throw new Error('SSE stream ended prematurely');
          }
          sseBuf += decoder.decode(value, { stream: true });
        }
      };

      const initialSse = await readNextSseState();
      assert.equal(initialSse.version, 0);
      assert.deepEqual(initialSse.state.cards, []);

      // Reject missing or unknown action on /api/mutate (no raw patch bypass)
      const missingAction = await postJson(baseUrl, '/api/mutate', { settings: { mcpRead: true } }, token);
      assert.equal(missingAction.status, 400);
      const unknownAction = await postJson(baseUrl, '/api/mutate', { action: 'non-existent' }, token);
      assert.equal(unknownAction.status, 400);

      // Mutate stash-add (nested { action, payload } AND flat { action, ...fields })
      const add1 = await postJson(
        baseUrl,
        '/api/mutate',
        {
          action: 'stash-add',
          payload: {
            text: 'Verify `/api/dispatch` leading dash #bug',
            workspacePath: 'c:/Users/dev/antigravity-notes',
          },
        },
        token
      );
      assert.equal(add1.status, 200);
      assert.equal(add1.json.ok, true);
      assert.equal(add1.json.version, 1, 'Single /api/mutate must increment version by 1 (not 2)');
      assert.equal(add1.json.result.card.tags[0], 'bug');
      assert.equal('result' in add1.json.state, false, 'state must not contain duplicate result property');

      const nextSse = await readNextSseState();
      assert.equal(nextSse.version, 1);
      assert.equal(nextSse.state.cards.length, 1);

      const diskAfterAdd1 = JSON.parse(readFileSync(join(dataDir, 'state.json'), 'utf8'));
      assert.equal('result' in diskAfterAdd1, false, 'state.json must not be polluted with top-level result');

      const addFlat = await postJson(
        baseUrl,
        '/api/mutate',
        { action: 'stash-add', text: 'Flat payload stash #mcp' },
        token
      );
      assert.equal(addFlat.status, 200);
      assert.equal(addFlat.json.version, 2);
      assert.equal(addFlat.json.result.card.tags[0], 'mcp');
      const secondSse = await readNextSseState();
      assert.equal(secondSse.version, 2, 'Must not have buffered a duplicate version=2 SSE from add1');
      assert.equal(secondSse.state.cards.length, 2);

      // 1 MiB Scratchpad payload with JSON-escaped characters (wire bytes > 1 MiB, UTF-8 content == 1 MiB)
      const exactOneMibWithNewlines = `${'# Pad\n"quoted"\n'}${'a'.repeat(MAX_PAD_BYTES - 15)}`;
      assert.equal(Buffer.byteLength(exactOneMibWithNewlines, 'utf8'), MAX_PAD_BYTES);

      const save1Mib = await postJson(
        baseUrl,
        '/api/mutate',
        {
          action: 'pad-save',
          payload: { scope: 'global', content: exactOneMibWithNewlines },
        },
        token
      );
      assert.equal(save1Mib.status, 200);
      assert.equal(save1Mib.json.ok, true);
      assert.equal(save1Mib.json.result.pad.content.length, MAX_PAD_BYTES);

      const overOneMib = `${exactOneMibWithNewlines}x`;
      const rejectOver1Mib = await postJson(
        baseUrl,
        '/api/mutate',
        { action: 'pad-save', payload: { scope: 'global', content: overOneMib } },
        token
      );
      assert.equal(rejectOver1Mib.status, 400);

      // settings-update toggling mcpRead triggers syncMcpRegistration + RefreshMcpServers
      const enableRead = await postJson(
        baseUrl,
        '/api/mutate',
        { action: 'settings-update', payload: { mcpRead: true } },
        token
      );
      assert.equal(enableRead.status, 200);
      const mcpCfgAfterEnable = JSON.parse(readFileSync(mcpConfigPath, 'utf8'));
      assert.equal(mcpCfgAfterEnable.mcpServers[MCP_SERVER_NAME].disabled, false);
      assert.equal(lsCalls.some((c) => c.method === 'RefreshMcpServers'), true);

      const disableAll = await postJson(
        baseUrl,
        '/api/mutate',
        { action: 'settings-update', payload: { mcpRead: false, mcpWrite: false } },
        token
      );
      assert.equal(disableAll.status, 200);
      const mcpCfgAfterDisable = JSON.parse(readFileSync(mcpConfigPath, 'utf8'));
      assert.equal(mcpCfgAfterDisable.mcpServers[MCP_SERVER_NAME].disabled, true);

      // POST /api/context resolves trajectory title & workspace
      const ctxRes = await postJson(
        baseUrl,
        '/api/context',
        { conversationId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' },
        token
      );
      assert.equal(ctxRes.status, 200);
      assert.equal(ctxRes.json.ok, true);
      assert.equal(ctxRes.json.workspacePath, 'c:/Users/dev/antigravity-notes');
      assert.equal(ctxRes.json.conversationTitle, 'Notes Architecture Thread');

      const newCtxRes = await postJson(
        baseUrl,
        '/api/context',
        { conversationId: '_new', workspaceUris: ['file:///C%3A/Users/dev/antigravity-notes/'] },
        token
      );
      assert.equal(newCtxRes.status, 200);
      assert.equal(newCtxRes.json.isNewConversation, true);
      assert.equal(newCtxRes.json.conversationId, '');

      // POST /api/dispatch shares contextResolver.lookupConversationTitle & handles 1 MiB prompt + 400 / 502 errors
      const dispatchOk = await postJson(
        baseUrl,
        '/api/dispatch',
        {
          mode: 'active',
          conversationId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
          text: exactOneMibWithNewlines,
        },
        token
      );
      assert.equal(dispatchOk.status, 200);
      assert.equal(dispatchOk.json.ok, true);
      assert.equal(dispatchOk.json.mode, 'active');
      assert.equal(dispatchOk.json.conversationTitle, 'Notes Architecture Thread');

      const dispatchBadReq = await postJson(baseUrl, '/api/dispatch', { text: '   ' }, token);
      assert.equal(dispatchBadReq.status, 400);

      const dispatchUpstreamFail = await postJson(
        baseUrl,
        '/api/dispatch',
        { mode: 'new', text: 'TRIGGER_AGENT_FAIL' },
        token
      );
      assert.equal(dispatchUpstreamFail.status, 502);
    } finally {
      sseAbort.abort();
      stateSync.stop();
      await app.close();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('gates BOTH POST /api/mcp AND POST /mcp through guardMcpRpc (never exposing get_state) and bridges cleanly with mcp.mjs', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'notes-srv-mcp-'));
    const dataDir = join(tmpDir, 'data');
    const mcpConfigPath = join(tmpDir, 'mcp_config.json');
    const token = 'mcp-gate-token';

    const { app, stateSync } = createNotesServer({
      dataDir,
      port: 0,
      uiToken: token,
      mcpConfigPath,
      callLsRpcFn: async () => ({ ok: true }),
    });

    let stdio = null;
    const input = new PassThrough();
    const output = new PassThrough();
    const stdioReplies = [];
    output.on('data', (chunk) => {
      for (const line of chunk.toString('utf8').split('\n')) {
        if (line.trim()) {
          stdioReplies.push(JSON.parse(line));
        }
      }
    });

    try {
      const server = await app.run();
      const baseUrl = `http://127.0.0.1:${server.address().port}`;

      // Seed a private card while MCP is completely OFF
      await postJson(
        baseUrl,
        '/api/mutate',
        { action: 'stash-add', payload: { text: 'Top secret parked prompt #idea' } },
        token
      );

      // BOTH /api/mcp AND /mcp must return empty tools/list and block get_state & list_stash when MCP is OFF
      for (const mcpRoute of ['/api/mcp', '/mcp']) {
        const listOff = await postJson(
          baseUrl,
          mcpRoute,
          { jsonrpc: '2.0', id: 1, method: 'tools/list' },
          token
        );
        assert.equal(listOff.status, 200);
        assert.deepEqual(listOff.json.result.tools, [], `Expected 0 tools on ${mcpRoute} when MCP is off`);

        const getStateBlocked = await postJson(
          baseUrl,
          mcpRoute,
          { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_state', arguments: {} } },
          token
        );
        assert.ok(getStateBlocked.json.error, `get_state must be blocked on ${mcpRoute}`);

        const readBlocked = await postJson(
          baseUrl,
          mcpRoute,
          { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_stash', arguments: {} } },
          token
        );
        assert.ok(readBlocked.json.error, `list_stash must be blocked on ${mcpRoute} when mcpRead=false`);
      }

      // Enable both mcpRead and mcpWrite -> BOTH /api/mcp and /mcp still strip/block get_state!
      await postJson(
        baseUrl,
        '/api/mutate',
        { action: 'settings-update', payload: { mcpRead: true, mcpWrite: true } },
        token
      );

      for (const mcpRoute of ['/api/mcp', '/mcp']) {
        const listOn = await postJson(
          baseUrl,
          mcpRoute,
          { jsonrpc: '2.0', id: 4, method: 'tools/list' },
          token
        );
        assert.deepEqual(
          listOn.json.result.tools.map((t) => t.name),
          [...READ_TOOL_NAMES, ...WRITE_TOOL_NAMES]
        );
        assert.equal(listOn.json.result.tools.some((t) => t.name === 'get_state'), false);

        const getStateStillBlocked = await postJson(
          baseUrl,
          mcpRoute,
          { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'get_state', arguments: {} } },
          token
        );
        assert.ok(getStateStillBlocked.json.error, `get_state must remain blocked on ${mcpRoute}`);
      }

      // Verify server_info.json was written by createNotesServer so mcp.mjs forwards online with X-Sidecar-Token
      assert.equal(existsSync(join(dataDir, 'server_info.json')), true);
      stdio = startNotesMcpStdio({ dataDir, input, output, forwardTimeoutMs: 1000 });
      const verBeforeOnlineMcp = stateSync.globalState.currentVersion;
      const reply = await stdio.routeRequest({
        jsonrpc: '2.0',
        id: 10,
        method: 'tools/call',
        params: { name: 'stash_prompt', arguments: { text: 'Added via online stdio bridge #mcp', color: 'cyan' } },
      });
      assert.equal(reply.result.structuredContent.ok, true);
      assert.equal(stateSync.getState().cards.length, 2);
      assert.equal(
        stateSync.globalState.currentVersion,
        verBeforeOnlineMcp + 1,
        'Online MCP stash_prompt must increment version by 1 (not 2)'
      );
      const diskAfterOnlineMcp = JSON.parse(readFileSync(join(dataDir, 'state.json'), 'utf8'));
      assert.equal('result' in diskAfterOnlineMcp, false, 'state.json must not contain top-level result');

      // External state.json edit (e.g. setup.mjs --no-mcp) must be seen immediately by /api/mcp via stateSync.refresh()
      const externallyDisabled = applyNotesAction(diskAfterOnlineMcp, 'settings-update', { mcpRead: false, mcpWrite: false }).nextState;
      writeJsonAtomic(join(dataDir, 'state.json'), externallyDisabled);
      const listAfterExternalOff = await postJson(
        baseUrl,
        '/api/mcp',
        { jsonrpc: '2.0', id: 11, method: 'tools/list' },
        token
      );
      assert.deepEqual(listAfterExternalOff.json.result.tools, []);
    } finally {
      stdio?.close();
      stateSync.stop();
      await app.close();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('launch.mjs & setup.mjs — self-healing launcher config & MCP CLI setup flags', () => {
  it('configures launch.mjs with fallback port 52325 and server.mjs entrypoint', async () => {
    assert.equal(LAUNCHER_CONFIG.sidecarId, 'notes');
    assert.equal(LAUNCHER_CONFIG.port, DEFAULT_PORT);
    assert.equal(DEFAULT_PORT, 52325);
    assert.equal(LAUNCHER_CONFIG.entryScript, 'server.mjs');

    let capturedConfig = null;
    const exitCode = await startNotesLauncher({
      env: {},
      runLauncher: async (cfg) => {
        capturedConfig = cfg;
        return 0;
      },
    });
    assert.equal(exitCode, 0);
    assert.equal(capturedConfig.port, 52325);
    assert.equal(capturedConfig.env.ANTIGRAVITY_SIDECAR_WEB_PORT, '52325');
  });

  it('handles --mcp-read, --mcp-write, --with-mcp, --no-mcp, and --uninstall in isolated temp directories', async () => {
    assert.deepEqual(parseSetupFlags(['--mcp-read']), {
      uninstall: false,
      hasMcpFlags: true,
      mcpRead: true,
      mcpWrite: undefined,
    });
    assert.deepEqual(parseSetupFlags(['--with-mcp']), {
      uninstall: false,
      hasMcpFlags: true,
      mcpRead: true,
      mcpWrite: true,
    });
    assert.deepEqual(parseSetupFlags(['--no-mcp']), {
      uninstall: false,
      hasMcpFlags: true,
      mcpRead: false,
      mcpWrite: false,
    });

    const tmpDir = mkdtempSync(join(tmpdir(), 'notes-setup-cli-'));
    const dataDir = join(tmpDir, 'data');
    const mcpConfigPath = join(tmpDir, 'mcp_config.json');
    const globalSidecarsDir = join(tmpDir, 'sidecars');
    const configJsonPath = join(tmpDir, 'config.json');
    const packagesDir = join(tmpDir, 'packages');

    const baseOpts = {
      repoRoot: REPO_ROOT,
      dataDir,
      mcpConfigPath,
      globalSidecarsDir,
      configJsonPath,
      packagesDir,
      restartDelayMs: 0,
      rpcOptions: { lsAddress: '', csrfToken: '' },
      callLsRpcFn: async () => ({ ok: true }),
    };

    try {
      // 1. Default setup (no MCP flags) -> disabled: true in mcp_config.json (0 context tokens)
      await runNotesSetup(['--skip-tests'], baseOpts);
      assert.equal(existsSync(join(globalSidecarsDir, 'notes')), true);
      const cfgDefault = JSON.parse(readFileSync(mcpConfigPath, 'utf8'));
      assert.equal(cfgDefault.mcpServers[MCP_SERVER_NAME].disabled, true);

      // 2. --mcp-read -> enables mcpRead: true, mcpWrite: false in state.json & disabled: false in mcp_config.json
      await runNotesSetup(['--skip-tests', '--mcp-read'], baseOpts);
      const stateRead = JSON.parse(readFileSync(join(dataDir, 'state.json'), 'utf8'));
      assert.deepEqual(
        { mcpRead: stateRead.settings.mcpRead, mcpWrite: stateRead.settings.mcpWrite },
        { mcpRead: true, mcpWrite: false }
      );
      assert.equal(JSON.parse(readFileSync(mcpConfigPath, 'utf8')).mcpServers[MCP_SERVER_NAME].disabled, false);

      // 3. --no-mcp -> disables both in state.json & sets disabled: true in mcp_config.json
      await runNotesSetup(['--skip-tests', '--no-mcp'], baseOpts);
      const stateOff = JSON.parse(readFileSync(join(dataDir, 'state.json'), 'utf8'));
      assert.deepEqual(
        { mcpRead: stateOff.settings.mcpRead, mcpWrite: stateOff.settings.mcpWrite },
        { mcpRead: false, mcpWrite: false }
      );
      assert.equal(JSON.parse(readFileSync(mcpConfigPath, 'utf8')).mcpServers[MCP_SERVER_NAME].disabled, true);

      // 4. --mcp-write -> enables mcpWrite: true, mcpRead: false
      await runNotesSetup(['--skip-tests', '--mcp-write'], baseOpts);
      const stateWrite = JSON.parse(readFileSync(join(dataDir, 'state.json'), 'utf8'));
      assert.deepEqual(
        { mcpRead: stateWrite.settings.mcpRead, mcpWrite: stateWrite.settings.mcpWrite },
        { mcpRead: false, mcpWrite: true }
      );

      // 5. --with-mcp -> enables both mcpRead: true and mcpWrite: true
      await runNotesSetup(['--skip-tests', '--with-mcp'], baseOpts);
      const stateBoth = JSON.parse(readFileSync(join(dataDir, 'state.json'), 'utf8'));
      assert.deepEqual(
        { mcpRead: stateBoth.settings.mcpRead, mcpWrite: stateBoth.settings.mcpWrite },
        { mcpRead: true, mcpWrite: true }
      );
      assert.equal(JSON.parse(readFileSync(mcpConfigPath, 'utf8')).mcpServers[MCP_SERVER_NAME].disabled, false);

      // 6. --uninstall -> removes antigravity-notes from mcp_config.json and removes sidecar junction
      const uninstallRes = await runNotesSetup(['--uninstall'], baseOpts);
      assert.equal(uninstallRes.uninstalled, true);
      assert.equal(existsSync(join(globalSidecarsDir, 'notes')), false);
      const cfgUninstalled = JSON.parse(readFileSync(mcpConfigPath, 'utf8'));
      assert.equal(MCP_SERVER_NAME in cfgUninstalled.mcpServers, false);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('writes state.json MCP flags inside onBeforeSetup BEFORE runSidecarSetup starts/restarts server.mjs and preserves seeded cards across sequential --mcp-read + --mcp-write runs', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'notes-setup-race-'));
    const dataDir = join(tmpDir, 'data');
    const statePath = join(dataDir, 'state.json');
    const mcpConfigPath = join(tmpDir, 'mcp_config.json');
    const globalSidecarsDir = join(tmpDir, 'sidecars');
    const configJsonPath = join(tmpDir, 'config.json');
    const packagesDir = join(tmpDir, 'packages');

    const seeded = applyNotesAction(
      createInitialState(),
      'stash-add',
      { text: 'Seeded card preserved across setup restarts #ship', scope: 'global' },
      10_000
    );
    const seededCardId = seeded.result.card.id;
    writeJsonAtomic(statePath, seeded.nextState);

    const beforeSetupSnapshots = [];
    const preRestartSnapshots = [];

    const makeOpts = () => ({
      repoRoot: REPO_ROOT,
      dataDir,
      mcpConfigPath,
      globalSidecarsDir,
      configJsonPath,
      packagesDir,
      restartDelayMs: 0,
      rpcOptions: { lsAddress: '', csrfToken: '' },
      callLsRpcFn: async () => ({ ok: true }),
      onBeforeSetup: async () => {
        beforeSetupSnapshots.push(JSON.parse(readFileSync(statePath, 'utf8')));
      },
      runSidecarSetupFn: async (cfg) => {
        await cfg.onBeforeSetup?.({ sidecarId: cfg.sidecarId, repoRoot: cfg.repoRoot });
        preRestartSnapshots.push(JSON.parse(readFileSync(statePath, 'utf8')));
        return runSidecarSetup({ ...cfg, onBeforeSetup: undefined });
      },
    });

    try {
      const resRead = await runNotesSetup(['--skip-tests', '--mcp-read'], makeOpts());
      assert.deepEqual(resRead.settings, { mcpRead: true, mcpWrite: false });
      assert.equal(beforeSetupSnapshots.length, 1);
      assert.equal(beforeSetupSnapshots[0].settings.mcpRead, true);
      assert.equal(beforeSetupSnapshots[0].settings.mcpWrite, false);
      assert.equal(beforeSetupSnapshots[0].cards[0]?.id, seededCardId);
      assert.equal(preRestartSnapshots[0].settings.mcpRead, true);

      const resWrite = await runNotesSetup(['--skip-tests', '--mcp-write'], makeOpts());
      assert.deepEqual(resWrite.settings, { mcpRead: true, mcpWrite: true });
      assert.equal(beforeSetupSnapshots.length, 2);
      assert.equal(beforeSetupSnapshots[1].settings.mcpRead, true);
      assert.equal(beforeSetupSnapshots[1].settings.mcpWrite, true);
      assert.equal(beforeSetupSnapshots[1].cards.length, 1);
      assert.equal(beforeSetupSnapshots[1].cards[0].id, seededCardId);
      assert.deepEqual(
        { mcpRead: preRestartSnapshots[1].settings.mcpRead, mcpWrite: preRestartSnapshots[1].settings.mcpWrite },
        { mcpRead: true, mcpWrite: true },
        'state.json must hold both mcpRead=true and mcpWrite=true before runSidecarSetup restarts server.mjs'
      );

      const finalDisk = JSON.parse(readFileSync(statePath, 'utf8'));
      assert.equal(finalDisk.settings.mcpRead, true);
      assert.equal(finalDisk.settings.mcpWrite, true);
      assert.equal(finalDisk.cards.length, 1);
      assert.equal(finalDisk.cards[0].id, seededCardId);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
