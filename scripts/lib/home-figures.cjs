'use strict';
/**
 * The display-tier homepage, held figure by figure (site-next/index.html, read by scripts/site-figures.cjs).
 *
 * Every check here marks the exact span of the page it verified. What no check marked is then read for numbers:
 * the visible text, SVG labels included, and the attributes that carry prose (`aria-label`, `alt`, `title`, and the
 * descriptions a search result or a link preview shows). Any number left is a failure. So a figure is gated where it
 * stands: a wrong number that happens to equal a true one elsewhere on the page, a second unchecked copy of a checked
 * figure, or a new figure no check knows, all fail. That is what lets the page's footer say every figure on it is
 * gated in CI.
 *
 * Prose that carries a figure is compared whole, against a string built from the sources, so the words around a
 * figure cannot turn its meaning while the figure stays right. Where that would copy a long paragraph into this file
 * for no gain, the block's numbers are bound in order instead: each must be the one its source gives, and there must
 * be no other.
 *
 * The page's drawings of the scale run and its crossover chart are generated (bench/scale.cjs, bench/run.cjs) and
 * held byte for byte by `pnpm bench:scale:check` and `pnpm bench:check`, so their regions count as verified here.
 * Figures are numerals: a number written as a word ("three nodes") is prose, and is not read.
 */
const fs = require('node:fs');
const path = require('node:path');

const NUMBER = /(?<![\w.])\d[\d,]*(?:\.\d+)?/g;
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
};

/** Every character reference decoded, so `&#57;` is read as the 9 it renders. */
function decode(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&([a-z]+);/gi, (m, name) => NAMED[name.toLowerCase()] ?? m);
}

/** An element's text as a reader gets it: tags dropped, references decoded, whitespace collapsed. */
const textOf = (html) =>
  decode(html.replace(/<[^>]+>/g, ''))
    .replace(/\s+/g, ' ')
    .trim();

const numbersIn = (text) => text.match(NUMBER) ?? [];

/** The spans of a page that checks have verified. */
function ledger(html) {
  const marks = [];
  return {
    html,
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
  /** One element, found once, whose numbers must be exactly `want`, in order. Marks the group it read. */
  const numbers = (what, re, want, group = 1) => {
    const all = matches(html, re);
    if (all.length !== 1) {
      fail(`${page}'s ${what} is found ${all.length} times; this check reads it where it is once`);
      return;
    }
    const m = all[0];
    const got = numbersIn(textOf(decode(m[group])));
    if (got.join(' | ') !== want.join(' | ')) {
      fail(
        `${page}'s ${what} states ${got.join(', ') || 'no figure'}, but its sources give ${want.join(', ')}`,
      );
      return;
    }
    L.mark(...m.indices[group]);
    record(what, want.join(', '));
  };

  // ── the page may not carry text a reader cannot see ─────────────────────────────────────────────────────
  // A check that verifies hidden text while the visible text is false is worse than none. So nothing is hidden by
  // attribute, an inline style may only set a custom property (the generated drawings set a few), and the sheet
  // may not insert a number through `content:`.
  const body = html.slice(html.indexOf('<body'));
  if (/<[a-z][^>]*\shidden(?=[\s>=])/i.test(body)) {
    fail(
      `${page} hides an element with the hidden attribute, so a check could verify text no reader sees`,
    );
  }
  for (const m of body.matchAll(/\sstyle="([^"]*)"/g)) {
    if (!/^\s*(--[\w-]+\s*:\s*[^;]+;?\s*)+$/.test(m[1])) {
      fail(`${page} sets an inline style other than a custom property (style="${m[1]}")`);
    }
  }
  const css = fs.readFileSync(path.join(ROOT, SITE_DIR, 'cloudbitmaps.css'), 'utf8');
  for (const m of css.matchAll(/content:\s*(["'])(.*?)\1/g)) {
    if (/\d/.test(m[2]))
      fail(`${SITE_DIR}/cloudbitmaps.css inserts text with a number in it: content: ${m[0]}`);
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
  numbers('meta description', /<meta\s+name="description"\s+content="([^"]*)"/, [
    fetched,
    total,
    sizeGiB,
    atRestShown,
    String(REDIS),
    rate,
  ]);
  numbers('link-preview description', /<meta\s+property="og:description"\s+content="([^"]*)"/, [
    sizeGiB,
    atRestShown,
    String(REDIS),
    rate,
  ]);
  numbers('card description', /<meta\s+name="twitter:description"\s+content="([^"]*)"/, [
    atRestShown,
    String(REDIS),
  ]);

  // ── the hero ─────────────────────────────────────────────────────────────────────────────────────────────
  exact(
    'eyebrow',
    /<p class="label">(Distributed, cloud-native bitmaps[\s\S]*?)<\/p>/,
    `Distributed, cloud-native bitmaps · roaring shipped · v${version.version}`,
  );
  numbers('lede', /<h1>[\s\S]*?<p class="cb-lede">([\s\S]*?)<\/p>/, [fetched, total]);
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
        `${page}'s hero figure row holds ${cells.length} readable cells; it should hold ${HERO.length}`,
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
  numbers(
    'the Redis column foot',
    /<p class="cb-op-foot cb-note">\s*(Three nodes standing[\s\S]*?)<\/p>/,
    [String(REDIS)],
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
  numbers('cost headline', /<section id="crossover"[^>]*>[\s\S]*?<h2>([\s\S]*?)<\/h2>/, [rate]);
  numbers('cost lede', /<section id="crossover"[^>]*>[\s\S]*?<p class="cb-lede">([\s\S]*?)<\/p>/, [
    String(REDIS),
  ]);
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
      ['What goes in', 'Where it comes from'],
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
      ['What comes out', 'Derived · arithmetic'],
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
  numbers("the fit band's losing case", /<h3>(You read past [\s\S]*?)<\/h3>/, [rate]);
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
    /(?<![\w-])(Apache-\d+\.\d+|MIT|ISC|BSD-\d-Clause|MPL-\d+\.\d+|(?:A|L)?GPL-\d+\.\d+(?:-only|-or-later)?)(?![\w.])/,
  );
  for (const m of licences) {
    if (m[1] !== licence)
      fail(`${page} states the licence ${m[1]}, but package.json says ${licence}`);
    else L.mark(...m.indices[1]);
  }
  const stage = matches(html, /(Pre-1\.0)\b/);
  for (const m of stage) {
    if (!version.version.startsWith('0.'))
      fail(`${page} says ${m[1]}, but the packages are at ${version.version}`);
    else L.mark(...m.indices[1]);
  }
  if (
    !/every figure here is gated in CI/.test(textOf(body.replace(/<script[\s\S]*?<\/script>/g, '')))
  ) {
    fail(
      `${page}'s footer no longer says every figure here is gated in CI, which this check holds`,
    );
  }
}

/**
 * The last check: every number the page shows, in its text or in an attribute that carries prose, lies in a span
 * some check verified. Called once every check in site-figures has marked its spans.
 */
function finish({ L, page, fail }) {
  const rest = L.rest()
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ');
  const prose = [
    ...rest.matchAll(/\s(?:aria-label|alt|title)="([^"]*)"/g),
    ...rest.matchAll(
      /<meta\s+(?:name|property)="(?:description|og:description|twitter:description|og:title|twitter:title)"\s+content="([^"]*)"/g,
    ),
  ].map((m) => m[1]);
  const text = [...prose, rest.replace(/<[^>]+>/g, ' ')].map(decode).join(' \n ');
  const left = [...text.matchAll(NUMBER)].map((m) => {
    const around = text
      .slice(Math.max(0, m.index - 40), m.index + m[0].length + 30)
      .replace(/\s+/g, ' ')
      .trim();
    return `${m[0]} (…${around}…)`;
  });
  if (left.length > 0) {
    fail(
      `${page} shows ${left.length} figure(s) no check holds, and its footer says every figure here is gated ` +
        `in CI:\n      ${left.slice(0, 12).join('\n      ')}`,
    );
  }
}

module.exports = { checkHome, finish, ledger, textOf, decode };
