import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { StateSync, writeJsonAtomic } from 'antigravity-sidecar-kit/state-sync';
import {
  DEFAULT_PORT,
  MAX_CARD_BYTES,
  MAX_PAD_BYTES,
  MAX_SENT_CARDS,
  PALETTE_COLOR_IDS,
  REPO_ROOT,
  SIDECAR_ID,
  SIDECAR_TITLE,
  UI_DIR,
  VALID_CARD_COLORS,
  VALID_COLOR_STYLES,
  createInitialState,
  inferDefaultTagColor,
  resolveNotesDataDir,
} from '../lib/constants.mjs';
import {
  applyNotesAction,
  createStoreMutators,
  exportStashMarkdown,
  filterCards,
  listScratchpadsForScope,
  parseHashtags,
  resolveCardColor,
} from '../lib/notes-store.mjs';

const EXPECTED_ACTIONS = [
  'stash-add',
  'stash-update',
  'stash-reorder',
  'stash-delete',
  'stash-mark-sent',
  'stash-restore',
  'stash-clear-sent',
  'tag-set-color',
  'pad-ensure',
  'pad-add',
  'pad-rename',
  'pad-reorder',
  'pad-save',
  'pad-delete',
  'settings-update',
];

describe('constants & defaults', () => {
  it('exports core sidecar constants, color palettes, semantic tag mapping, and initial state', () => {
    assert.equal(SIDECAR_ID, 'notes');
    assert.equal(SIDECAR_TITLE, 'Notes');
    assert.equal(DEFAULT_PORT, 52325);
    assert.equal(MAX_CARD_BYTES, 262_144);
    assert.equal(MAX_PAD_BYTES, 1_048_576);
    assert.equal(MAX_SENT_CARDS, 300);
    assert.ok(REPO_ROOT.length > 0);
    assert.equal(UI_DIR, join(REPO_ROOT, 'ui'));
    assert.deepEqual(PALETTE_COLOR_IDS, ['rose', 'amber', 'emerald', 'blue', 'violet', 'cyan']);
    assert.equal(Object.isFrozen(PALETTE_COLOR_IDS), true);
    assert.equal(VALID_CARD_COLORS.has('auto'), true);
    assert.equal(VALID_CARD_COLORS.has('none'), true);
    for (const colorId of PALETTE_COLOR_IDS) {
      assert.equal(VALID_CARD_COLORS.has(colorId), true);
    }
    assert.deepEqual([...VALID_COLOR_STYLES].sort(), ['bold', 'stripe', 'wash']);

    assert.equal(inferDefaultTagColor('bug'), 'rose');
    assert.equal(inferDefaultTagColor('hotfix'), 'rose');
    assert.equal(inferDefaultTagColor('blocked'), 'amber');
    assert.equal(inferDefaultTagColor('ship'), 'emerald');
    assert.equal(inferDefaultTagColor('later'), 'blue');
    assert.equal(inferDefaultTagColor('ux'), 'violet');
    assert.equal(inferDefaultTagColor('mcp'), 'cyan');

    const hashedA = inferDefaultTagColor('architecture-review');
    const hashedB = inferDefaultTagColor('architecture-review');
    assert.equal(hashedA, hashedB);
    assert.equal(PALETTE_COLOR_IDS.includes(hashedA), true);

    const customDir = resolveNotesDataDir({ ANTIGRAVITY_NOTES_DATA_DIR: '/tmp/custom-notes' });
    assert.ok(customDir.endsWith('custom-notes'));

    const hangarInheritedDir = resolveNotesDataDir({
      ANTIGRAVITY_EXECUTABLE_DATA_DIR: 'C:/Users/test/.gemini/antigravity/sidecar_data/hangar/data',
    });
    assert.equal(
      hangarInheritedDir.replace(/\\/g, '/'),
      'C:/Users/test/.gemini/antigravity/sidecar_data/notes/data'
    );

    const s1 = createInitialState();
    const s2 = createInitialState();
    assert.notEqual(s1, s2);
    assert.deepEqual(s1, {
      schemaVersion: 1,
      settings: {
        enterBehavior: 'stash',
        cardColorStyle: 'wash',
        stashLayout: 'grid',
        workbenchMode: 'split',
        workbenchSplitRatio: 0.44,
        mcpRead: false,
        mcpWrite: false,
      },
      tagColors: {},
      cards: [],
      scratchpads: [],
    });
  });
});

describe('parseHashtags', () => {
  it('extracts standalone lowercase #tags while ignoring headings, fenced/inline code, URLs, and numeric #42', () => {
    const sample = [
      '# Heading Should Be Ignored',
      '## Secondary Heading #ignored_in_heading',
      'Check https://x.io/path#frag and [Docs](#section-anchor) before fixing #Bug and #later.',
      'Ignore inline `#nope` and issue #42 or #99problems or mid#word or #' + 'a'.repeat(33) + '.',
      'Keep (#design) and #mcp_v2 and #ui-fix and duplicate #BUG.',
      '```js',
      '// #inside_fence should be ignored',
      'const tag = "#also_ignored";',
      '```',
    ].join('\n');

    assert.deepEqual(parseHashtags(sample), ['bug', 'later', 'design', 'mcp_v2', 'ui-fix']);
    assert.deepEqual(parseHashtags(''), []);

    const trickyMarkdown = [
      '# Heading with stray ` backtick',
      'Check fn[0](unclosed',
      'Still capture #resilient and (`inline`) safely)',
    ].join('\n');
    assert.deepEqual(parseHashtags(trickyMarkdown), ['resilient']);

    assert.deepEqual(
      parseHashtags('Ignore `` `#nope` `` and ``` ``#also_nope`` ``` while keeping #valid'),
      ['valid']
    );
    assert.deepEqual(
      parseHashtags('Check `foo\nFix #bug\nSee `bar`'),
      ['bug']
    );
    assert.deepEqual(
      parseHashtags('Broken `` opener on same line before `#nope` and #real'),
      ['real']
    );
    assert.deepEqual(
      parseHashtags('Ignore `foo `` #nope ` here'),
      []
    );
    assert.deepEqual(
      parseHashtags('Broken ` opener before `` #nope `` and #real'),
      ['real']
    );
  });
});

describe('card & #tag color resolution and filtering', () => {
  it('auto-populates tagColors on stash-add, resolves auto/none/explicit card colors, and updates globally via tag-set-color', () => {
    const initial = createInitialState();
    const snapshot = structuredClone(initial);

    const step1 = applyNotesAction(initial, 'stash-add', {
      text: 'Investigate workspace race #bug #later',
      scope: 'workspace',
      workspacePath: 'c:/Users/dev/IdeaProjects/antigravity-notes',
    }, 1_000);
    assert.deepEqual(initial, snapshot, 'applyNotesAction must not mutate currentState');

    let state = step1.nextState;
    const bugCard = step1.result.card;
    assert.equal(state.tagColors.bug, 'rose');
    assert.equal(state.tagColors.later, 'blue');
    assert.equal(resolveCardColor(bugCard, state.tagColors), 'rose');

    const step2 = applyNotesAction(state, 'stash-add', {
      text: 'Explicitly muted #bug note',
      color: 'none',
      scope: 'workspace',
      workspacePath: 'c:/Users/dev/IdeaProjects/antigravity-notes',
    }, 2_000);
    state = step2.nextState;
    assert.equal(resolveCardColor(step2.result.card, state.tagColors), '');

    const step3 = applyNotesAction(state, 'stash-add', {
      text: 'Untagged release checklist reminder',
      color: 'amber',
      scope: 'workspace',
      workspacePath: 'c:/Users/dev/IdeaProjects/antigravity-notes',
    }, 3_000);
    state = step3.nextState;
    assert.equal(resolveCardColor(step3.result.card, state.tagColors), 'amber');

    const step4 = applyNotesAction(state, 'stash-add', {
      text: 'Manual violet card without hashtags',
      color: 'violet',
      scope: 'global',
    }, 4_000);
    state = step4.nextState;

    const recolored = applyNotesAction(state, 'tag-set-color', {
      tag: 'bug',
      color: 'violet',
    }, 5_000);
    state = recolored.nextState;
    assert.equal(state.tagColors.bug, 'violet');
    assert.equal(resolveCardColor(bugCard, state.tagColors), 'violet');
    assert.equal(resolveCardColor(step2.result.card, state.tagColors), '');

    const violetCards = filterCards(state, { color: 'violet' });
    assert.deepEqual(
      violetCards.map((c) => c.id).sort(),
      [bugCard.id, step4.result.card.id].sort()
    );

    const mutedBug = applyNotesAction(state, 'tag-set-color', {
      tag: '#BUG',
      color: 'none',
    }, 6_000);
    state = mutedBug.nextState;
    assert.equal(
      resolveCardColor(bugCard, state.tagColors),
      'blue',
      'when #bug is set to none, #bug #later card falls back to #later (blue)'
    );

    assert.throws(
      () => applyNotesAction(state, 'tag-set-color', { tag: 'bug', color: 'auto' }),
      /color/i
    );
    assert.throws(
      () => applyNotesAction(state, 'stash-add', { text: 'Bad color', color: 'magenta' }),
      /color/i
    );
  });
});

describe('filterCards scoping and Windows URI normalization', () => {
  it('normalizes encoded file:///C%3A/.../ URIs vs c:/... paths across multi-root allWorkspacePaths', () => {
    let state = createInitialState();

    const addA = applyNotesAction(state, 'stash-add', {
      text: 'Card from encoded host URI #mcp',
      scope: 'workspace',
      workspacePath: 'file:///C%3A/Users/Dev/IdeaProjects/Repo-Alpha/',
      originConversationId: 'conv-alpha',
      originConversationTitle: 'Alpha Chat',
    }, 1_000);
    state = addA.nextState;

    const addB = applyNotesAction(state, 'stash-add', {
      text: 'Card from second root folder',
      scope: 'workspace',
      workspacePath: 'D:\\Work\\Repo-Beta\\',
      originConversationId: 'conv-beta',
      originConversationTitle: 'Beta Chat',
    }, 2_000);
    state = addB.nextState;

    const addOther = applyNotesAction(state, 'stash-add', {
      text: 'Card in unrelated repo',
      scope: 'workspace',
      workspacePath: 'c:/Users/dev/IdeaProjects/other-repo',
    }, 3_000);
    state = addOther.nextState;

    const addGlobal = applyNotesAction(state, 'stash-add', {
      text: 'Global note across repos',
      scope: 'global',
      workspacePath: 'c:/Users/dev/IdeaProjects/repo-alpha',
      originConversationId: 'conv-alpha',
      originConversationTitle: 'Alpha Chat',
    }, 4_000);
    state = addGlobal.nextState;
    assert.equal(addGlobal.result.card.scope, 'global');
    assert.equal(addGlobal.result.card.workspacePath, '', 'global card must not retain workspacePath');
    assert.equal(addGlobal.result.card.workspaceName, '', 'global card must not retain workspaceName');
    assert.equal(addGlobal.result.card.originConversationId, '', 'global card must not link to active chat');
    assert.equal(addGlobal.result.card.originConversationTitle, '', 'global card must not retain chat title');

    const singleMatch = filterCards(state, {
      scope: 'workspace',
      workspacePath: 'c:/users/dev/ideaprojects/repo-alpha',
    });
    assert.deepEqual(singleMatch.map((c) => c.id), [addA.result.card.id]);

    const multiRootMatch = filterCards(state, {
      scope: 'workspace',
      workspacePath: 'c:/users/dev/ideaprojects/repo-alpha',
      allWorkspacePaths: [
        'c:/users/dev/ideaprojects/repo-alpha',
        'file:///D%3A/work/repo-beta/',
      ],
    });
    assert.deepEqual(
      multiRootMatch.map((c) => c.id),
      [addB.result.card.id, addA.result.card.id]
    );

    const chatMatch = filterCards(state, {
      scope: 'chat',
      conversationId: 'conv-alpha',
    });
    assert.deepEqual(
      chatMatch.map((c) => c.id),
      [addA.result.card.id]
    );

    assert.deepEqual(filterCards(state, { scope: 'chat', conversationId: '_new' }), []);
    assert.deepEqual(filterCards(state, { scope: 'chat', conversationId: '' }), []);

    const globalOnly = filterCards(state, { scope: 'global', includeAllWorkspaces: false });
    assert.deepEqual(globalOnly.map((c) => c.id), [addGlobal.result.card.id]);

    const allScope = filterCards(state, { scope: 'all' });
    assert.equal(allScope.length, 4);

    const allWorkspaces = filterCards(state, { scope: 'global', includeAllWorkspaces: true });
    assert.equal(allWorkspaces.length, 4);

    assert.deepEqual(filterCards(state, { tag: '#MCP' }).map((c) => c.id), [addA.result.card.id]);
    assert.deepEqual(filterCards(state, { query: 'SECOND ROOT' }).map((c) => c.id), [addB.result.card.id]);
  });

  it('coerces empty workspacePath to global scope on stash-add and stash-update so cards never become unreachable orphans', () => {
    let state = createInitialState();

    const noWsAdd = applyNotesAction(state, 'stash-add', {
      text: 'Captured with no folder open #idea',
      scope: 'workspace',
      workspacePath: '',
    }, 1_000);
    state = noWsAdd.nextState;
    assert.equal(noWsAdd.result.card.scope, 'global');

    const mcpNoWsAdd = applyNotesAction(state, 'stash-add', {
      text: 'Captured via MCP without workspacePath',
    }, 2_000);
    state = mcpNoWsAdd.nextState;
    assert.equal(mcpNoWsAdd.result.card.scope, 'global');

    // Opening a repository later must keep both cards reachable in Global scope
    const visibleInGlobal = filterCards(state, {
      scope: 'global',
      workspacePath: 'c:/Users/dev/IdeaProjects/antigravity-notes',
      includeAllWorkspaces: false,
    });
    assert.equal(visibleInGlobal.length, 2);

    // Updating scope to workspace without a workspacePath stays global
    const stayGlobal = applyNotesAction(state, 'stash-update', {
      id: noWsAdd.result.card.id,
      scope: 'workspace',
    }, 3_000);
    state = stayGlobal.nextState;
    assert.equal(stayGlobal.result.card.scope, 'global');

    // Moving to a real workspacePath succeeds, and clearing workspacePath coerces back to global
    const movedToWs = applyNotesAction(state, 'stash-update', {
      id: noWsAdd.result.card.id,
      scope: 'workspace',
      workspacePath: 'c:/Users/dev/IdeaProjects/antigravity-notes',
    }, 4_000);
    state = movedToWs.nextState;
    assert.equal(movedToWs.result.card.scope, 'workspace');

    const clearedWs = applyNotesAction(state, 'stash-update', {
      id: noWsAdd.result.card.id,
      workspacePath: '',
    }, 5_000);
    state = clearedWs.nextState;
    assert.equal(clearedWs.result.card.scope, 'global');

    // Detaching a chat-linked workspace card to global clears workspacePath and originConversationId
    const wsChatCard = applyNotesAction(state, 'stash-add', {
      text: 'Attached to project chat',
      scope: 'workspace',
      workspacePath: 'c:/Users/dev/IdeaProjects/repo-one',
      originConversationId: 'conv-123',
      originConversationTitle: 'Chat 123',
    }, 6_000);
    state = wsChatCard.nextState;
    const detachedCard = applyNotesAction(state, 'stash-update', {
      id: wsChatCard.result.card.id,
      scope: 'global',
    }, 7_000);
    state = detachedCard.nextState;
    assert.equal(detachedCard.result.card.scope, 'global');
    assert.equal(detachedCard.result.card.workspacePath, '');
    assert.equal(detachedCard.result.card.originConversationId, '');
    assert.equal(detachedCard.result.card.originConversationTitle, '');

    // Multi-repo project Scratchpads match across allWorkspacePaths
    state = applyNotesAction(state, 'pad-add', {
      scope: 'workspace',
      workspacePath: 'c:/Users/dev/IdeaProjects/repo-one',
      title: 'Repo One Notes',
    }, 8_000).nextState;
    state = applyNotesAction(state, 'pad-add', {
      scope: 'workspace',
      workspacePath: 'c:/Users/dev/IdeaProjects/repo-two',
      title: 'Repo Two Notes',
    }, 9_000).nextState;
    const multiRepoPads = listScratchpadsForScope(state, {
      scope: 'workspace',
      workspacePath: 'c:/Users/dev/IdeaProjects/repo-one',
      allWorkspacePaths: ['c:/Users/dev/IdeaProjects/repo-one', 'c:/Users/dev/IdeaProjects/repo-two'],
    });
    assert.deepEqual(multiRepoPads.map((p) => p.title), ['Repo One Notes', 'Repo Two Notes']);
  });
});

describe('stash mutations, 300-item FIFO sent cap, restore, reorder, and markdown export', () => {
  it('enforces 300-item FIFO cap on sent cards without pruning active cards, and supports restore/update/reorder/delete/clear', () => {
    let state = createInitialState();
    const activeKeepIds = [];
    for (let i = 0; i < 5; i++) {
      const res = applyNotesAction(state, 'stash-add', {
        text: `Active keep #${i + 1}`,
        scope: 'global',
      }, 100 + i);
      state = res.nextState;
      activeKeepIds.push(res.result.card.id);
    }

    const sentSequenceIds = [];
    for (let i = 0; i < 305; i++) {
      const added = applyNotesAction(state, 'stash-add', {
        text: `Dispatched item ${i}`,
        scope: 'global',
      }, 1_000 + i);
      state = added.nextState;
      sentSequenceIds.push(added.result.card.id);

      const marked = applyNotesAction(state, 'stash-mark-sent', {
        ids: [added.result.card.id],
        sentToConversationId: 'conv-dest',
        sentToConversationTitle: 'Target Thread',
        sentMode: 'active',
      }, 10_000 + i);
      state = marked.nextState;
    }

    const activeAfterCap = filterCards(state, { status: 'active' });
    const sentAfterCap = filterCards(state, { status: 'sent' });
    assert.equal(activeAfterCap.length, 5, 'active cards must never be pruned by sent FIFO cap');
    assert.equal(sentAfterCap.length, MAX_SENT_CARDS);

    const remainingSentSet = new Set(sentAfterCap.map((c) => c.id));
    for (let i = 0; i < 5; i++) {
      assert.equal(remainingSentSet.has(sentSequenceIds[i]), false, `oldest sent card ${i} should be evicted`);
    }
    for (let i = 5; i < 305; i++) {
      assert.equal(remainingSentSet.has(sentSequenceIds[i]), true, `recent sent card ${i} should be retained`);
    }

    const targetRestoreId = sentSequenceIds[304];
    const restored = applyNotesAction(state, 'stash-restore', { ids: [targetRestoreId] }, 50_000);
    state = restored.nextState;
    const restoredCard = state.cards.find((c) => c.id === targetRestoreId);
    assert.equal(restoredCard.status, 'active');
    assert.equal(restoredCard.sentAt, null);
    assert.equal(restoredCard.sentToConversationId, '');

    const updated = applyNotesAction(state, 'stash-update', {
      id: activeKeepIds[0],
      text: 'Updated prompt text #urgent',
      color: 'cyan',
      scope: 'workspace',
      workspacePath: 'file:///C%3A/Repo/',
    }, 51_000);
    state = updated.nextState;
    assert.equal(updated.result.card.color, 'cyan');
    assert.deepEqual(updated.result.card.tags, ['urgent']);
    assert.equal(state.tagColors.urgent, 'rose');
    assert.equal(updated.result.card.workspacePath, 'c:/Repo');

    const reordered = applyNotesAction(state, 'stash-reorder', {
      orderedIds: [activeKeepIds[2], activeKeepIds[1], targetRestoreId],
    }, 52_000);
    state = reordered.nextState;
    const globalActive = filterCards(state, { scope: 'global', status: 'active' });
    assert.equal(globalActive[0].id, activeKeepIds[2]);
    assert.equal(globalActive[1].id, activeKeepIds[1]);
    assert.equal(globalActive[2].id, targetRestoreId);

    const md = exportStashMarkdown(globalActive.slice(0, 2), 'Global Notes');
    assert.match(md, /# Prompt Stash — Global Notes/);
    assert.match(md, /Active keep #3/);
    assert.match(md, /Active keep #2/);

    const deleted = applyNotesAction(state, 'stash-delete', { id: activeKeepIds[2] }, 53_000);
    state = deleted.nextState;
    assert.equal(state.cards.some((c) => c.id === activeKeepIds[2]), false);

    const cleared = applyNotesAction(state, 'stash-clear-sent', {}, 54_000);
    state = cleared.nextState;
    assert.equal(cleared.result.clearedCount, 299);
    assert.equal(filterCards(state, { status: 'sent' }).length, 0);
    assert.equal(filterCards(state, { status: 'active' }).length, 5);
  });
});

describe('scratchpad lifecycle, byte caps, settings validation, and StateSync mutators', () => {
  it('manages multi-pad scopes and resets to a blank default Scratchpad when deleting the last pad', () => {
    let state = createInitialState();

    const ensured1 = applyNotesAction(state, 'pad-ensure', {
      scope: 'workspace',
      workspacePath: 'file:///C%3A/Users/dev/Repo/',
    }, 1_000);
    state = ensured1.nextState;
    assert.equal(ensured1.result.created, true);
    assert.equal(ensured1.result.pad.title, 'Scratchpad');

    const ensured2 = applyNotesAction(state, 'pad-ensure', {
      scope: 'workspace',
      workspacePath: 'c:/users/dev/repo',
    }, 1_500);
    state = ensured2.nextState;
    assert.equal(ensured2.result.created, false);
    assert.equal(ensured2.result.pad.id, ensured1.result.pad.id);

    const globalPad = applyNotesAction(state, 'pad-ensure', { scope: 'global' }, 1_800);
    state = globalPad.nextState;

    const addedPad = applyNotesAction(state, 'pad-add', {
      scope: 'workspace',
      workspacePath: 'c:/Users/dev/Repo',
      title: 'API Notes',
      content: '- [ ] Check endpoints',
    }, 2_000);
    state = addedPad.nextState;

    const renamed = applyNotesAction(state, 'pad-rename', {
      id: addedPad.result.pad.id,
      title: 'MCP Design',
    }, 2_500);
    state = renamed.nextState;
    assert.equal(renamed.result.pad.title, 'MCP Design');

    const reordered = applyNotesAction(state, 'pad-reorder', {
      orderedIds: [addedPad.result.pad.id, ensured1.result.pad.id],
    }, 3_000);
    state = reordered.nextState;
    let wsPads = listScratchpadsForScope(state, {
      scope: 'workspace',
      workspacePath: 'c:/Users/dev/Repo',
    });
    assert.deepEqual(wsPads.map((p) => p.id), [addedPad.result.pad.id, ensured1.result.pad.id]);

    const saved = applyNotesAction(state, 'pad-save', {
      id: ensured1.result.pad.id,
      content: '# Non-empty notes',
    }, 3_500);
    state = saved.nextState;
    assert.equal(saved.result.pad.content, '# Non-empty notes');

    const delFirst = applyNotesAction(state, 'pad-delete', { id: addedPad.result.pad.id }, 4_000);
    state = delFirst.nextState;
    wsPads = listScratchpadsForScope(state, { scope: 'workspace', workspacePath: 'c:/Users/dev/Repo' });
    assert.equal(wsPads.length, 1);
    assert.equal(wsPads[0].id, ensured1.result.pad.id);

    const delLast = applyNotesAction(state, 'pad-delete', { id: ensured1.result.pad.id }, 4_500);
    state = delLast.nextState;
    wsPads = listScratchpadsForScope(state, { scope: 'workspace', workspacePath: 'c:/Users/dev/Repo' });
    assert.equal(wsPads.length, 1, 'deleting last pad in scope must reset to a blank default Scratchpad');
    assert.notEqual(wsPads[0].id, ensured1.result.pad.id);
    assert.equal(wsPads[0].title, 'Scratchpad');
    assert.equal(wsPads[0].content, '');

    const globalPads = listScratchpadsForScope(state, { scope: 'global' });
    assert.equal(globalPads.length, 1);
    assert.equal(globalPads[0].id, globalPad.result.pad.id);

    // Atomic pad-save with mode: 'append' and matchByTitle: true
    const append1 = applyNotesAction(
      state,
      'pad-save',
      { mode: 'append', scope: 'global', title: 'Runbook', matchByTitle: true, content: 'First step' },
      5_000
    );
    state = append1.nextState;
    assert.equal(append1.result.pad.title, 'Runbook');
    assert.equal(append1.result.pad.content, 'First step');

    const append2 = applyNotesAction(
      state,
      'pad-save',
      { mode: 'append', scope: 'global', title: 'runbook', matchByTitle: true, content: 'Second step' },
      5_500
    );
    state = append2.nextState;
    assert.equal(append2.result.pad.id, append1.result.pad.id);
    assert.equal(append2.result.pad.content, 'First step\nSecond step');
    assert.equal(listScratchpadsForScope(state, { scope: 'global' }).length, 2);
  });

  it('enforces UTF-8 Buffer.byteLength caps for cards and scratchpads, clamps workbenchSplitRatio, and validates cardColorStyle', () => {
    let state = createInitialState();

    // 70,000 4-byte emojis = 140,000 UTF-16 code units (< 262,144) but 280,000 UTF-8 bytes (> 262,144)
    const oversizedUtf8Card = '🎉'.repeat(70_000);
    assert.ok(oversizedUtf8Card.length < MAX_CARD_BYTES);
    assert.ok(Buffer.byteLength(oversizedUtf8Card, 'utf8') > MAX_CARD_BYTES);
    assert.throws(
      () => applyNotesAction(state, 'stash-add', { text: oversizedUtf8Card }),
      /262144|256\s*KB|exceeds maximum/i
    );

    // 270,000 4-byte emojis = 540,000 UTF-16 code units (< 1,048,576) but 1,080,000 UTF-8 bytes (> 1,048,576)
    const ensured = applyNotesAction(state, 'pad-ensure', { scope: 'global' });
    state = ensured.nextState;
    const oversizedUtf8Pad = '🎉'.repeat(270_000);
    assert.ok(oversizedUtf8Pad.length < MAX_PAD_BYTES);
    assert.ok(Buffer.byteLength(oversizedUtf8Pad, 'utf8') > MAX_PAD_BYTES);
    assert.throws(
      () => applyNotesAction(state, 'pad-save', { id: ensured.result.pad.id, content: oversizedUtf8Pad }),
      /1048576|1\s*MB|exceeds maximum/i
    );

    const lowClamp = applyNotesAction(state, 'settings-update', { workbenchSplitRatio: 0.1 });
    assert.equal(lowClamp.nextState.settings.workbenchSplitRatio, 0.26);

    const highClamp = applyNotesAction(state, 'settings-update', { workbenchSplitRatio: 0.95 });
    assert.equal(highClamp.nextState.settings.workbenchSplitRatio, 0.72);

    const validSettings = applyNotesAction(state, 'settings-update', {
      enterBehavior: 'newline',
      cardColorStyle: 'bold',
      stashLayout: 'list',
      workbenchMode: 'stash',
      workbenchSplitRatio: 0.5,
      mcpRead: true,
      mcpWrite: false,
    });
    assert.deepEqual(validSettings.nextState.settings, {
      enterBehavior: 'newline',
      cardColorStyle: 'bold',
      stashLayout: 'list',
      workbenchMode: 'stash',
      workbenchSplitRatio: 0.5,
      mcpRead: true,
      mcpWrite: false,
    });

    assert.throws(
      () => applyNotesAction(state, 'settings-update', { cardColorStyle: 'neon' }),
      /cardColorStyle/i
    );
  });

  it('wires all 15 actions via createStoreMutators with StateSync and fires onSettingsChanged', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'agy-notes-store-'));
    const settingsEvents = [];
    let sync = null;
    const mutators = createStoreMutators(
      () => sync,
      async (nextSettings, prevSettings) => {
        settingsEvents.push({ nextSettings, prevSettings });
      }
    );

    for (const actionName of EXPECTED_ACTIONS) {
      assert.equal(typeof mutators[actionName], 'function', `missing mutator "${actionName}"`);
    }

    sync = new StateSync(tmpDir, null, {
      sidecarId: SIDECAR_ID,
      conversationScoped: false,
      initialState: createInitialState,
      mutators,
    });

    try {
      const addRes = await sync.handleMutate({
        action: 'stash-add',
        payload: { text: 'Persisted via StateSync #idea' },
      });
      assert.equal(addRes.ok, true);
      assert.equal(sync.getState().cards.length, 1);
      assert.equal(sync.getState().tagColors.idea, 'violet');

      const settingsRes = await sync.handleMutate({
        action: 'settings-update',
        payload: { mcpRead: true, workbenchSplitRatio: 0.9 },
      });
      assert.equal(settingsRes.ok, true);
      assert.equal(sync.getState().settings.mcpRead, true);
      assert.equal(sync.getState().settings.workbenchSplitRatio, 0.72);
      assert.equal(settingsEvents.length, 1);
      assert.equal(settingsEvents[0].prevSettings.mcpRead, false);
      assert.equal(settingsEvents[0].nextSettings.mcpRead, true);
    } finally {
      sync.dispose();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('serializes concurrent mutations on a FIFO queue without poisoning on error and refreshes external state.json edits before mutating', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'agy-notes-race-'));
    const appliedMcpLog = [];
    let externalSinkMcpRead = false;
    let activeCallbacks = 0;
    let maxConcurrentCallbacks = 0;
    let sync = null;

    const mutators = createStoreMutators(
      () => sync,
      async (nextSettings) => {
        activeCallbacks += 1;
        maxConcurrentCallbacks = Math.max(maxConcurrentCallbacks, activeCallbacks);
        const delayMs = nextSettings.mcpRead ? 45 : 5;
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        externalSinkMcpRead = nextSettings.mcpRead;
        appliedMcpLog.push(nextSettings.mcpRead);
        activeCallbacks -= 1;
      }
    );

    sync = new StateSync(tmpDir, null, {
      sidecarId: SIDECAR_ID,
      conversationScoped: false,
      initialState: createInitialState,
      mutators,
    });

    try {
      // Rapid toggle ON (slow 45ms callback) then OFF (fast 5ms callback)
      const [resOn, resOff] = await Promise.all([
        sync.handleMutate({ action: 'settings-update', payload: { mcpRead: true } }),
        sync.handleMutate({ action: 'settings-update', payload: { mcpRead: false } }),
      ]);
      assert.equal(resOn.ok, true);
      assert.equal(resOff.ok, true);
      assert.equal(maxConcurrentCallbacks, 1, 'onSettingsChanged callbacks must run strictly sequentially');
      assert.deepEqual(appliedMcpLog, [true, false]);
      assert.equal(externalSinkMcpRead, false, 'final external MCP registration state must match final false state');
      assert.equal(sync.getState().settings.mcpRead, false);

      // Failed mutation must reject/fail cleanly without poisoning the queue
      const badRes = await sync.handleMutate({
        action: 'settings-update',
        payload: { cardColorStyle: 'invalid-style' },
      });
      assert.equal(badRes.ok, false);

      // Simulate offline mcp.mjs writing directly to state.json inside the poll window
      const diskSnapshot = sync.getState();
      const offlineAdded = applyNotesAction(diskSnapshot, 'stash-add', {
        text: 'Written externally by offline mcp.mjs #mcp',
        scope: 'global',
      }, 90_000);
      writeJsonAtomic(join(tmpDir, 'state.json'), offlineAdded.nextState);

      const onlineAdd = await sync.handleMutate({
        action: 'stash-add',
        payload: { text: 'Written immediately via online server #later', scope: 'global' },
      });
      assert.equal(onlineAdd.ok, true);
      const finalCards = sync.getState().cards;
      assert.equal(finalCards.length, 2, 'online mutation must refresh disk first and preserve offline mcp.mjs writes');
      assert.equal(finalCards.some((c) => c.id === offlineAdded.result.card.id), true);
    } finally {
      sync.dispose();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('tolerates null, primitive, and array entries in state.cards and state.scratchpads without throwing', () => {
    const validAdd = applyNotesAction(createInitialState(), 'stash-add', {
      text: 'Valid card #bug',
      scope: 'global',
    }, 1_000);
    const validPad = applyNotesAction(validAdd.nextState, 'pad-add', {
      scope: 'global',
      title: 'Valid Pad',
      content: 'Valid content',
    }, 2_000);

    const corrupted = {
      ...validPad.nextState,
      cards: [null, undefined, 42, 'corrupt-card', ['array-entry'], validAdd.result.card],
      scratchpads: [null, false, 99, 'corrupt-pad', ['array-pad'], validPad.result.pad],
    };

    const afterAdd = applyNotesAction(corrupted, 'stash-add', { text: 'Second valid card #ship', scope: 'global' }, 3_000);
    assert.equal(afterAdd.nextState.cards.length, 2);
    assert.equal(afterAdd.nextState.scratchpads.length, 1);

    const afterUpdate = applyNotesAction(corrupted, 'stash-update', { id: validAdd.result.card.id, color: 'violet' }, 3_500);
    assert.equal(afterUpdate.result.card.color, 'violet');

    const afterReorder = applyNotesAction(corrupted, 'stash-reorder', { orderedIds: [validAdd.result.card.id] }, 4_000);
    assert.equal(afterReorder.nextState.cards.length, 1);

    const afterPadSave = applyNotesAction(corrupted, 'pad-save', { id: validPad.result.pad.id, content: 'Updated safely' }, 4_500);
    assert.equal(afterPadSave.result.pad.content, 'Updated safely');
    assert.equal(afterPadSave.nextState.scratchpads.length, 1);

    const afterPadRename = applyNotesAction(corrupted, 'pad-rename', { id: validPad.result.pad.id, title: 'Renamed Pad' }, 5_000);
    assert.equal(afterPadRename.result.pad.title, 'Renamed Pad');
  });
});
