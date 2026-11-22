import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createLsRpcCache } from 'antigravity-sidecar-kit/rpc';
import { NEW_CONVERSATION_ID } from 'antigravity-sidecar-kit/workspace';
import {
  createContextResolver,
  extractConversationTitle,
  lookupConversationTitle as defaultLookupConversationTitle,
} from '../lib/context-resolver.mjs';
import { createInitialState } from '../lib/constants.mjs';
import { applyNotesAction, filterCards } from '../lib/notes-store.mjs';

describe('extractConversationTitle', () => {
  it('prefers annotations.title over title and summary, collapses whitespace, and handles invalid inputs', () => {
    assert.equal(
      extractConversationTitle({
        annotations: { title: '  Custom\nRenamed   Thread  ' },
        title: 'Direct Title',
        summary: 'Auto Summary',
      }),
      'Custom Renamed Thread'
    );
    assert.equal(
      extractConversationTitle({
        annotations: { title: '   ' },
        title: '  Direct Title  ',
        summary: 'Auto Summary',
      }),
      'Direct Title'
    );
    assert.equal(
      extractConversationTitle({
        summary: 'Fix Windows URI\n\tnormalization in Notes',
      }),
      'Fix Windows URI normalization in Notes'
    );
    assert.equal(
      extractConversationTitle({
        trajectoryMetadata: { title: 'Metadata Fallback Title' },
      }),
      'Metadata Fallback Title'
    );
    assert.equal(
      extractConversationTitle({
        annotations: { title: 42 },
        title: { nested: true },
        summary: ['array'],
      }),
      ''
    );
    assert.equal(extractConversationTitle({}), '');
    assert.equal(extractConversationTitle(null), '');
    assert.equal(extractConversationTitle(undefined), '');
    assert.equal(extractConversationTitle('string-input'), '');
    assert.equal(extractConversationTitle([]), '');
  });
});

describe('createContextResolver — workspace, multi-root URI normalization & _new isolation', () => {
  it('resolves real conversationId workspace, title, and deduplicated multi-root allWorkspacePaths across encoded Windows URIs', async () => {
    const rpcCalls = [];
    const resolver = createContextResolver({
      callLsRpcFn: async (method, body) => {
        rpcCalls.push({ method, body });
        return {
          trajectorySummaries: {
            'conv-alpha': {
              annotations: { title: 'Notes Architecture Review' },
              summary: 'Older auto summary',
              workspaces: [
                { workspaceFolderAbsoluteUri: 'file:///C%3A/Users/dev/IdeaProjects/antigravity-notes/' },
                { workspaceFolderAbsoluteUri: 'file:///D%3A/Shared/antigravity-sidecar-kit/' },
              ],
            },
          },
        };
      },
    });

    const ctx = await resolver.resolveContext({
      conversationId: 'conv-alpha',
      workspaceUris: [
        'C:\\Users\\Dev\\IdeaProjects\\antigravity-notes\\',
        'file:///E%3A/Users/dev/100%ready/extra-root/',
      ],
    });

    assert.equal(rpcCalls.length, 1);
    assert.equal(rpcCalls[0].method, 'GetAllCascadeTrajectories');
    assert.equal(ctx.workspacePath, 'c:/Users/dev/IdeaProjects/antigravity-notes');
    assert.equal(ctx.workspaceName, 'antigravity-notes');
    assert.deepEqual(ctx.allWorkspacePaths, [
      'c:/Users/dev/IdeaProjects/antigravity-notes',
      'd:/Shared/antigravity-sidecar-kit',
      'e:/Users/dev/100%ready/extra-root',
    ]);
    assert.equal(ctx.conversationId, 'conv-alpha');
    assert.equal(ctx.conversationTitle, 'Notes Architecture Review');
    assert.equal(ctx.isNewConversation, false);
    assert.equal(ctx.source, 'conversation');

    // Verify end-to-end compatibility with notes-store filterCards across multi-root paths
    let state = createInitialState();
    state = applyNotesAction(state, 'stash-add', {
      text: 'Primary repo card #later',
      scope: 'workspace',
      workspacePath: 'file:///C%3A/Users/dev/IdeaProjects/antigravity-notes/',
    }, 1_000).nextState;
    state = applyNotesAction(state, 'stash-add', {
      text: 'Second root card #mcp',
      scope: 'workspace',
      workspacePath: 'D:\\Shared\\antigravity-sidecar-kit\\',
    }, 2_000).nextState;
    state = applyNotesAction(state, 'stash-add', {
      text: 'Malformed percent folder card #bug',
      scope: 'workspace',
      workspacePath: 'e:/Users/dev/100%ready/extra-root',
    }, 3_000).nextState;

    const matched = filterCards(state, {
      scope: 'workspace',
      workspacePath: ctx.workspacePath,
      allWorkspacePaths: ctx.allWorkspacePaths,
    });
    assert.equal(matched.length, 3);
  });

  it('falls back to host workspaceUris for a brand-new real conversationId not yet in trajectories and guards Object.prototype keys', async () => {
    const resolver = createContextResolver({
      callLsRpcFn: async () => ({ trajectorySummaries: {} }),
    });

    const unsavedConv = await resolver.resolveContext({
      conversationId: 'conv-brand-new-uuid',
      workspaceUris: ['file:///C%3A/Users/dev/IdeaProjects/antigravity-notes/'],
    });
    assert.equal(unsavedConv.workspacePath, 'c:/Users/dev/IdeaProjects/antigravity-notes');
    assert.equal(unsavedConv.workspaceName, 'antigravity-notes');
    assert.deepEqual(unsavedConv.allWorkspacePaths, ['c:/Users/dev/IdeaProjects/antigravity-notes']);
    assert.equal(unsavedConv.conversationId, 'conv-brand-new-uuid');
    assert.equal(unsavedConv.conversationTitle, '');
    assert.equal(unsavedConv.isNewConversation, false);
    assert.equal(unsavedConv.source, 'host_push');

    const protoCheck = await resolver.resolveContext({
      conversationId: 'toString',
      workspaceUris: [],
    });
    assert.equal(protoCheck.conversationId, 'toString');
    assert.equal(protoCheck.conversationTitle, '');
    assert.equal(protoCheck.workspacePath, '');
    assert.equal(protoCheck.workspaceName, 'Global');

    // Folder literally named "foo%20bar" on disk (encoded once in file:// URI as foo%2520bar)
    // must decode exactly once to "c:/Users/dev/foo%20bar", never double-decode to "foo bar"
    const literalPercent = await resolver.resolveContext({
      conversationId: 'conv-percent-dir',
      workspaceUris: ['file:///C%3A/Users/dev/foo%2520bar/'],
    });
    assert.equal(literalPercent.workspacePath, 'c:/Users/dev/foo%20bar');
    assert.deepEqual(literalPercent.allWorkspacePaths, ['c:/Users/dev/foo%20bar']);
  });

  it('isolates _new placeholder and empty conversationId so background trajectory IDs and titles never leak', async () => {
    let rpcCount = 0;
    const resolver = createContextResolver({
      callLsRpcFn: async () => {
        rpcCount += 1;
        return {
          trajectorySummaries: {
            'conv-recent': {
              summary: 'Recent Background Thread',
              annotations: { lastUserViewTime: '2026-11-21T08:00:00Z' },
              workspaces: [
                { workspaceFolderAbsoluteUri: 'file:///C%3A/Users/dev/IdeaProjects/other-repo/' },
              ],
            },
          },
        };
      },
    });

    // _new with host-pushed workspaceUris must use host workspace only and never attribute conv-recent
    const newWithWs = await resolver.resolveContext({
      conversationId: NEW_CONVERSATION_ID,
      workspaceUris: ['file:///C%3A/Users/dev/IdeaProjects/antigravity-notes/'],
    });
    assert.equal(newWithWs.workspacePath, 'c:/Users/dev/IdeaProjects/antigravity-notes');
    assert.equal(newWithWs.workspaceName, 'antigravity-notes');
    assert.deepEqual(newWithWs.allWorkspacePaths, ['c:/Users/dev/IdeaProjects/antigravity-notes']);
    assert.equal(newWithWs.conversationId, '');
    assert.equal(newWithWs.conversationTitle, '');
    assert.equal(newWithWs.isNewConversation, true);
    assert.equal(newWithWs.source, 'new_conversation');

    // _new without workspaceUris must NOT fall back to conv-recent's workspace
    const newWithoutWs = await resolver.resolveContext({
      conversationId: '_new',
      workspaceUris: [],
    });
    assert.equal(newWithoutWs.workspacePath, '');
    assert.equal(newWithoutWs.workspaceName, 'Global');
    assert.deepEqual(newWithoutWs.allWorkspacePaths, []);
    assert.equal(newWithoutWs.conversationId, '');
    assert.equal(newWithoutWs.conversationTitle, '');
    assert.equal(newWithoutWs.isNewConversation, true);
    assert.equal(newWithoutWs.source, 'new_conversation');

    // Empty conversationId (e.g. standalone browser tab) resolves workspace from trajectory,
    // but keeps conversationId: '', conversationTitle: '', isNewConversation: false
    const emptyConv = await resolver.resolveContext({
      conversationId: '',
      workspaceUris: [],
    });
    assert.equal(emptyConv.workspacePath, 'c:/Users/dev/IdeaProjects/other-repo');
    assert.equal(emptyConv.workspaceName, 'other-repo');
    assert.deepEqual(emptyConv.allWorkspacePaths, ['c:/Users/dev/IdeaProjects/other-repo']);
    assert.equal(emptyConv.conversationId, '');
    assert.equal(emptyConv.conversationTitle, '');
    assert.equal(emptyConv.isNewConversation, false);
    assert.equal(emptyConv.source, 'trajectory');
    assert.ok(rpcCount >= 1);
  });
});

describe('lookupConversationTitle, 3_000ms cache TTL, invalidation & graceful RPC degradation', () => {
  it('caches GetAllCascadeTrajectories for 3_000ms, coalesces concurrent lookups, and refreshes on invalidate()', async () => {
    let clockMs = 10_000;
    let rpcCalls = 0;
    let currentTitle = 'Initial Thread Title';

    const resolver = createContextResolver({
      now: () => clockMs,
      callLsRpcFn: async (method) => {
        assert.equal(method, 'GetAllCascadeTrajectories');
        rpcCalls += 1;
        await new Promise((r) => setTimeout(r, 10));
        return {
          trajectorySummaries: {
            'conv-1': {
              summary: currentTitle,
              workspaces: [
                { workspaceFolderAbsoluteUri: 'file:///C%3A/Users/dev/IdeaProjects/antigravity-notes/' },
              ],
            },
          },
        };
      },
    });

    assert.equal(typeof defaultLookupConversationTitle, 'function');

    // _new and empty IDs short-circuit without calling LS RPC
    assert.equal(await resolver.lookupConversationTitle('_new'), '');
    assert.equal(await resolver.lookupConversationTitle(''), '');
    assert.equal(await resolver.lookupConversationTitle(null), '');
    assert.equal(rpcCalls, 0);

    // Concurrent resolveContext + lookupConversationTitle share 1 in-flight RPC
    const [ctx, titleA, missingTitle] = await Promise.all([
      resolver.resolveContext({ conversationId: 'conv-1' }),
      resolver.lookupConversationTitle('conv-1'),
      resolver.lookupConversationTitle('conv-missing'),
    ]);
    assert.equal(rpcCalls, 1);
    assert.equal(ctx.conversationTitle, 'Initial Thread Title');
    assert.equal(titleA, 'Initial Thread Title');
    assert.equal(missingTitle, '');

    // Within 3_000ms TTL (at +2,999ms), cached result is served
    currentTitle = 'Renamed Thread Title';
    clockMs += 2_999;
    assert.equal(await resolver.lookupConversationTitle('conv-1'), 'Initial Thread Title');
    assert.equal(rpcCalls, 1);

    // At 3_000ms boundary, TTL expires and fresh title is fetched
    clockMs += 1;
    assert.equal(await resolver.lookupConversationTitle('conv-1'), 'Renamed Thread Title');
    assert.equal(rpcCalls, 2);

    // Explicit invalidate() clears cache immediately before TTL expires
    currentTitle = 'Post-Invalidate Title';
    clockMs += 100;
    resolver.invalidate();
    assert.equal(await resolver.lookupConversationTitle('conv-1'), 'Post-Invalidate Title');
    assert.equal(rpcCalls, 3);
  });

  it('accepts an external rpcCache instance and degrades gracefully when LS RPC throws, returns null, or returns { ok: false }', async () => {
    let mode = 'throw';
    let calls = 0;
    const externalCache = createLsRpcCache({
      ttlMs: { GetAllCascadeTrajectories: 3_000 },
      rpcFn: async () => {
        calls += 1;
        if (mode === 'throw') {
          throw new Error('Missing ANTIGRAVITY_LS_ADDRESS or ANTIGRAVITY_CSRF_TOKEN');
        }
        if (mode === 'null') {
          return null;
        }
        if (mode === 'not-ok') {
          return { ok: false, error: 'LS starting up' };
        }
        return {
          trajectorySummaries: {
            'conv-recovered': {
              summary: 'Recovered LS Thread',
              workspaces: [{ workspaceFolderAbsoluteUri: 'file:///C%3A/Repo/' }],
            },
          },
        };
      },
    });

    const resolver = createContextResolver({ rpcCache: externalCache });

    // 1. Thrown RPC error degrades cleanly while preserving host workspaceUris
    const onThrow = await resolver.resolveContext({
      conversationId: 'conv-recovered',
      workspaceUris: ['file:///C%3A/Users/dev/FallbackRepo/'],
    });
    assert.equal(onThrow.workspacePath, 'c:/Users/dev/FallbackRepo');
    assert.equal(onThrow.workspaceName, 'FallbackRepo');
    assert.deepEqual(onThrow.allWorkspacePaths, ['c:/Users/dev/FallbackRepo']);
    assert.equal(onThrow.conversationId, 'conv-recovered');
    assert.equal(onThrow.conversationTitle, '');
    assert.equal(onThrow.source, 'host_push');
    assert.equal(await resolver.lookupConversationTitle('conv-recovered'), '');

    // 2. null response degrades cleanly and does not poison cache
    mode = 'null';
    const onNull = await resolver.resolveContext({
      conversationId: 'conv-recovered',
      workspaceUris: [],
    });
    assert.equal(onNull.workspacePath, '');
    assert.equal(onNull.workspaceName, 'Global');
    assert.deepEqual(onNull.allWorkspacePaths, []);
    assert.equal(onNull.conversationTitle, '');

    // 3. { ok: false } response degrades cleanly and does not poison cache
    mode = 'not-ok';
    assert.equal(await resolver.lookupConversationTitle('conv-recovered'), '');

    // 4. Subsequent call immediately recovers once LS responds normally (no stale null/{ok:false} cached)
    mode = 'healthy';
    const recovered = await resolver.resolveContext({
      conversationId: 'conv-recovered',
      workspaceUris: [],
    });
    assert.equal(recovered.workspacePath, 'c:/Repo');
    assert.equal(recovered.conversationTitle, 'Recovered LS Thread');
    assert.ok(calls >= 5);
  });

  it('resolves Antigravity Project name from projectsDir via trajectoryMetadata.projectId or multi-repo folder set match', async () => {
    const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');

    const projDir = mkdtempSync(join(tmpdir(), 'notes-proj-meta-'));
    try {
      writeFileSync(
        join(projDir, 'outside-of-project.json'),
        JSON.stringify({ id: 'outside-of-project', name: 'Outside of Project' }),
        'utf8'
      );
      writeFileSync(
        join(projDir, 'single-kit.json'),
        JSON.stringify({
          id: 'single-kit',
          name: 'antigravity-sidecar-kit',
          projectResources: {
            resources: [{ gitFolder: { folderUri: 'file:///c%3A/Users/dev/IdeaProjects/antigravity-sidecar-kit' } }],
          },
        }),
        'utf8'
      );
      writeFileSync(
        join(projDir, 'toolkit-uuid.json'),
        JSON.stringify({
          id: 'toolkit-uuid',
          name: 'Antigravity Toolkit',
          projectResources: {
            resources: [
              { gitFolder: { folderUri: 'file:///c%3A/Users/dev/IdeaProjects/agy-plugin-porter' } },
              { gitFolder: { folderUri: 'file:///c%3A/Users/dev/IdeaProjects/antigravity-sidecar-kit' } },
            ],
          },
        }),
        'utf8'
      );

      const resolver = createContextResolver({
        projectsDir: projDir,
        callLsRpcFn: async () => ({
          trajectorySummaries: {
            'conv-toolkit': {
              summary: 'Toolkit Thread',
              trajectoryMetadata: {
                projectId: 'toolkit-uuid',
                workspaceUris: [
                  'file:///c%3A/Users/dev/IdeaProjects/agy-plugin-porter',
                  'file:///c%3A/Users/dev/IdeaProjects/antigravity-sidecar-kit',
                ],
              },
            },
            'conv-outside': {
              summary: 'Adhoc Thread',
              trajectoryMetadata: {
                projectId: 'outside-of-project',
                workspaceUris: ['file:///c%3A/Users/dev/IdeaProjects/unregistered-folder'],
              },
            },
          },
        }),
      });

      const realMatch = await resolver.resolveContext({ conversationId: 'conv-toolkit', workspaceUris: [] });
      assert.equal(realMatch.projectId, 'toolkit-uuid');
      assert.equal(realMatch.projectName, 'Antigravity Toolkit');

      // _new conversation with the 2 project folders must match "Antigravity Toolkit" (exact set match) over 1-folder "antigravity-sidecar-kit"
      const newMatch = await resolver.resolveContext({
        conversationId: '_new',
        workspaceUris: [
          'file:///C%3A/Users/dev/IdeaProjects/agy-plugin-porter/',
          'file:///C%3A/Users/dev/IdeaProjects/antigravity-sidecar-kit/',
        ],
      });
      assert.equal(newMatch.projectId, 'toolkit-uuid');
      assert.equal(newMatch.projectName, 'Antigravity Toolkit');

      // outside-of-project synthetic entry must be ignored and fall back cleanly to folder basename
      const outsideMatch = await resolver.resolveContext({ conversationId: 'conv-outside', workspaceUris: [] });
      assert.equal(outsideMatch.projectId, '');
      assert.equal(outsideMatch.projectName, 'unregistered-folder');
    } finally {
      rmSync(projDir, { recursive: true, force: true });
    }
  });
});
