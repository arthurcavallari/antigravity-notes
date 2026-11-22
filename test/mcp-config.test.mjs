import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { REPO_ROOT, SIDECAR_ID } from '../lib/constants.mjs';
import {
  DEFAULT_MCP_CONFIG_PATH,
  MCP_SERVER_NAME,
  syncMcpRegistration,
} from '../lib/mcp-config.mjs';

describe('lib/mcp-config.mjs — syncMcpRegistration lifecycle', () => {
  it('registers disabled by default (0 context tokens), enables on read/write opt-in, preserves unrelated servers, strips BOM, and removes entry on uninstall', async () => {
    assert.equal(MCP_SERVER_NAME, 'antigravity-notes');
    assert.ok(DEFAULT_MCP_CONFIG_PATH.endsWith('mcp_config.json'));

    const tmpDir = mkdtempSync(join(tmpdir(), 'notes-mcp-cfg-'));
    const mcpConfigPath = join(tmpDir, 'mcp_config.json');
    const customEntryPath = join(REPO_ROOT, 'mcp.mjs');
    const rpcCalls = [];

    const mockLsRpc = async (method, body, opts) => {
      rpcCalls.push({ method, body, opts });
      return { ok: true };
    };

    try {
      // Seed an existing user mcp_config.json with UTF-8 BOM and unrelated servers
      const initialUserConfig = {
        $schema: 'https://antigravity.google/schemas/mcp_config.json',
        mcpServers: {
          github: {
            command: 'npx',
            args: ['-y', '@modelcontextprotocol/server-github'],
          },
          postgres: {
            serverUrl: 'http://127.0.0.1:8888/mcp',
          },
        },
      };
      writeFileSync(mcpConfigPath, `\uFEFF${JSON.stringify(initialUserConfig, null, 2)}\n`, 'utf8');

      // 1. Default registration (mcpRead: false, mcpWrite: false) -> disabled: true
      const regOff = await syncMcpRegistration({
        mcpRead: false,
        mcpWrite: false,
        mcpEntryPath: customEntryPath,
        mcpConfigPath,
        callLsRpcFn: mockLsRpc,
      });
      assert.deepEqual(regOff, { registered: true, enabled: false });
      assert.equal(rpcCalls.length, 1);
      assert.deepEqual(rpcCalls[0], {
        method: 'RefreshMcpServers',
        body: {},
        opts: { sidecarId: SIDECAR_ID },
      });

      const rawAfterOff = readFileSync(mcpConfigPath, 'utf8');
      assert.equal(rawAfterOff.charCodeAt(0) === 0xfeff, false, 'Must write UTF-8 without BOM');
      const parsedOff = JSON.parse(rawAfterOff);
      assert.equal(parsedOff.$schema, initialUserConfig.$schema);
      assert.deepEqual(parsedOff.mcpServers.github, initialUserConfig.mcpServers.github);
      assert.deepEqual(parsedOff.mcpServers.postgres, initialUserConfig.mcpServers.postgres);
      assert.deepEqual(parsedOff.mcpServers['antigravity-notes'], {
        command: process.execPath,
        args: [customEntryPath],
        disabled: true,
      });

      // 2. Enable via mcpRead: true, mcpWrite: false -> disabled: false
      const regRead = await syncMcpRegistration({
        mcpRead: true,
        mcpWrite: false,
        mcpEntryPath: customEntryPath,
        mcpConfigPath,
        callLsRpcFn: mockLsRpc,
      });
      assert.deepEqual(regRead, { registered: true, enabled: true });
      const parsedRead = JSON.parse(readFileSync(mcpConfigPath, 'utf8'));
      assert.deepEqual(parsedRead.mcpServers['antigravity-notes'], {
        command: process.execPath,
        args: [customEntryPath],
        disabled: false,
      });

      // 3. Enable via mcpRead: false, mcpWrite: true -> disabled: false
      const regWrite = await syncMcpRegistration({
        mcpRead: false,
        mcpWrite: true,
        mcpEntryPath: customEntryPath,
        mcpConfigPath,
        callLsRpcFn: mockLsRpc,
      });
      assert.deepEqual(regWrite, { registered: true, enabled: true });
      const parsedWrite = JSON.parse(readFileSync(mcpConfigPath, 'utf8'));
      assert.equal(parsedWrite.mcpServers['antigravity-notes'].disabled, false);

      // 4. Disable back to (false, false) -> remains registered with disabled: true
      const regDisabledAgain = await syncMcpRegistration({
        mcpRead: false,
        mcpWrite: false,
        mcpEntryPath: customEntryPath,
        mcpConfigPath,
        callLsRpcFn: mockLsRpc,
      });
      assert.deepEqual(regDisabledAgain, { registered: true, enabled: false });
      assert.equal(
        JSON.parse(readFileSync(mcpConfigPath, 'utf8')).mcpServers['antigravity-notes'].disabled,
        true
      );

      // 5. Uninstall -> deletes antigravity-notes entry while preserving github & postgres
      const regUninstall = await syncMcpRegistration({
        mcpRead: true,
        mcpWrite: true,
        uninstall: true,
        mcpEntryPath: customEntryPath,
        mcpConfigPath,
        callLsRpcFn: mockLsRpc,
      });
      assert.deepEqual(regUninstall, { registered: false, enabled: false });
      assert.equal(rpcCalls.length, 5);

      const parsedUninstalled = JSON.parse(readFileSync(mcpConfigPath, 'utf8'));
      assert.equal(Object.hasOwn(parsedUninstalled.mcpServers, 'antigravity-notes'), false);
      assert.deepEqual(parsedUninstalled.mcpServers.github, initialUserConfig.mcpServers.github);
      assert.deepEqual(parsedUninstalled.mcpServers.postgres, initialUserConfig.mcpServers.postgres);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('creates missing mcp_config.json, degrades gracefully when Language Server RPC fails, handles uninstall on missing file, and refuses to clobber corrupt JSON', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'notes-mcp-cfg-offline-'));
    const missingPath = join(tmpDir, 'nested', 'mcp_config.json');

    const offlineRpc = async () => {
      throw new Error('Missing ANTIGRAVITY_LS_ADDRESS or ANTIGRAVITY_CSRF_TOKEN');
    };

    try {
      // Uninstall when file does not exist yet succeeds cleanly without creating junk files
      const uninstMissing = await syncMcpRegistration({
        uninstall: true,
        mcpConfigPath: missingPath,
        callLsRpcFn: offlineRpc,
      });
      assert.deepEqual(uninstMissing, { registered: false, enabled: false });
      assert.equal(existsSync(missingPath), false);

      // Register when file does not exist yet + offline LS RPC
      const created = await syncMcpRegistration({
        mcpRead: true,
        mcpWrite: true,
        mcpConfigPath: missingPath,
        callLsRpcFn: offlineRpc,
      });
      assert.deepEqual(created, { registered: true, enabled: true });
      assert.equal(existsSync(missingPath), true);
      const parsed = JSON.parse(readFileSync(missingPath, 'utf8'));
      assert.equal(parsed.mcpServers['antigravity-notes'].command, process.execPath);
      assert.equal(parsed.mcpServers['antigravity-notes'].args[0], join(REPO_ROOT, 'mcp.mjs'));
      assert.equal(parsed.mcpServers['antigravity-notes'].disabled, false);

      // Corrupt JSON on disk must throw rather than silently wiping user's other MCP servers
      writeFileSync(missingPath, '{ broken json', 'utf8');
      await assert.rejects(
        () => syncMcpRegistration({
          mcpRead: false,
          mcpWrite: false,
          mcpConfigPath: missingPath,
          callLsRpcFn: offlineRpc,
        }),
        /SyntaxError|JSON/i
      );
      assert.equal(readFileSync(missingPath, 'utf8'), '{ broken json');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
