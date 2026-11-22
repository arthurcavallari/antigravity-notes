/**
 * @fileoverview Active workspace and conversation title resolver backed by a 3s Language Server RPC cache.
 */

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { GLOBAL_CONFIG_DIR, readJsonSafe } from 'antigravity-sidecar-kit/config';
import { createLsRpcCache } from 'antigravity-sidecar-kit/rpc';
import {
  NEW_CONVERSATION_ID,
  extractWorkspaceName,
  isRealConversationId,
  normalizeWorkspacePath,
  resolveActiveWorkspace,
} from 'antigravity-sidecar-kit/workspace';
import { SIDECAR_ID } from './constants.mjs';

export const TRAJECTORIES_RPC_METHOD = 'GetAllCascadeTrajectories';
export const TRAJECTORIES_CACHE_TTL_MS = 3_000;
const SYNTHETIC_PROJECT_IDS = new Set(['outside-of-project', 'default-cli-project']);

function isPlainObject(val) {
  return Boolean(val) && typeof val === 'object' && !Array.isArray(val);
}

function sanitizeRawWorkspaceUri(raw) {
  if (typeof raw !== 'string' || !raw.trim()) {
    return '';
  }
  return raw.trim().replace(/%3a/gi, ':');
}

function cleanWorkspacePath(raw) {
  const preDecoded = sanitizeRawWorkspaceUri(raw);
  if (!preDecoded) {
    return '';
  }
  return normalizeWorkspacePath(preDecoded);
}

function repairActiveWorkspacePath(normalizedPath) {
  if (typeof normalizedPath !== 'string' || !normalizedPath) {
    return '';
  }
  const repaired = normalizedPath.replace(/^\/([A-Za-z])%3a/i, '$1:');
  if (/^[A-Z]:/.test(repaired)) {
    return repaired[0].toLowerCase() + repaired.slice(1);
  }
  return repaired;
}

function dedupeNormalizedPaths(paths) {
  const seen = new Set();
  const result = [];
  for (const entry of paths) {
    if (typeof entry !== 'string' || !entry) {
      continue;
    }
    const key = entry.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      result.push(entry);
    }
  }
  return result;
}

function normalizeWorkspaceList(rawList) {
  if (!Array.isArray(rawList)) {
    return [];
  }
  const normalized = [];
  for (const item of rawList) {
    const clean = cleanWorkspacePath(item);
    if (clean) {
      normalized.push(clean);
    }
  }
  return dedupeNormalizedPaths(normalized);
}

function extractSummaryMap(trajectoriesResponse) {
  if (!isPlainObject(trajectoriesResponse)) {
    return {};
  }
  if (isPlainObject(trajectoriesResponse.trajectorySummaries)) {
    return trajectoriesResponse.trajectorySummaries;
  }
  if (isPlainObject(trajectoriesResponse.updates)) {
    return trajectoriesResponse.updates;
  }
  return {};
}

function getOwnSummary(summaries, id) {
  if (!isPlainObject(summaries) || !id || !Object.hasOwn(summaries, id)) {
    return null;
  }
  const entry = summaries[id];
  return isPlainObject(entry) ? entry : null;
}

function collectWorkspaceObjects(wsList, target) {
  if (!Array.isArray(wsList)) {
    return;
  }
  for (const ws of wsList) {
    if (typeof ws === 'string') {
      target.push(ws);
    } else if (isPlainObject(ws)) {
      const uri = ws.workspaceFolderAbsoluteUri || ws.gitRootAbsoluteUri;
      if (typeof uri === 'string') {
        target.push(uri);
      }
    }
  }
}

function extractTrajectoryWorkspacePaths(summary) {
  if (!isPlainObject(summary)) {
    return [];
  }
  const rawUris = [];
  collectWorkspaceObjects(summary.workspaces, rawUris);
  const meta = isPlainObject(summary.trajectoryMetadata) ? summary.trajectoryMetadata : null;
  if (meta) {
    collectWorkspaceObjects(meta.workspaces, rawUris);
    if (Array.isArray(meta.workspaceUris)) {
      rawUris.push(...meta.workspaceUris);
    }
  }
  return normalizeWorkspaceList(rawUris);
}

export function extractConversationTitle(summary) {
  if (!isPlainObject(summary)) {
    return '';
  }
  const annotations = isPlainObject(summary.annotations) ? summary.annotations : null;
  const meta = isPlainObject(summary.trajectoryMetadata) ? summary.trajectoryMetadata : null;
  const candidates = [
    annotations?.title,
    summary.title,
    summary.summary,
    meta?.title,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string') {
      const cleaned = candidate.replace(/\s+/g, ' ').trim();
      if (cleaned) {
        return cleaned;
      }
    }
  }
  return '';
}

function extractSummaryProjectId(summary) {
  if (!isPlainObject(summary)) {
    return '';
  }
  const meta = isPlainObject(summary.trajectoryMetadata) ? summary.trajectoryMetadata : null;
  const raw = typeof meta?.projectId === 'string' && meta.projectId.trim()
    ? meta.projectId.trim()
    : typeof summary.projectId === 'string'
      ? summary.projectId.trim()
      : '';
  if (!raw || SYNTHETIC_PROJECT_IDS.has(raw.toLowerCase())) {
    return '';
  }
  return raw;
}

function collectResourcePathKeys(resources, targetSet) {
  if (!Array.isArray(resources)) {
    return;
  }
  for (const res of resources) {
    if (!isPlainObject(res)) {
      continue;
    }
    const rawUri = res.gitFolder?.folderUri || res.folder?.folderUri || res.folderUri || '';
    const clean = cleanWorkspacePath(rawUri);
    if (clean) {
      targetSet.add(clean.toLowerCase());
    }
  }
}

function loadProjectsList(projectsDir) {
  if (!projectsDir || !existsSync(projectsDir)) {
    return [];
  }
  let entries = [];
  try {
    entries = readdirSync(projectsDir);
  } catch {
    return [];
  }
  const parsed = [];
  for (const file of entries) {
    if (!file.endsWith('.json')) {
      continue;
    }
    const data = readJsonSafe(join(projectsDir, file));
    if (!isPlainObject(data)) {
      continue;
    }
    const id = typeof data.id === 'string' ? data.id.trim() : '';
    const name = typeof data.name === 'string' ? data.name.trim() : '';
    if (!id || !name || SYNTHETIC_PROJECT_IDS.has(id.toLowerCase())) {
      continue;
    }
    const rootKeys = new Set();
    const envKeys = new Set();
    collectResourcePathKeys(data.projectResources?.resources, rootKeys);
    if (Array.isArray(data.environments?.environments)) {
      for (const envEntry of data.environments.environments) {
        collectResourcePathKeys(envEntry?.resources?.resources, envKeys);
      }
    }
    parsed.push({ id, name, rootKeys, envKeys });
  }
  return parsed;
}

function matchProjectMetadata(projects, { projectId = '', allWorkspacePaths = [], workspaceName = '' }) {
  if (projectId) {
    const byId = projects.find((p) => p.id === projectId);
    if (byId) {
      return { projectId: byId.id, projectName: byId.name };
    }
  }
  const activeKeys = new Set(allWorkspacePaths.map((p) => String(p || '').toLowerCase()).filter(Boolean));
  if (activeKeys.size > 0) {
    const exactMatch = projects.find(
      (p) => p.rootKeys.size === activeKeys.size && [...activeKeys].every((k) => p.rootKeys.has(k))
    );
    if (exactMatch) {
      return { projectId: exactMatch.id, projectName: exactMatch.name };
    }
    const envMatch = projects.find(
      (p) => [...activeKeys].some((k) => p.envKeys.has(k)) && [...activeKeys].every((k) => p.envKeys.has(k) || p.rootKeys.has(k))
    );
    if (envMatch) {
      return { projectId: envMatch.id, projectName: envMatch.name };
    }
    const supersets = projects
      .filter((p) => p.rootKeys.size > activeKeys.size && [...activeKeys].every((k) => p.rootKeys.has(k)))
      .sort((a, b) => a.rootKeys.size - b.rootKeys.size);
    if (supersets.length > 0) {
      return { projectId: supersets[0].id, projectName: supersets[0].name };
    }
  }
  const fallbackName = workspaceName && workspaceName !== 'Global' ? workspaceName : '';
  return { projectId: '', projectName: fallbackName };
}

export function createContextResolver(rawOptions = {}) {
  const options = isPlainObject(rawOptions) ? rawOptions : {};
  const nowFn = typeof options.now === 'function' ? options.now : Date.now;
  const customRpcFn = typeof options.callLsRpcFn === 'function'
    ? options.callLsRpcFn
    : typeof options.callRpc === 'function'
      ? options.callRpc
      : null;
  const projectsDir = options.projectsDir !== undefined
    ? String(options.projectsDir || '')
    : customRpcFn || options.rpcCache
      ? ''
      : join(GLOBAL_CONFIG_DIR, 'projects');
  let cachedProjects = null;
  let cachedProjectsAt = 0;

  function getProjectsCached() {
    if (!projectsDir) {
      return [];
    }
    const ts = nowFn();
    if (!cachedProjects || ts - cachedProjectsAt >= TRAJECTORIES_CACHE_TTL_MS) {
      cachedProjects = loadProjectsList(projectsDir);
      cachedProjectsAt = ts;
    }
    return cachedProjects;
  }

  const cache = options.rpcCache || createLsRpcCache({
    ttlMs: { [TRAJECTORIES_RPC_METHOD]: TRAJECTORIES_CACHE_TTL_MS },
    ...(customRpcFn
      ? {
          rpcFn: async (method, body, rpcOpts) => {
            const res = await customRpcFn(method, body, rpcOpts);
            if (!isPlainObject(res) || res.ok === false) {
              throw new Error('Invalid or failed Language Server trajectories response.');
            }
            return res;
          },
        }
      : {}),
    ...(typeof options.now === 'function' ? { now: options.now } : {}),
  });

  function invalidate() {
    cachedProjects = null;
    cachedProjectsAt = 0;
    if (typeof cache?.invalidate === 'function') {
      cache.invalidate(TRAJECTORIES_RPC_METHOD);
    }
  }

  async function fetchTrajectoriesSafe() {
    try {
      const res = await cache.call(TRAJECTORIES_RPC_METHOD, {}, { sidecarId: SIDECAR_ID });
      if (!isPlainObject(res) || res.ok === false) {
        invalidate();
        return { trajectorySummaries: {} };
      }
      return res;
    } catch {
      return { trajectorySummaries: {} };
    }
  }

  async function resolveContext(rawInput = {}) {
    const input = isPlainObject(rawInput) ? rawInput : {};
    const rawConversationId = typeof input.conversationId === 'string'
      ? input.conversationId.trim()
      : '';
    const isNewConversation = rawConversationId === NEW_CONVERSATION_ID;
    const hasRealConversation = isRealConversationId(rawConversationId);
    const rawUris = Array.isArray(input.workspaceUris) ? input.workspaceUris : [];
    const sanitizedClientUris = rawUris.map(sanitizeRawWorkspaceUri).filter(Boolean);
    const clientPaths = normalizeWorkspaceList(rawUris);

    if (isNewConversation) {
      const active = resolveActiveWorkspace({
        clientWorkspaceUris: sanitizedClientUris,
        trajectoriesResponse: { trajectorySummaries: {} },
        requestedConversationId: NEW_CONVERSATION_ID,
      });
      const workspacePath = repairActiveWorkspacePath(active.workspacePath) || clientPaths[0] || '';
      const workspaceName = workspacePath ? extractWorkspaceName(workspacePath) : 'Global';
      const allWorkspacePaths = dedupeNormalizedPaths([workspacePath, ...clientPaths]);
      const proj = matchProjectMetadata(getProjectsCached(), { allWorkspacePaths, workspaceName });
      return {
        workspacePath,
        workspaceName,
        projectId: proj.projectId,
        projectName: proj.projectName,
        allWorkspacePaths,
        conversationId: '',
        conversationTitle: '',
        isNewConversation: true,
        source: active.source,
      };
    }

    const trajectoriesResponse = await fetchTrajectoriesSafe();
    const summaries = extractSummaryMap(trajectoriesResponse);
    const active = resolveActiveWorkspace({
      clientWorkspaceUris: sanitizedClientUris,
      trajectoriesResponse: { trajectorySummaries: summaries },
      requestedConversationId: hasRealConversation ? rawConversationId : '',
    });

    if (hasRealConversation) {
      const summary = getOwnSummary(summaries, rawConversationId);
      const trajPaths = extractTrajectoryWorkspacePaths(summary);
      const workspacePath = repairActiveWorkspacePath(active.workspacePath)
        || trajPaths[0]
        || clientPaths[0]
        || '';
      const workspaceName = workspacePath ? extractWorkspaceName(workspacePath) : 'Global';
      const allWorkspacePaths = dedupeNormalizedPaths([
        workspacePath,
        ...trajPaths,
        ...clientPaths,
      ]);
      const proj = matchProjectMetadata(getProjectsCached(), {
        projectId: extractSummaryProjectId(summary),
        allWorkspacePaths,
        workspaceName,
      });
      return {
        workspacePath,
        workspaceName,
        projectId: proj.projectId,
        projectName: proj.projectName,
        allWorkspacePaths,
        conversationId: rawConversationId,
        conversationTitle: extractConversationTitle(summary),
        isNewConversation: false,
        source: active.source,
      };
    }

    const guessedSummary = isRealConversationId(active.conversationId)
      ? getOwnSummary(summaries, active.conversationId)
      : null;
    const guessedTrajPaths = clientPaths.length === 0
      ? extractTrajectoryWorkspacePaths(guessedSummary)
      : [];
    const workspacePath = repairActiveWorkspacePath(active.workspacePath)
      || guessedTrajPaths[0]
      || clientPaths[0]
      || '';
    const workspaceName = workspacePath ? extractWorkspaceName(workspacePath) : 'Global';
    const allWorkspacePaths = dedupeNormalizedPaths([
      workspacePath,
      ...guessedTrajPaths,
      ...clientPaths,
    ]);
    const proj = matchProjectMetadata(getProjectsCached(), {
      projectId: clientPaths.length === 0 ? extractSummaryProjectId(guessedSummary) : '',
      allWorkspacePaths,
      workspaceName,
    });

    return {
      workspacePath,
      workspaceName,
      projectId: proj.projectId,
      projectName: proj.projectName,
      allWorkspacePaths,
      conversationId: '',
      conversationTitle: '',
      isNewConversation: false,
      source: active.source,
    };
  }

  async function lookupConversationTitle(conversationId) {
    const id = typeof conversationId === 'string' ? conversationId.trim() : '';
    if (!isRealConversationId(id)) {
      return '';
    }
    const trajectoriesResponse = await fetchTrajectoriesSafe();
    const summaries = extractSummaryMap(trajectoriesResponse);
    const summary = getOwnSummary(summaries, id);
    return extractConversationTitle(summary);
  }

  return {
    resolveContext,
    lookupConversationTitle,
    invalidate,
  };
}

let defaultResolver = null;

export function lookupConversationTitle(conversationId) {
  if (!defaultResolver) {
    defaultResolver = createContextResolver();
  }
  return defaultResolver.lookupConversationTitle(conversationId);
}
