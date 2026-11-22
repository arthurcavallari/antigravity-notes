/**
 * @fileoverview Permission gate for online HTTP /api/mcp and offline stdio mcp.mjs JSON-RPC traffic.
 */

import { READ_TOOL_NAMES, WRITE_TOOL_NAMES } from './mcp-tools.mjs';

const ERR_INVALID_REQUEST = -32600;
const ERR_METHOD_NOT_FOUND = -32601;
const ERR_INVALID_PARAMS = -32602;
const ERR_PERMISSION_DENIED = -32001;

const READ_TOOL_SET = new Set(READ_TOOL_NAMES);
const WRITE_TOOL_SET = new Set(WRITE_TOOL_NAMES);

function isPlainObject(val) {
  return Boolean(val) && typeof val === 'object' && !Array.isArray(val);
}

function jsonRpcError(id, code, message) {
  return {
    jsonrpc: '2.0',
    id,
    error: { code, message },
  };
}

function unwrapForwardReply(rawReply) {
  if (isPlainObject(rawReply) && rawReply.jsonrpc === undefined && typeof rawReply.body === 'string') {
    try {
      const parsed = JSON.parse(rawReply.body);
      if (Number.isInteger(rawReply.status) && rawReply.status !== 200 && isPlainObject(parsed)) {
        Object.defineProperty(parsed, 'status', {
          value: rawReply.status,
          enumerable: false,
          configurable: true,
          writable: true,
        });
      }
      return parsed;
    } catch {
      return rawReply;
    }
  }
  return rawReply;
}

async function resolvePermissions(getSettings) {
  const raw = typeof getSettings === 'function' ? await getSettings() : null;
  return {
    mcpRead: raw?.mcpRead === true,
    mcpWrite: raw?.mcpWrite === true,
  };
}

async function guardSingleMcpRpc(rpcRequest, { getSettings, forwardRpc }) {
  if (!isPlainObject(rpcRequest)) {
    return jsonRpcError(null, ERR_INVALID_REQUEST, 'Invalid Request');
  }
  const hasId = Object.hasOwn(rpcRequest, 'id') && rpcRequest.id !== undefined;
  const id = hasId ? rpcRequest.id : null;
  const method = typeof rpcRequest.method === 'string' ? rpcRequest.method.trim() : '';
  if (!method) {
    return jsonRpcError(id, ERR_INVALID_REQUEST, 'Invalid Request');
  }

  if (method === 'tools/call') {
    const params = isPlainObject(rpcRequest.params) ? rpcRequest.params : {};
    const toolName = typeof params.name === 'string' ? params.name.trim() : '';
    if (!toolName) {
      return hasId ? jsonRpcError(id, ERR_INVALID_PARAMS, 'Missing or invalid tool name.') : null;
    }
    if (toolName === 'get_state') {
      return hasId ? jsonRpcError(id, ERR_METHOD_NOT_FOUND, 'Tool "get_state" is disabled for privacy.') : null;
    }

    const { mcpRead, mcpWrite } = await resolvePermissions(getSettings);
    if (READ_TOOL_SET.has(toolName)) {
      if (!mcpRead) {
        return hasId
          ? jsonRpcError(id, ERR_PERMISSION_DENIED, `MCP read access is disabled for "${toolName}".`)
          : null;
      }
    } else if (WRITE_TOOL_SET.has(toolName)) {
      if (!mcpWrite) {
        return hasId
          ? jsonRpcError(id, ERR_PERMISSION_DENIED, `MCP write access is disabled for "${toolName}".`)
          : null;
      }
    } else {
      return hasId ? jsonRpcError(id, ERR_METHOD_NOT_FOUND, `Unknown tool: ${toolName}`) : null;
    }

    const rawCallReply = await forwardRpc(rpcRequest);
    return hasId ? unwrapForwardReply(rawCallReply) : null;
  }

  if (!hasId) {
    await forwardRpc(rpcRequest);
    return null;
  }

  if (method === 'tools/list') {
    const { mcpRead, mcpWrite } = await resolvePermissions(getSettings);
    const allowedNames = new Set([
      ...(mcpRead ? READ_TOOL_NAMES : []),
      ...(mcpWrite ? WRITE_TOOL_NAMES : []),
    ]);

    const rawListReply = await forwardRpc(rpcRequest);
    const unwrapped = unwrapForwardReply(rawListReply);
    if (!isPlainObject(unwrapped) || unwrapped.error) {
      return unwrapped;
    }
    const rawTools = Array.isArray(unwrapped.result?.tools) ? unwrapped.result.tools : [];
    const filteredTools = rawTools.filter(
      (tool) => isPlainObject(tool) && tool.name !== 'get_state' && allowedNames.has(tool.name)
    );
    const nextReply = {
      ...unwrapped,
      result: {
        ...(isPlainObject(unwrapped.result) ? unwrapped.result : {}),
        tools: filteredTools,
      },
    };
    if (Number.isInteger(unwrapped.status) && unwrapped.status !== 200) {
      Object.defineProperty(nextReply, 'status', {
        value: unwrapped.status,
        enumerable: false,
        configurable: true,
        writable: true,
      });
    }
    return nextReply;
  }

  const rawReply = await forwardRpc(rpcRequest);
  return unwrapForwardReply(rawReply);
}

export async function guardMcpRpc(rpcRequest, rawOptions = {}) {
  const options = isPlainObject(rawOptions) ? rawOptions : {};
  const forwardRpc = typeof options.forwardRpc === 'function'
    ? options.forwardRpc
    : async () => jsonRpcError(null, ERR_METHOD_NOT_FOUND, 'MCP forwarder unavailable.');

  if (Array.isArray(rpcRequest)) {
    if (rpcRequest.length === 0) {
      return jsonRpcError(null, ERR_INVALID_REQUEST, 'Invalid Request');
    }
    const replies = [];
    for (const item of rpcRequest) {
      const reply = await guardSingleMcpRpc(item, {
        getSettings: options.getSettings,
        forwardRpc,
      });
      if (reply !== null && reply !== undefined) {
        replies.push(reply);
      }
    }
    return replies.length > 0 ? replies : null;
  }

  return guardSingleMcpRpc(rpcRequest, {
    getSettings: options.getSettings,
    forwardRpc,
  });
}
