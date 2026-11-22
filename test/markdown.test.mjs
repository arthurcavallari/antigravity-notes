import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseHTML } from 'linkedom';
import {
  applyEditorListEnter,
  applyEditorTabIndent,
  isListLineAtSelection,
  renderCardInlineHtml,
  renderMarkdownHtml,
  toggleTaskLine,
} from '../ui/markdown.js';

function parseFragment(html) {
  const { document } = parseHTML(`<!doctype html><html><body><div id="root">${html}</div></body></html>`);
  return document.getElementById('root');
}

describe('ui/markdown.js — exports & global NotesMarkdown registration', () => {
  it('exposes all 5 functions via ESM exports and globalThis.NotesMarkdown', () => {
    assert.equal(typeof renderMarkdownHtml, 'function');
    assert.equal(typeof renderCardInlineHtml, 'function');
    assert.equal(typeof toggleTaskLine, 'function');
    assert.equal(typeof applyEditorListEnter, 'function');
    assert.equal(typeof applyEditorTabIndent, 'function');

    assert.ok(globalThis.NotesMarkdown);
    assert.equal(globalThis.NotesMarkdown.renderMarkdownHtml, renderMarkdownHtml);
    assert.equal(globalThis.NotesMarkdown.renderCardInlineHtml, renderCardInlineHtml);
    assert.equal(globalThis.NotesMarkdown.toggleTaskLine, toggleTaskLine);
    assert.equal(globalThis.NotesMarkdown.applyEditorListEnter, applyEditorListEnter);
    assert.equal(globalThis.NotesMarkdown.applyEditorTabIndent, applyEditorTabIndent);
  });
});

describe('ui/markdown.js — XSS neutralization (Review Focus #5)', () => {
  it('escapes raw HTML tags and event handlers before block and inline rendering', () => {
    const maliciousMd = [
      '# <script>alert("h1")</script>',
      '',
      'Paragraph with <img src=x onerror=alert(1)> and <svg onload="evil()">.',
      '',
      '- <iframe src="javascript:alert(2)"></iframe>',
      '- [ ] <input type="checkbox" data-task-line="999" onclick="evil()">',
      '',
      '> <a href="javascript:alert(3)" onmouseover="evil()">quote</a>',
      '',
      '```html',
      '</pre><script>alert("breakout")</script>',
      '```',
    ].join('\n');

    const html = renderMarkdownHtml(maliciousMd, { interactiveTasks: true });
    const root = parseFragment(html);

    assert.equal(root.querySelectorAll('script, img, svg, iframe').length, 0);
    assert.equal(root.querySelectorAll('a').length, 0);
    const checkboxes = root.querySelectorAll('input[type="checkbox"]');
    assert.equal(checkboxes.length, 1);
    assert.equal(checkboxes[0].getAttribute('data-task-line'), '5');
    assert.equal(checkboxes[0].hasAttribute('onclick'), false);
    assert.match(root.querySelector('h1').textContent, /<script>alert\("h1"\)<\/script>/);
    assert.match(root.querySelector('pre code').textContent, /<\/pre><script>alert\("breakout"\)<\/script>/);

    const cardHtml = renderCardInlineHtml(
      'Check <script>alert(1)</script> & <img src=x onerror=alert(1)> #bug',
      { bug: 'rose' }
    );
    const cardRoot = parseFragment(cardHtml);
    assert.equal(cardRoot.querySelectorAll('script, img').length, 0);
    assert.match(cardRoot.textContent, /<script>alert\(1\)<\/script> & <img src=x onerror=alert\(1\)> #bug/);
  });

  it('blocks javascript:, data:, vbscript:, file:, entity-obfuscated, and attribute-breakout link hrefs while allowing https:, http:, and mailto:', () => {
    const payload = [
      '[js1](javascript:alert(1))',
      '[js2](JAVASCRIPT:alert(2))',
      '[js3](   javascript:alert(3))',
      '[js4](java&#x09;script:alert(4))',
      '[js5](&#106;avascript:alert(5))',
      '[js6](javascript&#58;alert(6))',
      '[dataUrl](data:text/html,<script>alert(7)</script>)',
      '[vbs](vbscript:msgbox(8))',
      '[localFile](file:///etc/passwd)',
      '[protoRel](//evil.example.com/payload)',
      '![badImg](javascript:alert(9))',
      '[safeHttps](https://example.com/docs?a=1&b=2)',
      '[safeHttp](http://127.0.0.1:52325/test)',
      '[safeMail](mailto:dev@example.com)',
      '[wikiParen](https://en.wikipedia.org/wiki/Markdown_(markup_language))',
      '[quoteEscape](https://example.com/path?q="test")',
      '[`server.mjs`](https://example.com/server)',
      '[`evilCode`](javascript:alert(10))',
      'NUL collision \0C0\0 `safe`',
    ].join('\n\n');

    const html = renderMarkdownHtml(payload);
    const root = parseFragment(html);

    assert.equal(root.querySelectorAll('img, script').length, 0);
    assert.doesNotMatch(html, /javascript:/i);
    assert.doesNotMatch(html, /data:text\/html/i);
    assert.doesNotMatch(html, /vbscript:/i);

    const anchors = [...root.querySelectorAll('a')];
    assert.equal(anchors.length, 6);
    assert.deepEqual(
      anchors.map((a) => a.getAttribute('href')),
      [
        'https://example.com/docs?a=1&b=2',
        'http://127.0.0.1:52325/test',
        'mailto:dev@example.com',
        'https://en.wikipedia.org/wiki/Markdown_(markup_language)',
        'https://example.com/path?q="test"',
        'https://example.com/server',
      ]
    );
    assert.equal(anchors[5].querySelector('code').textContent, 'server.mjs');
    for (const anchor of anchors) {
      assert.equal(anchor.getAttribute('target'), '_blank');
      assert.equal(anchor.getAttribute('rel'), 'noopener noreferrer');
      assert.equal(anchor.hasAttribute('onclick'), false);
    }
  });

  it('rejects malicious or non-palette tagColors values without attribute injection', () => {
    const html = renderCardInlineHtml('Test #bug and #__proto__', {
      bug: 'rose" onmouseover="alert(1)',
    });
    const root = parseFragment(html);
    const tagSpans = [...root.querySelectorAll('[data-inline-tag]')];
    assert.equal(tagSpans.length, 1);
    assert.equal(tagSpans[0].getAttribute('class'), 'notes-inline-tag');
    assert.equal(tagSpans[0].hasAttribute('onmouseover'), false);
  });
});

describe('ui/markdown.js — renderCardInlineHtml', () => {
  it('formats inline code (including multi-backtick runs) and colored #tag spans while ignoring code, headings, URLs, and numbers', () => {
    const src = [
      '# Heading #ignored_in_heading',
      'Verify `_new` and `` `#not_a_tag` `` on https://x.io/#frag and [docs](https://x.io/#linkfrag) for issue #42 #Bug #later #muted',
      '```js',
      'const s = "#ignored_in_fence";',
      '```',
    ].join('\n');

    const html = renderCardInlineHtml(src, {
      bug: 'violet',
      muted: 'none',
    });
    const root = parseFragment(html);

    const codes = [...root.querySelectorAll('code')].map((el) => el.textContent);
    assert.deepEqual(codes, ['_new', '`#not_a_tag`']);

    const tags = [...root.querySelectorAll('.notes-inline-tag')];
    assert.deepEqual(
      tags.map((el) => ({
        tag: el.getAttribute('data-inline-tag'),
        text: el.textContent,
        cls: el.getAttribute('class'),
      })),
      [
        {
          tag: 'bug',
          text: '#Bug',
          cls: 'notes-inline-tag has-hue notes-hue-violet',
        },
        {
          tag: 'later',
          text: '#later',
          cls: 'notes-inline-tag has-hue notes-hue-blue',
        },
        {
          tag: 'muted',
          text: '#muted',
          cls: 'notes-inline-tag',
        },
      ]
    );
  });
});

describe('ui/markdown.js — renderMarkdownHtml & toggleTaskLine', () => {
  it('renders headings, lists, blockquotes, hr, code blocks, inline formatting, and gates interactive task checkboxes', () => {
    const md = [
      '# Title One',
      '### Sub Heading',
      '',
      'Use **bold**, *italic*, ~~strike~~, `snake_case_var`, and snake_case_ident.',
      '',
      '> Quoted note',
      '',
      '---',
      '',
      '- Bullet item',
      '- [ ] Open task',
      '- [X] Completed task',
      '',
      '1. First ordered',
      '2. Second ordered',
      '',
      '```md',
      '- [ ] Task inside fenced code must NOT become checkbox',
      '```',
    ].join('\n');

    const staticHtml = renderMarkdownHtml(md);
    const staticRoot = parseFragment(staticHtml);
    assert.equal(staticRoot.querySelector('h1').textContent, 'Title One');
    assert.equal(staticRoot.querySelector('h3').textContent, 'Sub Heading');
    assert.equal(staticRoot.querySelector('strong').textContent, 'bold');
    assert.equal(staticRoot.querySelector('em').textContent, 'italic');
    assert.equal(staticRoot.querySelector('del').textContent, 'strike');
    assert.match(staticRoot.textContent, /snake_case_ident/);
    assert.equal(staticRoot.querySelector('blockquote').textContent, 'Quoted note');
    assert.equal(staticRoot.querySelectorAll('hr').length, 1);
    assert.equal(staticRoot.querySelectorAll('ol li').length, 2);

    const staticChecks = [...staticRoot.querySelectorAll('input[type="checkbox"]')];
    assert.equal(staticChecks.length, 2);
    assert.equal(staticChecks[0].hasAttribute('disabled'), true);
    assert.equal(staticChecks[0].hasAttribute('data-task-line'), false);
    assert.equal(staticChecks[0].hasAttribute('checked'), false);
    assert.equal(staticChecks[1].hasAttribute('disabled'), true);
    assert.equal(staticChecks[1].hasAttribute('checked'), true);

    const interactiveHtml = renderMarkdownHtml(md, { interactiveTasks: true });
    const interactiveRoot = parseFragment(interactiveHtml);
    const liveChecks = [...interactiveRoot.querySelectorAll('input[type="checkbox"]')];
    assert.equal(liveChecks.length, 2, 'Fenced code - [ ] must never render as checkbox');
    assert.equal(liveChecks[0].getAttribute('data-task-line'), '10');
    assert.equal(liveChecks[0].hasAttribute('disabled'), false);
    assert.equal(liveChecks[0].hasAttribute('checked'), false);
    assert.equal(liveChecks[1].getAttribute('data-task-line'), '11');
    assert.equal(liveChecks[1].hasAttribute('checked'), true);
  });

  it('toggleTaskLine toggles task markers outside code fences and preserves LF/CRLF line endings', () => {
    const crlfDoc = [
      '# Tasks',
      '- [ ] First item',
      '- [X] Second item',
      '~~~',
      '- [ ] Fenced pseudo-task',
      '~~~',
      '1. [ ] Numbered task',
    ].join('\r\n');

    const step1 = toggleTaskLine(crlfDoc, 1);
    assert.equal(step1.includes('\r\n'), true);
    assert.equal(step1.split('\r\n')[1], '- [x] First item');

    const step2 = toggleTaskLine(step1, 2);
    assert.equal(step2.split('\r\n')[2], '- [ ] Second item');

    const fencedUntouched = toggleTaskLine(step2, 4);
    assert.equal(fencedUntouched, step2, 'Must not toggle - [ ] inside fenced code block');

    const numberedToggled = toggleTaskLine(step2, 6);
    assert.equal(numberedToggled.split('\r\n')[6], '1. [x] Numbered task');

    assert.equal(toggleTaskLine(step2, -1), step2);
    assert.equal(toggleTaskLine(step2, 99), step2);
    assert.equal(toggleTaskLine(step2, 0), step2);

    // Lone \r inside a preceding line must NOT desync data-task-line index from toggleTaskLine
    const loneCrDoc = 'Intro\rinline\n- [ ] Task after lone CR\n';
    const loneCrRoot = parseFragment(renderMarkdownHtml(loneCrDoc, { interactiveTasks: true }));
    const loneCrCheck = loneCrRoot.querySelector('input[type="checkbox"][data-task-line]');
    assert.equal(loneCrCheck.getAttribute('data-task-line'), '1');
    assert.equal(
      toggleTaskLine(loneCrDoc, Number(loneCrCheck.getAttribute('data-task-line'))),
      'Intro\rinline\n- [x] Task after lone CR\n'
    );
  });
});

describe('ui/markdown.js — applyEditorListEnter & applyEditorTabIndent', () => {
  it('continues bullets, increments ordered lists, resets task checkboxes, and exits on empty marker', () => {
    assert.equal(applyEditorListEnter('Plain paragraph', 15, 15), null);

    const contBullet = applyEditorListEnter('  * First bullet', 16, 16);
    assert.deepEqual(contBullet, {
      value: '  * First bullet\n  * ',
      cursor: 21,
    });

    const exitEmptyBullet = applyEditorListEnter('Header\n- ', 9, 9);
    assert.deepEqual(exitEmptyBullet, {
      value: 'Header\n',
      cursor: 7,
    });

    const contOrdered = applyEditorListEnter('1. Step one', 11, 11);
    assert.deepEqual(contOrdered, {
      value: '1. Step one\n2. ',
      cursor: 15,
    });

    const exitEmptyOrdered = applyEditorListEnter('2. ', 3, 3);
    assert.deepEqual(exitEmptyOrdered, {
      value: '',
      cursor: 0,
    });

    const contTask = applyEditorListEnter('- [x] Finished item', 19, 19);
    assert.deepEqual(contTask, {
      value: '- [x] Finished item\n- [ ] ',
      cursor: 26,
    });

    const exitEmptyTask = applyEditorListEnter('- [ ] ', 6, 6);
    assert.deepEqual(exitEmptyTask, {
      value: '',
      cursor: 0,
    });

    const insideFence = '```sh\n- echo hi';
    assert.equal(applyEditorListEnter(insideFence, insideFence.length, insideFence.length), null);
  });

  it('indents and outdents single-line and multi-line selections by 2 spaces with exact selection offsets', () => {
    const singleIndent = applyEditorTabIndent('- item', 2, 6, false);
    assert.deepEqual(singleIndent, { value: '  - item', start: 4, end: 8 });

    const singleOutdent = applyEditorTabIndent('  - item', 4, 8, true);
    assert.deepEqual(singleOutdent, { value: '- item', start: 2, end: 6 });

    const oneSpaceOutdent = applyEditorTabIndent(' - item', 1, 1, true);
    assert.deepEqual(oneSpaceOutdent, { value: '- item', start: 0, end: 0 });

    const noSpaceOutdent = applyEditorTabIndent('- item', 2, 2, true);
    assert.deepEqual(noSpaceOutdent, { value: '- item', start: 2, end: 2 });

    const multi = 'alpha\nbeta\ngamma';
    const multiIndented = applyEditorTabIndent(multi, 2, 9, false);
    assert.deepEqual(multiIndented, {
      value: '  alpha\n  beta\ngamma',
      start: 4,
      end: 13,
    });

    const multiOutdented = applyEditorTabIndent(multiIndented.value, multiIndented.start, multiIndented.end, true);
    assert.deepEqual(multiOutdented, {
      value: multi,
      start: 2,
      end: 9,
    });

    // Selection ending right after newline at col 0 of line 3 must only indent lines 1 & 2
    const lineBoundaryIndent = applyEditorTabIndent(multi, 0, 11, false);
    assert.deepEqual(lineBoundaryIndent, {
      value: '  alpha\n  beta\ngamma',
      start: 2,
      end: 15,
    });

    // selectionStart === 0 when text starts with '\n' must NOT duplicate the leading newline
    assert.deepEqual(applyEditorTabIndent('\n- item', 0, 0, false), {
      value: '  \n- item',
      start: 2,
      end: 2,
    });
    assert.deepEqual(applyEditorTabIndent('\n  - item', 0, 0, true), {
      value: '\n  - item',
      start: 0,
      end: 0,
    });
    assert.deepEqual(applyEditorTabIndent('  \n  - item', 0, 0, true), {
      value: '\n  - item',
      start: 0,
      end: 0,
    });
  });

  it('processes pathological 256 KB boundary-heavy cards and 40 KB+ heading/bracket inputs in linear time (< 100ms)', () => {
    const pathologicalCard = 'a+'.repeat(128_000);
    const t0 = performance.now();
    const cardOut = renderCardInlineHtml(pathologicalCard);
    const cardMs = performance.now() - t0;
    assert.equal(cardOut.length, pathologicalCard.length);
    assert.ok(cardMs < 100, `Expected renderCardInlineHtml < 100ms on 256 KB pathological input, took ${cardMs.toFixed(1)}ms`);

    const pathologicalCardWithUrl = `https://x.io/#frag ${'a+'.repeat(128_000)} #bug`;
    const tUrl = performance.now();
    const cardUrlOut = renderCardInlineHtml(pathologicalCardWithUrl);
    const cardUrlMs = performance.now() - tUrl;
    assert.match(cardUrlOut, /data-inline-tag="bug"/);
    assert.ok(cardUrlMs < 100, `Expected BARE_URL_RE < 100ms on 256 KB card containing ://, took ${cardUrlMs.toFixed(1)}ms`);

    const pathologicalHeading = `# ${' '.repeat(25_000)}#${' '.repeat(25_000)}x`;
    const t1 = performance.now();
    const mdOut = renderMarkdownHtml(pathologicalHeading);
    const mdMs = performance.now() - t1;
    assert.match(mdOut, /^<h1>/);
    assert.ok(mdMs < 100, `Expected renderMarkdownHtml < 100ms on pathological heading, took ${mdMs.toFixed(1)}ms`);

    const trimmedHashesHeading = renderMarkdownHtml('## Clean Heading   ###   ');
    assert.equal(trimmedHashesHeading, '<h2>Clean Heading</h2>');

    const pathologicalBrackets = '[a]('.repeat(20_000);
    const t2 = performance.now();
    renderMarkdownHtml(pathologicalBrackets);
    const bracketMs = performance.now() - t2;
    assert.ok(bracketMs < 100, `Expected scanLinksInText < 100ms on pathological unclosed links, took ${bracketMs.toFixed(1)}ms`);

    // 1. 256 KB repeated '[a](' with a single trailing ')'
    const trailingParen256k = `${'[a]('.repeat(64_000)})`;
    const t3 = performance.now();
    const outTrailingParen = renderCardInlineHtml(trailingParen256k);
    const ms3 = performance.now() - t3;
    assert.ok(outTrailingParen.endsWith('a'), 'Final [a]() should neutralize empty href to label "a"');
    assert.ok(ms3 < 100, `Expected < 100ms on '[a]('.repeat(64_000) + ')', took ${ms3.toFixed(1)}ms`);

    // 2. ~240 KB repeated '[a](http://x' with a single trailing ')'
    const repeatedHttp240k = `${'[a](http://x'.repeat(20_000)})`;
    const t4 = performance.now();
    const outRepeatedHttp = renderCardInlineHtml(repeatedHttp240k);
    const ms4 = performance.now() - t4;
    assert.match(outRepeatedHttp, /<a href="http:\/\/x" target="_blank" rel="noopener noreferrer">a<\/a>$/);
    assert.ok(ms4 < 100, `Expected < 100ms on '[a](http://x'.repeat(20_000) + ')', took ${ms4.toFixed(1)}ms`);

    // 3a. 256 KB leading '[' before non-link ']x' followed by valid '[b](https://x.io)'
    const openBracketsNonLink = `${'['.repeat(255_900)}]x [b](https://x.io)`;
    const t5 = performance.now();
    const outOpenNonLink = renderCardInlineHtml(openBracketsNonLink);
    const ms5 = performance.now() - t5;
    assert.ok(
      outOpenNonLink.endsWith(']x <a href="https://x.io" target="_blank" rel="noopener noreferrer">b</a>'),
      'Trailing [b](https://x.io) must render as safe anchor after 255,900 open brackets'
    );
    assert.ok(ms5 < 100, `Expected < 100ms on '['.repeat(255_900) + ']x [b](https://x.io)', took ${ms5.toFixed(1)}ms`);

    // 3b. 256 KB leading '[' directly forming innermost '[a](https://x.io)'
    const openBracketsInnerLink = `${'['.repeat(255_900)}a](https://x.io)`;
    const t6 = performance.now();
    const outOpenInner = renderCardInlineHtml(openBracketsInnerLink);
    const ms6 = performance.now() - t6;
    assert.equal(
      outOpenInner,
      `${'['.repeat(255_899)}<a href="https://x.io" target="_blank" rel="noopener noreferrer">a</a>`
    );
    assert.ok(ms6 < 100, `Expected < 100ms on '['.repeat(255_900) + 'a](https://x.io)', took ${ms6.toFixed(1)}ms`);
  });

  it('cycles ordered markers 1. -> a. -> i. on Tab (3-space indent), resumes parent style on Shift+Tab / empty Enter, preserves manual overrides, and renders card #tags', () => {
    // 1. Tab outline cycle: 1. hello ->    a. sdfsdf ->       i. dsfdsf ->          1. wrap
    let doc = '1. hello';
    doc = applyEditorListEnter(doc, doc.length, doc.length).value;
    assert.equal(doc, '1. hello\n2. ');

    const level1 = applyEditorTabIndent(doc, doc.length, doc.length, false);
    assert.deepEqual(level1, {
      value: '1. hello\n   a. ',
      start: 15,
      end: 15,
    });

    doc = `${level1.value}sdfsdf`;
    doc = applyEditorListEnter(doc, doc.length, doc.length).value;
    assert.equal(doc, '1. hello\n   a. sdfsdf\n   b. ');

    const level2 = applyEditorTabIndent(doc, doc.length, doc.length, false);
    assert.deepEqual(level2, {
      value: '1. hello\n   a. sdfsdf\n      i. ',
      start: 31,
      end: 31,
    });

    doc = `${level2.value}dsfdsf`;
    doc = applyEditorListEnter(doc, doc.length, doc.length).value;
    assert.equal(doc, '1. hello\n   a. sdfsdf\n      i. dsfdsf\n      ii. ');

    // Wrapping depth 3 -> cycles roman back to digit ('         1. ')
    const level3 = applyEditorTabIndent(doc, doc.length, doc.length, false);
    assert.equal(level3.value, '1. hello\n   a. sdfsdf\n      i. dsfdsf\n         1. ');

    // Enter on empty nested marker steps back up: '      ii. ' -> '   b. ' -> '2. ' -> ''
    const upToAlpha = applyEditorListEnter(doc, doc.length, doc.length);
    assert.deepEqual(upToAlpha, {
      value: '1. hello\n   a. sdfsdf\n      i. dsfdsf\n   b. ',
      cursor: 44,
    });
    const upToDigit = applyEditorListEnter(upToAlpha.value, upToAlpha.cursor, upToAlpha.cursor);
    assert.deepEqual(upToDigit, {
      value: '1. hello\n   a. sdfsdf\n      i. dsfdsf\n2. ',
      cursor: 41,
    });
    const exited = applyEditorListEnter(upToDigit.value, upToDigit.cursor, upToDigit.cursor);
    assert.deepEqual(exited, {
      value: '1. hello\n   a. sdfsdf\n      i. dsfdsf\n',
      cursor: 38,
    });

    // 2. Indenting middle item of [1. Alpha, 2. Beta, 3. Gamma] cycles 2. -> '   a.' and renumbers sibling 3. -> 2.
    const threeItems = '1. Alpha\n2. Beta\n3. Gamma';
    const midStart = threeItems.indexOf('2. Beta');
    const midIndented = applyEditorTabIndent(threeItems, midStart + 3, midStart + 3, false);
    assert.equal(midIndented.value, '1. Alpha\n   a. Beta\n2. Gamma');

    // Indenting middle item of Roman list [i..v] renumbers 'v. Five' -> 'iv. Five'
    const romanFive = '1. Top\n   a. Sub\n      i. One\n      ii. Two\n      iii. Three\n      iv. Four\n      v. Five';
    const ivPos = romanFive.indexOf('iv. Four');
    const romanIndented = applyEditorTabIndent(romanFive, ivPos, ivPos, false);
    assert.match(romanIndented.value, /\n         1\. Four\n      iv\. Five$/);

    // 3. Shift+Tab on nested "   b. " resumes outer numbering at "2. ", and preserves manual numeric sub-list overrides
    const nestedAlpha = '1. Step one\n   a. Sub A\n   b. ';
    const outdented = applyEditorTabIndent(nestedAlpha, nestedAlpha.length, nestedAlpha.length, true);
    assert.deepEqual(outdented, {
      value: '1. Step one\n   a. Sub A\n2. ',
      start: 27,
      end: 27,
    });

    const manualNumericSub = '1. Step one\n   1. Manual sub';
    assert.equal(
      applyEditorListEnter(manualNumericSub, manualNumericSub.length, manualNumericSub.length)?.value,
      '1. Step one\n   1. Manual sub\n   2. '
    );

    // 4. Enter on empty indented bullet outdents one level first, then exits on second Enter
    const emptyIndentedBullet = applyEditorListEnter('- Top\n  - ', 10, 10);
    assert.deepEqual(emptyIndentedBullet, { value: '- Top\n- ', cursor: 8 });
    const exitedBullet = applyEditorListEnter(emptyIndentedBullet.value, emptyIndentedBullet.cursor, emptyIndentedBullet.cursor);
    assert.deepEqual(exitedBullet, { value: '- Top\n', cursor: 6 });

    // 5. Alphabetic lists (a. -> b., middle insertion renumbering, and h. -> i. -> j. without Roman false positive)
    assert.equal(applyEditorListEnter('a. First', 8, 8)?.value, 'a. First\nb. ');
    assert.equal(applyEditorListEnter('a. First\nb. Third', 8, 8)?.value, 'a. First\nb. \nc. Third');
    const alphaHi = 'h. Eighth\ni. Ninth';
    assert.equal(applyEditorListEnter(alphaHi, alphaHi.length, alphaHi.length)?.value, 'h. Eighth\ni. Ninth\nj. ');

    // 6. Roman numeral lists (i. -> ii. -> iii. -> iv. -> v. -> vi.)
    let rom = 'i. One';
    rom = `${applyEditorListEnter(rom, rom.length, rom.length).value}Two`;
    rom = `${applyEditorListEnter(rom, rom.length, rom.length).value}Three`;
    rom = `${applyEditorListEnter(rom, rom.length, rom.length).value}Four`;
    rom = `${applyEditorListEnter(rom, rom.length, rom.length).value}Five`;
    const romNext = applyEditorListEnter(rom, rom.length, rom.length).value;
    assert.match(romNext, /\nii\. Two\niii\. Three\niv\. Four\nv\. Five\nvi\. $/);

    // 7. isListLineAtSelection distinguishes list lines / selections from plain prose
    assert.equal(isListLineAtSelection('Plain sentence', 5, 5), false);
    assert.equal(isListLineAtSelection('Plain sentence', 0, 5), true);
    assert.equal(isListLineAtSelection('   a. Ordered item', 6, 6), true);
    assert.equal(isListLineAtSelection('- [ ] Task item', 8, 8), true);

    // 8. Nested 3-level 1. -> a. -> i. + #tag highlighting in renderMarkdownHtml
    const cardMd = [
      'Check **urgent #bug_fix** and `code #ignored`',
      '',
      '1. hello #todo',
      '   a. sdfsdf',
      '      i. dsfdsf',
    ].join('\n');
    const cardRoot = parseFragment(renderMarkdownHtml(cardMd, { interactiveTasks: true, tagColors: { bug_fix: 'rose' } }));
    assert.equal(cardRoot.querySelector('strong .notes-inline-tag')?.getAttribute('data-inline-tag'), 'bug_fix');
    assert.equal(cardRoot.querySelectorAll('[data-inline-tag]').length, 2);
    assert.ok(cardRoot.querySelector('ol > ol[type="a"] > ol[type="i"]'), 'Expected 3-level <ol> -> <ol type="a"> -> <ol type="i">');
  });
});
