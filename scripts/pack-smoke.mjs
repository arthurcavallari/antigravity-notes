#!/usr/bin/env node
/**
 * @fileoverview Packs antigravity-notes, installs the tarball into an empty project, verifies
 * published vs. excluded files and bin shims, runs isolated setup/uninstall, and boots the server.
 */

import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const work = mkdtempSync(join(tmpdir(), 'notes-pack-smoke-'));

const run = (cmd, cwd) =>
  execSync(cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });

try {
  const [{ filename }] = JSON.parse(run(`npm pack --json --pack-destination "${work}"`, ROOT));
  const appDir = join(work, 'app');
  mkdirSync(appDir, { recursive: true });
  writeFileSync(join(appDir, 'package.json'), JSON.stringify({ name: 'notes-smoke', private: true, type: 'module' }));
  run(`npm install --no-audit --no-fund "${join(work, filename)}"`, appDir);

  const installed = join(appDir, 'node_modules', pkg.name);
  for (const excluded of ['test', 'scripts', 'docs', '.github']) {
    assert.equal(existsSync(join(installed, excluded)), false, `${excluded}/ must not be published`);
  }

  const requiredPublished = [
    'LICENSE',
    'README.md',
    'package.json',
    'sidecar.json',
    'hub-manifest.json',
    'launch.mjs',
    'server.mjs',
    'mcp.mjs',
    'setup.mjs',
    'lib/constants.mjs',
    'lib/notes-store.mjs',
    'lib/mcp-guard.mjs',
    'lib/exporter.mjs',
    'ui/index.html',
    'ui/markdown.js',
    'ui/styles.css',
    'ui/components.css',
    'ui/app.js',
  ];
  for (const rel of requiredPublished) {
    assert.equal(existsSync(join(installed, rel)), true, `${rel} must be published`);
  }

  for (const binName of Object.keys(pkg.bin)) {
    const binWin = join(appDir, 'node_modules', '.bin', `${binName}.cmd`);
    const binPosix = join(appDir, 'node_modules', '.bin', binName);
    assert.equal(existsSync(binWin) || existsSync(binPosix), true, `Expected .bin/${binName} shim`);
  }

  const sandboxDir = join(work, 'sandbox');
  const { runNotesSetup } = await import(pathToFileURL(join(installed, 'setup.mjs')).href);
  const setupOpts = {
    repoRoot: installed,
    dataDir: join(sandboxDir, 'data'),
    mcpConfigPath: join(sandboxDir, 'mcp_config.json'),
    globalSidecarsDir: join(sandboxDir, 'sidecars'),
    configJsonPath: join(sandboxDir, 'config.json'),
    packagesDir: join(sandboxDir, 'packages'),
    restartDelayMs: 0,
    rpcOptions: { lsAddress: '', csrfToken: '', sidecarDataRoot: join(sandboxDir, 'sidecar_data') },
    callLsRpcFn: async () => ({ ok: true }),
  };

  await runNotesSetup(['--skip-tests', '--with-mcp'], setupOpts);
  assert.equal(existsSync(join(sandboxDir, 'sidecars', 'notes')), true, 'Packed setup must link notes sidecar');
  const mcpCfg = JSON.parse(readFileSync(join(sandboxDir, 'mcp_config.json'), 'utf8'));
  assert.equal(mcpCfg.mcpServers['antigravity-notes'].disabled, false);

  await runNotesSetup(['--uninstall'], setupOpts);
  assert.equal(existsSync(join(sandboxDir, 'sidecars', 'notes')), false, 'Packed uninstall must remove notes link');

  const { createNotesServer } = await import(pathToFileURL(join(installed, 'server.mjs')).href);
  const { app: serverApp, stateSync } = createNotesServer({
    dataDir: join(sandboxDir, 'srv-data'),
    downloadsDir: join(sandboxDir, 'Downloads'),
    mcpConfigPath: join(sandboxDir, 'mcp_config.json'),
    port: 0,
    uiToken: 'smoke-token',
    callLsRpcFn: async () => ({ trajectorySummaries: {} }),
  });
  try {
    const httpSrv = await serverApp.run();
    const base = `http://127.0.0.1:${httpSrv.address().port}`;
    const health = await fetch(`${base}/_sidecar/health`);
    assert.equal(health.status, 200);
    const html = await fetch(`${base}/index.html?token=smoke-token`);
    assert.equal(html.status, 200);
    const mdJs = await fetch(`${base}/markdown.js?token=smoke-token`);
    assert.equal(mdJs.status, 200);
  } finally {
    stateSync.stop();
    await serverApp.close();
  }

  console.log(`[pack-smoke] ${filename}: published files, bins, isolated setup/uninstall, and HTTP server OK`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
