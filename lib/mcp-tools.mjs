/**
 * @fileoverview Opt-in Read & Write MCP tool definitions and zero-leakage handlers for Antigravity Notes.
 */

import { normalizeWorkspacePath } from 'antigravity-sidecar-kit/workspace';
import { PALETTE_COLOR_IDS, createInitialState } from './constants.mjs';
import {
  applyNotesAction,
  filterCards,
  listScratchpadsForScope,
  resolveCardColor,
} from './notes-store.mjs';

export const READ_TOOL_NAMES = Object.freeze([
  'list_stash',
  'read_scratchpad',
  'search_notes',
]);

export const WRITE_TOOL_NAMES = Object.freeze([
  'stash_prompt',
  'update_stash_card',
  'append_scratchpad',
  'replace_scratchpad',
]);

const ERR_INVALID_PARAMS = -32602;
const WORKSPACE_PATH_REQUIRED_MSG = 'workspacePath is required when scope is "workspace".';
const CARD_COLOR_ENUM = Object.freeze(['auto', 'none', ...PALETTE_COLOR_IDS]);
const FILTER_COLOR_ENUM = Object.freeze(['all', 'none', ...PALETTE_COLOR_IDS]);
const VALID_CARD_SCOPES = new Set(['all', 'workspace', 'chat', 'conversation', 'global']);
const VALID_WRITE_SCOPES = new Set(['workspace', 'global']);
const VALID_PAD_SCOPES = new Set(['workspace', 'global', 'all']);
const VALID_STATUS_FILTERS = new Set(['active', 'sent', 'all']);

const COMMON_FILTER_SCHEMA_PROPS = Object.freeze({
  scope: { type: 'string', enum: ['all', 'workspace', 'chat', 'conversation', 'global'] },
  workspacePath: { type: 'string' },
  conversationId: { type: 'string' },
  status: { type: 'string', enum: ['active', 'sent', 'all'] },
  tag: { type: 'string' },
  color: { type: 'string', enum: [...FILTER_COLOR_ENUM] },
});

const PAD_WRITE_SCHEMA_PROPS = Object.freeze({
  content: { type: 'string', description: 'Markdown content to write.' },
  id: { type: 'string', description: 'Optional target scratchpad ID.' },
  title: { type: 'string', description: 'Optional target scratchpad title.' },
  scope: { type: 'string', enum: ['workspace', 'global'] },
  workspacePath: { type: 'string' },
});

function isPlainObject(val) {
  return Boolean(val) && typeof val === 'object' && !Array.isArray(val);
}

function invalidParams(message) {
  return { error: { code: ERR_INVALID_PARAMS, message } };
}

function defineSchema(properties, required) {
  return {
    type: 'object',
    properties,
    ...(required ? { required } : {}),
  };
}

function hasExplicitId(raw) {
  return typeof raw === 'string' && raw.trim().length > 0;
}

function hasValidWorkspacePath(raw) {
  if (typeof raw !== 'string' || !raw.trim()) {
    return false;
  }
  const normalized = normalizeWorkspacePath(raw.trim().replace(/%3a/gi, ':'));
  return Boolean(normalized && normalized !== '/');
}

function validateCardFilterArgs(args) {
  if (args.scope !== undefined && !VALID_CARD_SCOPES.has(args.scope)) {
    return `Invalid scope "${String(args.scope)}".`;
  }
  if (args.scope === 'workspace' && !hasValidWorkspacePath(args.workspacePath)) {
    return WORKSPACE_PATH_REQUIRED_MSG;
  }
  if (args.status !== undefined && !VALID_STATUS_FILTERS.has(args.status)) {
    return `Invalid status "${String(args.status)}".`;
  }
  if (args.color !== undefined && args.color !== '' && !FILTER_COLOR_ENUM.includes(args.color)) {
    return `Invalid color filter "${String(args.color)}".`;
  }
  return '';
}

function resolveCurrentState(ctx, getSync) {
  const sync = ctx?.sync || (typeof getSync === 'function' ? getSync() : null);
  if (sync) {
    if (typeof sync.refresh === 'function') {
      return sync.refresh();
    }
    if (typeof sync.getState === 'function') {
      return sync.getState();
    }
  }
  return isPlainObject(ctx?.currentState) ? ctx.currentState : createInitialState();
}

async function executeStoreMutation(ctx, getSync, action, payload) {
  const sync = ctx?.sync || (typeof getSync === 'function' ? getSync() : null);
  if (sync && isPlainObject(sync.mutators) && typeof sync.mutators[action] === 'function') {
    const result = await sync.mutators[action](payload);
    const nextState = typeof sync.getState === 'function' ? sync.getState() : createInitialState();
    return { nextState, result, persisted: true };
  }
  const baseState = resolveCurrentState(ctx, sync ? getSync : null);
  const { nextState, result } = applyNotesAction(baseState, action, payload);
  if (sync && typeof sync.mutate === 'function') {
    sync.mutate(nextState, { replace: true });
    return { nextState, result, persisted: true };
  }
  return { nextState, result, persisted: false };
}

function sortPadsByOrder(pads) {
  return [...pads].sort((a, b) => {
    const orderDiff = (Number(a.order) || 0) - (Number(b.order) || 0);
    return orderDiff !== 0 ? orderDiff : (Number(a.createdAt) || 0) - (Number(b.createdAt) || 0);
  });
}

function queryEnrichedCards(state, filterOpts) {
  const tagColors = isPlainObject(state.tagColors) ? state.tagColors : {};
  return filterCards(state, filterOpts).map((card) => ({
    ...card,
    resolvedColor: resolveCardColor(card, tagColors),
  }));
}

function formatWriteResult(ack, nextState, persisted) {
  return persisted ? { result: ack } : { patch: nextState, result: ack };
}

function formatPadWriteAck(savedPad, nextState, persisted) {
  const ack = {
    ok: true,
    id: savedPad.id,
    title: savedPad.title,
    scope: savedPad.scope,
    byteLength: Buffer.byteLength(String(savedPad.content || ''), 'utf8'),
  };
  return formatWriteResult(ack, nextState, persisted);
}

async function handleListStash(args, ctx, getSync) {
  const filterErr = validateCardFilterArgs(args);
  if (filterErr) {
    return invalidParams(filterErr);
  }
  const state = resolveCurrentState(ctx, getSync);
  const cards = queryEnrichedCards(state, {
    scope: args.scope,
    workspacePath: args.workspacePath,
    conversationId: args.conversationId || ctx?.conversationId || '',
    status: args.status || 'active',
    tag: args.tag,
    color: args.color,
    query: args.query,
    includeAllWorkspaces: Boolean(args.includeAllWorkspaces),
  });
  return { result: { ok: true, total: cards.length, cards } };
}

async function handleReadScratchpad(args, ctx, getSync) {
  if (args.scope !== undefined && !VALID_PAD_SCOPES.has(args.scope)) {
    return invalidParams(`Invalid scratchpad scope "${String(args.scope)}".`);
  }
  if (!hasExplicitId(args.id) && args.scope === 'workspace' && !hasValidWorkspacePath(args.workspacePath)) {
    return invalidParams(WORKSPACE_PATH_REQUIRED_MSG);
  }
  const state = resolveCurrentState(ctx, getSync);
  const allPads = Array.isArray(state.scratchpads) ? state.scratchpads.filter(isPlainObject) : [];

  if (hasExplicitId(args.id)) {
    const cleanId = args.id.trim();
    const found = allPads.find((p) => p.id === cleanId);
    if (!found) {
      return invalidParams(`Scratchpad not found: ${cleanId}`);
    }
    const cloned = structuredClone(found);
    return {
      result: {
        ok: true,
        pad: cloned,
        id: cloned.id,
        title: cloned.title,
        scope: cloned.scope,
        content: cloned.content,
        scratchpads: [cloned],
      },
    };
  }

  let candidates;
  if (args.scope === 'all') {
    candidates = structuredClone(sortPadsByOrder(allPads));
  } else if (args.workspacePath || args.scope) {
    candidates = listScratchpadsForScope(state, { scope: args.scope, workspacePath: args.workspacePath });
  } else {
    const globalPads = listScratchpadsForScope(state, { scope: 'global' });
    candidates = globalPads.length > 0 ? globalPads : structuredClone(sortPadsByOrder(allPads));
  }

  const cleanTitle = typeof args.title === 'string' ? args.title.trim().toLowerCase() : '';
  if (cleanTitle) {
    const exact = candidates.filter((p) => String(p.title || '').trim().toLowerCase() === cleanTitle);
    candidates = exact.length > 0
      ? exact
      : candidates.filter((p) => String(p.title || '').toLowerCase().includes(cleanTitle));
  }

  const primary = candidates[0] || null;
  const fallbackScope = args.workspacePath && args.scope !== 'global' ? 'workspace' : 'global';
  return {
    result: {
      ok: true,
      pad: primary,
      id: primary ? primary.id : '',
      title: primary ? primary.title : 'Scratchpad',
      scope: primary ? primary.scope : fallbackScope,
      content: primary ? primary.content : '',
      scratchpads: candidates,
    },
  };
}

async function handleSearchNotes(args, ctx, getSync) {
  const query = typeof args.query === 'string' ? args.query.trim() : '';
  if (!query) {
    return invalidParams('Search query must be a non-empty string.');
  }
  const filterErr = validateCardFilterArgs(args);
  if (filterErr) {
    return invalidParams(filterErr);
  }

  const state = resolveCurrentState(ctx, getSync);
  const cards = queryEnrichedCards(state, {
    scope: args.scope,
    workspacePath: args.workspacePath,
    conversationId: args.conversationId || ctx?.conversationId || '',
    status: args.status || 'all',
    color: args.color,
    tag: args.tag,
    query,
  });

  let candidatePads = [];
  if (args.scope === 'global') {
    candidatePads = listScratchpadsForScope(state, { scope: 'global' });
  } else if (args.scope === 'workspace') {
    candidatePads = listScratchpadsForScope(state, { scope: 'workspace', workspacePath: args.workspacePath });
  } else if (!args.scope || args.scope === 'all') {
    const allPads = Array.isArray(state.scratchpads) ? state.scratchpads.filter(isPlainObject) : [];
    candidatePads = structuredClone(sortPadsByOrder(allPads));
  }

  const needle = query.toLowerCase();
  const scratchpads = candidatePads.filter((pad) => (
    String(pad.title || '').toLowerCase().includes(needle)
    || String(pad.content || '').toLowerCase().includes(needle)
  ));

  return {
    result: { ok: true, query, totalMatches: cards.length + scratchpads.length, cards, scratchpads },
  };
}

async function handleStashPrompt(args, ctx, getSync) {
  if (args.scope !== undefined && !VALID_WRITE_SCOPES.has(args.scope)) {
    return invalidParams(`Invalid card scope "${String(args.scope)}".`);
  }
  if (args.scope === 'workspace' && !hasValidWorkspacePath(args.workspacePath)) {
    return invalidParams(WORKSPACE_PATH_REQUIRED_MSG);
  }
  const payload = {
    text: args.text,
    ...(args.color !== undefined ? { color: args.color } : {}),
    ...(args.scope !== undefined ? { scope: args.scope } : {}),
    ...(args.workspacePath !== undefined ? { workspacePath: args.workspacePath } : {}),
    originConversationId: args.conversationId ?? ctx?.conversationId ?? '',
  };
  const { nextState, result, persisted } = await executeStoreMutation(ctx, getSync, 'stash-add', payload);
  const card = result.card;
  const ack = {
    ok: true,
    id: card.id,
    status: 'active',
    color: card.color,
    resolvedColor: resolveCardColor(card, nextState.tagColors),
    tags: card.tags,
  };
  return formatWriteResult(ack, nextState, persisted);
}

async function handleUpdateStashCard(args, ctx, getSync) {
  const cleanId = typeof args.id === 'string' ? args.id.trim() : '';
  if (!cleanId) {
    return invalidParams('Card id is required.');
  }
  const payload = {
    id: cleanId,
    ...(args.text !== undefined ? { text: args.text } : {}),
    ...(args.color !== undefined ? { color: args.color } : {}),
    ...(args.status !== undefined ? { status: args.status } : {}),
  };
  const { nextState, result, persisted } = await executeStoreMutation(ctx, getSync, 'stash-update', payload);
  return formatWriteResult({ ok: true, id: result.card.id, status: result.card.status }, nextState, persisted);
}

async function handleWriteScratchpad(args, ctx, getSync, isAppend) {
  if (args.scope !== undefined && !VALID_WRITE_SCOPES.has(args.scope)) {
    return invalidParams(`Invalid scratchpad scope "${String(args.scope)}".`);
  }
  const cleanId = hasExplicitId(args.id) ? args.id.trim() : '';
  if (!cleanId && args.scope === 'workspace' && !hasValidWorkspacePath(args.workspacePath)) {
    return invalidParams(WORKSPACE_PATH_REQUIRED_MSG);
  }
  const rawContent = args.content !== undefined ? args.content : args.text;
  if (isAppend ? typeof rawContent !== 'string' || rawContent.length === 0 : typeof rawContent !== 'string') {
    return invalidParams(
      isAppend
        ? 'Scratchpad content to append must be a non-empty string.'
        : 'Scratchpad content must be a string.'
    );
  }
  const cleanTitle = typeof args.title === 'string' && args.title.trim() ? args.title.trim() : '';
  const { nextState, result, persisted } = await executeStoreMutation(ctx, getSync, 'pad-save', {
    mode: isAppend ? 'append' : 'replace',
    ...(cleanId ? { id: cleanId } : {}),
    ...(cleanTitle ? { title: cleanTitle, matchByTitle: !cleanId } : {}),
    ...(args.scope !== undefined ? { scope: args.scope } : {}),
    ...(args.workspacePath !== undefined ? { workspacePath: args.workspacePath } : {}),
    content: rawContent,
  });
  return formatPadWriteAck(result.pad, nextState, persisted);
}

export function buildNotesMcpTools(rawOptions = {}) {
  const options = isPlainObject(rawOptions) ? rawOptions : {};
  const getSync = typeof options.getSync === 'function' ? options.getSync : null;

  const wrapRead = (fn) => (rawArgs = {}, ctx = {}) => fn(isPlainObject(rawArgs) ? rawArgs : {}, ctx, getSync);
  const wrapWrite = (fn) => async (rawArgs = {}, ctx = {}) => {
    try {
      return await fn(isPlainObject(rawArgs) ? rawArgs : {}, ctx, getSync);
    } catch (err) {
      return invalidParams(err?.message || String(err));
    }
  };

  return [
    {
      name: 'list_stash',
      description: 'List stashed prompt cards with optional scope, status, color, #tag, and text query filters.',
      inputSchema: defineSchema({ ...COMMON_FILTER_SCHEMA_PROPS, query: { type: 'string' }, includeAllWorkspaces: { type: 'boolean' } }),
      handler: wrapRead(handleListStash),
    },
    {
      name: 'read_scratchpad',
      description: 'Read a Markdown Scratchpad by id, title, workspacePath, or global scope.',
      inputSchema: defineSchema({
        id: { type: 'string' },
        title: { type: 'string' },
        scope: { type: 'string', enum: ['workspace', 'global', 'all'] },
        workspacePath: { type: 'string' },
      }),
      handler: wrapRead(handleReadScratchpad),
    },
    {
      name: 'search_notes',
      description: 'Search across both Prompt Stash cards and Markdown Scratchpads.',
      inputSchema: defineSchema({ query: { type: 'string', description: 'Non-empty search query.' }, ...COMMON_FILTER_SCHEMA_PROPS }, ['query']),
      handler: wrapRead(handleSearchNotes),
    },
    {
      name: 'stash_prompt',
      description: 'Add a draft prompt card to Prompt Stash with optional Onyx color and #tags.',
      inputSchema: defineSchema({
        text: { type: 'string', description: 'Prompt text to stash (supports #tags).' },
        color: { type: 'string', enum: [...CARD_COLOR_ENUM] },
        scope: { type: 'string', enum: ['workspace', 'global'] },
        workspacePath: { type: 'string' },
        conversationId: { type: 'string' },
      }, ['text']),
      handler: wrapWrite(handleStashPrompt),
    },
    {
      name: 'update_stash_card',
      description: 'Update an existing stashed prompt card (text, color, or active/sent status).',
      inputSchema: defineSchema({
        id: { type: 'string', description: 'Card ID to update.' },
        text: { type: 'string' },
        color: { type: 'string', enum: [...CARD_COLOR_ENUM] },
        status: { type: 'string', enum: ['active', 'sent'] },
      }, ['id']),
      handler: wrapWrite(handleUpdateStashCard),
    },
    {
      name: 'append_scratchpad',
      description: 'Append Markdown text to a Scratchpad without exposing pre-existing content.',
      inputSchema: defineSchema({ ...PAD_WRITE_SCHEMA_PROPS }, ['content']),
      handler: wrapWrite((args, ctx, syncGetter) => handleWriteScratchpad(args, ctx, syncGetter, true)),
    },
    {
      name: 'replace_scratchpad',
      description: 'Replace the full Markdown content of a Scratchpad without echoing previous text.',
      inputSchema: defineSchema({ ...PAD_WRITE_SCHEMA_PROPS }, ['content']),
      handler: wrapWrite((args, ctx, syncGetter) => handleWriteScratchpad(args, ctx, syncGetter, false)),
    },
  ];
}
