/**
 * @fileoverview Atomic mcp_config.json registration & RefreshMcpServers lifecycle sync for Antigravity Notes.
 */

import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { GLOBAL_CONFIG_DIR, readJsonSafe } from 'antigravity-sidecar-kit/config';
import { callLsRpc } from 'antigravity-sidecar-kit/rpc';
import { writeJsonAtomic } from 'antigravity-sidecar-kit/state-sync';
import { REPO_ROOT, SIDECAR_ID } from './constants.mjs';

export const MCP_SERVER_NAME = 'antigravity-notes';
export const DEFAULT_MCP_CONFIG_PATH = join(GLOBAL_CONFIG_DIR, 'mcp_config.json');
export const MCP_CONFIG_PATH = DEFAULT_MCP_CONFIG_PATH;
export const DEFAULT_MCP_ENTRY_PATH = join(REPO_ROOT, 'mcp.mjs');

function isPlainObject(val) {
  return Boolean(val) && typeof val === 'object' && !Array.isArray(val);
}

async function refreshMcpServersBestEffort(callLsRpcFn) {
  if (typeof callLsRpcFn !== 'function') {
    return;
  }
  await Promise.resolve()
    .then(() => callLsRpcFn('RefreshMcpServers', {}, { sidecarId: SIDECAR_ID }))
    .catch(() => {});
}

export async function syncMcpRegistration(rawOptions = {}) {
  const options = isPlainObject(rawOptions) ? rawOptions : {};
  const uninstall = Boolean(options.uninstall);
  const enabled = Boolean(options.mcpRead) || Boolean(options.mcpWrite);
  const mcpConfigPath = options.mcpConfigPath
    ? resolve(String(options.mcpConfigPath))
    : DEFAULT_MCP_CONFIG_PATH;
  const mcpEntryPath = options.mcpEntryPath
    ? resolve(String(options.mcpEntryPath))
    : DEFAULT_MCP_ENTRY_PATH;
  const callLsRpcFn = options.callLsRpcFn === undefined ? callLsRpc : options.callLsRpcFn;

  if (uninstall) {
    if (existsSync(mcpConfigPath)) {
      const currentConfig = readJsonSafe(mcpConfigPath, {}, { strict: true });
      const nextServers = isPlainObject(currentConfig.mcpServers)
        ? { ...currentConfig.mcpServers }
        : {};
      delete nextServers[MCP_SERVER_NAME];
      writeJsonAtomic(mcpConfigPath, {
        ...currentConfig,
        mcpServers: nextServers,
      });
    }
    await refreshMcpServersBestEffort(callLsRpcFn);
    return { registered: false, enabled: false };
  }

  const currentConfig = readJsonSafe(mcpConfigPath, {}, { strict: true });
  const prevServers = isPlainObject(currentConfig.mcpServers) ? currentConfig.mcpServers : {};
  const prevEntry = isPlainObject(prevServers[MCP_SERVER_NAME]) ? prevServers[MCP_SERVER_NAME] : {};

  const nextEntry = {
    ...(isPlainObject(prevEntry.env) ? { env: prevEntry.env } : {}),
    command: process.execPath,
    args: [mcpEntryPath],
    disabled: !enabled,
  };

  writeJsonAtomic(mcpConfigPath, {
    ...currentConfig,
    mcpServers: {
      ...prevServers,
      [MCP_SERVER_NAME]: nextEntry,
    },
  });

  await refreshMcpServersBestEffort(callLsRpcFn);
  return { registered: true, enabled };
}
