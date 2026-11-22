/** @fileoverview Thin HTTP & StateSync routing entrypoint for Antigravity Notes. */
import { realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FallbackResponse, createSidecarApp, exitWithLanguageServer, extractConversationId, setupSidecarServer,
} from 'antigravity-sidecar-kit';
import { DEFAULT_PORT, SIDECAR_ID, UI_DIR, createInitialState, resolveNotesDataDir } from './lib/constants.mjs';
import { createContextResolver } from './lib/context-resolver.mjs';
import { createDispatcher } from './lib/dispatcher.mjs';
import { createExporter } from './lib/exporter.mjs';
import { syncMcpRegistration } from './lib/mcp-config.mjs';
import { guardMcpRpc } from './lib/mcp-guard.mjs';
import { buildNotesMcpTools } from './lib/mcp-tools.mjs';
import { createStoreMutators } from './lib/notes-store.mjs';

const sdk = await import('sidecar_sdk').catch(() => null);
const Response = sdk?.Response || FallbackResponse;
const MODULE_PATH = realpathSync(fileURLToPath(import.meta.url));
const MAX_HTTP_BODY_BYTES = 8 * 1024 * 1024;
const [HTML_MIME, CSS_MIME, JS_MIME] = ['text/html; charset=utf-8', 'text/css; charset=utf-8', 'text/javascript; charset=utf-8'];
const UI_SCRIPTS = [
  'core.js', 'markdown.js', 'app.js',
  'components/swatch-picker.js', 'components/stash-tab.js', 'components/combine-modal.js', 'components/scratchpad-tab.js',
];
const UI_ASSETS = Object.freeze(Object.fromEntries([
  ['/', ['index.html', HTML_MIME]], ['/index.html', ['index.html', HTML_MIME]],
  ['/styles.css', ['styles.css', CSS_MIME]], ['/components.css', ['components.css', CSS_MIME]],
  ...UI_SCRIPTS.map((rel) => [`/${rel}`, [rel, JS_MIME]]),
]));
const isObj = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const jsonRes = (body, status = 200) => new Response(JSON.stringify(body), { status, contentType: 'application/json; charset=utf-8' });
const isMain = (() => {
  try {
    return !process.execArgv.includes('--test') && realpathSync(resolve(process.argv[1] || '')) === MODULE_PATH;
  } catch {
    return false;
  }
})();

export function createNotesServer(rawOpts = {}) {
  const opts = isObj(rawOpts) ? rawOpts : {};
  const env = isObj(opts.env) ? opts.env : process.env;
  const uiToken = opts.uiToken !== undefined ? String(opts.uiToken) : String(env.ANTIGRAVITY_SIDECAR_UI_TOKEN || '');
  const dataDir = opts.dataDir !== undefined ? String(opts.dataDir) : (isMain ? resolveNotesDataDir(env) : '');
  const mcpConfigPath = opts.mcpConfigPath || (!isMain && dataDir ? join(dataDir, 'mcp_config.json') : undefined);
  const callLsRpcFn = opts.callLsRpcFn !== undefined ? opts.callLsRpcFn : (isMain ? undefined : null);
  const port = opts.port ?? (Number(env.ANTIGRAVITY_SIDECAR_WEB_PORT) || (isMain ? DEFAULT_PORT : 0));
  const app = opts.app || createSidecarApp({ port, uiToken, bodyLimitBytes: opts.bodyLimitBytes ?? MAX_HTTP_BODY_BYTES });
  const contextResolver = createContextResolver({ ...(typeof opts.callLsRpcFn === 'function' ? { callLsRpcFn: opts.callLsRpcFn } : {}), projectsDir: opts.projectsDir ?? (isMain ? undefined : '') });
  const dispatcher = createDispatcher({ agentApiFn: opts.agentApiFn, lookupConversationTitle: contextResolver.lookupConversationTitle, env });
  const exporter = createExporter({ execFileFn: opts.execFileFn, downloadsDir: opts.downloadsDir, platform: opts.platform, env });
  let stateSync = null;
  const mutators = createStoreMutators(() => stateSync, async (next, prev) => {
    if ((next.mcpRead !== prev.mcpRead || next.mcpWrite !== prev.mcpWrite) && (isMain || mcpConfigPath)) {
      await syncMcpRegistration({ mcpRead: next.mcpRead, mcpWrite: next.mcpWrite, mcpConfigPath, mcpEntryPath: opts.mcpEntryPath, callLsRpcFn });
    }
  });
  stateSync = setupSidecarServer(app, {
    uiDir: opts.uiDir || UI_DIR, assets: UI_ASSETS, uiModules: 'all', ResponseClass: Response, uiToken,
    stateSyncOptions: {
      sidecarId: SIDECAR_ID, dataDir, uiAuthToken: uiToken, ResponseClass: Response,
      initialState: createInitialState, mutators, mcpTools: buildNotesMcpTools({ getSync: () => stateSync }),
    },
  }).sync;
  const guardApi = (fn) => async (data, ctx) => {
    const err = stateSync.checkAuth(data, ctx);
    return err ? jsonRes({ ok: false, error: err.error }, err.status) : fn(data, ctx);
  };
  app.api('/api/mutate', guardApi(async (data, ctx) => {
    const action = typeof data?.action === 'string' ? data.action : '';
    if (!action || !Object.hasOwn(mutators, action)) {
      return jsonRes({ ok: false, error: `Unknown action: ${action}` }, 400);
    }
    const { action: _a, payload: nested, token: _t, ...flat } = isObj(data) ? data : {};
    const base = isObj(nested) ? nested : flat;
    const convId = extractConversationId(data, ctx) || '';
    const payload = convId && !base.conversationId ? { ...base, conversationId: convId } : base;
    try {
      const result = await mutators[action](payload);
      return jsonRes({ ok: true, version: stateSync.globalState.currentVersion, state: stateSync.getState(), result }, 200);
    } catch (err) {
      return jsonRes({ ok: false, error: String(err?.message || err) }, err?.code ? 500 : 400);
    }
  }), 'POST');
  app.api('/api/context', guardApi(async (data) => jsonRes({ ok: true, ...(await contextResolver.resolveContext(data || {})) }, 200)), 'POST');
  const runSafe = (fn) => guardApi(async (data) => {
    try {
      return jsonRes(await fn(data || {}), 200);
    } catch (err) {
      return jsonRes({ ok: false, error: String(err?.message || err) }, err?.statusCode || err?.status || 500);
    }
  });
  app.api('/api/dispatch', runSafe((d) => dispatcher.dispatchPrompt(d)), 'POST');
  app.api('/api/export', runSafe((d) => exporter.exportMarkdown(d)), 'POST');
  const handleGuardedMcp = async (data, ctx) => {
    const err = stateSync.checkAuth(data, ctx);
    if (err) {
      return jsonRes({ jsonrpc: '2.0', id: data?.id ?? null, error: { code: -32600, message: err.error } }, err.status);
    }
    const getSettings = () => (typeof stateSync.refresh === 'function' ? stateSync.refresh() : stateSync.getState())?.settings;
    const reply = await guardMcpRpc(data, { getSettings, forwardRpc: (r) => stateSync.handleMcp(r, ctx) });
    return reply === null ? new Response('', { status: 202 }) : jsonRes(reply, reply?.status || 200);
  };
  app.api('/api/mcp', handleGuardedMcp, 'POST');
  app.api('/mcp', handleGuardedMcp, 'POST');
  return { app, stateSync };
}

if (isMain) {
  const { app, stateSync } = createNotesServer();
  const cleanup = () => stateSync.stop();
  process.once('exit', cleanup);
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.once(sig, () => process.exit(0));
  }
  await app.run();
  exitWithLanguageServer({ app, onExit: cleanup });
}
