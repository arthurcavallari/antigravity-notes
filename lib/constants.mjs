/**
 * @fileoverview Core constants, bounds, Onyx color palette definitions, and initial state factory for Antigravity Notes.
 */

import { realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveSidecarDataRoot } from 'antigravity-sidecar-kit/config';

const MODULE_DIR = realpathSync(dirname(fileURLToPath(import.meta.url)));

export const SIDECAR_ID = 'notes';
export const SIDECAR_TITLE = 'Notes';
export const DEFAULT_PORT = 52325;

export const REPO_ROOT = process.env.SIDECAR_REPO_ROOT
  ? resolve(process.env.SIDECAR_REPO_ROOT)
  : resolve(MODULE_DIR, '..');

export const UI_DIR = join(REPO_ROOT, 'ui');

export const SCHEMA_VERSION = 1;
export const MAX_CARD_BYTES = 262_144;
export const MAX_PAD_BYTES = 1_048_576;
export const MAX_SENT_CARDS = 300;

export const MIN_SPLIT_RATIO = 0.26;
export const MAX_SPLIT_RATIO = 0.72;
export const DEFAULT_SPLIT_RATIO = 0.44;

export const PALETTE_COLOR_IDS = Object.freeze([
  'rose',
  'amber',
  'emerald',
  'blue',
  'violet',
  'cyan',
]);

export const VALID_CARD_COLORS = new Set(['auto', 'none', ...PALETTE_COLOR_IDS]);
export const VALID_TAG_COLORS = new Set(['none', ...PALETTE_COLOR_IDS]);
export const VALID_COLOR_STYLES = new Set(['wash', 'stripe', 'bold']);
export const VALID_ENTER_BEHAVIORS = new Set(['stash', 'newline']);
export const VALID_STASH_LAYOUTS = new Set(['grid', 'list']);
export const VALID_WORKBENCH_MODES = new Set(['split', 'stash', 'scratchpad']);

const KEYWORD_TAG_COLORS = Object.freeze({
  bug: 'rose',
  fix: 'rose',
  urgent: 'rose',
  hotfix: 'rose',
  warn: 'amber',
  blocked: 'amber',
  perf: 'amber',
  done: 'emerald',
  ready: 'emerald',
  ship: 'emerald',
  later: 'blue',
  todo: 'blue',
  idea: 'violet',
  design: 'violet',
  ux: 'violet',
  mcp: 'cyan',
  api: 'cyan',
});

export function resolveNotesDataDir(env = process.env) {
  const explicitDir = env?.ANTIGRAVITY_NOTES_DATA_DIR
    ? String(env.ANTIGRAVITY_NOTES_DATA_DIR).trim()
    : '';
  if (explicitDir) {
    return resolve(explicitDir);
  }
  const sidecarDataRoot = resolveSidecarDataRoot(env);
  return join(sidecarDataRoot, SIDECAR_ID, 'data');
}

export function inferDefaultTagColor(tag) {
  const clean = String(tag || '')
    .trim()
    .replace(/^#+/, '')
    .toLowerCase();
  if (Object.hasOwn(KEYWORD_TAG_COLORS, clean)) {
    return KEYWORD_TAG_COLORS[clean];
  }
  let hash = 0;
  for (let i = 0; i < clean.length; i++) {
    hash = ((hash << 5) - hash + clean.charCodeAt(i)) | 0;
  }
  const index = Math.abs(hash) % PALETTE_COLOR_IDS.length;
  return PALETTE_COLOR_IDS[index];
}

export function createInitialState() {
  return {
    schemaVersion: SCHEMA_VERSION,
    settings: {
      enterBehavior: 'stash',
      cardColorStyle: 'wash',
      stashLayout: 'grid',
      workbenchMode: 'split',
      workbenchSplitRatio: DEFAULT_SPLIT_RATIO,
      mcpRead: false,
      mcpWrite: false,
    },
    tagColors: {},
    cards: [],
    scratchpads: [],
  };
}
