'use strict';
/**
 * The display-tier homepage, held figure by figure (site-next/index.html, read by scripts/site-figures.cjs).
 *
 * Every check here reads the page as it renders: comments, `<template>`, `<noscript>`, scripts and styles are
 * blanked first, so a check cannot pass on a copy no reader sees. Each marks the exact span it verified. What no
 * check marked is then read for numbers: the visible text, SVG labels included, and the attributes that carry
 * prose (`aria-label`, `alt`, `title`, `placeholder`, `value`, and the descriptions a search result or a link
 * preview shows), however they are quoted. Any number left is a failure, and so is a number in such an attribute
 * inside a span a check read, since the check compared the text and not the attribute. So a figure is gated where it
 * stands: a wrong number that happens to equal a true one elsewhere on the page, a second unchecked copy of a checked
 * figure, or a new figure no check knows, all fail. That is what lets the page's footer say every figure on it is
 * gated in CI.
 *
 * Prose that carries a figure is compared whole, against a string built from the sources, so the words around a
 * figure cannot turn its meaning while the figure stays right.
 *
 * The page's drawings of the scale run and its crossover chart are generated (bench/scale.cjs, bench/run.cjs) and
 * held byte for byte by `pnpm bench:scale:check` and `pnpm bench:check`, so their regions count as verified here.
 * Figures are numerals, in any script's digits, fractions included: a number written as a word ("three nodes") is
 * prose, and is not read.
 *
 * The page may not carry what would put text before a reader that no check reads: a `<style>` element or a second
 * sheet, a sheet rule that inserts anything but a digit-free string or draws quotation marks, list markers or
 * counters, an element that hides or embeds content (`hidden`, `<template>`, `<details>`, `<dialog>`, `popover`,
 * `<iframe>`, `<object>`, `<embed>`, a `data:` image), a list that numbers its own items, structured data, a base URL
 * or a refresh, a character reference this does not decode, an inline style other than a custom property, or a
 * script that writes text. Every meta's content is read but for a short list whose content is not prose.
 *
 * What it holds, and what it does not: it holds the page against the edits a maintainer makes, a figure changed,
 * added, left stale, reworded around, moved into a comment or out of view, or copied into an attribute. It is not a
 * sandbox against a page built to deceive a static reader: markup the browser parses differently from these patterns
 * (`<!-->`), a bidirectional override that draws `329.15` backwards, a script that writes text by a route not listed
 * here. Those are review's to catch; site-text-floor's Chrome pass narrows them by checking that every word on the
 * page is one a reader can see.
 */
const fs = require('node:fs');
const path = require('node:path');

// A numeral in any script (`９`, `𝟿`), a leading-dot decimal (`$.50`) or a fraction or numeric symbol (`½`, `²`).
// Digits glued to a letter, as in `v0.10.0` or `S3`, are part of a word; a version is held where it stands.
const NUMBER = /(?<![\p{L}\p{N}_.])(?:\p{Nd}[\p{Nd},]*(?:\.\p{Nd}+)?|\.\p{Nd}+)|[\p{No}\p{Nl}]/gu;
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

/** Every character reference decoded, so `&#57;` is read as the 9 it renders, with or without its `;`, as a browser reads it. */
function decode(s) {
  return s
    .replace(/&#x([0-9a-f]+);?/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);?/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&([a-z]+);/gi, (m, name) => NAMED[name.toLowerCase()] ?? m);
}

/** An element's text as a reader gets it: tags dropped, references decoded, whitespace collapsed. */
const textOf = (html) =>
  decode(html.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, ''))
    .replace(/\s+/g, ' ')
    .trim();

/** The generated regions' markers, the one kind of comment the checks read. */
const BENCH_MARKER = /^<!-- BENCH:[A-Z]+:(?:START|END) -->$/;

/**
 * The page as it renders, the same length as the page so that every position still points at the same character:
 * comments other than the generated regions' markers, and the elements whose content no reader sees as text, are
 * blanked to spaces.
 */
function rendered(html) {
  const blank = (m) => m.replace(/[^\n]/g, ' ');
  return html
    .replace(/<!--[\s\S]*?-->/g, (m) => (BENCH_MARKER.test(m) ? m : blank(m)))
    .replace(/<(template|noscript|script|style)\b[\s\S]*?<\/\1\s*>/gi, blank);
}

/** A start tag's attributes as a browser reads them: any quoting, names in lower case, values decoded. */
function attrsOf(tag) {
  const out = {};
  const inner = tag.replace(/^<[a-z][\w-]*/i, '').replace(/\/?>$/, '');
  for (const m of inner.matchAll(
    /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g,
  )) {
    const name = m[1].toLowerCase();
    if (!(name in out)) out[name] = decode(m[2] ?? m[3] ?? m[4] ?? '');
  }
  return out;
}

/** Every start tag, with where it stands and its attributes. */
const tagsOf = (html) =>
  [...html.matchAll(/<([a-z][\w-]*)\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi)].map((m) => ({
    name: m[1].toLowerCase(),
    start: m.index,
    end: m.index + m[0].length,
    attrs: attrsOf(m[0]),
  }));

/** The attributes a reader is read or shown, and the meta tags whose content is prose. */
const PROSE_ATTRS = [
  'aria-label',
  'aria-description',
  'aria-valuetext',
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
const metaKey = (t) => metaKeys(t)[0] ?? '';
const isProseMeta = (t) =>
  t.name === 'meta' && 'content' in t.attrs && metaKeys(t).some((k) => !NON_PROSE_METAS.has(k));

/** The spans of a page that checks have verified, over the page as it renders. */
function ledger(page) {
  const marks = [];
  const html = rendered(page);
  return {
    raw: page,
    html,
    marks,
    mark(start, end) {
      if (start >= 0 && end > start) marks.push([start, end]);
    },
    /** The page with every verified span blanked. */
    rest() {
      const sorted = [...marks].sort((a, b) => a[0] - b[0]);
      let out = '';
      let at = 0;
      for (const [a, b] of sorted) {
        if (b <= at) continue;
        out += html.slice(at, Math.max(at, a)) + ' ';
        at = Math.max(at, b);
      }
      return out + html.slice(at);
    },
  };
}

/** Every match of `re` with its groups' positions. */
const matches = (html, re) => [
  ...html.matchAll(new RegExp(re.source, [...new Set(`${re.flags}gd`)].join(''))),
];

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
    const got = textOf(m[group]);
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
    const all = tagsOf(html).filter((t) => t.name === 'meta' && metaKeys(t).includes(key));
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
  // renders where no check looks. The checks read the page as it renders; what is refused here is what would hide
  // text from a reader, or put text before one, outside that view. Read from the page itself, not the rendered view.
  const REFUSED = {
    style: 'a style element, whose rules no check reads',
    template: 'a template, whose content a check could read and no reader sees',
    noscript: 'a noscript element, shown only without a script',
    details: 'a details element, whose content is shown only when it is opened',
    dialog: 'a dialog, shown only when it is opened',
    iframe: 'an embedded document, whose text no check reads',
    object: 'an embedded object, whose text no check reads',
    embed: 'an embedded object, whose text no check reads',
    ol: 'a numbered list, whose numbers the browser draws and no check reads',
  };
  for (const t of tagsOf(L.raw)) {
    if (REFUSED[t.name]) fail(`${page} holds ${REFUSED[t.name]} (<${t.name}>)`);
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
    if (t.attrs.style !== undefined && !/^\s*(--[\w-]+\s*:\s*[^;]+;?\s*)+$/.test(t.attrs.style)) {
      fail(`${page} sets an inline style other than a custom property (style="${t.attrs.style}")`);
    }
    const source = t.attrs.src ?? t.attrs.href ?? t.attrs['xlink:href'] ?? '';
    if ((t.name === 'img' || t.name === 'image') && /^\s*data:/i.test(source)) {
      fail(`${page} draws an image from a data: URL, whose text no check reads`);
    }
    if (t.name === 'script' && /json/i.test(t.attrs.type ?? '')) {
      fail(`${page} carries structured data, whose figures no check reads`);
    }
  }
  // A script may set classes and state; one that writes text puts words on the page that no check reads.
  const WRITES_TEXT =
    /\.(?:textContent|innerText|outerText|innerHTML|outerHTML|nodeValue)\s*\+?=(?!=)|\.(?:append|prepend|before|after|replaceWith|replaceChildren|setHTML|insertAdjacent(?:HTML|Text|Element))\s*\(|\b(?:createTextNode|document\.write(?:ln)?)\s*\(/;
  for (const m of L.raw.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    const src = attrsOf(`<script${m[1]}>`).src;
    const code = src ? fs.readFileSync(path.join(ROOT, SITE_DIR, src), 'utf8') : m[2];
    if (
      WRITES_TEXT.test(code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1'))
    ) {
      fail(`${page} runs a script that writes text (${src ?? 'inline'}), which no check reads`);
    }
  }
  // The sheet may insert nothing but a digit-free string: not a number, and not an attribute, a counter or a
  // variable, whose text no check reads. Nor may it number a list or put words in quotes or markers, or pull in
  // another sheet. Read as the browser reads it, escapes decoded, so `c\6f ntent` is `content`.
  const css = fs
    .readFileSync(path.join(ROOT, SITE_DIR, 'cloudbitmaps.css'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\\([0-9a-f]{1,6})\s?/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/\\(.)/g, '$1');
  const STRINGS = `(?:(?:"[^"\\d]*"|'[^'\\d]*')\\s*)+`;
  const CONTENT_OK = new RegExp(`^(?:none|normal|${STRINGS}(?:/\\s*${STRINGS})?)$`, 'i');
  const sheetRules = [
    ['content', (v) => CONTENT_OK.test(v), 'inserts text no check reads'],
    ['quotes', (v) => /^(?:none|auto)$/i.test(v), 'puts text in quotation marks no check reads'],
    [
      'list-style',
      (v) => /\bnone\b/i.test(v) && !/["']/.test(v),
      'draws list markers no check reads',
    ],
    ['list-style-type', (v) => /^none$/i.test(v), 'draws list markers no check reads'],
    ['display', (v) => !/\blist-item\b/i.test(v), 'draws list markers no check reads'],
    ['counter-reset', () => false, 'counts, for markers no check reads'],
    ['counter-increment', () => false, 'counts, for markers no check reads'],
    ['counter-set', () => false, 'counts, for markers no check reads'],
  ];
  for (const m of css.matchAll(/(?:^|[{;])\s*([a-z-]+)\s*:\s*([^;}]*)/gi)) {
    const rule = sheetRules.find(([name]) => name === m[1].toLowerCase());
    const value = m[2].trim().replace(/\s*!important$/i, '');
    if (rule && !rule[1](value)) fail(`${SITE_DIR}/cloudbitmaps.css ${rule[2]}: ${m[1]}: ${value}`);
  }
  if (/@(?:import|counter-style)\b/i.test(css)) {
    fail(`${SITE_DIR}/cloudbitmaps.css pulls in a sheet or a counter style no check reads`);
  }
  // A named reference this does not decode could be a figure (`&frac12;`) that no check reads.
  for (const m of L.raw.matchAll(/&([a-z][a-z0-9]*);/gi)) {
    if (!(m[1].toLowerCase() in NAMED))
      fail(`${page} writes &${m[1]}; , a reference this check does not read`);
  }

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
  const tables = matches(
    html,
    /<table class="cb-ftable" aria-label="(?:What goes in|What comes out)[^"]*">([\s\S]*?)<\/table>/,
  );
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
  const stage = matches(html, /(Pre-1\.0)\b/i);
  for (const m of stage) {
    if (!version.version.startsWith('0.'))
      fail(`${page} says ${m[1]}, but the packages are at ${version.version}`);
    else L.mark(...m.indices[1]);
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
  const rest = L.rest()
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ');
  const proseOf = (t) => [
    ...PROSE_ATTRS.filter((a) => t.attrs[a] !== undefined).map((a) => t.attrs[a]),
    ...(isProseMeta(t) ? [t.attrs.content ?? ''] : []),
  ];
  const prose = tagsOf(rest).flatMap(proseOf);
  // Inside a span a check read, the check compared the text, not the attributes: a number in one is unread.
  for (const [a, b] of L.marks) {
    const span = L.html.slice(a, b);
    if (span.startsWith('<!-- BENCH:')) continue;
    for (const t of tagsOf(span)) {
      if (t.name === 'meta') continue;
      for (const v of proseOf(t)) {
        if ((v.match(NUMBER) ?? []).length > 0) {
          fail(
            `${page} states "${v}" in an attribute of an element a check read for its text alone`,
          );
        }
      }
    }
  }
  const text = [...prose, decode(rest.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, ' '))].join(
    ' \n ',
  );
  const left = [...text.matchAll(NUMBER)].map((m) => {
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
const claims = (html) => plain(textOf(rendered(html))).includes(plain(CLAIM));

module.exports = {
  checkHome,
  finish,
  ledger,
  textOf,
  decode,
  tagsOf,
  metaKey,
  isProseMeta,
  claims,
  plain,
  CLAIM,
};
