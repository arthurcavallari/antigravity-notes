#!/usr/bin/env node
/**
 * @fileoverview Setup & uninstall CLI for Antigravity Notes (`--mcp-read`, `--mcp-write`, `--with-mcp`, `--no-mcp`, `--uninstall`).
 */

import { cpSync, existsSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GLOBAL_SIDECARS_DIR, readJsonSafe } from 'antigravity-sidecar-kit/config';
import { runSidecarSetup } from 'antigravity-sidecar-kit/setup';
import { writeJsonAtomic } from 'antigravity-sidecar-kit/state-sync';
import {
  DEFAULT_PORT,
  REPO_ROOT,
  SIDECAR_ID,
  SIDECAR_TITLE,
  createInitialState,
  resolveNotesDataDir,
} from './lib/constants.mjs';
import { syncMcpRegistration } from './lib/mcp-config.mjs';
import { applyNotesAction } from './lib/notes-store.mjs';

const MODULE_PATH = realpathSync(fileURLToPath(import.meta.url));

const REQUIRED_SETUP_FILES = Object.freeze([
  'sidecar.json',
  'hub-manifest.json',
  'launch.mjs',
  'server.mjs',
  'mcp.mjs',
  'ui/markdown.js',
]);

function isPlainObject(val) {
  return Boolean(val) && typeof val === 'object' && !Array.isArray(val);
}

export function parseSetupFlags(rawArgs = []) {
  const args = Array.isArray(rawArgs) ? rawArgs : [];
  let uninstall = false;
  let hasMcpFlags = false;
  let mcpRead;
  let mcpWrite;

  for (const raw of args) {
    const arg = String(raw || '').trim();
    if (arg === '--uninstall') {
      uninstall = true;
    } else if (arg === '--with-mcp') {
      hasMcpFlags = true;
      mcpRead = true;
      mcpWrite = true;
    } else if (arg === '--no-mcp') {
      hasMcpFlags = true;
      mcpRead = false;
      mcpWrite = false;
    } else if (arg === '--mcp-read') {
      hasMcpFlags = true;
      mcpRead = true;
    } else if (arg === '--no-mcp-read') {
      hasMcpFlags = true;
      mcpRead = false;
    } else if (arg === '--mcp-write') {
      hasMcpFlags = true;
      mcpWrite = true;
    } else if (arg === '--no-mcp-write') {
      hasMcpFlags = true;
      mcpWrite = false;
    }
  }

  return { uninstall, hasMcpFlags, mcpRead, mcpWrite };
}

function syncLocalSidecarKit(repoRoot, env) {
  if (env?.ANTIGRAVITY_DEV_SYNC_KIT !== '1') {
    return;
  }
  const siblingKitLib = join(repoRoot, '..', 'antigravity-sidecar-kit', 'lib');
  const localKitLib = join(repoRoot, 'node_modules', 'antigravity-sidecar-kit', 'lib');
  if (existsSync(siblingKitLib) && existsSync(join(repoRoot, 'node_modules', 'antigravity-sidecar-kit'))) {
    cpSync(siblingKitLib, localKitLib, { recursive: true });
    console.log(`[${SIDECAR_ID}] Synced sibling antigravity-sidecar-kit/lib -> ${localKitLib}`);
  }
}

export async function runNotesSetup(rawArgs = process.argv.slice(2), rawOptions = {}) {
  const args = Array.isArray(rawArgs) ? rawArgs : [];
  const options = isPlainObject(rawOptions) ? rawOptions : {};
  const env = isPlainObject(options.env) ? options.env : process.env;
  const repoRoot = options.repoRoot ? resolve(String(options.repoRoot)) : REPO_ROOT;
  const hasCustomDataDir = Boolean(options.dataDir);
  const dataDir = hasCustomDataDir ? resolve(String(options.dataDir)) : resolveNotesDataDir(env);
  const statePath = join(dataDir, 'state.json');
  const effectiveRpcOptions = hasCustomDataDir && !options.rpcOptions?.sidecarDataRoot
    ? { ...(isPlainObject(options.rpcOptions) ? options.rpcOptions : {}), sidecarDataRoot: join(dataDir, '_rpc_sandbox') }
    : options.rpcOptions;
  const flags = parseSetupFlags(args);
  const runSidecarSetupFn = typeof options.runSidecarSetupFn === 'function' ? options.runSidecarSetupFn : runSidecarSetup;
  let finalSettings = null;

  const syncMcpFlagsToStateFile = () => {
    const existingState = readJsonSafe(statePath, null) || createInitialState();
    const prevSettings = isPlainObject(existingState.settings) ? existingState.settings : {};
    const nextRead = flags.mcpRead !== undefined ? flags.mcpRead : Boolean(prevSettings.mcpRead);
    const nextWrite = flags.mcpWrite !== undefined ? flags.mcpWrite : Boolean(prevSettings.mcpWrite);
    if (flags.hasMcpFlags && !flags.uninstall) {
      const patch = {};
      if (flags.mcpRead !== undefined) {
        patch.mcpRead = flags.mcpRead;
      }
      if (flags.mcpWrite !== undefined) {
        patch.mcpWrite = flags.mcpWrite;
      }
      const { nextState } = applyNotesAction(existingState, 'settings-update', patch);
      writeJsonAtomic(statePath, nextState);
    }
    finalSettings = { mcpRead: nextRead, mcpWrite: nextWrite };
    return finalSettings;
  };

  const setupRes = await runSidecarSetupFn({
    sidecarId: SIDECAR_ID,
    displayName: SIDECAR_TITLE,
    port: DEFAULT_PORT,
    sidecarDir: repoRoot,
    repoRoot,
    entryScript: 'launch.mjs',
    requiredFiles: options.requiredFiles || [...REQUIRED_SETUP_FILES],
    args,
    ...(options.globalSidecarsDir ? { globalSidecarsDir: options.globalSidecarsDir } : {}),
    ...(options.configJsonPath ? { configJsonPath: options.configJsonPath } : {}),
    ...(options.packagesDir ? { packagesDir: options.packagesDir } : {}),
    ...(effectiveRpcOptions ? { rpcOptions: effectiveRpcOptions } : {}),
    ...(options.execFn ? { execFn: options.execFn } : {}),
    ...(options.restartDelayMs !== undefined ? { restartDelayMs: options.restartDelayMs } : {}),
    onBeforeSetup: async (ctx) => {
      syncLocalSidecarKit(repoRoot, env);
      const settings = syncMcpFlagsToStateFile();
      if (typeof options.onBeforeSetup === 'function') {
        await options.onBeforeSetup({ ...ctx, statePath, settings: { ...settings } });
      }
    },
    onUninstall: async () => {
      await syncMcpRegistration({
        uninstall: true,
        mcpConfigPath: options.mcpConfigPath,
        callLsRpcFn: options.callLsRpcFn,
      });
    },
  });

  if (setupRes.uninstalled) {
    return setupRes;
  }

  if (!finalSettings) {
    syncMcpFlagsToStateFile();
  }

  const linkedRoot = setupRes.linkedTo || repoRoot;
  const effectiveSidecarsDir = resolve(String(options.globalSidecarsDir || GLOBAL_SIDECARS_DIR));
  const stableLinkEntry = join(effectiveSidecarsDir, SIDECAR_ID, 'mcp.mjs');
  const resolvedMcpEntry = options.mcpEntryPath
    || (existsSync(stableLinkEntry) ? stableLinkEntry : join(linkedRoot, 'mcp.mjs'));
  const mcpRes = await syncMcpRegistration({
    mcpRead: finalSettings.mcpRead,
    mcpWrite: finalSettings.mcpWrite,
    mcpEntryPath: resolvedMcpEntry,
    globalSidecarsDir: effectiveSidecarsDir,
    mcpConfigPath: options.mcpConfigPath,
    callLsRpcFn: options.callLsRpcFn,
  });

  return {
    ...setupRes,
    mcp: mcpRes,
    settings: { mcpRead: finalSettings.mcpRead, mcpWrite: finalSettings.mcpWrite },
  };
}

const isMain = (() => {
  try {
    return !process.execArgv.includes('--test') && realpathSync(resolve(process.argv[1] || '')) === MODULE_PATH;
  } catch {
    return false;
  }
})();

if (isMain) {
  runNotesSetup().catch((err) => {
    console.error(`[${SIDECAR_ID}] Setup failed: ${err?.message || err}`);
    process.exit(1);
  });
}
