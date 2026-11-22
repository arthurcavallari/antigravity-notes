#!/usr/bin/env node
/**
 * @fileoverview Guarded stdio JSON-RPC MCP entrypoint for Antigravity Notes (online /api/mcp + offline hibernation fallback).
 */

import { realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { readJsonSafe } from 'antigravity-sidecar-kit/config';
import { startStdioMcpBridge } from 'antigravity-sidecar-kit/state-sync';
import { SIDECAR_ID, createInitialState, resolveNotesDataDir } from './lib/constants.mjs';
import { guardMcpRpc } from './lib/mcp-guard.mjs';
import { buildNotesMcpTools } from './lib/mcp-tools.mjs';

const ERR_PARSE = -32700;
const ERR_INTERNAL = -32603;

function isPlainObject(val) {
  return Boolean(val) && typeof val === 'object' && !Array.isArray(val);
}

export function startNotesMcpStdio(rawOptions = {}) {
  const options = isPlainObject(rawOptions) ? rawOptions : {};
  const dataDir = options.dataDir
    ? resolve(String(options.dataDir))
    : resolveNotesDataDir(options.env || process.env);
  const stateFilePath = join(dataDir, 'state.json');
  const input = options.input || process.stdin;
  const output = options.output || process.stdout;
  const exitOnClose = Boolean(options.exitOnClose);
  const mcpTools = options.mcpTools || options.tools || buildNotesMcpTools();

  const inertInput = new PassThrough();
  const inertOutput = new PassThrough();
  const bridge = startStdioMcpBridge({
    sidecarId: SIDECAR_ID,
    dataDir,
    mcpPath: '/api/mcp',
    initialState: createInitialState(),
    mcpTools,
    ...(options.forwardTimeoutMs !== undefined ? { forwardTimeoutMs: options.forwardTimeoutMs } : {}),
    ...(options.fetchFn !== undefined ? { fetchFn: options.fetchFn } : {}),
    ...(options.serverInfoPath !== undefined ? { serverInfoPath: options.serverInfoPath } : {}),
    input: inertInput,
    output: inertOutput,
  });

  const defaultGetSettings = () => {
    const state = readJsonSafe(stateFilePath, null);
    const settings = isPlainObject(state?.settings) ? state.settings : null;
    return {
      mcpRead: settings?.mcpRead === true,
      mcpWrite: settings?.mcpWrite === true,
    };
  };
  const getSettings = typeof options.getSettings === 'function' ? options.getSettings : defaultGetSettings;

  const routeRequest = (rpcRequest) => guardMcpRpc(rpcRequest, {
    getSettings,
    forwardRpc: (req) => bridge.routeRequest(req),
  });

  const handleLine = async (rawLine) => {
    const trimmed = typeof rawLine === 'string' ? rawLine.trim() : '';
    if (!trimmed) {
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      const parseErr = { jsonrpc: '2.0', id: null, error: { code: ERR_PARSE, message: 'Parse error' } };
      output.write(`${JSON.stringify(parseErr)}\n`);
      return;
    }
    try {
      const reply = await routeRequest(parsed);
      if (reply !== null && reply !== undefined) {
        output.write(`${JSON.stringify(reply)}\n`);
      }
    } catch (err) {
      const id = isPlainObject(parsed) && parsed.id !== undefined ? parsed.id : null;
      const internalErr = {
        jsonrpc: '2.0',
        id,
        error: { code: ERR_INTERNAL, message: err?.message || String(err) },
      };
      output.write(`${JSON.stringify(internalErr)}\n`);
    }
  };

  let queue = Promise.resolve();
  const rl = createInterface({ input, crlfDelay: Infinity, terminal: false });
  rl.on('line', (line) => {
    queue = queue.then(() => handleLine(line)).catch(() => {});
  });

  let resolveClosed;
  const closed = new Promise((r) => {
    resolveClosed = r;
  });

  let cleanedUp = false;
  const finalizeClose = () => {
    if (cleanedUp) {
      return;
    }
    cleanedUp = true;
    inertInput.end();
    inertOutput.end();
    bridge.close();
    resolveClosed();
    if (exitOnClose) {
      process.exit(0);
    }
  };

  let rlClosed = false;
  rl.once('close', () => {
    rlClosed = true;
    queue.finally(finalizeClose);
  });

  const close = () => {
    if (!rlClosed) {
      rl.close();
    }
  };

  return { close, closed, handleLine, routeRequest };
}

function isExecutedDirectly() {
  const entryArg = process.argv[1];
  if (!entryArg || process.execArgv.includes('--test')) {
    return false;
  }
  try {
    const entryReal = realpathSync(resolve(entryArg));
    const moduleReal = realpathSync(fileURLToPath(import.meta.url));
    return entryReal === moduleReal;
  } catch {
    return false;
  }
}

if (isExecutedDirectly()) {
  startNotesMcpStdio({ exitOnClose: true });
}
