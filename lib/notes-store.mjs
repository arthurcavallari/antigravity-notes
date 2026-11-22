/**
 * @fileoverview Pure immutable Notes domain store: #tag parser, Onyx color resolver, scoping, and StateSync mutators.
 */

import { randomUUID } from 'node:crypto';
import {
  extractWorkspaceName,
  isRealConversationId,
  normalizeWorkspacePath,
} from 'antigravity-sidecar-kit/workspace';
import {
  MAX_CARD_BYTES,
  MAX_PAD_BYTES,
  MAX_SENT_CARDS,
  MAX_SPLIT_RATIO,
  MIN_SPLIT_RATIO,
  PALETTE_COLOR_IDS,
  SCHEMA_VERSION,
  VALID_CARD_COLORS,
  VALID_COLOR_STYLES,
  VALID_ENTER_BEHAVIORS,
  VALID_STASH_LAYOUTS,
  VALID_TAG_COLORS,
  VALID_WORKBENCH_MODES,
  createInitialState,
  inferDefaultTagColor,
} from './constants.mjs';

export const NOTES_ACTION_NAMES = Object.freeze([
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
]);

const HASHTAG_RE = /(?:^|[\s([{"'*~])#([a-z][a-z0-9_-]{0,31})(?=$|[\s.,;:!?)\]}"'*~])/gi;
const TAG_NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const ENUM_SETTING_RULES = Object.freeze([
  ['enterBehavior', VALID_ENTER_BEHAVIORS],
  ['cardColorStyle', VALID_COLOR_STYLES],
  ['stashLayout', VALID_STASH_LAYOUTS],
  ['workbenchMode', VALID_WORKBENCH_MODES],
]);
const BOOLEAN_SETTING_KEYS = Object.freeze(['mcpRead', 'mcpWrite']);

function isPlainObject(val) {
  return Boolean(val) && typeof val === 'object' && !Array.isArray(val);
}

function cleanWorkspacePath(raw) {
  if (typeof raw !== 'string' || !raw.trim()) {
    return '';
  }
  return normalizeWorkspacePath(raw.replace(/%3a/gi, ':'));
}

function toWorkspaceKey(raw) {
  if (typeof raw !== 'string' || !raw.trim()) {
    return '';
  }
  return normalizeWorkspacePath(raw.replace(/%3a/gi, ':'), { lowercase: true });
}

function resolvePadTargetScope(scope, workspacePath) {
  const normWs = cleanWorkspacePath(workspacePath || '');
  if (scope === 'global' || scope === 'all' || !normWs) {
    return { scope: 'global', workspacePath: '', workspaceName: 'Global' };
  }
  return { scope: 'workspace', workspacePath: normWs, workspaceName: extractWorkspaceName(normWs) };
}

function assertMaxUtf8Bytes(value, limitBytes, label) {
  const byteLen = Buffer.byteLength(value, 'utf8');
  if (byteLen > limitBytes) {
    throw new Error(`${label} exceeds maximum size of ${limitBytes} bytes (got ${byteLen} bytes).`);
  }
}

function assertEnum(value, allowedSet, fieldName) {
  if (!allowedSet.has(value)) {
    throw new Error(`Invalid ${fieldName} "${String(value)}".`);
  }
}

function normalizeState(rawState) {
  const defaults = createInitialState();
  const src = isPlainObject(rawState) ? rawState : {};
  const rawSettings = isPlainObject(src.settings) ? src.settings : {};
  const ratio = Number(rawSettings.workbenchSplitRatio);
  const clampedRatio = Number.isFinite(ratio)
    ? Math.min(MAX_SPLIT_RATIO, Math.max(MIN_SPLIT_RATIO, ratio))
    : defaults.settings.workbenchSplitRatio;

  const settings = {
    enterBehavior: VALID_ENTER_BEHAVIORS.has(rawSettings.enterBehavior)
      ? rawSettings.enterBehavior
      : defaults.settings.enterBehavior,
    cardColorStyle: VALID_COLOR_STYLES.has(rawSettings.cardColorStyle)
      ? rawSettings.cardColorStyle
      : defaults.settings.cardColorStyle,
    stashLayout: VALID_STASH_LAYOUTS.has(rawSettings.stashLayout)
      ? rawSettings.stashLayout
      : defaults.settings.stashLayout,
    workbenchMode: VALID_WORKBENCH_MODES.has(rawSettings.workbenchMode)
      ? rawSettings.workbenchMode
      : defaults.settings.workbenchMode,
    workbenchSplitRatio: clampedRatio,
    mcpRead: Boolean(rawSettings.mcpRead),
    mcpWrite: Boolean(rawSettings.mcpWrite),
  };

  const tagColors = {};
  if (isPlainObject(src.tagColors)) {
    for (const [k, v] of Object.entries(src.tagColors)) {
      const cleanKey = k.trim().toLowerCase();
      if (TAG_NAME_RE.test(cleanKey) && !UNSAFE_KEYS.has(cleanKey) && VALID_TAG_COLORS.has(v)) {
        tagColors[cleanKey] = v;
      }
    }
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    settings,
    tagColors,
    cards: Array.isArray(src.cards) ? structuredClone(src.cards.filter(isPlainObject)) : [],
    scratchpads: Array.isArray(src.scratchpads) ? structuredClone(src.scratchpads.filter(isPlainObject)) : [],
  };
}

function stripInlineCodeOnLine(line) {
  if (!line.includes('`')) {
    return line;
  }
  const runs = [];
  let pos = 0;
  while (pos < line.length) {
    const start = line.indexOf('`', pos);
    if (start === -1) {
      break;
    }
    let end = start + 1;
    while (end < line.length && line.charCodeAt(end) === 96) {
      end += 1;
    }
    runs.push({ start, end, len: end - start });
    pos = end;
  }
  const deadLengths = new Set();
  const out = [];
  let cursor = 0;
  let i = 0;
  while (i < runs.length) {
    const openRun = runs[i];
    if (deadLengths.has(openRun.len)) {
      i += 1;
      continue;
    }
    let closeIdx = -1;
    for (let j = i + 1; j < runs.length; j++) {
      if (runs[j].len === openRun.len) {
        closeIdx = j;
        break;
      }
    }
    if (closeIdx === -1) {
      deadLengths.add(openRun.len);
      i += 1;
      continue;
    }
    out.push(line.slice(cursor, openRun.start), ' ');
    cursor = runs[closeIdx].end;
    i = closeIdx + 1;
  }
  out.push(line.slice(cursor));
  return out.join('');
}

function stripCodeAndHeadings(text) {
  const lines = text.split('\n');
  const kept = [];
  let fenceChar = '';
  let fenceLen = 0;
  for (const line of lines) {
    if (!fenceChar) {
      const open = line.match(/^[ ]{0,3}(`{3,}|~{3,})(.*)$/);
      if (open && !(open[1][0] === '`' && open[2].includes('`'))) {
        fenceChar = open[1][0];
        fenceLen = open[1].length;
        continue;
      }
      if (/^\s{0,3}#{1,6}\s/.test(line)) {
        continue;
      }
      kept.push(stripInlineCodeOnLine(line));
    } else {
      const close = line.match(/^[ ]{0,3}(`{3,}|~{3,})[ \t]*$/);
      if (close && close[1][0] === fenceChar && close[1].length >= fenceLen) {
        fenceChar = '';
        fenceLen = 0;
      }
    }
  }
  return kept.join('\n');
}

export function parseHashtags(text) {
  if (typeof text !== 'string' || !text) {
    return [];
  }
  const clean = stripCodeAndHeadings(text.replace(/\r\n/g, '\n'))
    .replace(/\]\([^)\s]*\)/g, '] ')
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, ' ');

  const found = new Set();
  HASHTAG_RE.lastIndex = 0;
  let match = HASHTAG_RE.exec(clean);
  while (match !== null) {
    const tag = match[1].toLowerCase();
    if (!UNSAFE_KEYS.has(tag)) {
      found.add(tag);
    }
    match = HASHTAG_RE.exec(clean);
  }
  return [...found];
}

export function resolveCardColor(card, tagColors = {}) {
  if (!isPlainObject(card) || card.color === 'none') {
    return '';
  }
  if (card.color && card.color !== 'auto') {
    return PALETTE_COLOR_IDS.includes(card.color) ? card.color : '';
  }
  const tags = Array.isArray(card.tags) ? card.tags : [];
  const colorMap = isPlainObject(tagColors) ? tagColors : {};
  for (const rawTag of tags) {
    const key = String(rawTag || '').toLowerCase();
    const mapped = Object.hasOwn(colorMap, key) ? colorMap[key] : undefined;
    if (PALETTE_COLOR_IDS.includes(mapped)) {
      return mapped;
    }
  }
  return '';
}

function compareCards(a, b) {
  const aSent = a.status === 'sent';
  const bSent = b.status === 'sent';
  if (aSent !== bSent) {
    return aSent ? 1 : -1;
  }
  if (aSent) {
    const sentDiff = (Number(b.sentAt) || 0) - (Number(a.sentAt) || 0);
    return sentDiff !== 0 ? sentDiff : (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0);
  }
  const orderDiff = (Number(a.order) || 0) - (Number(b.order) || 0);
  return orderDiff !== 0 ? orderDiff : (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0);
}

export function filterCards(state, options = {}) {
  const cards = Array.isArray(state?.cards) ? state.cards : [];
  const tagColors = isPlainObject(state?.tagColors) ? state.tagColors : {};
  const {
    scope,
    workspacePath,
    allWorkspacePaths,
    conversationId,
    status,
    tag,
    color,
    query,
    includeAllWorkspaces = false,
  } = isPlainObject(options) ? options : {};

  const wsKeys = new Set();
  const primaryKey = toWorkspaceKey(workspacePath);
  if (primaryKey) {
    wsKeys.add(primaryKey);
  }
  if (Array.isArray(allWorkspacePaths)) {
    for (const entry of allWorkspacePaths) {
      const key = toWorkspaceKey(entry);
      if (key) {
        wsKeys.add(key);
      }
    }
  }

  const cleanTag = typeof tag === 'string' ? tag.trim().replace(/^#+/, '').toLowerCase() : '';
  const cleanColor = typeof color === 'string' ? color.trim().toLowerCase() : '';
  const cleanQuery = typeof query === 'string' ? query.trim().toLowerCase() : '';

  const matched = cards.filter((card) => {
    if (!isPlainObject(card)) {
      return false;
    }
    if (status && status !== 'all' && card.status !== status) {
      return false;
    }
    if (scope === 'workspace') {
      if (card.scope !== 'workspace') {
        return false;
      }
      const cardWsKey = toWorkspaceKey(card.workspacePath);
      if (wsKeys.size === 0 ? cardWsKey !== '' : !cardWsKey || !wsKeys.has(cardWsKey)) {
        return false;
      }
    } else if (scope === 'chat' || scope === 'conversation') {
      if (card.scope === 'global' || !isRealConversationId(conversationId) || card.originConversationId !== conversationId) {
        return false;
      }
    } else if (scope === 'global' && !includeAllWorkspaces && card.scope !== 'global') {
      return false;
    }
    if (cleanTag && (!Array.isArray(card.tags) || !card.tags.includes(cleanTag))) {
      return false;
    }
    if (cleanColor && cleanColor !== 'all') {
      const targetColor = cleanColor === 'none' ? '' : cleanColor;
      if (resolveCardColor(card, tagColors) !== targetColor) {
        return false;
      }
    }
    if (cleanQuery && !String(card.text || '').toLowerCase().includes(cleanQuery)) {
      return false;
    }
    return true;
  });

  return structuredClone(matched.sort(compareCards));
}

export function listScratchpadsForScope(state, options = {}) {
  const scratchpads = Array.isArray(state?.scratchpads) ? state.scratchpads : [];
  const opts = isPlainObject(options) ? options : {};
  const target = resolvePadTargetScope(opts.scope, opts.workspacePath);
  const wsKeys = new Set();
  const targetWsKey = toWorkspaceKey(target.workspacePath);
  if (targetWsKey) {
    wsKeys.add(targetWsKey);
  }
  if (Array.isArray(opts.allWorkspacePaths)) {
    for (const entry of opts.allWorkspacePaths) {
      const key = toWorkspaceKey(entry);
      if (key) {
        wsKeys.add(key);
      }
    }
  }

  const matched = scratchpads.filter((pad) => {
    if (!isPlainObject(pad)) {
      return false;
    }
    if (target.scope === 'global') {
      return pad.scope === 'global';
    }
    const padWsKey = toWorkspaceKey(pad.workspacePath);
    return pad.scope === 'workspace' && Boolean(padWsKey && wsKeys.has(padWsKey));
  });

  matched.sort((a, b) => {
    const orderDiff = (Number(a.order) || 0) - (Number(b.order) || 0);
    return orderDiff !== 0 ? orderDiff : (Number(a.createdAt) || 0) - (Number(b.createdAt) || 0);
  });

  return structuredClone(matched);
}

export function exportStashMarkdown(cards, scopeLabel = '') {
  const safeLabel = typeof scopeLabel === 'string' ? scopeLabel.trim() : '';
  const heading = safeLabel ? `# Prompt Stash — ${safeLabel}` : '# Prompt Stash';
  const list = Array.isArray(cards) ? cards : [];
  if (list.length === 0) {
    return `${heading}\n\n_No stashed prompts._\n`;
  }
  const sections = [heading, ''];
  list.forEach((card, idx) => {
    const statusLabel = card.status === 'sent' ? 'Sent' : 'Active';
    const tagList = Array.isArray(card.tags) && card.tags.length > 0
      ? ` · ${card.tags.map((t) => `#${t}`).join(' ')}`
      : '';
    const originLabel = card.originConversationTitle ? ` · ${card.originConversationTitle}` : '';
    sections.push(`## ${idx + 1}. ${statusLabel}${tagList}${originLabel}`);
    sections.push('');
    sections.push(String(card.text || '').trim());
    sections.push('');
  });
  return `${sections.join('\n').trimEnd()}\n`;
}

function populateMissingTagColors(tagColors, tags) {
  for (const tag of tags) {
    if (!UNSAFE_KEYS.has(tag) && !Object.hasOwn(tagColors, tag)) {
      tagColors[tag] = inferDefaultTagColor(tag);
    }
  }
}

function pruneSentCardsFifo(cards) {
  const sentEntries = [];
  cards.forEach((card, index) => {
    if (card.status === 'sent') {
      sentEntries.push({ card, index });
    }
  });
  if (sentEntries.length <= MAX_SENT_CARDS) {
    return { cards, prunedCount: 0 };
  }
  sentEntries.sort((a, b) => {
    const sentDiff = (Number(b.card.sentAt) || 0) - (Number(a.card.sentAt) || 0);
    if (sentDiff !== 0) {
      return sentDiff;
    }
    const createdDiff = (Number(b.card.createdAt) || 0) - (Number(a.card.createdAt) || 0);
    return createdDiff !== 0 ? createdDiff : b.index - a.index;
  });

  const keepSentIds = new Set(sentEntries.slice(0, MAX_SENT_CARDS).map((e) => e.card.id));
  const nextCards = cards.filter((c) => c.status !== 'sent' || keepSentIds.has(c.id));
  return { cards: nextCards, prunedCount: sentEntries.length - MAX_SENT_CARDS };
}

function extractTargetIds(payload, errorMsg) {
  const rawList = Array.isArray(payload?.ids)
    ? payload.ids
    : typeof payload?.id === 'string' && payload.id.trim()
      ? [payload.id.trim()]
      : [];
  const cleanIds = [...new Set(rawList.map((id) => String(id || '').trim()).filter(Boolean))];
  if (cleanIds.length === 0) {
    throw new Error(errorMsg);
  }
  return cleanIds;
}

function reorderItemsById(items, rawIds, entityLabel) {
  if (!Array.isArray(rawIds)) {
    throw new Error(`${entityLabel} reorder requires an orderedIds array.`);
  }
  const byId = new Map(items.map((item) => [item.id, item]));
  const seen = new Set();
  const ordered = [];
  for (const rawId of rawIds) {
    const id = String(rawId || '').trim();
    if (id && byId.has(id) && !seen.has(id)) {
      seen.add(id);
      ordered.push(byId.get(id));
    }
  }
  for (const item of items) {
    if (!seen.has(item.id)) {
      ordered.push(item);
    }
  }
  ordered.forEach((item, index) => {
    item.order = (index + 1) * 1000;
  });
  return { items: ordered, orderedIds: [...seen] };
}

function createDefaultPad(target, ts, title = 'Scratchpad', content = '') {
  return {
    id: randomUUID(),
    title,
    scope: target.scope,
    workspacePath: target.workspacePath,
    workspaceName: target.workspaceName,
    content,
    order: 1000,
    createdAt: ts,
    updatedAt: ts,
  };
}

export function applyNotesAction(currentState, action, rawPayload = {}, now = Date.now()) {
  const nextState = normalizeState(currentState);
  const payload = isPlainObject(rawPayload) ? rawPayload : {};
  const ts = typeof now === 'number' && Number.isFinite(now) ? now : Date.now();

  if (action === 'stash-add') {
    if (typeof payload.text !== 'string' || !payload.text.trim()) {
      throw new Error('Card text must be a non-empty string.');
    }
    assertMaxUtf8Bytes(payload.text, MAX_CARD_BYTES, 'Card text');
    const trimmedText = payload.text.trim();
    const cardColor = payload.color === undefined || payload.color === '' ? 'auto' : String(payload.color);
    assertEnum(cardColor, VALID_CARD_COLORS, 'card color');

    const tags = parseHashtags(trimmedText);
    populateMissingTagColors(nextState.tagColors, tags);

    const normWs = cleanWorkspacePath(payload.workspacePath || '');
    const isUnscoped = payload.scope === 'global' || payload.scope === 'all' || !normWs;
    const resolvedScope = isUnscoped ? 'global' : 'workspace';
    const rawOrigin = payload.originConversationId !== undefined
      ? payload.originConversationId
      : payload.conversationId;
    const originConversationId = !isUnscoped && isRealConversationId(rawOrigin) ? rawOrigin.trim() : '';
    const originConversationTitle = !isUnscoped && typeof payload.originConversationTitle === 'string'
      ? payload.originConversationTitle.trim()
      : '';
    const cardWsPath = isUnscoped ? '' : normWs;
    const cardWsName = isUnscoped
      ? ''
      : typeof payload.workspaceName === 'string' && payload.workspaceName.trim()
        ? payload.workspaceName.trim()
        : cardWsPath ? extractWorkspaceName(cardWsPath) : '';

    let minOrder = 2000;
    for (const existing of nextState.cards) {
      if (existing.status === 'active' && typeof existing.order === 'number') {
        minOrder = Math.min(minOrder, existing.order);
      }
    }
    const card = {
      id: randomUUID(),
      text: trimmedText,
      tags,
      color: cardColor,
      scope: resolvedScope,
      workspacePath: cardWsPath,
      workspaceName: cardWsName,
      originConversationId,
      originConversationTitle,
      status: 'active',
      order: minOrder - 1000,
      createdAt: ts,
      updatedAt: ts,
      sentAt: null,
      sentToConversationId: '',
      sentToConversationTitle: '',
      sentMode: '',
    };
    nextState.cards.unshift(card);
    return { nextState, result: { id: card.id, card: structuredClone(card) } };
  }

  if (action === 'stash-update') {
    const card = nextState.cards.find((c) => c.id === payload.id);
    if (!card) {
      throw new Error(`Card not found: ${String(payload.id || '')}`);
    }
    if (payload.text !== undefined) {
      if (typeof payload.text !== 'string' || !payload.text.trim()) {
        throw new Error('Card text must be a non-empty string.');
      }
      assertMaxUtf8Bytes(payload.text, MAX_CARD_BYTES, 'Card text');
      card.text = payload.text.trim();
      card.tags = parseHashtags(card.text);
      populateMissingTagColors(nextState.tagColors, card.tags);
    }
    if (payload.color !== undefined) {
      assertEnum(payload.color, VALID_CARD_COLORS, 'card color');
      card.color = payload.color;
    }
    if (payload.scope !== undefined) {
      if (payload.scope !== 'workspace' && payload.scope !== 'global' && payload.scope !== 'all') {
        throw new Error(`Invalid card scope "${String(payload.scope)}".`);
      }
      card.scope = payload.scope === 'all' ? 'global' : payload.scope;
    }
    if (payload.workspacePath !== undefined) {
      const normWs = cleanWorkspacePath(payload.workspacePath);
      card.workspacePath = normWs;
      card.workspaceName = normWs ? extractWorkspaceName(normWs) : '';
    }
    if (card.scope === 'workspace' && !card.workspacePath) {
      card.scope = 'global';
    }
    if (card.scope === 'global') {
      card.workspacePath = '';
      card.workspaceName = '';
      card.originConversationId = '';
      card.originConversationTitle = '';
    }
    if (payload.status !== undefined) {
      if (payload.status !== 'active' && payload.status !== 'sent') {
        throw new Error(`Invalid card status "${String(payload.status)}".`);
      }
      card.status = payload.status;
      if (payload.status === 'sent') {
        card.sentAt = card.sentAt || ts;
      } else {
        card.sentAt = null;
        card.sentToConversationId = '';
        card.sentToConversationTitle = '';
        card.sentMode = '';
      }
    }
    card.updatedAt = ts;
    if (card.status === 'sent') {
      nextState.cards = pruneSentCardsFifo(nextState.cards).cards;
    }
    return { nextState, result: { card: structuredClone(card) } };
  }

  if (action === 'stash-reorder') {
    const reordered = reorderItemsById(nextState.cards, payload.orderedIds ?? payload.ids, 'Stash');
    nextState.cards = reordered.items;
    return { nextState, result: { orderedIds: reordered.orderedIds } };
  }

  if (action === 'stash-delete') {
    const targetIds = new Set(extractTargetIds(payload, 'Card id is required to delete.'));
    const beforeLen = nextState.cards.length;
    nextState.cards = nextState.cards.filter((c) => !targetIds.has(c.id));
    return {
      nextState,
      result: { deletedIds: [...targetIds], deletedCount: beforeLen - nextState.cards.length },
    };
  }

  if (action === 'stash-mark-sent') {
    const targetIds = new Set(extractTargetIds(payload, 'At least one card id is required to mark sent.'));
    const destId = typeof payload.sentToConversationId === 'string' ? payload.sentToConversationId.trim() : '';
    const destTitle = typeof payload.sentToConversationTitle === 'string'
      ? payload.sentToConversationTitle.trim()
      : '';
    const sentMode = typeof payload.sentMode === 'string' ? payload.sentMode.trim() : '';
    const markedIds = [];
    for (const card of nextState.cards) {
      if (targetIds.has(card.id)) {
        card.status = 'sent';
        card.sentAt = ts;
        card.updatedAt = ts;
        card.sentToConversationId = destId;
        card.sentToConversationTitle = destTitle;
        card.sentMode = sentMode;
        markedIds.push(card.id);
      }
    }
    const pruned = pruneSentCardsFifo(nextState.cards);
    nextState.cards = pruned.cards;
    return { nextState, result: { markedIds, prunedCount: pruned.prunedCount } };
  }

  if (action === 'stash-restore') {
    const targetIds = new Set(extractTargetIds(payload, 'At least one card id is required to restore.'));
    const restoredIds = [];
    for (const card of nextState.cards) {
      if (targetIds.has(card.id)) {
        card.status = 'active';
        card.updatedAt = ts;
        card.sentAt = null;
        card.sentToConversationId = '';
        card.sentToConversationTitle = '';
        card.sentMode = '';
        restoredIds.push(card.id);
      }
    }
    return { nextState, result: { restoredIds } };
  }

  if (action === 'stash-clear-sent') {
    let removeIds;
    if (payload.scope && payload.scope !== 'all') {
      const scopedSent = filterCards(nextState, {
        scope: payload.scope,
        workspacePath: payload.workspacePath,
        allWorkspacePaths: payload.allWorkspacePaths,
        conversationId: payload.conversationId,
        includeAllWorkspaces: payload.includeAllWorkspaces,
        status: 'sent',
      });
      removeIds = new Set(scopedSent.map((c) => c.id));
    } else {
      removeIds = new Set(nextState.cards.filter((c) => c.status === 'sent').map((c) => c.id));
    }
    nextState.cards = nextState.cards.filter((c) => !removeIds.has(c.id));
    return { nextState, result: { clearedCount: removeIds.size } };
  }

  if (action === 'tag-set-color') {
    const cleanTag = typeof payload.tag === 'string'
      ? payload.tag.trim().replace(/^#+/, '').toLowerCase()
      : '';
    if (!TAG_NAME_RE.test(cleanTag) || UNSAFE_KEYS.has(cleanTag)) {
      throw new Error(`Invalid tag name "${String(payload.tag || '')}".`);
    }
    const color = String(payload.color || '');
    assertEnum(color, VALID_TAG_COLORS, 'tag color');
    nextState.tagColors[cleanTag] = color;
    return { nextState, result: { tag: cleanTag, color } };
  }

  if (action === 'pad-ensure') {
    const target = resolvePadTargetScope(payload.scope, payload.workspacePath);
    const existing = listScratchpadsForScope(nextState, target);
    if (existing.length > 0) {
      return { nextState, result: { pad: existing[0], created: false } };
    }
    const title = typeof payload.title === 'string' && payload.title.trim()
      ? payload.title.trim().slice(0, 120)
      : 'Scratchpad';
    const pad = createDefaultPad(target, ts, title, '');
    nextState.scratchpads.push(pad);
    return { nextState, result: { pad: structuredClone(pad), created: true } };
  }

  if (action === 'pad-add') {
    const content = payload.content === undefined ? '' : String(payload.content);
    assertMaxUtf8Bytes(content, MAX_PAD_BYTES, 'Scratchpad content');
    const target = resolvePadTargetScope(payload.scope, payload.workspacePath);
    const existing = listScratchpadsForScope(nextState, target);
    const maxOrder = existing.reduce((max, p) => Math.max(max, Number(p.order) || 0), 0);
    const fallbackTitle = existing.length === 0 ? 'Scratchpad' : `Pad ${existing.length + 1}`;
    const title = typeof payload.title === 'string' && payload.title.trim()
      ? payload.title.trim().slice(0, 120)
      : fallbackTitle;
    const pad = { ...createDefaultPad(target, ts, title, content), order: maxOrder + 1000 };
    nextState.scratchpads.push(pad);
    return { nextState, result: { pad: structuredClone(pad) } };
  }

  if (action === 'pad-rename') {
    const pad = nextState.scratchpads.find((p) => p.id === payload.id);
    if (!pad) {
      throw new Error(`Scratchpad not found: ${String(payload.id || '')}`);
    }
    const title = typeof payload.title === 'string' ? payload.title.trim() : '';
    if (!title) {
      throw new Error('Scratchpad title must be a non-empty string.');
    }
    pad.title = title.slice(0, 120);
    pad.updatedAt = ts;
    return { nextState, result: { pad: structuredClone(pad) } };
  }

  if (action === 'pad-reorder') {
    const reordered = reorderItemsById(nextState.scratchpads, payload.orderedIds ?? payload.ids, 'Scratchpad');
    nextState.scratchpads = reordered.items;
    return { nextState, result: { orderedIds: reordered.orderedIds } };
  }

  if (action === 'pad-save') {
    const mode = payload.mode === undefined ? 'replace' : payload.mode;
    if (mode !== 'replace' && mode !== 'append') {
      throw new Error(`Invalid scratchpad save mode "${String(mode)}".`);
    }
    if (typeof payload.content !== 'string') {
      throw new Error('Scratchpad content must be a string.');
    }
    if (mode === 'append' && payload.content.length === 0) {
      throw new Error('Scratchpad content to append must be a non-empty string.');
    }
    const cleanId = typeof payload.id === 'string' ? payload.id.trim() : '';
    let pad = cleanId ? nextState.scratchpads.find((p) => p.id === cleanId) : null;
    if (cleanId && !pad) {
      throw new Error(`Scratchpad not found: ${cleanId}`);
    }
    const requestedTitle = typeof payload.title === 'string' && payload.title.trim()
      ? payload.title.trim().slice(0, 120)
      : '';
    if (!pad) {
      const target = resolvePadTargetScope(payload.scope, payload.workspacePath);
      const existing = listScratchpadsForScope(nextState, target);
      if (payload.matchByTitle === true && requestedTitle) {
        const titleLower = requestedTitle.toLowerCase();
        const matched = existing.find((p) => String(p.title || '').trim().toLowerCase() === titleLower);
        if (matched) {
          pad = nextState.scratchpads.find((p) => p.id === matched.id);
        } else {
          assertMaxUtf8Bytes(payload.content, MAX_PAD_BYTES, 'Scratchpad content');
          const maxOrder = existing.reduce((max, p) => Math.max(max, Number(p.order) || 0), 0);
          pad = { ...createDefaultPad(target, ts, requestedTitle, payload.content), order: maxOrder + 1000 };
          nextState.scratchpads.push(pad);
          return { nextState, result: { pad: structuredClone(pad) } };
        }
      } else if (existing.length > 0) {
        pad = nextState.scratchpads.find((p) => p.id === existing[0].id);
      } else {
        assertMaxUtf8Bytes(payload.content, MAX_PAD_BYTES, 'Scratchpad content');
        pad = createDefaultPad(target, ts, requestedTitle || 'Scratchpad', payload.content);
        nextState.scratchpads.push(pad);
        return { nextState, result: { pad: structuredClone(pad) } };
      }
    }
    const baseContent = mode === 'append' ? String(pad.content || '') : '';
    const needsNewline = mode === 'append'
      && baseContent.length > 0
      && !baseContent.endsWith('\n')
      && !payload.content.startsWith('\n');
    const nextContent = needsNewline ? `${baseContent}\n${payload.content}` : `${baseContent}${payload.content}`;
    assertMaxUtf8Bytes(nextContent, MAX_PAD_BYTES, 'Scratchpad content');
    pad.content = nextContent;
    if (mode !== 'append' && requestedTitle && !payload.matchByTitle) {
      pad.title = requestedTitle;
    }
    pad.updatedAt = ts;
    return { nextState, result: { pad: structuredClone(pad) } };
  }

  if (action === 'pad-delete') {
    const targetPad = nextState.scratchpads.find((p) => p.id === payload.id);
    if (!targetPad) {
      throw new Error(`Scratchpad not found: ${String(payload.id || '')}`);
    }
    nextState.scratchpads = nextState.scratchpads.filter((p) => p.id !== targetPad.id);
    const remainingInScope = listScratchpadsForScope(nextState, {
      scope: targetPad.scope,
      workspacePath: targetPad.workspacePath,
    });
    if (remainingInScope.length === 0) {
      const replacement = createDefaultPad(
        {
          scope: targetPad.scope,
          workspacePath: targetPad.workspacePath,
          workspaceName: targetPad.workspaceName || (targetPad.scope === 'global' ? 'Global' : ''),
        },
        ts,
        'Scratchpad',
        ''
      );
      nextState.scratchpads.push(replacement);
      return {
        nextState,
        result: {
          deletedId: targetPad.id,
          replacementPad: structuredClone(replacement),
          activePadId: replacement.id,
        },
      };
    }
    return {
      nextState,
      result: { deletedId: targetPad.id, replacementPad: null, activePadId: remainingInScope[0].id },
    };
  }

  if (action === 'settings-update') {
    const nextSettings = { ...nextState.settings };
    for (const [key, allowedSet] of ENUM_SETTING_RULES) {
      if (payload[key] !== undefined) {
        assertEnum(payload[key], allowedSet, key);
        nextSettings[key] = payload[key];
      }
    }
    if (payload.workbenchSplitRatio !== undefined) {
      if (typeof payload.workbenchSplitRatio !== 'number' || !Number.isFinite(payload.workbenchSplitRatio)) {
        throw new Error('workbenchSplitRatio must be a finite number.');
      }
      nextSettings.workbenchSplitRatio = Math.min(
        MAX_SPLIT_RATIO,
        Math.max(MIN_SPLIT_RATIO, payload.workbenchSplitRatio)
      );
    }
    for (const key of BOOLEAN_SETTING_KEYS) {
      if (payload[key] !== undefined) {
        if (typeof payload[key] !== 'boolean') {
          throw new Error(`${key} must be a boolean.`);
        }
        nextSettings[key] = payload[key];
      }
    }
    nextState.settings = nextSettings;
    return { nextState, result: { settings: structuredClone(nextSettings) } };
  }

  throw new Error(`Unknown notes action: ${String(action)}`);
}

export function createStoreMutators(getSync, onSettingsChanged) {
  let mutationQueue = Promise.resolve();
  const enqueueMutation = (fn) => {
    const run = mutationQueue.then(fn);
    const settleTicks = async () => {
      await Promise.resolve();
      await Promise.resolve();
    };
    mutationQueue = run.then(settleTicks, settleTicks);
    return run;
  };

  const mutators = {};
  for (const action of NOTES_ACTION_NAMES) {
    mutators[action] = (payload = {}) => enqueueMutation(async () => {
      const sync = typeof getSync === 'function' ? getSync() : null;
      if (!sync) {
        throw new Error('StateSync instance is not available.');
      }
      const prevState = typeof sync.refresh === 'function' ? sync.refresh() : sync.getState();
      const prevSettings = structuredClone(normalizeState(prevState).settings);
      const { nextState, result } = applyNotesAction(prevState, action, payload);
      if (typeof sync.mutate === 'function') {
        sync.mutate(nextState, { replace: true });
      } else if (typeof sync.setState === 'function') {
        sync.setState(nextState);
      }
      if (action === 'settings-update' && typeof onSettingsChanged === 'function') {
        await onSettingsChanged(structuredClone(nextState.settings), prevSettings);
      }
      return result;
    });
  }
  return mutators;
}
