/**
 * @fileoverview Self-healing standalone & Hangar launcher for Antigravity Notes.
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MODULE_PATH = realpathSync(fileURLToPath(import.meta.url));
const MODULE_DIR = dirname(MODULE_PATH);
const DEFAULT_PORT = 52325;

const isMain = (() => {
  try {
    return !process.execArgv.includes('--test') && realpathSync(resolve(process.argv[1] || '')) === MODULE_PATH;
  } catch {
    return false;
  }
})();

export const LAUNCHER_CONFIG = Object.freeze({
  sidecarId: 'notes',
  sidecarName: 'Notes',
  title: 'Notes',
  sidecarDir: MODULE_DIR,
  repoRoot: MODULE_DIR,
  entryScript: 'server.mjs',
  targetPath: join(MODULE_DIR, 'server.mjs'),
  port: DEFAULT_PORT,
  healthPath: '/_sidecar/health',
  requiredPaths: [
    join(MODULE_DIR, 'node_modules', 'antigravity-sidecar-kit', 'package.json'),
    join(MODULE_DIR, 'ui', 'index.html'),
  ],
  remediationCommand: 'npm install && npm run setup',
  registerSignalHandlers: true,
});

export async function startNotesLauncher(overrides = {}) {
  const run = overrides.runLauncher || (await import('antigravity-sidecar-kit/launcher')).runSidecarLauncher;
  const env = overrides.env || process.env;
  const port = Number(overrides.port || env.ANTIGRAVITY_SIDECAR_WEB_PORT || LAUNCHER_CONFIG.port);
  return run({
    ...LAUNCHER_CONFIG,
    ...overrides,
    port,
    env: {
      ...env,
      ANTIGRAVITY_SIDECAR_WEB_PORT: String(port),
    },
  });
}

function escapeFallbackHtml(str) {
  return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function tokensMatchSafe(provided, expected) {
  if (!provided || !expected) {
    return false;
  }
  const a = Buffer.from(String(provided), 'utf8');
  const b = Buffer.from(String(expected), 'utf8');
  const digestA = createHash('sha256').update(a).digest();
  const digestB = createHash('sha256').update(b).digest();
  return timingSafeEqual(digestA, digestB) && a.byteLength === b.byteLength;
}

function serveMissingKitFallback(port) {
  const allowedOriginRe = /^(?:https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?|plugin:\/\/[a-z0-9][a-z0-9._-]*)$/i;
  const retryScript = [
    "const btn = document.getElementById('retry-btn');",
    "btn.addEventListener('click', () => {",
    "  const q = new URLSearchParams(location.search).get('token') || '';",
    "  const hdrs = q ? { 'X-Sidecar-Token': q } : {};",
    "  fetch('/__launcher/retry' + (location.search || ''), { method: 'POST', headers: hdrs })",
    '    .then(() => { setTimeout(() => { location.reload(); }, 800); });',
    '});',
  ].join('\n');
  const pageHtml = [
    '<!doctype html><html><body style="font-family:system-ui;padding:24px">',
    '<h1>Notes dependencies missing</h1>',
    `<p>Run <code>npm install &amp;&amp; npm run setup</code> in <code>${escapeFallbackHtml(MODULE_DIR)}</code>, then click Retry.</p>`,
    '<button id="retry-btn" type="button">Retry</button>',
    `<script>\n${retryScript}\n</script>`,
    '</body></html>',
  ].join('\n');

  const srv = createServer((req, res) => {
    if (req.method === 'POST' && req.url?.startsWith('/__launcher/retry')) {
      if (req.headers.origin && !allowedOriginRe.test(req.headers.origin)) {
        res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end('{"error":"Forbidden origin"}');
        return;
      }
      const expectedTok = process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN;
      if (expectedTok) {
        const reqTok = req.headers['x-sidecar-token'] || new URL(req.url, 'http://127.0.0.1').searchParams.get('token');
        if (!tokensMatchSafe(reqTok, expectedTok)) {
          res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end('{"error":"Unauthorized"}');
          return;
        }
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end('{"ok":true}');
      srv.close(() => process.exit(1));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(pageHtml);
  });
  srv.listen(port, '127.0.0.1');
}

if (isMain) {
  try {
    const exitCode = await startNotesLauncher();
    process.exit(exitCode ?? 0);
  } catch (err) {
    const port = Number(process.env.ANTIGRAVITY_SIDECAR_WEB_PORT || LAUNCHER_CONFIG.port);
    const hasKitLauncher = existsSync(join(MODULE_DIR, 'node_modules', 'antigravity-sidecar-kit', 'lib', 'launcher.mjs'));
    if (!port || hasKitLauncher) {
      console.error('[notes] Launcher failed:', err?.message || err);
      process.exit(1);
    }
    serveMissingKitFallback(port);
  }
}
