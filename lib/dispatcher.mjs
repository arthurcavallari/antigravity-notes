/**
 * @fileoverview Truncation-free, dedup-free agentapi prompt dispatcher with leading-hyphen flag protection and projectId caching.
 */

import { runAgentApiAsync, sanitizeConversationId } from 'antigravity-sidecar-kit/state-sync';
import { MAX_PAD_BYTES } from './constants.mjs';
import { lookupConversationTitle as defaultLookupConversationTitle } from './context-resolver.mjs';

export const MAX_DISPATCH_BYTES = MAX_PAD_BYTES;
const MAX_TITLE_CHARS = 200;
const MAX_DERIVED_TITLE_CHARS = 60;
const MAX_PROJECT_CACHE_SIZE = 256;
const VALID_DISPATCH_MODES = new Set(['active', 'new']);
const UUID_RE = /\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i;
const CODE_FENCE_LINE_RE = /^(?:`{3,}|~{3,})[^`~]*$/;

function isPlainObject(val) {
  return Boolean(val) && typeof val === 'object' && !Array.isArray(val);
}

function createDispatchError(message, statusCode) {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.status = statusCode;
  if (statusCode >= 400 && statusCode < 500) {
    err.clientMessage = message;
  }
  return err;
}

function truncateCodePoints(str, maxCodePoints, suffix = '') {
  const codePoints = [...str];
  if (codePoints.length <= maxCodePoints) {
    return str;
  }
  let sliced = codePoints.slice(0, maxCodePoints).join('').trimEnd();
  while (sliced.endsWith('\u2026')) {
    sliced = sliced.slice(0, -1);
  }
  return `${sliced}${suffix}`;
}

function readSafeEnvString(env, key, { forbidLeadingDash = false } = {}) {
  if (!isPlainObject(env) || !Object.hasOwn(env, key) || typeof env[key] !== 'string') {
    return '';
  }
  const trimmed = env[key].trim();
  return !trimmed || trimmed.includes('\0') || (forbidLeadingDash && trimmed.startsWith('-')) ? '' : trimmed;
}

function validateOptionalString(raw, fieldName, { forbidLeadingDash = false } = {}) {
  if (raw === undefined || raw === null) {
    return '';
  }
  if (typeof raw !== 'string') {
    throw createDispatchError(`${fieldName} must be a string.`, 400);
  }
  if (raw.includes('\0')) {
    throw createDispatchError(`${fieldName} must not contain NUL bytes.`, 400);
  }
  const trimmed = raw.trim();
  if (forbidLeadingDash && trimmed.startsWith('-')) {
    throw createDispatchError(`Invalid ${fieldName}.`, 400);
  }
  return trimmed;
}

function cleanSingleLineTitle(raw) {
  const collapsed = typeof raw === 'string'
    ? raw.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()
    : '';
  return collapsed ? truncateCodePoints(collapsed, MAX_TITLE_CHARS) : '';
}

function deriveShortTitle(text) {
  const nonEmptyLines = String(text || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const firstLine = nonEmptyLines.find((line) => !CODE_FENCE_LINE_RE.test(line)) || nonEmptyLines[0] || '';
  if (!firstLine) {
    return 'New Conversation';
  }
  const stripped = firstLine
    .replace(/^(?:#{1,6}\s+|[-*+]\s+\[[ xX]\]\s+|[-*+]\s+|\d+\.\s+|>\s+)/, '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const candidate = stripped || firstLine.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return truncateCodePoints(candidate, MAX_DERIVED_TITLE_CHARS, '\u2026');
}

function getNestedConversationNode(resp) {
  if (!isPlainObject(resp)) {
    return null;
  }
  for (const key of ['newConversation', 'new_conversation', 'conversation', 'conversationMetadata', 'conversation_metadata']) {
    if (Object.hasOwn(resp, key) && isPlainObject(resp[key])) {
      return resp[key];
    }
  }
  return null;
}

function extractProjectIdFromMetadata(raw) {
  if (!isPlainObject(raw) || raw.error || raw.ok === false) {
    return '';
  }
  const resp = isPlainObject(raw.response) ? raw.response : raw;
  const convMeta = getNestedConversationNode(resp) || resp;
  const meta = isPlainObject(convMeta.metadata) ? convMeta.metadata : convMeta;
  const candidate = meta.projectId ?? meta.project_id ?? resp.projectId ?? resp.project_id ?? raw.projectId ?? raw.project_id;
  const trimmed = typeof candidate === 'string' ? candidate.trim() : '';
  return !trimmed || trimmed.startsWith('-') || trimmed.includes('\0') ? '' : trimmed;
}

function extractCreatedConversationId(raw) {
  if (!isPlainObject(raw)) {
    return '';
  }
  const resp = isPlainObject(raw.response) ? raw.response : isPlainObject(raw.result) ? raw.result : null;
  const scopes = [getNestedConversationNode(resp), resp, raw].filter(isPlainObject);
  for (const field of ['conversationId', 'conversation_id', 'cascadeId', 'cascade_id', 'id']) {
    for (const scope of scopes) {
      const clean = Object.hasOwn(scope, field) ? sanitizeConversationId(scope[field]) : null;
      if (clean) {
        return clean;
      }
    }
  }
  if (typeof raw.raw === 'string' && raw.raw.trim()) {
    const uuidMatch = raw.raw.match(UUID_RE);
    return sanitizeConversationId(raw.raw) || (uuidMatch ? sanitizeConversationId(uuidMatch[1]) || '' : '');
  }
  return '';
}

function extractResponseTitle(raw) {
  if (!isPlainObject(raw)) {
    return '';
  }
  const resp = isPlainObject(raw.response) ? raw.response : null;
  const nested = getNestedConversationNode(resp);
  for (const item of [raw.title, resp?.title, nested?.title]) {
    const clean = cleanSingleLineTitle(item);
    if (clean) {
      return clean;
    }
  }
  return '';
}

function extractUpstreamFailureMessage(res) {
  if (!isPlainObject(res)) {
    return 'Empty or invalid response from agentapi.';
  }
  if (res.error) {
    if (typeof res.error === 'string' && res.error.trim()) {
      return res.error.trim();
    }
    const nestedMsg = isPlainObject(res.error) && typeof res.error.message === 'string' ? res.error.message.trim() : '';
    return nestedMsg || String(res.error);
  }
  if (res.ok === false) {
    return typeof res.message === 'string' && res.message.trim() ? res.message.trim() : 'agentapi dispatch returned ok: false.';
  }
  if (typeof res.exitCode === 'number' && res.exitCode !== 0) {
    return typeof res.raw === 'string' && res.raw.trim() ? res.raw.trim() : `agentapi exited with code ${res.exitCode}.`;
  }
  if (typeof res.code === 'number' && res.code !== 0) {
    return `agentapi exited with code ${res.code}.`;
  }
  return '';
}

export function createDispatcher(rawOptions = {}) {
  const options = isPlainObject(rawOptions) ? rawOptions : {};
  const agentApiFn = typeof options.agentApiFn === 'function' ? options.agentApiFn : runAgentApiAsync;
  const lookupTitleFn = options.lookupConversationTitle === undefined
    ? defaultLookupConversationTitle
    : options.lookupConversationTitle;
  const hasExplicitEnv = isPlainObject(options.env);
  const envObj = hasExplicitEnv ? options.env : process.env;
  const projectIdCache = new Map();
  const inflightProjectLookups = new Map();

  function getBaseAgentOpts() {
    const exePath = hasExplicitEnv
      ? readSafeEnvString(envObj, 'ANTIGRAVITY_AGENTAPI_EXE', { forbidLeadingDash: true })
      : '';
    return exePath ? { exePath } : {};
  }

  function rememberProjectId(convId, projectId) {
    if (!convId || !projectId) {
      return;
    }
    if (projectIdCache.has(convId)) {
      projectIdCache.delete(convId);
    } else if (projectIdCache.size >= MAX_PROJECT_CACHE_SIZE) {
      const oldestKey = projectIdCache.keys().next().value;
      if (oldestKey !== undefined) {
        projectIdCache.delete(oldestKey);
      }
    }
    projectIdCache.set(convId, projectId);
  }

  function fetchAndCacheProjectId(convId) {
    if (inflightProjectLookups.has(convId)) {
      return inflightProjectLookups.get(convId);
    }
    const lookupPromise = Promise.resolve()
      .then(() => agentApiFn(['get-conversation-metadata', convId], getBaseAgentOpts()))
      .then((metaRes) => {
        const extracted = extractProjectIdFromMetadata(metaRes);
        if (extracted) {
          rememberProjectId(convId, extracted);
        }
        return extracted;
      })
      .catch(() => '')
      .finally(() => {
        inflightProjectLookups.delete(convId);
      });
    inflightProjectLookups.set(convId, lookupPromise);
    return lookupPromise;
  }

  async function invokeAgentApiStrict(args, opts) {
    let res;
    try {
      res = await agentApiFn(args, opts);
    } catch (err) {
      throw createDispatchError(err?.message || String(err), 502);
    }
    const failureMsg = extractUpstreamFailureMessage(res);
    if (failureMsg) {
      throw createDispatchError(failureMsg, 502);
    }
    return res;
  }

  async function safeLookupConversationTitle(convId) {
    if (!convId || typeof lookupTitleFn !== 'function') {
      return '';
    }
    try {
      return cleanSingleLineTitle(await lookupTitleFn(convId));
    } catch {
      return '';
    }
  }

  async function sendWithProjectRetry(cleanConvId, sendArgs, explicitProjectId, envProjectId, baseOpts) {
    let usedCachedProjectId = false;
    let activeProjectId = explicitProjectId;
    if (!activeProjectId) {
      if (projectIdCache.has(cleanConvId)) {
        activeProjectId = projectIdCache.get(cleanConvId);
        rememberProjectId(cleanConvId, activeProjectId);
        usedCachedProjectId = true;
      } else {
        activeProjectId = (await fetchAndCacheProjectId(cleanConvId)) || envProjectId;
      }
    }

    try {
      await invokeAgentApiStrict(sendArgs, { ...baseOpts, projectId: activeProjectId });
    } catch (firstErr) {
      if (projectIdCache.get(cleanConvId) === activeProjectId) {
        projectIdCache.delete(cleanConvId);
      }
      if (!usedCachedProjectId) {
        throw firstErr;
      }
      const refreshed = projectIdCache.get(cleanConvId) || (await fetchAndCacheProjectId(cleanConvId)) || envProjectId;
      if (refreshed === activeProjectId) {
        throw firstErr;
      }
      try {
        await invokeAgentApiStrict(sendArgs, { ...baseOpts, projectId: refreshed });
      } catch (retryErr) {
        if (projectIdCache.get(cleanConvId) === refreshed) {
          projectIdCache.delete(cleanConvId);
        }
        throw retryErr;
      }
    }
  }

  async function dispatchPrompt(rawReq) {
    if (!isPlainObject(rawReq)) {
      throw createDispatchError('Dispatch request must be a JSON object.', 400);
    }
    if (typeof rawReq.text !== 'string' || !rawReq.text.trim()) {
      throw createDispatchError('Prompt text must be a non-empty string.', 400);
    }
    if (rawReq.text.includes('\0')) {
      throw createDispatchError('Prompt text must not contain NUL bytes.', 400);
    }
    const byteLength = Buffer.byteLength(rawReq.text, 'utf8');
    if (byteLength > MAX_DISPATCH_BYTES) {
      throw createDispatchError(`Prompt text exceeds maximum size of ${MAX_DISPATCH_BYTES} bytes (got ${byteLength} bytes).`, 400);
    }

    const requestedMode = rawReq.mode === undefined || rawReq.mode === null ? 'active' : rawReq.mode;
    if (typeof requestedMode !== 'string' || !VALID_DISPATCH_MODES.has(requestedMode)) {
      throw createDispatchError(`Invalid dispatch mode "${String(requestedMode)}".`, 400);
    }

    validateOptionalString(rawReq.title, 'title');
    const cleanTitle = cleanSingleLineTitle(rawReq.title);
    const titleHint = cleanSingleLineTitle(validateOptionalString(rawReq.conversationTitle, 'conversationTitle'));
    const explicitWorkspace = validateOptionalString(rawReq.workspacePath ?? rawReq.workspace ?? rawReq.cwd, 'workspacePath', { forbidLeadingDash: true });
    const explicitProjectId = validateOptionalString(rawReq.projectId, 'projectId', { forbidLeadingDash: true });

    const cleanConvId = requestedMode === 'active' ? sanitizeConversationId(rawReq.conversationId ?? rawReq.conversation_id ?? '') : null;
    const effectiveMode = requestedMode === 'active' && cleanConvId ? 'active' : 'new';
    const flagArgs = cleanTitle ? [`--title=${cleanTitle}`] : [];
    const envProjectId = readSafeEnvString(envObj, 'ANTIGRAVITY_PROJECT_ID', { forbidLeadingDash: true });
    const baseOpts = getBaseAgentOpts();

    if (effectiveMode === 'active') {
      const sendArgs = ['send-message', ...flagArgs, '--', cleanConvId, rawReq.text];
      await sendWithProjectRetry(cleanConvId, sendArgs, explicitProjectId, envProjectId, baseOpts);
      const resolvedTitle = cleanTitle || titleHint || (await safeLookupConversationTitle(cleanConvId)) || '';
      return { ok: true, mode: 'active', conversationId: cleanConvId, conversationTitle: resolvedTitle };
    }

    const resolvedWorkspace = explicitWorkspace || readSafeEnvString(envObj, 'ANTIGRAVITY_WORKSPACE', { forbidLeadingDash: true });
    const startArgs = ['new-conversation', ...flagArgs, '--', rawReq.text];
    const startOpts = {
      ...baseOpts,
      projectId: explicitProjectId || envProjectId,
      ...(resolvedWorkspace ? { workspace: resolvedWorkspace } : {}),
    };
    const startRes = await invokeAgentApiStrict(startArgs, startOpts);
    const createdConvId = extractCreatedConversationId(startRes);
    const resolvedNewTitle = cleanTitle
      || extractResponseTitle(startRes)
      || (createdConvId ? await safeLookupConversationTitle(createdConvId) : '')
      || deriveShortTitle(rawReq.text);

    return { ok: true, mode: 'new', conversationId: createdConvId, conversationTitle: resolvedNewTitle };
  }

  return { dispatchPrompt };
}
