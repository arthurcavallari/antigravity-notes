import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runAgentApiAsync } from 'antigravity-sidecar-kit/state-sync';
import { MAX_PAD_BYTES, REPO_ROOT } from '../lib/constants.mjs';
import { MAX_DISPATCH_BYTES, createDispatcher } from '../lib/dispatcher.mjs';

const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/;

describe('createDispatcher — truncation-free & dedup-free prompt dispatch', () => {
  it('sends >4,000-char prompts and exact 1 MiB prompts intact without truncation or whitespace mangling', async () => {
    assert.equal(MAX_DISPATCH_BYTES, MAX_PAD_BYTES);
    const calls = [];
    const dispatcher = createDispatcher({
      agentApiFn: async (args, opts) => {
        calls.push({ args, opts });
        if (args[0] === 'get-conversation-metadata') {
          return {
            response: {
              conversationMetadata: {
                metadata: { projectId: 'proj-alpha' },
              },
            },
          };
        }
        return { ok: true };
      },
      lookupConversationTitle: async (id) => (id === 'conv-alpha' ? 'Notes Architecture Sprint' : ''),
      env: {},
    });

    const longPrompt = `Header line\n${'x'.repeat(12_500)}\n  indented footer\n`;
    assert.ok(longPrompt.length > 4_000);

    const res = await dispatcher.dispatchPrompt({
      mode: 'active',
      conversationId: 'conv-alpha',
      text: longPrompt,
    });

    assert.deepEqual(res, {
      ok: true,
      mode: 'active',
      conversationId: 'conv-alpha',
      conversationTitle: 'Notes Architecture Sprint',
    });
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0].args, ['get-conversation-metadata', 'conv-alpha']);
    assert.deepEqual(calls[1].args, ['send-message', '--', 'conv-alpha', longPrompt]);
    assert.equal(calls[1].args[3].length, longPrompt.length);
    assert.equal(calls[1].args[3].endsWith('\u2026'), false);
    assert.deepEqual(calls[1].opts, { projectId: 'proj-alpha' });

    const maxPrompt = 'm'.repeat(MAX_PAD_BYTES);
    const maxRes = await dispatcher.dispatchPrompt({
      conversationId: 'conv-alpha',
      text: maxPrompt,
    });
    assert.equal(maxRes.ok, true);
    assert.equal(calls[2].args[3].length, MAX_PAD_BYTES);
  });

  it('dispatches consecutive identical prompts every time in both active and new modes', async () => {
    const sendCalls = [];
    const startCalls = [];
    let nextId = 1;
    const dispatcher = createDispatcher({
      agentApiFn: async (args, opts) => {
        if (args[0] === 'get-conversation-metadata') {
          return { response: { conversationMetadata: { metadata: { projectId: 'proj-repeat' } } } };
        }
        if (args[0] === 'send-message') {
          sendCalls.push({ args, opts });
          return { ok: true };
        }
        if (args[0] === 'new-conversation') {
          startCalls.push({ args, opts });
          const createdId = `conv-new-${nextId}`;
          nextId += 1;
          return { conversationId: createdId };
        }
        return {};
      },
      lookupConversationTitle: async () => 'Repeated Thread',
      env: {},
    });

    const repeatedText = 'Run full integration suite and report flaky tests';
    const r1 = await dispatcher.dispatchPrompt({
      mode: 'active',
      conversationId: 'conv-dup',
      text: repeatedText,
    });
    const r2 = await dispatcher.dispatchPrompt({
      mode: 'active',
      conversationId: 'conv-dup',
      text: repeatedText,
    });
    const r3 = await dispatcher.dispatchPrompt({
      mode: 'active',
      conversationId: 'conv-dup',
      text: repeatedText,
    });

    assert.equal(sendCalls.length, 3);
    assert.equal(r1.ok, true);
    assert.equal(r2.ok, true);
    assert.equal(r3.ok, true);

    const n1 = await dispatcher.dispatchPrompt({
      mode: 'new',
      workspacePath: 'c:/Users/dev/IdeaProjects/antigravity-notes',
      text: repeatedText,
    });
    const n2 = await dispatcher.dispatchPrompt({
      mode: 'new',
      workspacePath: 'c:/Users/dev/IdeaProjects/antigravity-notes',
      text: repeatedText,
    });

    assert.equal(startCalls.length, 2);
    assert.equal(n1.conversationId, 'conv-new-1');
    assert.equal(n2.conversationId, 'conv-new-2');
  });
});

describe('createDispatcher — leading-hyphen CLI flag injection protection (Review Focus #1)', () => {
  it('always places -- before positional args and binds --title=<value> safely for leading-hyphen titles and prompts', async () => {
    const execCalls = [];
    const customAgentApi = (args, opts = {}) =>
      runAgentApiAsync(args, {
        ...opts,
        exePath: 'C:\\Users\\dev\\bin\\agentapi.exe',
        execFileFn: (file, execArgs, execOpts, cb) => {
          execCalls.push({ file, execArgs, execOpts });
          if (execArgs[0] === 'get-conversation-metadata') {
            cb(null, JSON.stringify({
              response: {
                conversationMetadata: {
                  metadata: { projectId: 'proj-real-exec' },
                },
              },
            }));
            return;
          }
          if (execArgs[0] === 'new-conversation') {
            cb(null, JSON.stringify({ conversationId: 'conv-spawned-dash' }));
            return;
          }
          cb(null, '{}');
        },
      });

    const dispatcher = createDispatcher({
      agentApiFn: customAgentApi,
      lookupConversationTitle: async () => '',
      env: {},
    });

    const checklistPrompt = '- [ ] Verify `--` before positional args\n- [ ] Check `--title=` binding';
    const activeRes = await dispatcher.dispatchPrompt({
      mode: 'active',
      conversationId: 'conv-target-1',
      title: '--urgent-checklist\n  review',
      text: checklistPrompt,
    });

    assert.deepEqual(activeRes, {
      ok: true,
      mode: 'active',
      conversationId: 'conv-target-1',
      conversationTitle: '--urgent-checklist review',
    });
    assert.deepEqual(execCalls[1].execArgs, [
      'send-message',
      '--title=--urgent-checklist review',
      '--',
      'conv-target-1',
      checklistPrompt,
    ]);
    assert.equal(execCalls[1].execOpts.env.ANTIGRAVITY_PROJECT_ID, 'proj-real-exec');

    await dispatcher.dispatchPrompt({
      mode: 'active',
      conversationId: 'conv-target-1',
      text: '--help',
    });
    assert.deepEqual(execCalls[2].execArgs, [
      'send-message',
      '--',
      'conv-target-1',
      '--help',
    ]);

    const newRes = await dispatcher.dispatchPrompt({
      mode: 'new',
      workspacePath: REPO_ROOT,
      title: '- [ ] Triage #bug',
      text: '--model=evil --profile=attacker',
    });

    assert.deepEqual(newRes, {
      ok: true,
      mode: 'new',
      conversationId: 'conv-spawned-dash',
      conversationTitle: '- [ ] Triage #bug',
    });
    assert.deepEqual(execCalls[3].execArgs, [
      'new-conversation',
      '--title=- [ ] Triage #bug',
      '--',
      '--model=evil --profile=attacker',
    ]);
    assert.equal(execCalls[3].execOpts.cwd, REPO_ROOT);
  });
});

describe('createDispatcher — mode routing, _new upgrade, workspace forwarding & title resolution', () => {
  it('upgrades mode: active to new-conversation when conversationId is _new, empty, null, or unsafe', async () => {
    const calls = [];
    let counter = 0;
    const dispatcher = createDispatcher({
      agentApiFn: async (args, opts) => {
        calls.push({ args, opts });
        counter += 1;
        return {
          response: {
            conversationId: `conv-upgraded-${counter}`,
          },
        };
      },
      lookupConversationTitle: async () => '',
      env: { ANTIGRAVITY_PROJECT_ID: 'proj-env-default' },
    });

    const cases = ['_new', '', '   ', null, undefined, 'null', '../traversal', '--flag-id'];
    for (let i = 0; i < cases.length; i += 1) {
      const res = await dispatcher.dispatchPrompt({
        mode: 'active',
        conversationId: cases[i],
        workspacePath: 'c:/Users/dev/IdeaProjects/antigravity-notes',
        text: '- [ ] Investigate _new fallback behavior',
      });
      assert.deepEqual(res, {
        ok: true,
        mode: 'new',
        conversationId: `conv-upgraded-${i + 1}`,
        conversationTitle: 'Investigate _new fallback behavior',
      });
    }

    assert.equal(calls.length, cases.length);
    for (const call of calls) {
      assert.deepEqual(call.args, [
        'new-conversation',
        '--',
        '- [ ] Investigate _new fallback behavior',
      ]);
      assert.deepEqual(call.opts, {
        projectId: 'proj-env-default',
        workspace: 'c:/Users/dev/IdeaProjects/antigravity-notes',
      });
    }
  });

  it('isolates mode: new from current conversationId, parses raw/nested new IDs, and resolves title fallbacks without splitting surrogate pairs', async () => {
    const calls = [];
    let nextResponse = {};
    const dispatcher = createDispatcher({
      agentApiFn: async (args, opts) => {
        calls.push({ args, opts });
        return nextResponse;
      },
      lookupConversationTitle: async (id) => {
        if (id === '11111111-2222-3333-4444-555555555555') {
          return 'Trajectory Resolved New Title';
        }
        if (id === 'conv-throw-title') {
          throw new Error('LS offline');
        }
        return '';
      },
      env: {},
    });

    // 1. When agentapi returns {} without an ID, current active conversationId must NOT leak into result
    nextResponse = {};
    const emptyIdRes = await dispatcher.dispatchPrompt({
      mode: 'new',
      conversationId: 'conv-currently-open',
      workspace: 'file:///C%3A/Users/dev/IdeaProjects/antigravity-notes/',
      text: '### Refactor Scratchpad split sash\nEnsure min-ratio 0.26 holds on resize',
    });
    assert.deepEqual(emptyIdRes, {
      ok: true,
      mode: 'new',
      conversationId: '',
      conversationTitle: 'Refactor Scratchpad split sash',
    });
    assert.deepEqual(calls[0], {
      args: [
        'new-conversation',
        '--',
        '### Refactor Scratchpad split sash\nEnsure min-ratio 0.26 holds on resize',
      ],
      opts: {
        projectId: '',
        workspace: 'file:///C%3A/Users/dev/IdeaProjects/antigravity-notes/',
      },
    });

    // 2. Parses UUID from { raw } CLI stdout and resolves title via lookupConversationTitle(resolvedConvId)
    nextResponse = { raw: 'Created conversation 11111111-2222-3333-4444-555555555555' };
    const rawUuidRes = await dispatcher.dispatchPrompt({
      mode: 'new',
      text: 'Check raw UUID extraction',
    });
    assert.deepEqual(rawUuidRes, {
      ok: true,
      mode: 'new',
      conversationId: '11111111-2222-3333-4444-555555555555',
      conversationTitle: 'Trajectory Resolved New Title',
    });
    assert.deepEqual(calls[1].opts, { projectId: '' });

    // 3. Degrades cleanly to derived short title on lookup error and preserves astral-plane surrogate pairs at boundary
    nextResponse = { response: { newConversation: { conversationId: 'conv-throw-title' } } };
    const astralPrompt = `${'a'.repeat(59)}🚀${'b'.repeat(20)}`;
    const fallbackTitleRes = await dispatcher.dispatchPrompt({
      mode: 'new',
      text: astralPrompt,
    });
    assert.equal(fallbackTitleRes.conversationId, 'conv-throw-title');
    assert.equal(LONE_SURROGATE_RE.test(fallbackTitleRes.conversationTitle), false);
    assert.equal(fallbackTitleRes.conversationTitle, `${'a'.repeat(59)}🚀\u2026`);

    // 4. Symbol-only prompt "---" still produces a non-empty derived title, while fenced code blocks use inner code line
    nextResponse = {};
    const symbolRes = await dispatcher.dispatchPrompt({
      mode: 'new',
      text: '---',
    });
    assert.equal(symbolRes.conversationTitle, '---');

    const fencedRes = await dispatcher.dispatchPrompt({
      mode: 'new',
      text: '```ts\nexport function computeSplitRatio(width) {\n  return 0.44;\n}\n```',
    });
    assert.equal(fencedRes.conversationTitle, 'export function computeSplitRatio(width) {');

    // 5. Prefers nested response.conversationId over top-level RPC envelope id
    nextResponse = { id: 'rpc-envelope-1', response: { conversationId: 'conv-nested-real' } };
    const envelopeRes = await dispatcher.dispatchPrompt({
      mode: 'new',
      text: 'Verify envelope ID priority',
    });
    assert.equal(envelopeRes.conversationId, 'conv-nested-real');
  });

  it('honors default process.env and default lookupConversationTitle when options are omitted', async () => {
    const prevProj = process.env.ANTIGRAVITY_PROJECT_ID;
    const prevWs = process.env.ANTIGRAVITY_WORKSPACE;
    const prevLsAddr = process.env.ANTIGRAVITY_LS_ADDRESS;
    process.env.ANTIGRAVITY_PROJECT_ID = 'proj-from-process-env';
    process.env.ANTIGRAVITY_WORKSPACE = 'c:/Users/dev/IdeaProjects/antigravity-notes';
    delete process.env.ANTIGRAVITY_LS_ADDRESS;

    try {
      const captured = [];
      const dispatcher = createDispatcher({
        agentApiFn: async (args, opts) => {
          captured.push({ args, opts });
          return { conversationId: 'conv-default-env' };
        },
      });
      const res = await dispatcher.dispatchPrompt({
        mode: 'new',
        text: 'Default env & lookup check',
      });
      assert.deepEqual(res, {
        ok: true,
        mode: 'new',
        conversationId: 'conv-default-env',
        conversationTitle: 'Default env & lookup check',
      });
      assert.deepEqual(captured[0].opts, {
        projectId: 'proj-from-process-env',
        workspace: 'c:/Users/dev/IdeaProjects/antigravity-notes',
      });
    } finally {
      if (prevProj === undefined) {
        delete process.env.ANTIGRAVITY_PROJECT_ID;
      } else {
        process.env.ANTIGRAVITY_PROJECT_ID = prevProj;
      }
      if (prevWs === undefined) {
        delete process.env.ANTIGRAVITY_WORKSPACE;
      } else {
        process.env.ANTIGRAVITY_WORKSPACE = prevWs;
      }
      if (prevLsAddr !== undefined) {
        process.env.ANTIGRAVITY_LS_ADDRESS = prevLsAddr;
      }
    }
  });
});

describe('createDispatcher — projectId per-conversation caching, coalescing & stale-cache recovery', () => {
  it('caches projectId per conversationId, coalesces concurrent lookups, guards prototype keys, and skips caching failed lookups', async () => {
    const calls = [];
    let failFlakyMeta = true;
    const dispatcher = createDispatcher({
      agentApiFn: async (args, opts) => {
        calls.push({ args, opts });
        if (args[0] === 'get-conversation-metadata') {
          const targetId = args[1];
          await new Promise((r) => setTimeout(r, 15));
          if (targetId === 'conv-a') {
            return { response: { conversation_metadata: { metadata: { project_id: 'proj-a' } } } };
          }
          if (targetId === 'conv-b') {
            return { response: { conversationMetadata: { metadata: { projectId: 'proj-b' } } } };
          }
          if (targetId === 'conv-flaky') {
            if (failFlakyMeta) {
              return { error: 'transient metadata timeout' };
            }
            return { response: { conversationMetadata: { metadata: { projectId: 'proj-flaky-ok' } } } };
          }
          return {};
        }
        return { ok: true };
      },
      lookupConversationTitle: async () => '',
      env: {
        ANTIGRAVITY_PROJECT_ID: 'proj-env-fallback',
        ANTIGRAVITY_AGENTAPI_EXE: '/opt/agy/agentapi',
      },
    });

    // Concurrent dispatches to conv-a coalesce into 1 get-conversation-metadata call
    await Promise.all([
      dispatcher.dispatchPrompt({ conversationId: 'conv-a', text: 'First concurrent' }),
      dispatcher.dispatchPrompt({ conversationId: 'conv-a', text: 'Second concurrent' }),
    ]);
    const metaCallsAfterConcurrent = calls.filter((c) => c.args[0] === 'get-conversation-metadata');
    assert.equal(metaCallsAfterConcurrent.length, 1);

    // Third dispatch to conv-a hits cache with 0 new metadata calls
    await dispatcher.dispatchPrompt({ conversationId: 'conv-a', text: 'Third cached' });
    assert.equal(calls.filter((c) => c.args[0] === 'get-conversation-metadata').length, 1);
    const convASends = calls.filter((c) => c.args[0] === 'send-message' && c.args[2] === 'conv-a');
    assert.equal(convASends.length, 3);
    for (const send of convASends) {
      assert.deepEqual(send.opts, {
        projectId: 'proj-a',
        exePath: '/opt/agy/agentapi',
      });
    }

    // Separate conversationId conv-b resolves and caches its own projectId
    await dispatcher.dispatchPrompt({ conversationId: 'conv-b', text: 'Hello B' });
    const convBSend = calls.find((c) => c.args[0] === 'send-message' && c.args[2] === 'conv-b');
    assert.equal(convBSend.opts.projectId, 'proj-b');

    // Object.prototype key 'toString' must not collide with Map cache
    const protoRes = await dispatcher.dispatchPrompt({ conversationId: 'toString', text: 'Proto key check' });
    assert.equal(protoRes.ok, true);
    assert.equal(protoRes.conversationId, 'toString');
    const protoSend = calls.find((c) => c.args[0] === 'send-message' && c.args[2] === 'toString');
    assert.equal(protoSend.opts.projectId, 'proj-env-fallback');

    // Transient metadata failure falls back to env projectId without poisoning cache
    await dispatcher.dispatchPrompt({ conversationId: 'conv-flaky', text: 'Attempt 1' });
    const flakySend1 = calls.filter((c) => c.args[0] === 'send-message' && c.args[2] === 'conv-flaky')[0];
    assert.equal(flakySend1.opts.projectId, 'proj-env-fallback');

    failFlakyMeta = false;
    await dispatcher.dispatchPrompt({ conversationId: 'conv-flaky', text: 'Attempt 2' });
    const flakySend2 = calls.filter((c) => c.args[0] === 'send-message' && c.args[2] === 'conv-flaky')[1];
    assert.equal(flakySend2.opts.projectId, 'proj-flaky-ok');
  });

  it('clears stale cached projectId and retries send-message once if refreshed metadata returns a new projectId', async () => {
    let currentProjectId = 'proj-v1';
    const calls = [];
    const dispatcher = createDispatcher({
      agentApiFn: async (args, opts) => {
        calls.push({ args, opts });
        if (args[0] === 'get-conversation-metadata') {
          return { response: { conversationMetadata: { metadata: { projectId: currentProjectId } } } };
        }
        if (args[0] === 'send-message' && opts.projectId === 'proj-v1' && currentProjectId === 'proj-v2') {
          return { error: 'Project mismatch for conversation' };
        }
        return { ok: true };
      },
      lookupConversationTitle: async () => 'Rotated Project Chat',
      env: {},
    });

    const first = await dispatcher.dispatchPrompt({
      conversationId: 'conv-rotate',
      text: 'Warm cache',
    });
    assert.equal(first.ok, true);

    currentProjectId = 'proj-v2';
    const second = await dispatcher.dispatchPrompt({
      conversationId: 'conv-rotate',
      text: 'After rotation',
    });
    assert.equal(second.ok, true);
    assert.deepEqual(
      calls.map((c) => ({ cmd: c.args[0], projectId: c.opts?.projectId || '' })),
      [
        { cmd: 'get-conversation-metadata', projectId: '' },
        { cmd: 'send-message', projectId: 'proj-v1' },
        { cmd: 'send-message', projectId: 'proj-v1' },
        { cmd: 'get-conversation-metadata', projectId: '' },
        { cmd: 'send-message', projectId: 'proj-v2' },
      ]
    );
  });
});

describe('createDispatcher — client validation (400) & upstream agentapi error handling (502)', () => {
  it('throws statusCode=400 validation errors without invoking agentApiFn on invalid inputs', async () => {
    let apiInvocations = 0;
    const dispatcher = createDispatcher({
      agentApiFn: async () => {
        apiInvocations += 1;
        return { ok: true };
      },
      lookupConversationTitle: async () => '',
      env: {},
    });

    const invalidInputs = [
      null,
      undefined,
      'raw-string',
      [],
      {},
      { text: '' },
      { text: '   \n\t  ' },
      { text: 42 },
      { text: 'contains\0nul' },
      { text: '🎉'.repeat(270_000) },
      { text: 'Valid prompt', mode: '' },
      { text: 'Valid prompt', mode: 'broadcast' },
      { text: 'Valid prompt', mode: 'ACTIVE' },
      { text: 'Valid prompt', title: 123 },
      { text: 'Valid prompt', title: 'bad\0title' },
      { text: 'Valid prompt', mode: 'new', workspacePath: '--inject-flag' },
      { text: 'Valid prompt', mode: 'new', workspacePath: 'bad\0path' },
      { text: 'Valid prompt', conversationId: 'conv-1', projectId: '--bad-proj' },
    ];

    for (const badReq of invalidInputs) {
      await assert.rejects(
        () => dispatcher.dispatchPrompt(badReq),
        (err) => {
          assert.equal(err instanceof Error, true);
          assert.equal(err.statusCode, 400);
          assert.equal(err.status, 400);
          assert.equal(typeof err.clientMessage, 'string');
          assert.ok(err.message.length > 0);
          return true;
        }
      );
    }

    assert.equal(apiInvocations, 0);
  });

  it('throws statusCode=502 errors without duplicate sends when agentApiFn fails or rejects', async () => {
    let sendCount = 0;
    let failureShape = 'error-obj';

    const dispatcher = createDispatcher({
      agentApiFn: async (args) => {
        if (args[0] === 'get-conversation-metadata') {
          return { response: { conversationMetadata: { metadata: { projectId: 'proj-err' } } } };
        }
        sendCount += 1;
        if (failureShape === 'error-obj') {
          return { error: 'agentapi binary exited with code 1' };
        }
        if (failureShape === 'ok-false') {
          return { ok: false, message: 'cascade unavailable' };
        }
        if (failureShape === 'exit-code') {
          return { exitCode: 2, raw: 'fatal error' };
        }
        if (failureShape === 'null-res') {
          return null;
        }
        throw new Error('spawn agentapi ENOENT');
      },
      lookupConversationTitle: async () => '',
      env: {},
    });

    for (const shape of ['error-obj', 'ok-false', 'exit-code', 'null-res', 'throw']) {
      failureShape = shape;
      const before = sendCount;
      await assert.rejects(
        () => dispatcher.dispatchPrompt({ conversationId: 'conv-fail', text: 'Check error handling' }),
        (err) => {
          assert.equal(err instanceof Error, true);
          assert.equal(err.statusCode, 502);
          assert.equal(err.status, 502);
          assert.ok(err.message.length > 0);
          return true;
        }
      );
      assert.equal(sendCount, before + 1, `shape ${shape} must not double-send on non-cached failure`);
    }
  });
});
