/**
 * @fileoverview Zero-dependency XSS-safe Markdown renderer, colored #tag card formatter, and smart editor helpers.
 */

const PALETTE_COLOR_IDS = Object.freeze(['rose', 'amber', 'emerald', 'blue', 'violet', 'cyan']);
const PALETTE_SET = new Set(PALETTE_COLOR_IDS);
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const KEYWORD_TAG_COLORS = Object.freeze({
  bug: 'rose', fix: 'rose', urgent: 'rose', hotfix: 'rose',
  warn: 'amber', blocked: 'amber', perf: 'amber',
  done: 'emerald', ready: 'emerald', ship: 'emerald',
  later: 'blue', todo: 'blue',
  idea: 'violet', design: 'violet', ux: 'violet',
  mcp: 'cyan', api: 'cyan',
});
const HTML_ESCAPE_MAP = Object.freeze({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' });

const FENCE_OPEN_RE = /^[ ]{0,3}(`{3,}|~{3,})(.*)$/;
const HR_LINE_RE = /^[ ]{0,3}(?:-\s*-\s*-[-\s]*|\*\s*\*\s*\*[\*\s]*|_\s*_\s*_[_\s]*)$/;
const HEADING_LINE_RE = /^[ ]{0,3}(#{1,6})[ \t]+(.*)$/;
const BLOCKQUOTE_LINE_RE = /^[ ]{0,3}>\s?(.*)$/;
const TASK_ITEM_RE = /^([ \t]*)(?:([-*+])|(\d+|[a-zA-Z]{1,6})\.)[ \t]+\[( |x|X)\](?:[ \t]+(.*)|$)$/;
const UL_ITEM_RE = /^([ \t]*)[-*+][ \t]+(.*)$/;
const OL_ITEM_RE = /^([ \t]*)(\d+|[a-zA-Z]{1,6})\.[ \t]+(.*)$/;
const ORDERED_EDIT_LINE_RE = /^([ \t]*)(\d+|[a-zA-Z]{1,6})(\.(?:[ \t]+\[[ xX]\])?[ \t]+.*)$/;
const LIST_LINE_QUICK_RE = /^[ \t]*(?:[-*+]|(?:\d+|[a-zA-Z]{1,6})\.)(?:[ \t]+\[[ xX]\])?[ \t]/;
const ORDERED_KIND_CYCLE = Object.freeze(['digit', 'alpha', 'roman']);
const ROMAN_STRICT_RE = /^(?=[mdclxvi]+$)m{0,3}(?:cm|cd|d?c{0,3})(?:xc|xl|l?x{0,3})(?:ix|iv|v?i{0,3})$/i;
const BARE_URL_RE = /\b[a-z][a-z0-9+.-]{0,31}:\/\/\S+/gi;
const CARD_HASHTAG_RE = /(^|[\s([{"'*~])#([a-z][a-z0-9_-]{0,31})(?=$|[\s.,;:!?)\]}"'*~])/gi;
const CODE_SLOT_RE = /\0C(\d+)\0/g;
const TAG_SLOT_RE = /\0T(\d+)\0/g;
const MAX_LINK_HREF_SCAN_CHARS = 2048;
const MAX_LINK_PAREN_DEPTH = 4;
const ROMAN_PAIRS = Object.freeze([
  [1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'],
  [100, 'c'], [90, 'xc'], [50, 'l'], [40, 'xl'],
  [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i'],
]);
const ROMAN_VALUES = Object.freeze({ i: 1, v: 5, x: 10, l: 50, c: 100, d: 500, m: 1000 });

function escapeHtml(raw) {
  return String(raw ?? '').replace(/[&<>"']/g, (ch) => HTML_ESCAPE_MAP[ch]);
}

function inferDefaultTagColor(tag) {
  const clean = String(tag || '').trim().replace(/^#+/, '').toLowerCase();
  if (Object.hasOwn(KEYWORD_TAG_COLORS, clean)) {
    return KEYWORD_TAG_COLORS[clean];
  }
  let hash = 0;
  for (let i = 0; i < clean.length; i += 1) {
    hash = ((hash << 5) - hash + clean.charCodeAt(i)) | 0;
  }
  return PALETTE_COLOR_IDS[Math.abs(hash) % PALETTE_COLOR_IDS.length];
}

function resolveTagHue(lowerTag, tagColors) {
  if (tagColors && typeof tagColors === 'object' && Object.hasOwn(tagColors, lowerTag)) {
    const explicit = tagColors[lowerTag];
    return PALETTE_SET.has(explicit) ? explicit : '';
  }
  return inferDefaultTagColor(lowerTag);
}

function measureIndentCols(ws) {
  let cols = 0;
  for (let i = 0; i < ws.length; i += 1) {
    cols += ws.charCodeAt(i) === 9 ? 2 : 1;
  }
  return cols;
}

function romanToInt(raw) {
  const s = raw.toLowerCase();
  let total = 0;
  for (let i = 0; i < s.length; i += 1) {
    const cur = ROMAN_VALUES[s[i]] || 0;
    const next = ROMAN_VALUES[s[i + 1]] || 0;
    total += cur < next ? -cur : cur;
  }
  return total;
}

function intToRoman(num, upper = false) {
  let rem = Math.max(1, Math.min(3999, Math.floor(num)));
  let out = '';
  for (const [val, sym] of ROMAN_PAIRS) {
    while (rem >= val) {
      out += sym;
      rem -= val;
    }
  }
  return upper ? out.toUpperCase() : out;
}

function alphaToInt(raw) {
  const s = raw.toLowerCase();
  let val = 0;
  for (let i = 0; i < s.length; i += 1) {
    val = val * 26 + (s.charCodeAt(i) - 96);
  }
  return val;
}

function intToAlpha(num, upper = false) {
  let rem = Math.max(1, Math.floor(num));
  let out = '';
  while (rem > 0) {
    const mod = (rem - 1) % 26;
    out = String.fromCharCode(97 + mod) + out;
    rem = Math.floor((rem - 1) / 26);
  }
  return upper ? out.toUpperCase() : out;
}

function parseOrderedMarker(token, prevSameIndentToken = '') {
  if (!token) {
    return null;
  }
  if (/^\d+$/.test(token)) {
    return { kind: 'digit', value: Number(token), upper: false, olType: '' };
  }
  if (!/^[a-zA-Z]+$/.test(token)) {
    return null;
  }
  const upper = token === token.toUpperCase();
  const lower = token.toLowerCase();
  if (lower !== token && !upper) {
    return null;
  }
  const prevLower = String(prevSameIndentToken || '').toLowerCase();
  if (ROMAN_STRICT_RE.test(lower)) {
    if (lower.length >= 2) {
      return { kind: 'roman', value: romanToInt(lower), upper, olType: upper ? 'I' : 'i' };
    }
    if (lower === 'i' && prevLower !== 'h') {
      return { kind: 'roman', value: 1, upper, olType: upper ? 'I' : 'i' };
    }
    if (prevLower && ROMAN_STRICT_RE.test(prevLower) && romanToInt(prevLower) + 1 === romanToInt(lower)) {
      return { kind: 'roman', value: romanToInt(lower), upper, olType: upper ? 'I' : 'i' };
    }
  }
  if (lower.length <= 2) {
    return { kind: 'alpha', value: alphaToInt(lower), upper, olType: upper ? 'A' : 'a' };
  }
  return null;
}

function formatOrderedMarker(parsed, nextVal) {
  if (parsed.kind === 'roman') {
    return intToRoman(nextVal, parsed.upper);
  }
  if (parsed.kind === 'alpha') {
    return intToAlpha(nextVal, parsed.upper);
  }
  return String(nextVal);
}

function matchFenceOpen(line) {
  const match = line.match(FENCE_OPEN_RE);
  if (!match || (match[1][0] === '`' && match[2].includes('`'))) {
    return null;
  }
  return { char: match[1][0], len: match[1].length };
}

function isFenceClose(line, fenceChar, fenceLen) {
  const match = line.match(/^[ ]{0,3}(`{3,}|~{3,})[ \t]*$/);
  return Boolean(match && match[1][0] === fenceChar && match[1].length >= fenceLen);
}

function extractInlineCodeSlots(rawLine) {
  const safeLine = rawLine.replace(/\0/g, '\uFFFD');
  if (!safeLine.includes('`')) {
    return { text: safeLine, slots: [] };
  }
  const runs = [];
  let pos = 0;
  while (pos < safeLine.length) {
    const start = safeLine.indexOf('`', pos);
    if (start === -1) {
      break;
    }
    let end = start + 1;
    while (end < safeLine.length && safeLine.charCodeAt(end) === 96) {
      end += 1;
    }
    runs.push({ start, end, len: end - start });
    pos = end;
  }
  const deadLengths = new Set();
  const slots = [];
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
    for (let j = i + 1; j < runs.length; j += 1) {
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
    out.push(safeLine.slice(cursor, openRun.start));
    const rawCode = safeLine.slice(openRun.end, runs[closeIdx].start);
    const trimSpace = rawCode.length >= 2 && rawCode.startsWith(' ') && rawCode.endsWith(' ') && rawCode.trim().length > 0;
    const slotIdx = slots.length;
    slots.push(`<code>${escapeHtml(trimSpace ? rawCode.slice(1, -1) : rawCode)}</code>`);
    out.push(`\0C${slotIdx}\0`);
    cursor = runs[closeIdx].end;
    i = closeIdx + 1;
  }
  out.push(safeLine.slice(cursor));
  return { text: out.join(''), slots };
}

function restoreCodeSlots(html, slots) {
  return slots.length === 0 ? html : html.replace(CODE_SLOT_RE, (_, idx) => slots[Number(idx)] ?? '');
}

function sanitizeLinkHref(rawHref) {
  const trimmed = String(rawHref ?? '').replace(CODE_SLOT_RE, '').trim();
  if (!trimmed || /[\u0000-\u0020\u007f]/.test(trimmed) || !/^(?:https?:\/\/|mailto:)/i.test(trimmed)) {
    return '';
  }
  try {
    const parsed = new URL(trimmed);
    const proto = parsed.protocol.toLowerCase();
    if (proto === 'https:' || proto === 'http:') {
      return parsed.hostname ? escapeHtml(trimmed) : '';
    }
    return proto === 'mailto:' && trimmed.slice(7).trim().length > 0 ? escapeHtml(trimmed) : '';
  } catch {
    return '';
  }
}

function stripTrailingHeadingHashes(rawText) {
  let end = rawText.length;
  while (end > 0 && (rawText[end - 1] === ' ' || rawText[end - 1] === '\t')) {
    end -= 1;
  }
  let hashStart = end;
  while (hashStart > 0 && rawText[hashStart - 1] === '#') {
    hashStart -= 1;
  }
  if (hashStart < end && (hashStart === 0 || rawText[hashStart - 1] === ' ' || rawText[hashStart - 1] === '\t')) {
    while (hashStart > 0 && (rawText[hashStart - 1] === ' ' || rawText[hashStart - 1] === '\t')) {
      hashStart -= 1;
    }
    return rawText.slice(0, hashStart);
  }
  return rawText.slice(0, end);
}

function scanLinksInText(rawSegment) {
  if (!rawSegment.includes('[') || !rawSegment.includes('](')) {
    return [{ type: 'plain', raw: rawSegment }];
  }
  const parts = [];
  let cursor = 0;
  let idx = 0;
  let nextParen = -2;
  while (idx < rawSegment.length) {
    const firstOpen = rawSegment.indexOf('[', idx);
    if (firstOpen === -1) {
      break;
    }
    const closeBracket = rawSegment.indexOf(']', firstOpen + 1);
    if (closeBracket === -1) {
      break;
    }
    if (rawSegment.charCodeAt(closeBracket + 1) !== 40) {
      idx = closeBracket + 1;
      continue;
    }
    const bracketStart = rawSegment.lastIndexOf('[', closeBracket - 1);
    const isImage = bracketStart > cursor && rawSegment.charCodeAt(bracketStart - 1) === 33;
    const tokenStart = isImage ? bracketStart - 1 : bracketStart;
    const hrefStart = closeBracket + 2;
    if (nextParen !== -1 && nextParen < hrefStart) {
      nextParen = rawSegment.indexOf(')', hrefStart);
    }
    if (nextParen === -1) {
      break;
    }
    if (nextParen - hrefStart > MAX_LINK_HREF_SCAN_CHARS) {
      idx = hrefStart;
      continue;
    }
    const scanLimit = Math.min(rawSegment.length, hrefStart + MAX_LINK_HREF_SCAN_CHARS);
    let parenDepth = 1;
    let p = hrefStart;
    while (p < scanLimit && parenDepth > 0) {
      const code = rawSegment.charCodeAt(p);
      if (code === 40) {
        parenDepth += 1;
        if (parenDepth > MAX_LINK_PAREN_DEPTH) {
          break;
        }
      } else if (code === 41) {
        parenDepth -= 1;
        if (parenDepth === 0) {
          break;
        }
      }
      p += 1;
    }
    if (parenDepth !== 0) {
      idx = hrefStart;
      continue;
    }
    if (tokenStart > cursor) {
      parts.push({ type: 'plain', raw: rawSegment.slice(cursor, tokenStart) });
    }
    parts.push({
      type: isImage ? 'image' : 'link',
      label: rawSegment.slice(bracketStart + 1, closeBracket),
      href: rawSegment.slice(hrefStart, p),
    });
    cursor = p + 1;
    idx = cursor;
  }
  if (cursor < rawSegment.length) {
    parts.push({ type: 'plain', raw: rawSegment.slice(cursor) });
  }
  return parts;
}

function applyInlineTypography(escaped) {
  return escaped
    .replace(/~~([^~\n]+?)~~/g, '<del>$1</del>')
    .replace(/\*\*([^*\n]+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s([{"'])__([^_\n]+?)__(?=$|[\s.,;:!?)\]}"'])/g, '$1<strong>$2</strong>')
    .replace(/(^|[^*])\*([^*\s](?:[^*\n]*?[^*\s])?)\*(?!\*)/g, '$1<em>$2</em>')
    .replace(/(^|[\s([{"'])_([^_\s](?:[^_\n]*?[^_\s])?)_(?=$|[\s.,;:!?)\]}"'])/g, '$1<em>$2</em>');
}

function extractTagSlotsFromPlain(rawPlain, tagColors, tagSlots) {
  if (!rawPlain.includes('#')) {
    return escapeHtml(rawPlain);
  }
  const replaceTagsInSlice = (slice) => {
    if (!slice.includes('#')) {
      return escapeHtml(slice);
    }
    const parts = [];
    let cursor = 0;
    CARD_HASHTAG_RE.lastIndex = 0;
    let match = CARD_HASHTAG_RE.exec(slice);
    while (match !== null) {
      const [full, prefix, rawTag] = match;
      const lower = rawTag.toLowerCase();
      if (match.index > cursor) {
        parts.push(escapeHtml(slice.slice(cursor, match.index)));
      }
      if (UNSAFE_KEYS.has(lower)) {
        parts.push(escapeHtml(full));
      } else {
        const hue = resolveTagHue(lower, tagColors);
        const cls = hue ? `notes-inline-tag has-hue notes-hue-${hue}` : 'notes-inline-tag';
        const slotIdx = tagSlots.length;
        tagSlots.push(`<span class="${cls}" data-inline-tag="${escapeHtml(lower)}">#${escapeHtml(rawTag)}</span>`);
        parts.push(`${escapeHtml(prefix)}\0T${slotIdx}\0`);
      }
      cursor = match.index + full.length;
      match = CARD_HASHTAG_RE.exec(slice);
    }
    if (cursor < slice.length) {
      parts.push(escapeHtml(slice.slice(cursor)));
    }
    return parts.join('');
  };

  if (!rawPlain.includes('://')) {
    return replaceTagsInSlice(rawPlain);
  }
  const out = [];
  let cursor = 0;
  BARE_URL_RE.lastIndex = 0;
  let match = BARE_URL_RE.exec(rawPlain);
  while (match !== null) {
    if (match.index > cursor) {
      out.push(replaceTagsInSlice(rawPlain.slice(cursor, match.index)));
    }
    out.push(escapeHtml(match[0]));
    cursor = match.index + match[0].length;
    match = BARE_URL_RE.exec(rawPlain);
  }
  if (cursor < rawPlain.length) {
    out.push(replaceTagsInSlice(rawPlain.slice(cursor)));
  }
  return out.join('');
}

function renderMarkdownInline(rawLine, tagColors = null) {
  const { text, slots } = extractInlineCodeSlots(rawLine);
  const tagSlots = [];
  const out = [];
  for (const seg of scanLinksInText(text)) {
    if (seg.type === 'plain') {
      const baseEscaped = tagColors ? extractTagSlotsFromPlain(seg.raw, tagColors, tagSlots) : escapeHtml(seg.raw);
      out.push(applyInlineTypography(baseEscaped));
    } else if (seg.type === 'link') {
      const labelHtml = applyInlineTypography(escapeHtml(seg.label));
      const safeHref = sanitizeLinkHref(seg.href);
      out.push(safeHref ? `<a href="${safeHref}" target="_blank" rel="noopener noreferrer">${labelHtml}</a>` : labelHtml);
    } else {
      out.push(applyInlineTypography(escapeHtml(seg.label)));
    }
  }
  const joined = out.join('');
  const withTags = tagSlots.length === 0 ? joined : joined.replace(TAG_SLOT_RE, (_, idx) => tagSlots[Number(idx)] ?? '');
  return restoreCodeSlots(withTags, slots);
}

function escapeHtmlWithTags(rawSlice, tagColors) {
  if (!rawSlice.includes('#')) {
    return escapeHtml(rawSlice);
  }
  const parts = [];
  let cursor = 0;
  CARD_HASHTAG_RE.lastIndex = 0;
  let match = CARD_HASHTAG_RE.exec(rawSlice);
  while (match !== null) {
    const [full, prefix, rawTag] = match;
    const lower = rawTag.toLowerCase();
    if (match.index > cursor) {
      parts.push(escapeHtml(rawSlice.slice(cursor, match.index)));
    }
    if (UNSAFE_KEYS.has(lower)) {
      parts.push(escapeHtml(full));
    } else {
      const hue = resolveTagHue(lower, tagColors);
      const cls = hue ? `notes-inline-tag has-hue notes-hue-${hue}` : 'notes-inline-tag';
      parts.push(`${escapeHtml(prefix)}<span class="${cls}" data-inline-tag="${escapeHtml(lower)}">#${escapeHtml(rawTag)}</span>`);
    }
    cursor = match.index + full.length;
    match = CARD_HASHTAG_RE.exec(rawSlice);
  }
  if (cursor < rawSlice.length) {
    parts.push(escapeHtml(rawSlice.slice(cursor)));
  }
  return parts.join('');
}

function escapeCardPlainSafe(rawPlain, tagColors) {
  if (!rawPlain.includes('://')) {
    return escapeHtmlWithTags(rawPlain, tagColors);
  }
  const out = [];
  let cursor = 0;
  BARE_URL_RE.lastIndex = 0;
  let match = BARE_URL_RE.exec(rawPlain);
  while (match !== null) {
    if (match.index > cursor) {
      out.push(escapeHtmlWithTags(rawPlain.slice(cursor, match.index), tagColors));
    }
    out.push(escapeHtml(match[0]));
    cursor = match.index + match[0].length;
    match = BARE_URL_RE.exec(rawPlain);
  }
  if (cursor < rawPlain.length) {
    out.push(escapeHtmlWithTags(rawPlain.slice(cursor), tagColors));
  }
  return out.join('');
}

function renderCardInlineHtml(src, tagColors = {}) {
  if (typeof src !== 'string' || !src) {
    return '';
  }
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const rendered = [];
  let fenceChar = '';
  let fenceLen = 0;
  for (const line of lines) {
    if (fenceChar) {
      if (isFenceClose(line, fenceChar, fenceLen)) {
        fenceChar = '';
        fenceLen = 0;
      }
      rendered.push(escapeHtml(line));
      continue;
    }
    const open = matchFenceOpen(line);
    if (open) {
      fenceChar = open.char;
      fenceLen = open.len;
      rendered.push(escapeHtml(line));
      continue;
    }
    const allowTags = !/^\s{0,3}#{1,6}\s/.test(line);
    const { text, slots } = extractInlineCodeSlots(line);
    const out = [];
    for (const seg of scanLinksInText(text)) {
      if (seg.type === 'plain') {
        out.push(allowTags ? escapeCardPlainSafe(seg.raw, tagColors) : escapeHtml(seg.raw));
      } else if (seg.type === 'image') {
        out.push(escapeHtml(seg.label));
      } else {
        const safeHref = sanitizeLinkHref(seg.href);
        const labelHtml = escapeHtml(seg.label);
        out.push(safeHref ? `<a href="${safeHref}" target="_blank" rel="noopener noreferrer">${labelHtml}</a>` : labelHtml);
      }
    }
    rendered.push(restoreCodeSlots(out.join(''), slots));
  }
  return rendered.join('\n');
}

function renderMarkdownHtml(src, { interactiveTasks = false, tagColors = null } = {}) {
  if (typeof src !== 'string' || !src) {
    return '';
  }
  const lines = src.replace(/\r\n/g, '\n').split('\n');
  const html = [];
  let fenceChar = '';
  let fenceLen = 0;
  let codeBuf = [];
  const listStack = [];
  const prevOrdTokenByIndent = new Map();
  let quoteBuf = [];
  let paraBuf = [];
  const inlineFn = (lineText) => renderMarkdownInline(lineText, tagColors);

  const closeListsDownTo = (minIndent = -1) => {
    while (listStack.length > 0 && listStack[listStack.length - 1].indent > minIndent) {
      const popped = listStack.pop();
      prevOrdTokenByIndent.delete(popped.indent);
      html.push(`</${popped.tag}>`);
    }
  };
  const closeAllLists = () => {
    closeListsDownTo(-1);
    prevOrdTokenByIndent.clear();
  };
  const flushQuote = () => {
    if (quoteBuf.length > 0) {
      html.push(`<blockquote>${quoteBuf.map(inlineFn).join('<br>')}</blockquote>`);
      quoteBuf = [];
    }
  };
  const flushPara = () => {
    if (paraBuf.length > 0) {
      html.push(`<p>${paraBuf.map(inlineFn).join('<br>')}</p>`);
      paraBuf = [];
    }
  };
  const flushAllTextBlocks = () => {
    flushPara();
    flushQuote();
    closeAllLists();
  };
  const ensureListAtIndent = (nextTag, indentCols, olType = '') => {
    flushPara();
    flushQuote();
    closeListsDownTo(indentCols);
    const openTag = nextTag === 'ol' && olType ? `ol type="${olType}"` : nextTag;
    const top = listStack[listStack.length - 1];
    if (!top || indentCols > top.indent) {
      html.push(`<${openTag}>`);
      listStack.push({ tag: nextTag, openTag, indent: indentCols });
      return;
    }
    if (top.openTag !== openTag) {
      listStack.pop();
      prevOrdTokenByIndent.delete(indentCols);
      html.push(`</${top.tag}>`);
      html.push(`<${openTag}>`);
      listStack.push({ tag: nextTag, openTag, indent: indentCols });
    }
  };

  for (let idx = 0; idx < lines.length; idx += 1) {
    const line = lines[idx];
    if (fenceChar) {
      if (isFenceClose(line, fenceChar, fenceLen)) {
        html.push(`<pre><code>${escapeHtml(codeBuf.join('\n'))}</code></pre>`);
        fenceChar = '';
        fenceLen = 0;
        codeBuf = [];
      } else {
        codeBuf.push(line);
      }
      continue;
    }
    const open = matchFenceOpen(line);
    if (open) {
      flushAllTextBlocks();
      fenceChar = open.char;
      fenceLen = open.len;
      codeBuf = [];
      continue;
    }
    if (!line.trim()) {
      flushAllTextBlocks();
      continue;
    }
    if (HR_LINE_RE.test(line)) {
      flushAllTextBlocks();
      html.push('<hr />');
      continue;
    }
    const headingMatch = line.match(HEADING_LINE_RE);
    if (headingMatch) {
      flushAllTextBlocks();
      const level = headingMatch[1].length;
      const headingBody = stripTrailingHeadingHashes(headingMatch[2]);
      html.push(`<h${level}>${renderMarkdownInline(headingBody, null)}</h${level}>`);
      continue;
    }
    const quoteMatch = line.match(BLOCKQUOTE_LINE_RE);
    if (quoteMatch) {
      flushPara();
      closeAllLists();
      quoteBuf.push(quoteMatch[1]);
      continue;
    }
    const taskMatch = line.match(TASK_ITEM_RE);
    if (taskMatch) {
      const indentCols = measureIndentCols(taskMatch[1]);
      const ordTok = taskMatch[3] || '';
      const parsedOrd = ordTok ? parseOrderedMarker(ordTok, prevOrdTokenByIndent.get(indentCols) || '') : null;
      if (ordTok && !parsedOrd) {
        flushQuote();
        closeAllLists();
        paraBuf.push(line);
        continue;
      }
      if (parsedOrd) {
        prevOrdTokenByIndent.set(indentCols, ordTok);
      }
      ensureListAtIndent(parsedOrd ? 'ol' : 'ul', indentCols, parsedOrd ? parsedOrd.olType : '');
      const checkedAttr = taskMatch[4].toLowerCase() === 'x' ? ' checked' : '';
      const taskAttr = interactiveTasks ? ` data-task-line="${idx}"` : ' disabled';
      html.push(`<li class="task-item"><input type="checkbox"${taskAttr}${checkedAttr} /><span>${inlineFn(taskMatch[5] || '')}</span></li>`);
      continue;
    }
    const ulMatch = line.match(UL_ITEM_RE);
    if (ulMatch) {
      const indentCols = measureIndentCols(ulMatch[1]);
      ensureListAtIndent('ul', indentCols, '');
      html.push(`<li>${inlineFn(ulMatch[2])}</li>`);
      continue;
    }
    const olMatch = line.match(OL_ITEM_RE);
    if (olMatch) {
      const indentCols = measureIndentCols(olMatch[1]);
      const parsedOrd = parseOrderedMarker(olMatch[2], prevOrdTokenByIndent.get(indentCols) || '');
      if (parsedOrd) {
        prevOrdTokenByIndent.set(indentCols, olMatch[2]);
        ensureListAtIndent('ol', indentCols, parsedOrd.olType);
        html.push(`<li>${inlineFn(olMatch[3])}</li>`);
        continue;
      }
    }
    flushQuote();
    closeAllLists();
    paraBuf.push(line);
  }

  if (fenceChar) {
    html.push(`<pre><code>${escapeHtml(codeBuf.join('\n'))}</code></pre>`);
  }
  flushAllTextBlocks();
  return html.join('');
}

function splitPreservingEndings(src) {
  const rows = [];
  let pos = 0;
  while (pos <= src.length) {
    const nl = src.indexOf('\n', pos);
    if (nl === -1) {
      rows.push({ text: src.slice(pos), eol: '' });
      break;
    }
    const isCrlf = nl > pos && src.charCodeAt(nl - 1) === 13;
    rows.push({ text: src.slice(pos, isCrlf ? nl - 1 : nl), eol: isCrlf ? '\r\n' : '\n' });
    pos = nl + 1;
    if (pos === src.length) {
      rows.push({ text: '', eol: '' });
      break;
    }
  }
  return rows;
}

function toggleTaskLine(src, lineIndex) {
  if (typeof src !== 'string' || !Number.isInteger(lineIndex) || lineIndex < 0 || src.length === 0) {
    return String(src ?? '');
  }
  const rows = splitPreservingEndings(src);
  if (lineIndex >= rows.length) {
    return src;
  }
  let fenceChar = '';
  let fenceLen = 0;
  for (let i = 0; i <= lineIndex; i += 1) {
    const line = rows[i].text;
    if (!fenceChar) {
      const open = matchFenceOpen(line);
      if (open) {
        fenceChar = open.char;
        fenceLen = open.len;
        if (i === lineIndex) {
          return src;
        }
      }
    } else {
      if (i === lineIndex) {
        return src;
      }
      if (isFenceClose(line, fenceChar, fenceLen)) {
        fenceChar = '';
        fenceLen = 0;
      }
    }
  }
  const target = rows[lineIndex].text;
  const toggled = target.replace(
    /^(\s*(?:[-*+]|(?:\d+|[a-zA-Z]{1,6})\.)\s+\[)( |x|X)(\](?:\s.*|$))$/,
    (_, pre, mark, post) => `${pre}${mark === ' ' ? 'x' : ' '}${post}`
  );
  if (toggled === target) {
    return src;
  }
  rows[lineIndex].text = toggled;
  return rows.map((r) => `${r.text}${r.eol}`).join('');
}

function isInsideOpenFence(textBeforeLine) {
  if (!textBeforeLine) {
    return false;
  }
  let fenceChar = '';
  let fenceLen = 0;
  for (const line of textBeforeLine.replace(/\r\n?/g, '\n').split('\n')) {
    if (!fenceChar) {
      const open = matchFenceOpen(line);
      if (open) {
        fenceChar = open.char;
        fenceLen = open.len;
      }
    } else if (isFenceClose(line, fenceChar, fenceLen)) {
      fenceChar = '';
      fenceLen = 0;
    }
  }
  return Boolean(fenceChar);
}

function isContiguousListLine(line) {
  return Boolean(line && !HR_LINE_RE.test(line) && LIST_LINE_QUICK_RE.test(line));
}

function findPrevOrderedTokenAtIndent(textBeforeLine, targetIndentCols) {
  if (!textBeforeLine) {
    return '';
  }
  const prevLines = textBeforeLine.replace(/\r\n?/g, '\n').split('\n');
  for (let i = prevLines.length - 1; i >= 0; i -= 1) {
    const ln = prevLines[i];
    if (!isContiguousListLine(ln)) {
      break;
    }
    const m = ln.match(/^([ \t]*)(\d+|[a-zA-Z]{1,6})\.(?:[ \t]+\[[ xX]\])?[ \t]+/);
    if (!m) {
      const bul = ln.match(/^([ \t]*)[-*+][ \t]+/);
      if (bul && measureIndentCols(bul[1]) < targetIndentCols) {
        break;
      }
      continue;
    }
    const cols = measureIndentCols(m[1]);
    if (cols < targetIndentCols) {
      break;
    }
    if (cols === targetIndentCols) {
      return m[2];
    }
  }
  return '';
}

function isOrderedEditLine(line) {
  if (!line || HR_LINE_RE.test(line)) {
    return false;
  }
  const m = line.match(ORDERED_EDIT_LINE_RE);
  return Boolean(m && parseOrderedMarker(m[2], ''));
}

function nextCycledOrderedStyle(parentOrd) {
  if (!parentOrd) {
    return { kind: 'digit', upper: false };
  }
  const idx = ORDERED_KIND_CYCLE.indexOf(parentOrd.kind);
  const nextKind = ORDERED_KIND_CYCLE[(idx + 1) % ORDERED_KIND_CYCLE.length];
  return { kind: nextKind, upper: nextKind === 'digit' ? false : Boolean(parentOrd.upper) };
}

function isCompatibleUntouchedOrderedKind(activeKind, rawToken, parsed) {
  if (parsed.kind === activeKind) {
    return true;
  }
  if (activeKind === 'roman') {
    return ROMAN_STRICT_RE.test(rawToken);
  }
  if (activeKind === 'alpha') {
    return /^[a-zA-Z]{1,2}$/.test(rawToken);
  }
  return false;
}

function renumberOrderedListBlock(allLines, touchStartIdx, touchEndIdx, cursorStart, cursorEnd, cycleTouchedKinds = false) {
  let blockFirst = touchStartIdx;
  while (blockFirst > 0 && isContiguousListLine(allLines[blockFirst - 1])) {
    blockFirst -= 1;
  }
  let blockLast = touchEndIdx;
  while (blockLast < allLines.length - 1 && isContiguousListLine(allLines[blockLast + 1])) {
    blockLast += 1;
  }

  let lineOffset = 0;
  for (let i = 0; i < blockFirst; i += 1) {
    lineOffset += allLines[i].length + 1;
  }

  let nextStart = cursorStart;
  let nextEnd = cursorEnd;
  const stack = [];

  const findNearestOrderedAncestor = (indentCols) => {
    for (let s = stack.length - 1; s >= 0; s -= 1) {
      if (stack[s].indentCols < indentCols && stack[s].isOrdered) {
        return stack[s];
      }
    }
    return null;
  };

  for (let idx = blockFirst; idx <= blockLast; idx += 1) {
    const line = allLines[idx];
    const wsMatch = line.match(/^([ \t]*)/);
    const indentCols = measureIndentCols(wsMatch ? wsMatch[1] : '');
    while (stack.length > 0 && stack[stack.length - 1].indentCols > indentCols) {
      stack.pop();
    }
    const top = stack[stack.length - 1] || null;
    const ordMatch = line.match(ORDERED_EDIT_LINE_RE);
    const prevSameTok = top && top.indentCols === indentCols && top.isOrdered ? top.lastToken : '';
    const parsed = ordMatch ? parseOrderedMarker(ordMatch[2], prevSameTok) : null;

    if (ordMatch && parsed) {
      const isTouched = cycleTouchedKinds && idx >= touchStartIdx && idx <= touchEndIdx;
      const resetStartToOne = cycleTouchedKinds && idx >= touchStartIdx;
      let active = null;

      if (top && top.indentCols === indentCols) {
        if (top.isOrdered && (isTouched || isCompatibleUntouchedOrderedKind(top.kind, ordMatch[2], parsed))) {
          top.count += 1;
          active = top;
        } else {
          const style = isTouched ? nextCycledOrderedStyle(findNearestOrderedAncestor(indentCols)) : { kind: parsed.kind, upper: parsed.upper };
          active = {
            indentCols,
            isOrdered: true,
            kind: style.kind,
            upper: style.upper,
            count: resetStartToOne ? 1 : parsed.value,
            lastToken: '',
          };
          stack[stack.length - 1] = active;
        }
      } else {
        const style = isTouched ? nextCycledOrderedStyle(findNearestOrderedAncestor(indentCols)) : { kind: parsed.kind, upper: parsed.upper };
        active = {
          indentCols,
          isOrdered: true,
          kind: style.kind,
          upper: style.upper,
          count: resetStartToOne ? 1 : parsed.value,
          lastToken: '',
        };
        stack.push(active);
      }

      const oldToken = ordMatch[2];
      const newToken = formatOrderedMarker(active, active.count);
      active.lastToken = newToken;
      if (oldToken !== newToken) {
        const tokenStart = lineOffset + ordMatch[1].length;
        const tokenEnd = tokenStart + oldToken.length;
        const delta = newToken.length - oldToken.length;
        if (nextStart >= tokenEnd) {
          nextStart += delta;
        } else if (nextStart > tokenStart) {
          nextStart = tokenStart + Math.min(nextStart - tokenStart, newToken.length);
        }
        if (nextEnd >= tokenEnd) {
          nextEnd += delta;
        } else if (nextEnd > tokenStart) {
          nextEnd = tokenStart + Math.min(nextEnd - tokenStart, newToken.length);
        }
        allLines[idx] = `${ordMatch[1]}${newToken}${ordMatch[3]}`;
      }
    } else if (!top || indentCols > top.indentCols) {
      stack.push({ indentCols, isOrdered: false });
    } else if (top.indentCols === indentCols && top.isOrdered) {
      stack[stack.length - 1] = { indentCols, isOrdered: false };
    }
    lineOffset += allLines[idx].length + 1;
  }

  return { start: nextStart, end: Math.max(nextStart, nextEnd) };
}

function isListLineAtSelection(value, selectionStart, selectionEnd) {
  const str = String(value ?? '');
  const selStart = Math.max(0, Math.min(str.length, Number(selectionStart) || 0));
  const selEnd = Math.max(selStart, Math.min(str.length, Number(selectionEnd ?? selStart) || 0));
  if (selEnd > selStart) {
    return true;
  }
  const lineStart = selStart === 0 ? 0 : str.lastIndexOf('\n', selStart - 1) + 1;
  if (lineStart > 0 && isInsideOpenFence(str.slice(0, lineStart - 1))) {
    return false;
  }
  const nextNl = str.indexOf('\n', selStart);
  const line = str.slice(lineStart, nextNl === -1 ? str.length : nextNl);
  return isContiguousListLine(line);
}

function applyEditorListEnter(value, selectionStart, selectionEnd) {
  const str = String(value ?? '');
  const start = Math.max(0, Math.min(str.length, Number(selectionStart) || 0));
  const end = Math.max(start, Math.min(str.length, Number(selectionEnd ?? start) || 0));
  const lineStart = str.slice(0, start).lastIndexOf('\n') + 1;
  if (lineStart > 0 && isInsideOpenFence(str.slice(0, lineStart - 1))) {
    return null;
  }
  const nextNl = str.indexOf('\n', end);
  const rawLineEnd = nextNl === -1 ? str.length : nextNl;
  const lineEnd = rawLineEnd > end && str.charCodeAt(rawLineEnd - 1) === 13 ? rawLineEnd - 1 : rawLineEnd;
  const lineBefore = str.slice(lineStart, start);
  const lineAfter = str.slice(end, lineEnd);
  const textAbove = lineStart > 0 ? str.slice(0, lineStart - 1) : '';

  const exitOrOutdentEmpty = (indent, markerSuffix, isOrdered = false) => {
    if (!indent) {
      return { value: `${str.slice(0, lineStart)}${str.slice(lineEnd)}`, cursor: lineStart };
    }
    let removeLen = 1;
    if (isOrdered && indent.startsWith('   ')) {
      removeLen = 3;
    } else if (indent.startsWith('  ')) {
      removeLen = 2;
    }
    const nextIndent = indent.slice(removeLen);
    const replaced = `${str.slice(0, lineStart)}${nextIndent}${markerSuffix}${str.slice(lineEnd)}`;
    const rawCursor = lineStart + nextIndent.length + markerSuffix.length;
    if (!isOrdered) {
      return { value: replaced, cursor: rawCursor };
    }
    const allLines = replaced.split('\n');
    const lineIdx = replaced.slice(0, lineStart).split('\n').length - 1;
    const adjusted = renumberOrderedListBlock(allLines, lineIdx, lineIdx, rawCursor, rawCursor, true);
    return { value: allLines.join('\n'), cursor: adjusted.start };
  };

  const insertContinuation = (prefix, isOrdered = false) => {
    const ins = `\n${prefix}`;
    const nextStr = `${str.slice(0, start)}${ins}${str.slice(end)}`;
    const rawCursor = start + ins.length;
    if (!isOrdered) {
      return { value: nextStr, cursor: rawCursor };
    }
    const allLines = nextStr.split('\n');
    const lineIdx = nextStr.slice(0, start + 1).split('\n').length - 1;
    const adjusted = renumberOrderedListBlock(allLines, lineIdx, lineIdx, rawCursor, rawCursor, false);
    return { value: allLines.join('\n'), cursor: adjusted.start };
  };

  const taskMatch = lineBefore.match(/^([ \t]*)(?:([-*+])|(\d+|[a-zA-Z]{1,6})\.)([ \t]+)\[[ xX]\]([ \t]*)(.*)$/);
  if (taskMatch) {
    const indent = taskMatch[1];
    const indentCols = measureIndentCols(indent);
    const ordToken = taskMatch[3] || '';
    const prevAboveAbove = ordToken ? findPrevOrderedTokenAtIndent(textAbove, indentCols) : '';
    const parsedOrd = ordToken ? parseOrderedMarker(ordToken, prevAboveAbove) : null;
    if (ordToken && !parsedOrd) {
      return null;
    }
    if (!taskMatch[6].trim() && !lineAfter.trim()) {
      const markerLabel = parsedOrd ? `${formatOrderedMarker(parsedOrd, 1)}.` : taskMatch[2];
      return exitOrOutdentEmpty(indent, `${markerLabel}${taskMatch[4]}[ ] `, Boolean(parsedOrd));
    }
    const nextMarker = parsedOrd ? `${formatOrderedMarker(parsedOrd, parsedOrd.value + 1)}.` : taskMatch[2];
    return insertContinuation(`${indent}${nextMarker}${taskMatch[4]}[ ] `, Boolean(parsedOrd));
  }

  const bulletMatch = lineBefore.match(/^([ \t]*)([-*+][ \t]+)(.*)$/);
  if (bulletMatch && !HR_LINE_RE.test(`${lineBefore}${lineAfter}`)) {
    if (!bulletMatch[3].trim() && !lineAfter.trim()) {
      return exitOrOutdentEmpty(bulletMatch[1], bulletMatch[2], false);
    }
    return insertContinuation(`${bulletMatch[1]}${bulletMatch[2]}`, false);
  }

  const orderedMatch = lineBefore.match(/^([ \t]*)(\d+|[a-zA-Z]{1,6})(\.[ \t]+)(.*)$/);
  if (orderedMatch) {
    const indent = orderedMatch[1];
    const indentCols = measureIndentCols(indent);
    const prevTok = findPrevOrderedTokenAtIndent(textAbove, indentCols);
    const parsedOrd = parseOrderedMarker(orderedMatch[2], prevTok);
    if (!parsedOrd) {
      return null;
    }
    if (!orderedMatch[4].trim() && !lineAfter.trim()) {
      const baseTok = formatOrderedMarker(parsedOrd, 1);
      return exitOrOutdentEmpty(indent, `${baseTok}${orderedMatch[3]}`, true);
    }
    const nextTok = formatOrderedMarker(parsedOrd, parsedOrd.value + 1);
    return insertContinuation(`${indent}${nextTok}${orderedMatch[3]}`, true);
  }
  return null;
}

function applyEditorTabIndent(value, selectionStart, selectionEnd, outdent = false) {
  const str = String(value ?? '');
  const selStart = Math.max(0, Math.min(str.length, Number(selectionStart) || 0));
  const selEnd = Math.max(selStart, Math.min(str.length, Number(selectionEnd ?? selStart) || 0));
  const effectiveEnd = selEnd > selStart && str.charCodeAt(selEnd - 1) === 10 ? selEnd - 1 : selEnd;
  const blockStart = selStart === 0 ? 0 : str.lastIndexOf('\n', selStart - 1) + 1;
  const nextNl = str.indexOf('\n', effectiveEnd);
  const blockEnd = nextNl === -1 ? str.length : nextNl;
  const lines = str.slice(blockStart, blockEnd).split('\n');
  const insideFence = blockStart > 0 && isInsideOpenFence(str.slice(0, blockStart - 1));

  let nextVal = '';
  let newStart = selStart;
  let newEnd = selEnd;

  if (!outdent) {
    const addedCounts = [];
    const indented = lines
      .map((line) => {
        const pad = !insideFence && isOrderedEditLine(line) ? '   ' : '  ';
        addedCounts.push(pad.length);
        return `${pad}${line}`;
      })
      .join('\n');
    nextVal = `${str.slice(0, blockStart)}${indented}${str.slice(blockEnd)}`;
    newStart = selStart + addedCounts[0];
    const totalAdded = addedCounts.reduce((acc, n) => acc + n, 0);
    newEnd = selEnd > selStart ? selEnd + totalAdded : newStart;
  } else {
    const removedCounts = [];
    const outdentedLines = lines.map((line) => {
      const maxSpaces = !insideFence && isOrderedEditLine(line) ? 3 : 2;
      if (maxSpaces === 3 && line.startsWith('   ')) {
        removedCounts.push(3);
        return line.slice(3);
      }
      if (line.startsWith('  ')) {
        removedCounts.push(2);
        return line.slice(2);
      }
      if (line.startsWith(' ') || line.startsWith('\t')) {
        removedCounts.push(1);
        return line.slice(1);
      }
      removedCounts.push(0);
      return line;
    });

    const firstRemoved = Math.min(removedCounts[0], selStart - blockStart);
    newStart = selStart - firstRemoved;
    newEnd = newStart;
    if (selEnd > selStart) {
      let lastLineOffset = blockStart;
      let priorRemoved = 0;
      for (let i = 0; i < lines.length - 1; i += 1) {
        lastLineOffset += lines[i].length + 1;
        priorRemoved += removedCounts[i];
      }
      const lastRemoved = selEnd > effectiveEnd
        ? removedCounts[lines.length - 1]
        : Math.min(removedCounts[lines.length - 1], selEnd - lastLineOffset);
      newEnd = selEnd - priorRemoved - lastRemoved;
    }
    nextVal = `${str.slice(0, blockStart)}${outdentedLines.join('\n')}${str.slice(blockEnd)}`;
  }

  const firstLineIdx = blockStart === 0 ? 0 : str.slice(0, blockStart - 1).split('\n').length;
  const lastLineIdx = firstLineIdx + lines.length - 1;
  if (!insideFence) {
    const allLines = nextVal.split('\n');
    const touchedHasOrdered = allLines
      .slice(firstLineIdx, lastLineIdx + 1)
      .some((ln) => isOrderedEditLine(ln));
    if (touchedHasOrdered) {
      const adjusted = renumberOrderedListBlock(allLines, firstLineIdx, lastLineIdx, newStart, Math.max(newStart, newEnd), true);
      return {
        value: allLines.join('\n'),
        start: adjusted.start,
        end: adjusted.end,
      };
    }
  }

  return {
    value: nextVal,
    start: newStart,
    end: Math.max(newStart, newEnd),
  };
}

const NotesMarkdown = Object.freeze({
  renderMarkdownHtml,
  renderCardInlineHtml,
  toggleTaskLine,
  applyEditorListEnter,
  applyEditorTabIndent,
  isListLineAtSelection,
});

globalThis.NotesMarkdown = NotesMarkdown;
if (typeof window !== 'undefined' && window) {
  window.NotesMarkdown = NotesMarkdown;
}

export {
  renderMarkdownHtml,
  renderCardInlineHtml,
  toggleTaskLine,
  applyEditorListEnter,
  applyEditorTabIndent,
  isListLineAtSelection,
};
