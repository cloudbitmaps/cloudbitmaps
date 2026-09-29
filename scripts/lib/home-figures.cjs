'use strict';
/**
 * The display-tier homepage, held figure by figure (site-next/index.html, read by scripts/site-figures.cjs).
 *
 * Every check here reads the page as the browser does. A small tokenizer splits it where the browser's does, so a
 * comment ends at `<!-->` or `--!>`, a quote opens a value only after `=`, a `/` closes a tag only where it is its own,
 * a script runs to its own end tag and a `<` that opens no tag is text. The view the checks match against has every
 * comment, template, script, sheet and title blanked, and every attribute's value but `class`, `id` and `scope`, so a
 * check cannot pass on a copy no reader sees, nor on one kept in an attribute; a check whose match still reaches into
 * an attribute fails. Each check marks the exact span it verified. What no check marked is then read for numbers:
 * the visible text, SVG labels and CDATA included, the title, and the attributes that carry prose (`aria-label` and
 * the other names and values read aloud, `alt`, `title`, `placeholder`, `value`, and the descriptions a search result
 * or a link preview shows). Any number left is a failure, and so is a number in such an attribute inside a span a
 * check read, since the check compared the text and not the attribute. So a figure is gated where it stands: a wrong
 * number that happens to equal a true one elsewhere on the page, a second unchecked copy of a checked figure, or a
 * new figure no check knows, all fail. That is what lets the page's footer say every figure on it is gated in CI.
 *
 * Prose that carries a figure is compared whole, against a string built from the sources, so the words around a
 * figure cannot turn its meaning while the figure stays right.
 *
 * The page's drawings of the scale run and its crossover chart are generated (bench/scale.cjs, bench/run.cjs) and
 * held byte for byte by `pnpm bench:scale:check` and `pnpm bench:check`, so their regions count as verified here.
 * Figures are numerals, in any script's digits, fractions included, and digits glued to a letter (`USD1200`) but for
 * the two names the page writes that way: a number written as a word ("three nodes") is prose, and is not read.
 *
 * The page may not carry what would show a reader text no check reads, or hide what one does:
 *
 * - an element that hides, embeds or draws: `hidden`, `popover`, `<template>`, `<details>`, `<dialog>`, `<iframe>`,
 *   `<object>`, `<embed>`, an image of any kind or a `background` attribute, a canvas, a video or an audio player,
 *   HTML or MathML inside SVG, a `<use>` of another file, a `data:` URL;
 * - markup these checks do not parse as the browser does: `<xmp>`, `<textarea>`, `<plaintext>`, `<noscript>`, a
 *   second title or one in the body, a `<!--` inside a script, a script inside SVG, an HTML tag that ends an SVG;
 * - a script no one has read: every script is pinned by its SHA-256, so one that changes is refused until it is read
 *   again, and there may be no handler attribute, `javascript:` link or module;
 * - digits drawn in another order, or passing for others: a `dir` other than `ltr`, `<bdo>`, `<bdi>`, a
 *   bidirectional mark or override, a right-to-left letter, a letter from a script other than Latin or Greek, or a
 *   sheet rule that sets a direction;
 * - a sheet that adds text: a `<style>` element or a second sheet, a `content` string other than arrows and middle
 *   dots unless it is one written for its rule, on a page that does not wear that rule's class, quotation marks, list
 *   markers, counters, emphasis marks, a first letter or line styled apart, a `url()` anywhere, a font, an import;
 * - a sheet that hides or turns text in a way site-text-floor does not measure: a shadow, a wide outline, a gradient,
 *   a stroke painted over the letters, a reflection, a font size adjustment, a hyphenation character, an individual
 *   scale, rotation or translation, a turned, mirrored or 3D transform, containment, skipped rendering, a blend, a
 *   thick decoration, lines laid over each other, a font outside the sheet's two stacks, an animation that never
 *   ends, or any `!important`, which could out-rank the sheets the browser pass adds while it looks;
 * - a sheet rule for a reader site-text-floor does not become: `@supports`, `@container`, a media feature other than
 *   width and motion (the theme is the page's `data-theme` stamp, and print stands alone), a size that follows the
 *   viewport's height or does arithmetic on its width, an animation tied to scrolling, the system's colours or an
 *   opt-out of forced colours, or, for a reader hovering,
 *   focusing or following a link, anything but a colour, a ground, a border colour, a decoration or an outline;
 * - a base URL or a refresh, structured data, an inline style other than a custom property, or a character reference
 *   this does not decode, in the text, an attribute or the title. Every meta's content is read but for a short list
 *   whose content is not prose.
 *
 * What it holds, and what it does not: it holds the page against the edits a maintainer makes, a figure changed,
 * added, left stale, reworded around, moved into a comment or out of view, or copied into an attribute, and against
 * the markup and sheet tricks listed above. It reads the page and the sheet, not the layout: a box laid over a
 * figure, or a rule that fades one out after load, is site-text-floor's to catch, which finds every word on the page
 * where Chrome draws it, checks that its letters change the pixels there, and counts the figures Chrome built into the
 * page against the ones read here
 * (`readerFigures`), so a construct this reader and the browser parse apart fails there. What neither reads is where
 * the layout puts a word: a grid or an `order` that moves a held figure beside another's label. That is review's.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

// A numeral in any script (`９`, `𝟿`), a leading-dot decimal (`$.50`) or a fraction or numeric symbol (`½`, `²`).
// Digits glued to a letter are read by `GLUED` below.
const NUMBER = /(?<![\p{L}\p{N}_.])(?:\p{Nd}[\p{Nd},]*(?:\.\p{Nd}+)?|\.\p{Nd}+)|[\p{No}\p{Nl}]/gu;
/**
 * A word with a digit glued to a letter (`USD1200`, `x3290`) says a figure too, and is read as one, but for the names
 * the page writes that are names and not figures: a package (`@cloudbitmaps/s3`) and a percentile (`p99`). A version
 * is held where it stands.
 */
const GLUED = /[\p{L}\p{N}_]*\p{L}\p{Nd}[\p{L}\p{N}_]*/gu;
const NAMES_WITH_DIGITS = new Set(['s3', 'p99']);
const NAMED = {
  nbsp: ' ',
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  rarr: '→',
  larr: '←',
  middot: '·',
  mdash: '—',
  ndash: '–',
  rsquo: '’',
  lsquo: '‘',
  ldquo: '“',
  rdquo: '”',
  times: '×',
  divide: '÷',
  hellip: '…',
  bull: '•',
  copy: '©',
  reg: '®',
  trade: '™',
  le: '≤',
  ge: '≥',
  laquo: '«',
  raquo: '»',
  minus: '−',
  thinsp: ' ',
  ensp: ' ',
  emsp: ' ',
  // Invisible, so that a claim or a figure written with one between its letters still reads as a reader sees it.
  shy: '\u00ad',
  zwsp: '\u200b',
  zwj: '\u200d',
  zwnj: '\u200c',
  lrm: '\u200e',
  rlm: '\u200f',
};

/** A character a numeric reference names, as a browser reads it: one out of range is the replacement character. */
function codePoint(n) {
  return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff)
    ? String.fromCodePoint(n)
    : '\ufffd';
}

/** Every character reference decoded, so `&#57;` is read as the 9 it renders, with or without its `;`, as a browser reads it. */
function decode(s) {
  return s
    .replace(/&#x([0-9a-f]+);?/gi, (_, hex) => codePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);?/g, (_, dec) => codePoint(Number(dec)))
    .replace(/&([a-z]+);/gi, (m, name) => NAMED[name.toLowerCase()] ?? m);
}

/**
 * The page split as a browser's tokenizer splits it, so that every check reads what the browser reads: text, start
 * and end tags with their attributes, comments, and the raw text of the elements whose content is not markup. A
 * subset of the HTML tokenizer, enough that no construct shows text the checks do not see or hides text they do:
 * a comment ends where the browser ends it (`<!-->`, `<!--->`, `--!>`), a quote opens a value only after `=`, an
 * unquoted value runs to a space or `>`, a raw-text element runs to its own end tag, CDATA is text inside SVG and
 * MathML, and a `<` that starts no tag is text. What it does not follow, a script's escaped states and content that
 * leaves SVG through an HTML tag, the homepage checks refuse.
 */
const RAW_TEXT = new Set([
  'script',
  'style',
  'xmp',
  'iframe',
  'noembed',
  'noframes',
  'noscript',
  'textarea',
  'title',
]);
const SPACE = /[\t\n\f\r ]/;

/**
 * A tag's attributes from `p`, just past its name, to its `>`, as the browser reads them: the first of a name wins.
 * With each value, where it stands (`values`), and whether the tag closes itself: a `/` that is its own, right before
 * the `>`, not the last character of an unquoted value.
 */
function scanAttrs(html, p) {
  const attrs = {};
  const values = {};
  const n = html.length;
  let selfClosing = false;
  for (;;) {
    while (p < n && (SPACE.test(html[p]) || html[p] === '/')) {
      selfClosing = html[p] === '/' && html[p + 1] === '>';
      p++;
    }
    if (p >= n) return { attrs, values, end: n, selfClosing };
    if (html[p] === '>') return { attrs, values, end: p + 1, selfClosing };
    selfClosing = false;
    let q = p + 1;
    while (q < n && !SPACE.test(html[q]) && !'/>='.includes(html[q])) q++;
    const name = html.slice(p, q).toLowerCase();
    p = q;
    while (p < n && SPACE.test(html[p])) p++;
    let at = [p, p];
    if (html[p] === '=') {
      p++;
      while (p < n && SPACE.test(html[p])) p++;
      const quote = html[p];
      if (quote === '"' || quote === "'") {
        const close = html.indexOf(quote, p + 1);
        at = [p + 1, close === -1 ? n : close];
        p = close === -1 ? n : close + 1;
      } else {
        const from = p;
        while (p < n && !SPACE.test(html[p]) && html[p] !== '>') p++;
        at = [from, p];
      }
    }
    if (!(name in attrs)) {
      attrs[name] = decode(html.slice(...at));
      values[name] = at;
    }
  }
}

/** The end of a tag's name, which runs from `p` to a space, a `/` or a `>`. */
function nameEnd(html, p) {
  while (p < html.length && !SPACE.test(html[p]) && html[p] !== '/' && html[p] !== '>') p++;
  return p;
}

/**
 * Every token of the page, in order, each with where it starts and ends: `text`, `start` (with its attributes and
 * whether it stands inside SVG or MathML), `end`, `comment`, `doctype`, `cdata` and `raw`, the content of a
 * raw-text element.
 */
function tokens(html) {
  const out = [];
  const n = html.length;
  let foreign = 0;
  let textFrom = 0;
  let i = 0;
  const upTo = (from, needle) => {
    const at = html.indexOf(needle, from);
    return at === -1 ? n : at + needle.length;
  };
  const push = (token) => {
    if (token.start > textFrom) out.push({ type: 'text', start: textFrom, end: token.start });
    out.push(token);
    textFrom = token.end;
  };
  while (i < n) {
    const lt = html.indexOf('<', i);
    if (lt === -1) break;
    const next = html[lt + 1] ?? '';
    let token = null;
    if (html.startsWith('<!--', lt)) {
      let end;
      if (html[lt + 4] === '>') end = lt + 5;
      else if (html.startsWith('->', lt + 4)) end = lt + 6;
      else {
        const close = /--!?>/g;
        close.lastIndex = lt + 4;
        const m = close.exec(html);
        end = m ? m.index + m[0].length : n;
      }
      token = { type: 'comment', start: lt, end };
    } else if (foreign > 0 && html.startsWith('<![CDATA[', lt)) {
      const close = html.indexOf(']]>', lt + 9);
      const stop = close === -1 ? n : close;
      token = {
        type: 'cdata',
        start: lt,
        end: close === -1 ? n : close + 3,
        inner: [lt + 9, stop],
      };
    } else if (next === '!' || next === '?') {
      const type = /^<!doctype/i.test(html.slice(lt, lt + 9)) ? 'doctype' : 'comment';
      token = { type, start: lt, end: upTo(lt + 2, '>') };
    } else if (next === '/') {
      const after = html[lt + 2] ?? '';
      if (/[a-z]/i.test(after)) {
        const q = nameEnd(html, lt + 3);
        const name = html.slice(lt + 2, q).toLowerCase();
        const { values, end } = scanAttrs(html, q);
        token = { type: 'end', name, start: lt, end, values };
        if ((name === 'svg' || name === 'math') && foreign > 0) foreign--;
      } else if (after === '>') {
        token = { type: 'comment', start: lt, end: lt + 3 };
      } else {
        token = { type: 'comment', start: lt, end: upTo(lt + 2, '>') };
      }
    } else if (/[a-z]/i.test(next)) {
      const q = nameEnd(html, lt + 2);
      const name = html.slice(lt + 1, q).toLowerCase();
      const { attrs, values, end, selfClosing } = scanAttrs(html, q);
      token = { type: 'start', name, start: lt, end, attrs, values, foreign: foreign > 0 };
      if ((name === 'svg' || name === 'math') && !selfClosing) foreign++;
      if (!token.foreign && RAW_TEXT.has(name)) {
        push(token);
        const close = new RegExp(`</${name}(?=[\\t\\n\\f\\r />])`, 'ig');
        close.lastIndex = end;
        const m = close.exec(html);
        const stop = m ? m.index : n;
        push({ type: 'raw', name, start: end, end: stop });
        i = stop;
        continue;
      }
    }
    if (token === null) {
      i = lt + 1; // a `<` that starts nothing is text
      continue;
    }
    push(token);
    i = token.end;
  }
  if (n > textFrom) out.push({ type: 'text', start: textFrom, end: n });
  return out;
}

/** What a token shows a reader: text decoded, CDATA as written, a `<br>` a break, and everything else `between`. */
const shown = (html, t, between) =>
  t.type === 'text'
    ? decode(html.slice(t.start, t.end))
    : t.type === 'cdata'
      ? html.slice(...t.inner)
      : t.type === 'start' && t.name === 'br'
        ? ' '
        : between;

/** An element's text as a reader gets it: its text and CDATA, references decoded, a `<br>` a space, spaces folded. */
const textOf = (html) =>
  tokens(html)
    .map((t) => shown(html, t, ''))
    .join('')
    .replace(/\s+/g, ' ')
    .trim();

/** The page's text for the last scan, every tag, comment and raw run a space, so no two figures join. */
const proseText = (html) =>
  tokens(html)
    .map((t) => shown(html, t, ' '))
    .join('');

/**
 * The text a scan of the other pages reads, where no check marks spans and more is safer than less: the text, CDATA
 * and title, what a text field, an `<xmp>` or a fallback element holds, and with `comments`, what a comment says,
 * since `view-source` is public too. Only a script's code and a sheet's rules are left out.
 */
function scanText(html, { comments = false } = {}) {
  return tokens(html)
    .map((t) => {
      const inner = html.slice(t.start, t.end);
      if (t.type === 'comment') return comments ? ` ${inner.replace(/^<!--|-->$/g, '')} ` : ' ';
      if (t.type !== 'raw') return shown(html, t, ' ');
      if (t.name === 'script' || t.name === 'style') return ' ';
      if (t.name === 'title' || t.name === 'textarea') return ` ${decode(inner)} `;
      if (t.name === 'xmp') return ` ${inner} `;
      return ` ${scanText(inner, { comments })} `;
    })
    .join('');
}

/** The page with its scripts' code and sheets' rules blanked, the same length, so a pattern over it meets neither. */
const withoutCode = (html) =>
  blankSpans(
    html,
    tokens(html)
      .filter((t) => t.type === 'raw' && (t.name === 'script' || t.name === 'style'))
      .map((t) => [t.start, t.end]),
  );

/** The generated regions' markers, the one kind of comment the checks read. */
const BENCH_MARKER = /^<!-- BENCH:[A-Z]+:(?:START|END) -->$/;

/** The page with the given spans blanked to spaces, the same length, so every position still points where it did. */
function blankSpans(html, spans) {
  const chars = html.split('');
  for (const [a, b] of spans) for (let k = a; k < b; k++) if (chars[k] !== '\n') chars[k] = ' ';
  return chars.join('');
}

/** A page without its comments, ended where the browser ends them. */
const withoutComments = (html) =>
  tokens(html)
    .map((t) => (t.type === 'comment' ? '' : html.slice(t.start, t.end)))
    .join('');

/** The attributes whose values the checks match on, kept in the rendered view with only word characters left. */
const MATCHED_ATTRS = new Set(['class', 'id', 'scope']);

/**
 * The page as it renders, the same length as the page: every comment but the generated regions' markers, every raw
 * run (a script's code, a sheet's rules, a title's text), every template and CDATA's delimiters are blanked, and so is
 * every attribute's value but the few the checks match on, which keep only their word characters. A check matched
 * against this cannot match what no reader sees, nor a copy of a figure, or of an end tag, kept in an attribute.
 */
function rendered(html) {
  const spans = [];
  const scrub = [];
  let template = null;
  let depth = 0;
  for (const t of tokens(html)) {
    if (t.type === 'start' || t.type === 'end') {
      for (const [name, at] of Object.entries(t.values))
        (MATCHED_ATTRS.has(name) ? scrub : spans).push(at);
    }
    if (t.type === 'start' && t.name === 'template') {
      if (depth++ === 0) template = t.start;
    } else if (t.type === 'end' && t.name === 'template' && depth > 0) {
      if (--depth === 0) spans.push([template, t.end]);
    } else if (t.type === 'comment' && !BENCH_MARKER.test(html.slice(t.start, t.end))) {
      spans.push([t.start, t.end]);
    } else if (t.type === 'raw') {
      spans.push([t.start, t.end]);
    } else if (t.type === 'cdata') {
      spans.push([t.start, t.inner[0]], [t.inner[1], t.end]);
    }
  }
  if (depth > 0) spans.push([template, html.length]);
  const chars = blankSpans(html, spans).split('');
  for (const [a, b] of scrub)
    for (let k = a; k < b; k++) if (!/[\w -]/.test(chars[k])) chars[k] = ' ';
  return chars.join('');
}

/** Every start tag, with where it stands and its attributes. */
const tagsOf = (html) => tokens(html).filter((t) => t.type === 'start');

/** The attributes a reader is read or shown, and the meta tags whose content is prose. */
const PROSE_ATTRS = [
  'aria-label',
  'aria-description',
  'aria-roledescription',
  'aria-valuetext',
  'aria-valuenow',
  'aria-valuemin',
  'aria-valuemax',
  'aria-placeholder',
  'aria-setsize',
  'aria-posinset',
  'aria-rowcount',
  'aria-colcount',
  'aria-rowindex',
  'aria-colindex',
  'aria-rowindextext',
  'aria-colindextext',
  'aria-braillelabel',
  'aria-brailleroledescription',
  'abbr',
  'alt',
  'title',
  'placeholder',
  'value',
  'label',
];
/** The meta keys whose content is not prose: what the page is, where it lives and how it is laid out. Every other
 * meta's content is read, since a search result or a link preview may show it. */
const NON_PROSE_METAS = new Set([
  'viewport',
  'og:type',
  'og:url',
  'og:image',
  'twitter:card',
  'twitter:image',
  'google-site-verification',
  'theme-color',
  'color-scheme',
  'robots',
  'referrer',
]);
/** Every key a meta tag is found by: its name, property and itemprop, as a browser or an unfurler reads them. */
const metaKeys = (t) =>
  ['name', 'property', 'itemprop']
    .map((a) => t.attrs[a])
    .filter((v) => v !== undefined)
    .map((v) => v.toLowerCase());
const isProseMeta = (t) =>
  t.name === 'meta' && 'content' in t.attrs && metaKeys(t).some((k) => !NON_PROSE_METAS.has(k));
/** The prose a tag carries in its attributes: what a reader is read aloud or shown, and a meta's description. */
const proseOf = (t) => [
  ...PROSE_ATTRS.filter((a) => t.attrs[a] !== undefined).map((a) => t.attrs[a]),
  ...(isProseMeta(t) ? [t.attrs.content ?? ''] : []),
];

/**
 * The spans of a page that checks have verified, over the page as it renders. A span that reaches into an attribute's
 * value without holding its whole tag is kept apart as `strays`: a check read words no reader sees as text, and
 * `finish()` refuses it.
 */
function ledger(page) {
  const marks = [];
  const strays = [];
  const html = rendered(page);
  const values = tokens(page).flatMap((t) =>
    t.type === 'start' || t.type === 'end'
      ? Object.values(t.values)
          .filter(([a, b]) => b > a)
          .map(([a, b]) => ({ a, b, tag: [t.start, t.end] }))
      : [],
  );
  return {
    raw: page,
    html,
    marks,
    strays,
    mark(start, end) {
      if (!(start >= 0 && end > start)) return;
      const inside = values.some(
        (v) => v.a < end && start < v.b && !(start <= v.tag[0] && v.tag[1] <= end),
      );
      (inside ? strays : marks).push([start, end]);
    },
    /** The rendered view with every verified span blanked, the same length, so nothing joins across a span. */
    rest() {
      return blankSpans(html, marks);
    },
  };
}

/** Every match of `re` with its groups' positions. */
const matches = (html, re) => [
  ...html.matchAll(new RegExp(re.source, [...new Set(`${re.flags}gd`)].join(''))),
];

/** A CSS escape decoded: `\6f ` is `o`, `\'` is `'`, and an escaped line break is nothing. */
const cssUnescape = (s) =>
  s.replace(/\\(?:([0-9a-f]{1,6})[\t\n ]?|(\n)|([\s\S]))/gi, (_, hex, line, ch) =>
    hex ? codePoint(parseInt(hex, 16)) : line ? '' : ch,
  );

/** A sheet's line breaks as the browser reads them before anything else: a CR, a CRLF or a form feed is a line feed. */
const cssNewlines = (sheet) => sheet.replace(/\r\n?|\f/g, '\n');

/**
 * A stylesheet's declarations, each with the selector of the rule it sits in, read as the browser reads the sheet:
 * line breaks are normalised first, a comment opens only outside a string and an unquoted `url()`, a string runs to
 * its closing quote or the end of its line, and escapes are decoded after the sheet is split, in one pass, so `c\6f ntent` is `content` and `'\''` is a quote inside a string. At-rules are
 * returned by name `@`, with their prelude as the value.
 */
function cssDeclarations(source) {
  const sheet = cssNewlines(source);
  const out = [];
  const stack = [];
  let buf = '';
  let depth = 0; // parentheses, inside which `;` and braces end nothing
  const flush = () => {
    const text = buf.trim();
    buf = '';
    if (text.startsWith('@')) {
      out.push({ selector: stack.at(-1) ?? '', name: '@', value: cssUnescape(text) });
      return;
    }
    const colon = text.indexOf(':');
    if (colon === -1 || stack.length === 0) return;
    out.push({
      selector: stack.at(-1),
      name: cssUnescape(text.slice(0, colon)).trim().toLowerCase(),
      value: text.slice(colon + 1).trim(),
    });
  };
  for (let i = 0; i < sheet.length; i++) {
    const c = sheet[i];
    if (c === '/' && sheet[i + 1] === '*') {
      const close = sheet.indexOf('*/', i + 2);
      i = close === -1 ? sheet.length : close + 1;
      buf += ' ';
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < sheet.length && sheet[j] !== c && sheet[j] !== '\n')
        j += sheet[j] === '\\' ? 2 : 1;
      buf += c + sheet.slice(i + 1, j) + c;
      i = j;
    } else if (c === '\\') {
      buf += sheet.slice(i, i + 2);
      i++;
    } else if (
      /^url\(\s*[^'"\s)]/i.test(sheet.slice(i, i + 64)) &&
      !/[\w-]/.test(sheet[i - 1] ?? '')
    ) {
      // An unquoted url() is one token to its `)`: a comment does not open inside it.
      const close = sheet.indexOf(')', i);
      const end = close === -1 ? sheet.length : close + 1;
      buf += sheet.slice(i, end);
      i = end - 1;
    } else if (c === '(') {
      depth++;
      buf += c;
    } else if (c === ')') {
      depth = Math.max(0, depth - 1);
      buf += c;
    } else if (depth === 0 && c === '{') {
      const prelude = cssUnescape(buf).replace(/\s+/g, ' ').trim();
      buf = '';
      if (prelude.startsWith('@'))
        out.push({ selector: stack.at(-1) ?? '', name: '@', value: prelude });
      stack.push(prelude);
    } else if (depth === 0 && c === '}') {
      flush();
      stack.pop();
    } else if (depth === 0 && c === ';') {
      flush();
    } else {
      buf += c;
    }
  }
  return out;
}

/** The strings in a declaration's value, decoded, and the rest of it, decoded, with each string left as `""`. */
function cssStrings(value) {
  const strings = [];
  const rest = value.replace(/(["'])((?:\\.|(?!\1)[^\\\n])*)\1?/gs, (_, _q, body) => {
    strings.push(cssUnescape(body));
    return ' "" ';
  });
  return { strings, rest: cssUnescape(rest).replace(/\s+/g, ' ').trim() };
}

/** A width in a media query, however it is written: `min-width: 48em`, `max-width: 1000px`, `width >= 768px`. */
const WIDTH_FEATURE =
  /\(\s*(?:(?:min|max)-width\s*:\s*[\d.]+(?:px|em)|(?:[\d.]+(?:px|em)\s*[<>]=?\s*)?width(?:\s*[<>]=?\s*[\d.]+(?:px|em))?)\s*\)/gi;

/**
 * One width inside each band the sheet's media queries mark out, for the bands none of `standard` falls in: where a
 * rule turns on or off between two widths a pass loads, the pass loads one more. Every width feature flips at a
 * point half a pixel from the width it names (`max-width: 1000px` holds at 1000 and not at 1001), and one width
 * between each two flips, and one past the last, sees every combination the queries make.
 */
function widthsToProbe(source, standard) {
  const flips = new Set();
  const sheet = cssUnescape(cssNewlines(source));
  for (const media of sheet.matchAll(/@media\b([^{]*)\{/gi)) {
    for (const f of media[1].matchAll(WIDTH_FEATURE)) {
      const px = (n, unit) => Number(n) * (unit.toLowerCase() === 'em' ? 16 : 1);
      const feature = /(min|max)-width\s*:\s*([\d.]+)(px|em)/i.exec(f[0]);
      if (feature) {
        flips.add(px(feature[2], feature[3]) + (feature[1].toLowerCase() === 'max' ? 0.5 : -0.5));
        continue;
      }
      // width OP n, and n OP width, read apart so a range (`700px <= width < 48em`) gives both: `<=` and `>` flip
      // above n, `<` and `>=` below it, read from width's side.
      const flip = (op, n, unit) =>
        flips.add(px(n, unit) + (op === '<=' || op === '>' ? 0.5 : -0.5));
      for (const m of f[0].matchAll(/width\s*([<>]=?)\s*([\d.]+)(px|em)/gi)) flip(m[1], m[2], m[3]);
      for (const m of f[0].matchAll(/([\d.]+)(px|em)\s*([<>]=?)\s*width/gi)) {
        flip({ '<': '>', '<=': '>=', '>': '<', '>=': '<=' }[m[3]], m[1], m[2]);
      }
    }
  }
  const sorted = [...flips].sort((a, b) => a - b);
  const bands = sorted
    .map((f, k) => [k === 0 ? 0 : sorted[k - 1], f])
    .concat([[sorted.at(-1) ?? 0, Infinity]]);
  // The narrowest band is loaded at its widest width, so a rule for folded phones below 320px is seen at 319.
  return bands
    .filter(([a, b]) => !standard.some((w) => w > a && w < b))
    .map(([a, b]) =>
      b === Infinity
        ? Math.ceil(a)
        : a === 0
          ? Math.floor(b)
          : Math.max(1, Math.round((a + b) / 2)),
    )
    .filter((w) => w >= 240 && w <= 3840);
}

/**
 * How many times each figure stands in what a reader can be given: the text, CDATA and title, and the prose
 * attributes and descriptions, as the checks read them. site-text-floor counts the same in the page Chrome built;
 * where the two disagree, these checks and the browser have read the page apart, and nothing the checks held says
 * what the reader got.
 */
function readerFigures(html) {
  const counts = new Map();
  const add = (text) => {
    const glued = [...text.matchAll(GLUED)]
      .map((m) => m[0])
      .filter((w) => !NAMES_WITH_DIGITS.has(w.toLowerCase()));
    for (const figure of [...[...text.matchAll(NUMBER)].map((m) => m[0]), ...glued]) {
      counts.set(figure, (counts.get(figure) ?? 0) + 1);
    }
  };
  for (const t of tokens(html)) {
    if (t.type === 'text') add(decode(html.slice(t.start, t.end)));
    else if (t.type === 'cdata') add(html.slice(...t.inner));
    else if (t.type === 'raw' && ['title', 'textarea'].includes(t.name))
      add(decode(html.slice(t.start, t.end)));
    else if (t.type === 'raw' && ['xmp', 'noscript', 'noembed', 'noframes'].includes(t.name))
      add(html.slice(t.start, t.end));
    else if (t.type === 'start') for (const v of proseOf(t)) add(v);
  }
  return counts;
}

/**
 * The strings the sheet may insert. One of arrows, middle dots and spaces cannot change what a figure beside it
 * says. One with words can (`k` after `100` makes it a hundred thousand, `−` before `$346` makes it a credit), so
 * each is allowed only in the one rule written for it, and a new one is added here, where its review is.
 */
const INSERTED = [{ selector: '.cmeasure .is-win .cm-name::after', text: ' ← smallest' }];
const MARKS_ONLY = /^[\s\u2190-\u21ff\u00b7]*$/u;

/**
 * The scripts the homepage may run, by the SHA-256 of their code. A script can put text on the page by more routes
 * than any pattern lists (a property set by name, a text node, a rule inserted into the sheet, a canvas), so each is
 * read by a person and pinned here, and a script that changes is refused until it is read again.
 */
const PINNED_SCRIPTS = new Map([
  [
    '6a8c3e0b88629ee9e905ba892ddd5d14d53e25d6824109b1710c810850ed2ce7',
    'inline, in the head: applies the theme before first paint',
  ],
  [
    '4ce9aa3a3fc98dad9006d46675161f55502705b7c5ee642158a34f95530b77e3',
    'inline, in the head: holds each animation until its band is in view',
  ],
  [
    'eb82d403edb08f8b80d9eca8a41c540d84b80a6b8909334b669116796512ac5f',
    'theme.js: the theme toggle',
  ],
  [
    '3fa92856e2f96cab1660f577f392a805b26a9c3c7293862f2146202875a3158f',
    'inline, at the foot: plays each animation once',
  ],
]);

/**
 * The characters a reader may be shown: Latin, Greek, zero-width spaces and joiners, and the punctuation, arrows and
 * symbols the page writes. A right-to-left letter, or a bidirectional mark or override, draws the digits beside it in
 * another order (`12`, a right-to-left mark and `34` show as `34 12`), and the checks read them in the order they are
 * written; a letter from another script can pass for a Latin one or a digit (a Cyrillic `О` for `0`); and anything
 * else is a character these checks were not written to read.
 */
const SHOWN_OK =
  /^[\t\n\f\r\u0020-\u024f\u0370-\u03ff\u200b-\u200d\u2010-\u2027\u2030-\u205e\u20a0-\u20cf\u2100-\u214f\u2190-\u23ff\u2500-\u27bf]$/u;

/** The HTML tags that end SVG or MathML where they stand, so what follows them is HTML to the browser. */
const BREAKOUT = new Set(
  'b big blockquote body br center code dd div dl dt em embed h1 h2 h3 h4 h5 h6 head hr i img li listing menu meta nobr ol p pre ruby s small span strong strike sub sup table tt u ul var'.split(
    ' ',
  ),
);

/** The fonts the sheet's two stacks name: a font draws the digits, and one the sheet does not name could draw others. */
const FONTS = new Set(
  [
    '-apple-system',
    'BlinkMacSystemFont',
    'Segoe UI',
    'Helvetica Neue',
    'Helvetica',
    'sans-serif',
    'ui-monospace',
    'SF Mono',
    'SFMono-Regular',
    'Menlo',
    'Consolas',
    'Liberation Mono',
    'monospace',
  ].map((f) => f.toLowerCase()),
);

/** The CSS system colours: what forced colours paint with, and what a sheet could use to paint text away there. */
const SYSTEM_COLOURS =
  'AccentColor|AccentColorText|ActiveText|ButtonBorder|ButtonFace|ButtonText|Canvas|CanvasText|Field|FieldText|GrayText|Highlight|HighlightText|LinkText|Mark|MarkText|SelectedItem|SelectedItemText|VisitedText';

/** The attributes that hold a URL the browser loads or follows. */
const URL_ATTRS = new Set([
  'src',
  'srcset',
  'href',
  'xlink:href',
  'poster',
  'data',
  'action',
  'formaction',
  'background',
  'imagesrcset',
  'cite',
]);

/** What the homepage may not carry, because it would show a reader text no check reads, or hide what one does. */
const REFUSED = {
  style: 'a style element, whose rules no check reads',
  template: 'a template, whose content a check could read and no reader sees',
  noscript: 'a noscript element, shown only without a script',
  noembed: 'a noembed element, whose content no reader sees',
  noframes: 'a noframes element, whose content no reader sees',
  xmp: 'an xmp element, which shows its markup as text',
  textarea: 'a text field, which shows its markup as text',
  plaintext: 'a plaintext element, which shows the rest of the page as text',
  details: 'a details element, whose content is shown only when it is opened',
  dialog: 'a dialog, shown only when it is opened',
  iframe: 'an embedded document, whose text no check reads',
  frame: 'an embedded document, whose text no check reads',
  object: 'an embedded object, whose text no check reads',
  embed: 'an embedded object, whose text no check reads',
  img: 'an image, whose pixels no check reads',
  picture: 'an image, whose pixels no check reads',
  source: 'an image or media source, whose pixels no check reads',
  video: 'a video, whose frames no check reads',
  audio: 'an audio player, which shows times no check reads',
  canvas: 'a canvas, whose drawing no check reads',
  image: 'an SVG image, whose pixels no check reads',
  feimage: 'an SVG filter image, whose pixels no check reads',
  foreignobject: 'HTML inside SVG, which these checks do not parse',
  math: 'MathML, which these checks do not parse',
  bdo: 'a bidirectional override, which draws the digits inside it in another order',
  bdi: 'a bidirectional isolate, which can draw the digits inside it in another order',
  marquee: 'a marquee, whose text moves out of view',
};

/** The homepage's refusals, read from the page itself rather than the rendered view, and from the sheet it loads. */
function refuse({ L, page, fail, ROOT, SITE_DIR }) {
  const toks = tokens(L.raw);
  const after = (t) => toks[toks.indexOf(t) + 1];
  const titles = toks.filter((t) => t.type === 'start' && t.name === 'title' && !t.foreign);
  const body = toks.find((t) => t.type === 'start' && t.name === 'body');
  if (titles.length !== 1 || (body && titles[0].start > body.start)) {
    fail(`${page} has ${titles.length} titles, or one in its body; it needs one, in its head`);
  }
  for (const t of toks) {
    if (t.type !== 'start') continue;
    if (REFUSED[t.name]) fail(`${page} holds ${REFUSED[t.name]} (<${t.name}>)`);
    if (
      t.foreign &&
      (BREAKOUT.has(t.name) ||
        (t.name === 'font' && /\b(?:color|face|size)\b/.test(Object.keys(t.attrs).join(' '))))
    ) {
      fail(
        `${page} writes <${t.name}> inside SVG, which ends the drawing where these checks do not`,
      );
    }
    if ('background' in t.attrs)
      fail(`${page} draws an image with a background attribute (<${t.name}>)`);
    if ('hidden' in t.attrs) {
      fail(
        `${page} hides an element with the hidden attribute, so a check could verify text no reader sees`,
      );
    }
    if ('popover' in t.attrs) fail(`${page} holds a popover, shown only when it is opened`);
    if (t.name === 'base') fail(`${page} sets a base URL, which moves every link and load on it`);
    if (t.name === 'meta' && (t.attrs['http-equiv'] ?? '').toLowerCase() === 'refresh') {
      fail(`${page} sends its readers to another page with a refresh`);
    }
    if (
      t.name === 'link' &&
      /\bstylesheet\b/i.test(t.attrs.rel ?? '') &&
      t.attrs.href !== 'cloudbitmaps.css'
    ) {
      fail(
        `${page} loads a stylesheet other than cloudbitmaps.css (${t.attrs.href}), which no check reads`,
      );
    }
    if (t.name === 'input' && (t.attrs.type ?? '').toLowerCase() === 'image') {
      fail(`${page} holds an image button, whose pixels no check reads`);
    }
    const used = t.attrs.href ?? t.attrs['xlink:href'] ?? '#';
    if (t.name === 'use' && !used.startsWith('#')) {
      fail(`${page} draws another file's SVG (<use href="${used}">), which no check reads`);
    }
    if (t.attrs.dir !== undefined && t.attrs.dir.trim().toLowerCase() !== 'ltr') {
      fail(
        `${page} sets a text direction (<${t.name} dir="${t.attrs.dir}">), which can draw digits in another order`,
      );
    }
    if (t.attrs.style !== undefined && !/^\s*(--[\w-]+\s*:\s*[^;]+;?\s*)*$/.test(t.attrs.style)) {
      fail(`${page} sets an inline style other than a custom property (style="${t.attrs.style}")`);
    }
    for (const [name, value] of Object.entries(t.attrs)) {
      if (name.startsWith('on')) {
        fail(`${page} runs a handler (<${t.name} ${name}>), whose code no check reads`);
      }
      if (!URL_ATTRS.has(name)) continue;
      // A srcset lists several; the browser skips the spaces and control characters before each.
      for (const url of value.split(',').map((u) => u.replace(/[\s\p{Cc}]/gu, '').toLowerCase())) {
        if (url.startsWith('javascript:'))
          fail(`${page} runs code from a link (<${t.name} ${name}>)`);
        if (url.startsWith('data:')) {
          fail(`${page} loads a data: URL (<${t.name} ${name}>), whose content no check reads`);
        }
      }
    }
    if (t.name !== 'script') continue;
    const type = (t.attrs.type ?? '').trim().toLowerCase();
    if (/json/.test(type)) {
      fail(`${page} carries structured data, whose figures no check reads`);
      continue;
    }
    if (t.foreign) {
      fail(`${page} runs a script inside SVG, which these checks do not parse`);
      continue;
    }
    if (type !== '' && type !== 'text/javascript') {
      fail(`${page} runs a script of type "${type}", which can load code no check reads`);
    }
    const src = t.attrs.src;
    let code;
    if (src !== undefined) {
      if (!/^[\w.-]+(?:\/[\w.-]+)*$/.test(src) || src.split('/').includes('..')) {
        fail(`${page} loads a script from outside the tree (${src}), which no check reads`);
        continue;
      }
      code = fs.readFileSync(path.join(ROOT, SITE_DIR, src), 'utf8');
    } else {
      const raw = after(t);
      code = raw?.type === 'raw' ? L.raw.slice(raw.start, raw.end) : '';
      if (code.includes('<!--')) {
        fail(
          `${page} writes <!-- inside a script, where the browser and these checks would end the script apart`,
        );
      }
    }
    const hash = crypto.createHash('sha256').update(code).digest('hex');
    if (!PINNED_SCRIPTS.has(hash)) {
      fail(
        `${page} runs a script no one has pinned (${src ?? 'inline'}, sha256 ${hash}): a script can put text on ` +
          'the page by routes no check reads, so read it, then pin its hash in PINNED_SCRIPTS',
      );
    }
  }

  // A string the sheet inserts for one rule may not be moved onto the homepage's figures by wearing that rule's
  // classes: the page may not carry the class a written insertion is scoped to.
  for (const i of INSERTED) {
    const scope = /\.([\w-]+)/.exec(i.selector)?.[1];
    const wearing = toks.find(
      (t) => t.type === 'start' && (t.attrs.class ?? '').split(/\s+/).includes(scope),
    );
    if (wearing) {
      fail(
        `${page} carries the class ${scope}, whose rule in the sheet inserts "${i.text.trim()}"`,
      );
    }
  }

  // A reference this does not decode could be a figure (`&frac12;`, or `&sup2` without its `;`) no check reads.
  for (const [k, t] of toks.entries()) {
    const title = t.type === 'raw' && t.name === 'title' && !toks[k - 1].foreign;
    if (t.type !== 'text' && t.type !== 'start' && t.type !== 'end' && !title) continue;
    for (const m of L.raw.slice(t.start, t.end).matchAll(/&([a-z][a-z0-9]*)/gi)) {
      if (!(m[1].toLowerCase() in NAMED)) {
        fail(`${page} writes &${m[1]}, a reference this check does not read`);
      }
    }
  }

  // What a reader is shown, in the characters it is written in: the text, the title and the prose attributes.
  const shownText = [
    proseText(rendered(L.raw)),
    ...titles.map((t) => {
      const raw = after(t);
      return raw?.type === 'raw' ? decode(L.raw.slice(raw.start, raw.end)) : '';
    }),
    ...toks.filter((t) => t.type === 'start').flatMap(proseOf),
  ].join(' ');
  for (const c of new Set(shownText)) {
    if (!SHOWN_OK.test(c)) {
      const hex = c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0');
      const why =
        /[\p{Bidi_Control}\p{Script=Hebrew}\p{Script=Arabic}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}]/u.test(
          c,
        )
          ? 'can draw the digits beside it in another order'
          : /\p{L}|\p{N}/u.test(c)
            ? 'can pass for a Latin letter or a digit'
            : 'these checks were not written to read';
      fail(`${page} shows U+${hex}, a character that ${why}`);
    }
  }

  // The sheet may insert nothing but the strings above, and may not number, quote, mark, turn or draw.
  const sheet = fs.readFileSync(path.join(ROOT, SITE_DIR, 'cloudbitmaps.css'), 'utf8');
  const where = `${SITE_DIR}/cloudbitmaps.css`;
  const CONTENT_WORDS = /^(?:none|normal|open-quote|close-quote|no-open-quote|no-close-quote|"")$/i;
  // A url() is a url token wherever it stands, even in a selector, and a comment does not open inside one; the reader
  // above does not follow that, so the sheet may name none, however it is escaped.
  if (/\burl\s*\(/i.test(sheet) || /\burl\s*\(/i.test(cssUnescape(sheet))) {
    fail(
      `${where} names url(, which loads what no check reads and which these checks do not parse as the browser does`,
    );
  }
  const once = new Set();
  const failOnce = (message) => {
    if (!once.has(message)) fail(message);
    once.add(message);
  };
  for (const d of cssDeclarations(sheet)) {
    if (/::?first-(?:letter|line)\b/i.test(d.selector)) {
      failOnce(`${where} styles a first letter or line apart from its text (${d.selector})`);
    }
    // The browser pass clears the letters it compares through a highlight, and a rule for one could restyle it.
    if (/::highlight\(/i.test(d.selector)) {
      failOnce(
        `${where} styles a highlight, which the browser pass clears letters through (${d.selector})`,
      );
    }
    if (d.name === '@') {
      // A condition site-text-floor does not probe shows some readers a page no pass has seen. It loads a width on each
      // side of every width the sheet names (`widthsToProbe`), both colour schemes, less motion, more contrast, a
      // touch screen and print, in Chrome.
      const media = /^@media\b(.*)$/i.exec(d.value);
      if (media) {
        // Each query of a list stands alone. Width and motion are probed in every combination the passes make; the
        // theme is the page's `data-theme` stamp, not a media query; print is probed on its own.
        for (const query of media[1].split(',')) {
          const rest = query
            .replace(WIDTH_FEATURE, '')
            .replace(/\(prefers-reduced-motion(?:\s*:\s*(?:reduce|no-preference))?\)/gi, '')
            .replace(/\b(?:and|not|only|screen|all)\b/gi, '')
            .trim();
          if (rest !== '' && !/^print$/i.test(query.replace(/\b(?:only|all)\b/gi, '').trim())) {
            fail(`${where} shows some readers a rule no pass probes (${d.value})`);
            break;
          }
        }
      }
      if (/^@container\b/i.test(d.value)) {
        fail(`${where} sizes a rule to a container, at widths no pass loads (${d.value})`);
      }
      if (/^@supports\b/i.test(d.value)) {
        fail(`${where} shows other browsers a page the Chrome pass does not see (${d.value})`);
      }
      if (/^@(?:import|counter-style|font-face)\b/i.test(d.value)) {
        fail(
          `${where} pulls in a sheet, a counter style or a font, which no check reads (${d.value})`,
        );
      }
      continue;
    }
    const { strings, rest } = cssStrings(d.value.replace(/\s*!important\s*$/i, ''));
    const says = `${where} ${d.name}: ${d.value}`;
    // The browser pass adds sheets of its own while it looks: one makes every box take pointer events, one makes
    // every letter clear. An important rule of the page's could out-rank either, so the sheet writes none.
    // Read as Chrome reads it: `! important`, `!/**/important` and an escaped letter are all the same flag, and the
    // browser pass reads each declaration's priority from Chrome too (`IMPORTANT` in site-text-floor).
    if (/!\s*important\s*$/i.test(cssUnescape(d.value.replace(/\/\*[\s\S]*?\*\//g, ' ')))) {
      fail(
        `${says} is important, which could out-rank the sheets the browser pass adds while it looks`,
      );
    }
    // The pass loads one height, and a width only at the widths it lists: a size may follow the width, but only as
    // it grows or shrinks, never through arithmetic that could make it vanish between two of them.
    if (/\d(?:[sld]?vh|[sld]?vb|vmin|vmax|cq[whib]|cqmin|cqmax)\b/i.test(rest)) {
      fail(`${says} follows the viewport's height or a container, which no pass varies`);
    }
    if (
      /\d[sld]?v[wi]\b/i.test(rest) &&
      (/\b(?:calc|mod|rem|abs|sign|round|sin|cos|tan|asin|acos|atan2?|pow|sqrt|hypot|log|exp)\(/i.test(
        rest,
      ) ||
        /\s[-+]\s|[*/]/.test(rest))
    ) {
      fail(
        `${says} does arithmetic on the viewport's width, which can make a size vanish between two widths`,
      );
    }
    if (/(?:url|image-set|image|element|paint|cross-fade|-webkit-canvas)\(/i.test(rest)) {
      fail(`${says} draws an image, whose pixels no check reads`);
    }
    // Forced colours replace the sheet's colours with the system's, a reader state no pass becomes.
    if (
      d.name === 'forced-color-adjust' ||
      new RegExp(`(?<![\\w-])(?:${SYSTEM_COLOURS})(?![\\w-])`, 'i').test(rest)
    ) {
      fail(`${says} paints with the system's colours, which no pass sees`);
    }
    if (/(?:linear|radial|conic)-gradient\(/i.test(rest)) {
      fail(`${says} paints a gradient, which the browser pass cannot read as a ground`);
    }
    if (/^(?:animation|animation-iteration-count)$/.test(d.name) && /\binfinite\b/i.test(rest)) {
      fail(`${says} runs an animation that never ends, at a moment no pass looks`);
    }
    if (
      /^(?:transform|-webkit-transform)$/.test(d.name) &&
      /\b(?:rotate|rotate[XYZ]|skew[XY]?|perspective|matrix|matrix3d|translate3d|translateZ|scale3d|scaleZ|rotate3d)\(|\bscale[XY]?\(\s*-/i.test(
        rest,
      )
    ) {
      fail(`${says} turns, mirrors or tilts text in a way the browser pass does not measure`);
    }
    // A reader state no pass becomes: hovering, focusing, following a link to a part of the page, checking a box.
    // There a rule may change a colour, a ground, a border, a decoration or an outline, and show the skip link.
    if (/:(?:hover|focus|focus-visible|focus-within|active|target|checked)\b/i.test(d.selector)) {
      const allowed =
        /^(?:color|background|background-color|border-color|text-decoration|outline|outline-offset)$/.test(
          d.name,
        ) ||
        (d.name === 'left' && /^\.skip:focus$/.test(d.selector));
      if (!allowed || /\btransparent\b|\/\s*0(?:\.0+)?%?\s*\)|,\s*0(?:\.0+)?\s*\)/i.test(rest)) {
        fail(
          `${says} changes, for a reader hovering, focusing or following a link, what no pass sees`,
        );
      }
    }
    switch (d.name) {
      case 'content': {
        const words = rest.split(/[\s/]+/).filter((w) => w !== '');
        const inserted = strings.join('');
        const allowed =
          MARKS_ONLY.test(inserted) ||
          INSERTED.some((i) => i.selector === d.selector && i.text === inserted);
        if (!words.every((w) => CONTENT_WORDS.test(w)) || !allowed) {
          fail(`${says} inserts text no check reads`);
        }
        break;
      }
      case 'quotes':
        if (!/^(?:none|auto)$/i.test(rest))
          fail(`${says} puts text in quotation marks no check reads`);
        break;
      case 'list-style':
        if (!/\bnone\b/i.test(rest) || strings.length > 0) {
          fail(`${says} draws list markers no check reads`);
        }
        break;
      case 'list-style-type':
      case 'list-style-image':
        if (!/^none$/i.test(rest)) fail(`${says} draws list markers no check reads`);
        break;
      case 'display':
        if (/\blist-item\b|(?:var|attr|env)\(/i.test(rest)) {
          fail(`${says} draws list markers no check reads`);
        }
        break;
      case 'counter-reset':
      case 'counter-increment':
      case 'counter-set':
        fail(`${says} counts, for markers no check reads`);
        break;
      case 'direction':
      case 'unicode-bidi':
      case 'writing-mode':
        fail(`${says} sets a text direction, which can draw digits in another order`);
        break;
      case 'animation-timeline':
      case 'scroll-timeline':
      case 'scroll-timeline-name':
      case 'view-timeline':
      case 'view-timeline-name':
      case 'timeline-scope':
        fail(`${says} ties an animation to scrolling, which a pass reads at one position`);
        break;
      case 'text-emphasis':
      case 'text-emphasis-style':
        if (!/^none$/i.test(rest)) fail(`${says} draws marks over its text`);
        break;
      case 'box-shadow':
      case 'text-shadow':
      case '-webkit-text-stroke':
      case '-webkit-text-stroke-width':
      case '-webkit-text-stroke-color':
      case '-webkit-box-reflect':
      case 'font-size-adjust':
      case 'hyphenate-character':
      case 'scale':
      case 'rotate':
      case 'translate':
      case 'perspective':
      case 'contain':
      case 'content-visibility':
      case 'backdrop-filter':
      case 'mix-blend-mode':
        if (!/^(?:none|normal|visible|auto)$/i.test(rest)) {
          fail(`${says} paints, moves or hides text in a way the browser pass does not measure`);
        }
        break;
      case 'outline':
      case 'outline-width':
      case 'outline-offset':
        if (
          [...rest.matchAll(/([\d.]+)(px|em|rem)?/g)].some(
            (m) => Number(m[1]) * (m[2] === 'px' || !m[2] ? 1 : 16) > 4,
          )
        ) {
          fail(`${says} draws an outline wide enough to cover text`);
        }
        break;
      case 'text-decoration':
        if (
          !/^(?:none|underline|overline|line-through)(?:\s+(?:solid|dotted|dashed))?$/i.test(rest)
        ) {
          fail(`${says} draws a decoration wide or coloured enough to cover text`);
        }
        break;
      case 'text-decoration-thickness':
      case 'text-underline-offset':
        fail(`${says} draws a decoration wide enough to cover text`);
        break;
      case 'line-height':
        if (/^[\d.]+$/.test(rest) && Number(rest) < 0.9)
          fail(`${says} lays its lines over each other`);
        break;
      case 'paint-order':
        // A stroke painted first is a halo under the letters; one painted last covers them.
        if (!/^(?:normal|stroke(?:\s+fill)?(?:\s+markers)?)$/i.test(rest)) {
          fail(`${says} paints a stroke over its text`);
        }
        break;
      case 'font-family':
        if (!/^(?:var\(--cb-(?:sans|mono)\)|inherit)$/i.test(rest)) {
          fail(`${says} sets a font the sheet does not name, whose glyphs no check reads`);
        }
        break;
      case 'font':
        if (!/^inherit$/i.test(rest))
          fail(`${says} sets a font the sheet does not name, whose glyphs no check reads`);
        break;
      case '--cb-sans':
      case '--cb-mono':
        if (
          d.value.split(',').some(
            (f) =>
              !FONTS.has(
                f
                  .trim()
                  .replace(/^['"]|['"]$/g, '')
                  .toLowerCase(),
              ),
          )
        ) {
          fail(`${says} names a font the sheet does not, whose glyphs no check reads`);
        }
        break;
      case '-webkit-text-security':
        if (!/^none$/i.test(rest)) fail(`${says} draws its text as discs`);
        break;
      default:
    }
  }
}

/**
 * Checks the display-tier homepage against its sources and records what it verified in `L`, the page's ledger.
 * `finish()` is called once every other check in site-figures has marked what it verified too.
 */
function checkHome(ctx) {
  const { L, page, fail, record, results, scale, sb, sbFigure, MEASURED_1M, WRITE_1M } = ctx;
  const { baselineTopology, baselineInstance, atRestShown, costSrc, ROOT, SITE_DIR } = ctx;
  const html = L.html;
  const n = (x) => x.toLocaleString('en-US');

  /** One element, found once, whose text must be `want`. Marks the group it read. */
  const exact = (what, re, want, group = 1) => {
    const all = matches(html, re);
    if (all.length !== 1) {
      fail(`${page}'s ${what} is found ${all.length} times; this check reads it where it is once`);
      return null;
    }
    const m = all[0];
    // Read from the page itself at the same place: the rendered view blanks a comment to spaces, where a reader
    // sees nothing at all, so `cloud<!-- -->-native` is one word.
    const got = textOf(L.raw.slice(...m.indices[group]));
    if (got !== want) {
      fail(`${page}'s ${what} reads "${got}", but its sources give "${want}"`);
      return null;
    }
    L.mark(...m.indices[group]);
    record(what, want);
    return m;
  };
  /** One meta tag, found once by its name, whose content must be `want`. Marks the tag. */
  const metaExact = (what, key, want) => {
    // Read from the page's own tags: the rendered view blanks every attribute a check does not match on.
    const all = tagsOf(L.raw).filter((t) => t.name === 'meta' && metaKeys(t).includes(key));
    if (all.length !== 1) {
      fail(`${page}'s ${what} is found ${all.length} times; this check reads it where it is once`);
      return;
    }
    const got = (all[0].attrs.content ?? '').replace(/\s+/g, ' ').trim();
    if (got !== want) {
      fail(`${page}'s ${what} reads "${got}", but its sources give "${want}"`);
      return;
    }
    L.mark(all[0].start, all[0].end);
    record(what, want);
  };

  // ── the page may not carry text a reader cannot see, or text no check reads ─────────────────────────────
  // A check that verifies hidden text while the visible text is false is worse than none, and so is text that
  // renders where no check looks.
  refuse({ L, page, fail, ROOT, SITE_DIR });

  // ── the generated regions, held byte for byte elsewhere ─────────────────────────────────────────────────
  for (const name of ['HOMESTRIP', 'HOMEGRID', 'HOMECHART', 'HOMEMEMORY']) {
    const all = matches(
      html,
      new RegExp(`<!-- BENCH:${name}:START -->[\\s\\S]*?<!-- BENCH:${name}:END -->`),
    );
    if (all.length !== 1)
      fail(`${page} has ${all.length} BENCH:${name} regions; it needs exactly one`);
    else L.mark(all[0].index, all[0].index + all[0][0].length);
  }

  // ── the sources ──────────────────────────────────────────────────────────────────────────────────────────
  const { chunksPerSegment, fetchedChunks, skippedChunks, intersectMs } = scale.intersect;
  const fetched = n(fetchedChunks);
  const total = n(chunksPerSegment);
  const perOperand = n(skippedChunks / 2);
  const REDIS = results.redisBaselineUSD;
  const rate = results.readCrossoverPerSec.toFixed(2);
  const sizeGiB = String(results.atRest.sizeGiB);
  const atRestMo = `$${atRestShown}/mo`;
  const pct = `${results.atRest.pctOfRedis}%`;
  const coldRate = sb ? sb.parity.intersectsPerSec.toFixed(1) : null;
  const fleets = [...scale.fleets].sort((a, b) => a.n - b.n);
  const smallest = fleets[0];
  const largest = fleets.at(-1);
  const scan = (ms) => (ms < 1000 ? `${ms.toFixed(1)} ms` : `${(ms / 1000).toPrecision(3)} s`);
  const version = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'packages', 'roaring', 'package.json'), 'utf8'),
  );
  const u32Max = /export const U32_MAX = (0x[\da-f_]+);/i.exec(
    fs.readFileSync(path.join(ROOT, 'packages', 'core', 'src', 'core', 'bit-route.ts'), 'utf8'),
  );
  const idBits = u32Max ? Math.log2(Number(u32Max[1].replace(/_/g, '')) + 1) : NaN;
  if (!Number.isInteger(idBits))
    fail('core/bit-route.ts no longer states U32_MAX in the form this check reads');

  // ── the head: what a search result and a link preview show ──────────────────────────────────────────────
  metaExact(
    'meta description',
    'description',
    'Large id-sets kept as immutable objects in storage you already own, with no daemon, no second service and ' +
      `one bucket. Requests only the chunks a query can match — ${fetched} of ${total}. ${sizeGiB} GiB at rest is ` +
      `$${atRestShown} a month against $${REDIS} for a Redis cluster standing by, and past ${rate} GETs a second, ` +
      'every read a cache miss, the cluster is cheaper.',
  );
  metaExact(
    'link-preview description',
    'og:description',
    'No daemon. No second service. One bucket. Large id-sets as immutable objects in your own storage: ' +
      `${sizeGiB} GiB at rest costs $${atRestShown}/mo against $${REDIS} standing for a Redis cluster, and past ` +
      `${rate} GETs a second, every read a cache miss, the cluster is cheaper.`,
  );
  metaExact(
    'card description',
    'twitter:description',
    `No daemon. No second service. One bucket. $${atRestShown}/mo at rest against $${REDIS} standing for a Redis ` +
      'cluster — and we publish the read rate past which the cluster is cheaper.',
  );

  // ── the hero ─────────────────────────────────────────────────────────────────────────────────────────────
  exact(
    'eyebrow',
    /<p class="label">(Distributed, cloud-native bitmaps[\s\S]*?)<\/p>/,
    `Distributed, cloud-native bitmaps · roaring shipped · v${version.version}`,
  );
  exact(
    'lede',
    /<h1>[\s\S]*?<p class="cb-lede">([\s\S]*?)<\/p>/,
    'CloudBitmaps keeps large id-sets as immutable objects in storage you already own, and requests only the ' +
      `chunks a query can match — ${fetched} of ${total}. The reads are the calls you know: has · count · iterate ` +
      '· intersect · union · andNot.',
  );
  const HERO = [
    [atRestMo, `${sizeGiB} GiB at rest, no traffic`],
    [`$${REDIS}/mo`, 'a Redis-HA cluster, standing, whether you read it or not'],
    [pct, 'what we cost against that line, idle'],
    [
      `${rate}/s`,
      `cache-miss GETs a second, above which the flat cluster is cheaper; ${coldRate} a second as cold A ∩ B`,
    ],
  ];
  const heroRow = matches(
    html,
    /<div class="cb-seam cb-cols-4">([\s\S]*?)<\/div>\s*<div class="cb-seam cb-cols-2">/,
  );
  if (heroRow.length !== 1) {
    fail(`${page}'s hero figure row is found ${heroRow.length} times`);
  } else {
    const [start] = heroRow[0].indices[1];
    const cells = [
      ...heroRow[0][1].matchAll(
        /<div class="cb-fig">\s*<p class="cb-figure-xl">([\s\S]*?)<\/p>\s*<p class="cb-note">([\s\S]*?)<\/p>\s*<\/div>/dg,
      ),
    ];
    if (
      cells.length !== HERO.length ||
      (heroRow[0][1].match(/<div class="cb-fig\b/g) ?? []).length !== HERO.length
    ) {
      fail(
        `${page}'s hero figure row holds ${cells.length} readable cells of ` +
          `${(heroRow[0][1].match(/<div class="cb-fig\b/g) ?? []).length}; it should hold ${HERO.length}`,
      );
    }
    HERO.forEach(([figure, caption], i) => {
      const c = cells[i];
      if (!c) return;
      const got = [textOf(c[1]), textOf(c[2])];
      if (got[0] !== figure || got[1] !== caption) {
        fail(
          `${page}'s hero figure ${i + 1} reads "${got[0]}" / "${got[1]}", but its sources give "${figure}" / "${caption}"`,
        );
        return;
      }
      L.mark(start + c.index, start + c.index + c[0].length);
      record(`hero figure ${i + 1}`, figure);
    });
  }

  // ── the bands' own numbering ─────────────────────────────────────────────────────────────────────────────
  const eyebrows = matches(html, /<p class="label">(\d{2}) · [^<]+<\/p>/);
  eyebrows.forEach((m, i) => {
    const want = String(i + 1).padStart(2, '0');
    if (m[1] !== want) fail(`${page}'s band ${i + 1} is numbered ${m[1]}, not ${want}`);
    else L.mark(...m.indices[1]);
  });
  record('bands numbered', `01–${String(eyebrows.length).padStart(2, '0')}`);

  // ── 01 · what you operate ────────────────────────────────────────────────────────────────────────────────
  exact(
    'the Redis column foot',
    /<p class="cb-op-foot cb-note">\s*(Three nodes standing[\s\S]*?)<\/p>/,
    `Three nodes standing, whether anything reads or not, for $${REDIS}/mo, and the planning that sizes them.`,
  );
  exact(
    'our column label',
    /<p class="label is-ours">(CloudBitmaps [\s\S]*?)<\/p>/,
    `CloudBitmaps v${version.version}`,
  );

  // ── 03 · chunk-skipping ──────────────────────────────────────────────────────────────────────────────────
  exact(
    'chunk band headline',
    /<section id="demo" class="cb-stack">[\s\S]*?<h2>([\s\S]*?)<\/h2>/,
    `${fetched} of ${total} chunks. The other ${perOperand} are never requested.`,
  );
  // A comparison of keys requests no chunk: the engine aligns the operands' keys from their indexes before it
  // fans out to any chunk (packages/core/src/core/engine.ts), which is what the band's third figure states.
  const CHUNKS_REQUESTED_WHILE_COMPARING = 0;
  const BAND = [
    ['Fetched', fetched, 'Chunks whose key is present in both operands.'],
    ['Never requested', perOperand, 'Per operand. Not skipped after reading — never asked for.'],
    [
      'Chunks requested while comparing',
      String(CHUNKS_REQUESTED_WHILE_COMPARING),
      "The keys come from each operand's index, in one tail read; on segments this small that read carries " +
        'chunk bytes too, never decoded. Step through the recorded run →',
    ],
  ];
  const bandFigs = matches(
    html,
    /<div class="cb-fig is-band">\s*<p class="label">([^<]*)<\/p>\s*<p class="cb-figure-l">([\s\S]*?)<\/p>\s*<p class="cb-note">([\s\S]*?)<\/p>\s*<\/div>/,
  );
  if (
    bandFigs.length !== BAND.length ||
    (html.match(/<div class="cb-fig is-band\b/g) ?? []).length !== BAND.length
  ) {
    fail(
      `${page}'s chunk band holds ${bandFigs.length} readable figures; it should hold ${BAND.length}`,
    );
  }
  BAND.forEach(([label, figure, note], i) => {
    const m = bandFigs[i];
    if (!m) return;
    const got = [textOf(m[1]), textOf(m[2]), textOf(m[3])];
    if (got.join(' / ') !== [label, figure, note].join(' / ')) {
      fail(
        `${page}'s chunk band figure ${i + 1} reads "${got.join(' / ')}", but its sources give "${[label, figure, note].join(' / ')}"`,
      );
      return;
    }
    L.mark(m.index, m.index + m[0].length);
    record(`chunk band "${label}"`, figure);
  });

  // ── 04 · the cost band ───────────────────────────────────────────────────────────────────────────────────
  exact(
    'cost headline',
    /<section id="crossover"[^>]*>[\s\S]*?<h2>([\s\S]*?)<\/h2>/,
    `Cheaper until ${rate} GETs a second. Then it isn't.`,
  );
  exact(
    'cost lede',
    /<section id="crossover"[^>]*>[\s\S]*?<p class="cb-lede">([\s\S]*?)<\/p>/,
    'Our line rises from nothing with read rate, every read here a cache miss and a GET. The Redis cluster is ' +
      `flat at $${REDIS} whether you read it or not. We publish both halves, because the half where a flat cluster ` +
      'wins is what makes the other half checkable.',
  );
  const prices =
    /AWS_US_EAST_1_ONDEMAND[^=]*=\s*deepFreeze\(\{[\s\S]*?storage:\s*\{\s*getPerMillion:\s*([\d.]+),\s*putPerMillion:\s*([\d.]+),\s*storagePerGiBMonth:\s*([\d.]+)\s*\}/.exec(
      costSrc,
    );
  const hours = Number(/const HOURS_PER_MONTH = (\d+);/.exec(costSrc)?.[1] ?? NaN);
  if (!prices || !Number.isFinite(hours)) {
    fail(
      'core/cost.ts no longer states the us-east-1 prices or HOURS_PER_MONTH in the form this check reads',
    );
    return;
  }
  if (results.pricing !== 'aws-us-east-1-ondemand') {
    fail(
      `bench/results.json is priced at ${results.pricing}, but the cost band says AWS us-east-1 list prices`,
    );
  }
  const [getM, putM, storeGiB] = prices.slice(1).map(Number);
  const S = n(hours * 3600);
  const usd2 = (x) => `$${x.toFixed(2)}`;
  const gets = Number(sb?.measuredGets ?? NaN);
  const puts = Number(sb?.putsPerSingle ?? NaN);
  const writeGets = Number(sb?.getsPerLoad ?? NaN);
  const nodes = (baselineTopology ?? '').match(/\d+/g)?.reduce((a, d) => a + Number(d), 0) ?? NaN;
  const coldPerM = sbFigure(MEASURED_1M);
  const TABLES = [
    [
      'what goes in',
      ['What goes in', 'Value'],
      [
        ['The reference set', 'chosen · at rest, no traffic', `${sizeGiB} GiB`],
        [
          `GETs per cold A ∩ B, ${sb?.chunksPerOperand} chunks shared`,
          `measured · the median of ${sb?.intersects} cold intersects on S3 in ${sb?.region}, from a client outside it`,
          String(gets),
        ],
        [
          'Requests per write and publish',
          'measured · on S3, pointer included; store.load() also lists and collects, about twice this',
          sbFigure('a single-part write and publish'),
        ],
        [
          'S3 GET · PUT, per million',
          'quoted · AWS us-east-1 list price',
          `${usd2(getM)} · ${usd2(putM)}`,
        ],
        ['S3 storage, per GiB-month', 'quoted · AWS us-east-1 list price', `$${storeGiB}`],
        [
          'Redis-HA cluster',
          `quoted · ${nodes} × ${baselineInstance}, ${hours} hours a month`,
          `$${REDIS}/mo`,
        ],
      ],
    ],
    [
      'what comes out',
      ['What comes out', 'Value'],
      [
        ['At rest', `${sizeGiB} GiB × $${storeGiB}`, atRestMo],
        ['Cold A ∩ B, per million', `${gets} GETs × ${usd2(getM)}`, coldPerM],
        [
          'Write and publish, per million',
          `${puts} × ${usd2(putM)} + ${writeGets} × ${usd2(getM)}`,
          sbFigure(WRITE_1M),
        ],
        ['Against that line', `$${results.atRest.monthlyUSD} ÷ $${REDIS}`, pct],
        [
          'Crossover, in GETs',
          `$${REDIS} ÷ (${usd2(getM)} per million × ${S} s a month)`,
          `${rate}/s`,
        ],
        [
          '…as cold A ∩ B',
          `$${REDIS} ÷ (${coldPerM} per million × ${S} s a month)`,
          `${coldRate}/s`,
        ],
      ],
    ],
  ];
  // The cost band's two, not the memory band's, which is generated and held whole.
  const generated = matches(html, /<!-- BENCH:([A-Z]+):START -->[\s\S]*?<!-- BENCH:\1:END -->/).map(
    (m) => [m.index, m.index + m[0].length],
  );
  const tables = matches(
    html,
    /<table class="cb-ftable" aria-label="[^"]*">([\s\S]*?)<\/table>/,
  ).filter((m) => !generated.some(([a, b]) => a <= m.index && m.index < b));
  if (tables.length !== TABLES.length)
    fail(`${page}'s cost band holds ${tables.length} tables; this check knows ${TABLES.length}`);
  TABLES.forEach(([name, heads, rows], t) => {
    const table = tables[t];
    if (!table) return;
    const [base] = table.indices[1];
    const inner = table[1];
    const head = /<thead>\s*<tr>((?:\s*<th scope="col">[^<]*<\/th>)+)\s*<\/tr>\s*<\/thead>/d.exec(
      inner,
    );
    const gotHeads = head
      ? [...head[1].matchAll(/<th scope="col">([^<]*)<\/th>/g)].map((m) => m[1])
      : [];
    if (gotHeads.join(' | ') !== heads.join(' | ')) {
      fail(
        `${page}'s table of ${name} is headed "${gotHeads.join(' | ')}", not "${heads.join(' | ')}"`,
      );
    } else {
      L.mark(base + head.indices[1][0], base + head.indices[1][1]);
    }
    const found = [
      ...inner.matchAll(
        /<tr>\s*<th scope="row">([\s\S]*?)<span class="cb-note">([\s\S]*?)<\/span><\/th>\s*<td>([\s\S]*?)<\/td>\s*<\/tr>/dg,
      ),
    ];
    if (found.length !== rows.length || (inner.match(/<tr\b/g) ?? []).length !== rows.length + 1) {
      fail(
        `${page}'s table of ${name} holds ${found.length} readable rows; this check knows ${rows.length}`,
      );
    }
    rows.forEach(([rowHead, note, value], i) => {
      const m = found[i];
      if (!m) return;
      const got = [textOf(m[1]), textOf(m[2]), textOf(m[3])];
      if (got.join(' / ') !== [rowHead, note, value].join(' / ')) {
        fail(
          `${page}'s table of ${name}, row ${i + 1}, reads "${got.join(' / ')}", but its sources give "${[rowHead, note, value].join(' / ')}"`,
        );
        return;
      }
      L.mark(base + m.index, base + m.index + m[0].length);
      record(`${name}, "${rowHead}"`, value);
    });
  });
  // The arithmetic the second table shows, redone from the operands as a reader sees them: a formula can match its
  // sources and still be wrong, and a value rounded for display can drift from its formula.
  const shownNum = (s) => Number(String(s).replace(/[$,%/a-z ]/gi, ''));
  for (const [what, got, want] of [
    ['at rest', (Number(sizeGiB) * storeGiB).toFixed(2), shownNum(atRestMo).toFixed(2)],
    // The share's own operand, to its four places: rounding to cents would pass any storage price near this one.
    [
      'at rest, unrounded',
      (Number(sizeGiB) * storeGiB).toFixed(4),
      results.atRest.monthlyUSD.toFixed(4),
    ],
    [
      'a cold intersect',
      (gets * Number(usd2(getM).slice(1)) || 0).toFixed(2),
      shownNum(coldPerM).toFixed(2),
    ],
    [
      'a write and publish',
      (puts * Number(usd2(putM).slice(1)) + writeGets * Number(usd2(getM).slice(1))).toFixed(2),
      shownNum(sbFigure(WRITE_1M)).toFixed(2),
    ],
    ['the share', ((results.atRest.monthlyUSD / REDIS) * 100).toFixed(3), shownNum(pct).toFixed(3)],
    [
      'the crossover',
      (REDIS / ((Number(usd2(getM).slice(1)) / 1e6) * hours * 3600)).toFixed(2),
      rate,
    ],
    ['the cold rate', (REDIS / ((shownNum(coldPerM) / 1e6) * hours * 3600)).toFixed(1), coldRate],
  ]) {
    if (got !== want)
      fail(
        `${page}'s cost band shows ${what} as ${want}, but the arithmetic beside it gives ${got}`,
      );
  }

  // ── 05 · memory ──────────────────────────────────────────────────────────────────────────────────────────
  exact(
    'memory lede',
    /<section id="memory" class="cb-stack">[\s\S]*?<p class="cb-lede">([\s\S]*?)<\/p>/,
    `With the reader cache capped at ${n(scale.cap)} segments, retained heap stays flat from ${n(smallest.n)} ` +
      `segments to ${n(largest.n)}. Process RSS does grow — the benchmark seeds every segment in the one process ` +
      '— and so does discovery, an honest O(total) scan. They sit side by side.',
  );
  exact(
    'memory caption',
    /<p class="cb-note is-caption">([\s\S]*?)<\/p>/,
    `Measured on one ${scale.env.cpu}, where discovery is filesystem-bound, so the shape is the claim and not the ` +
      'milliseconds. The run →',
  );

  // ── 06 · the conditions ──────────────────────────────────────────────────────────────────────────────────
  const ref = results.referenceRedis;
  const refCluster = /^(\d+) × ([\w.]+)$/.exec(ref.cluster);
  const replicas = Number(/replicasPerShard:\s*(\d+)/.exec(costSrc)?.[1] ?? NaN);
  if (!refCluster || Number(refCluster[1]) !== replicas + 1 || replicas !== 2) {
    fail(
      `the reference cluster "${ref.cluster}" is not the one shard of a primary and two replicas the card says`,
    );
  }
  const CARDS = [
    [
      'The crossover is a rate, not a verdict',
      `Above ${rate} GETs a second, every one a cache miss, the flat cluster costs less, and the chart says so. ` +
        'For point reads, a warm cache moves the line out by the reciprocal of its miss rate.',
    ],
    [
      `$${REDIS} is one cluster, not your bill`,
      `It is ${nodes} × ${baselineInstance}, whatever the data size. A primary and two replicas of ` +
        `${refCluster?.[2]} hold this ${sizeGiB} GiB set for $${ref.monthlyUSD.toFixed(2)} a month on demand, and ` +
        `against them the line crosses at ${ref.readCrossoverPerSec.toFixed(2)} GETs a second. One replica, Valkey ` +
        'or reserved nodes cost less again. Pass the Redis you would run to estimateCost().',
    ],
    [
      `${fetched} of ${total} is one overlap`,
      'The skip rate is a property of your key overlap, not a promise. Two segments that share most of their ' +
        'chunk keys fetch most of their chunks, and the saving shrinks with it.',
    ],
    [
      'A flat heap does not make listing free',
      `Retained heap stays flat to ${n(largest.n)} segments, but finding them is an O(total) scan: ` +
        `${scan(largest.discoveryMs)} over that fleet, on one machine.`,
    ],
    [
      'No in-region latency figure yet',
      `${intersectMs} ms is the recorded run on the memory driver, not a round trip to a bucket. In-region ` +
        'latency is still owed, and no latency is published here that was not measured.',
    ],
    [
      'The prices are AWS list prices, in us-east-1',
      "Every dollar here is an AWS us-east-1 list price, S3's and ElastiCache's, and another region or a discount " +
        'moves it. On GCS or Azure Blob a pointer read and an index read are two requests each; a chunk read is one ' +
        'everywhere.',
    ],
  ];
  const cards = matches(
    html,
    /<div class="cb-cell cb-caveat">\s*<h3 class="label">([\s\S]*?)<\/h3>\s*<p>([\s\S]*?)<\/p>\s*<\/div>/,
  );
  if (
    cards.length !== CARDS.length ||
    (html.match(/class="cb-cell cb-caveat"/g) ?? []).length !== CARDS.length
  ) {
    fail(
      `${page}'s conditions band holds ${cards.length} readable cards; this check knows ${CARDS.length}`,
    );
  }
  CARDS.forEach(([title, text], i) => {
    const m = cards[i];
    if (!m) return;
    const got = [textOf(m[1]), textOf(m[2])];
    if (got[0] !== title || got[1] !== text) {
      fail(
        `${page}'s condition ${i + 1} reads "${got[0]}: ${got[1]}", but its sources give "${title}: ${text}"`,
      );
      return;
    }
    L.mark(m.index, m.index + m[0].length);
    record(`condition ${i + 1}`, title);
  });

  // ── 07 · fit, the install and the footer ─────────────────────────────────────────────────────────────────
  exact(
    "the fit band's losing case",
    /<h3>(You read past [\s\S]*?)<\/h3>/,
    `You read past ${rate} GETs a second, every one a cache miss.`,
  );
  exact(
    'id width',
    /<p class="cb-note">\s*(Ids are \d+-bit unsigned integers\.)/,
    `Ids are ${idBits}-bit unsigned integers.`,
  );
  const licence = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).license;
  // Every licence a page could plausibly name, not only ours: one without a digit in it, MIT say, would otherwise
  // pass unread, since the last check only looks for numbers.
  const licences = matches(
    html,
    /(?<![\w-])(Apache-\d+\.\d+|MIT|ISC|BSD-\d-Clause|MPL-\d+\.\d+|BUSL-\d+\.\d+|(?:A|L)?GPL-\d+\.\d+(?:-only|-or-later)?)(?![\w-]|\.\d)/,
  );
  for (const m of licences) {
    if (m[1] !== licence)
      fail(`${page} states the licence ${m[1]}, but package.json says ${licence}`);
    else L.mark(...m.indices[1]);
  }
  // The footer's "Pre-1.0" is held with the claim below, and is true only while the packages are at 0.x; said anywhere
  // else, it is a figure no check holds, since the words around it could turn it.
  if (!version.version.startsWith('0.')) {
    fail(`${page}'s footer says Pre-1.0, but the packages are at ${version.version}`);
  }
  exact(
    'footer',
    /<footer[\s\S]*?<span>(CloudBitmaps · [\s\S]*?)<\/span>/,
    `CloudBitmaps · v${version.version} · ${licence}`,
  );
  exact(
    "footer's claim",
    /<footer[\s\S]*?<span class="right">([\s\S]*?)<\/span>/,
    `Pre-1.0 · single maintainer · ${CLAIM} · read the conditions`,
  );
}

/** What the page's footer says, which the ledger exists to make true: site-figures runs it on the page that says it. */
const CLAIM = 'every figure on this page is gated in CI';

/**
 * The last check: every number the page shows, in its text or in an attribute that carries prose, lies in a span
 * some check verified. Called once every check in site-figures has marked its spans.
 */
function finish({ L, page, fail }) {
  for (const [a, b] of L.strays) {
    fail(
      `${page}: a check read "${L.raw.slice(a, b).slice(0, 60)}" inside an attribute, which no reader sees as text`,
    );
  }
  const rest = L.rest();
  const regions = L.marks.filter(([a]) => L.html.startsWith('<!-- BENCH:', a));
  const within = (t, spans) => spans.some(([a, b]) => a <= t.start && t.end <= b);
  // A tag's prose is read where no check read the element; inside a span a check read, the check compared the text,
  // not the attributes, so a number there is unread. The generated regions are held whole elsewhere.
  const prose = [];
  for (const t of tagsOf(L.raw)) {
    if (within(t, regions)) continue;
    if (!within(t, L.marks)) {
      prose.push(...proseOf(t));
      continue;
    }
    if (t.name === 'meta') continue;
    for (const v of proseOf(t)) {
      if ((v.match(NUMBER) ?? []).length > 0) {
        fail(`${page} states "${v}" in an attribute of an element a check read for its text alone`);
      }
    }
  }
  // The title is shown in the tab, and the rendered view blanks it with the other raw text.
  const toks = tokens(L.raw);
  const title = toks
    .filter((t) => t.type === 'raw' && t.name === 'title')
    .map((t) => decode(L.raw.slice(t.start, t.end)));
  const text = [...prose, ...title, proseText(rest)].join(' \n ');
  const glued = [...text.matchAll(GLUED)].filter((m) => !NAMES_WITH_DIGITS.has(m[0].toLowerCase()));
  const left = [...text.matchAll(NUMBER), ...glued].map((m) => {
    const around = text
      .slice(Math.max(0, m.index - 40), m.index + m[0].length + 30)
      .replace(/\s+/g, ' ')
      .trim();
    return `${m[0]} (…${around}…)`;
  });
  if (left.length > 0) {
    fail(
      `${page} shows ${left.length} figure(s) no check holds, and its footer says ${CLAIM}:\n      ` +
        left.slice(0, 12).join('\n      '),
    );
  }
}

/** The claim as a reader gets it: invisible characters and soft hyphens out, spaces folded, case folded. */
const plain = (text) =>
  text
    .normalize('NFKC')
    .replace(/[\p{Cf}\u00ad]/gu, '')
    .replace(/\s+/g, ' ')
    .toLowerCase();
/** Whether a page's text makes the claim, however its case or spacing is written. */
const claims = (html) => plain(textOf(html)).includes(plain(CLAIM));

/**
 * Whether a homepage is the display tier's: it makes the claim, or it is built from the display tier's `cb-` classes,
 * however its hero is named. Neither a reworded hero nor a claim split by a comment turns the ledger off.
 */
const isDisplayTier = (html) =>
  claims(html) ||
  tagsOf(html).some((t) => (t.attrs.class ?? '').split(/\s+/).some((c) => c.startsWith('cb-')));

module.exports = {
  checkHome,
  finish,
  ledger,
  textOf,
  proseText,
  rendered,
  decode,
  tagsOf,
  withoutComments,
  withoutCode,
  scanText,
  isProseMeta,
  claims,
  isDisplayTier,
  readerFigures,
  widthsToProbe,
  PROSE_ATTRS,
  NON_PROSE_METAS,
  NUMBER,
  GLUED,
  NAMES_WITH_DIGITS,
  cssUnescape,
  plain,
  CLAIM,
};
