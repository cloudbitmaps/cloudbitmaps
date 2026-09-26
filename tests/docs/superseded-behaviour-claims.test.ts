import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Claims about behaviour this library NO LONGER HAS, spelled out so they cannot come back.
 *
 * WHY THIS FILE EXISTS. "An empty result publishes an empty generation" was true, was documented as
 * deliberate, and lived in **four** places: the guide's `*Into` section, two entries in the roadmap, and a
 * doc-comment that ships in the published `.d.ts`. The change that made it false updated exactly one of them,
 * and the full gate stayed green — the docs gates check that exports are documented and that links resolve,
 * neither of which can see prose contradicting behaviour.
 *
 * That is the second time a single sentence has outlived the code in this repo, which is the point at which
 * being careful stops being the answer. Each entry below is a phrase that was TRUE and is now FALSE; a hit
 * means someone wrote it again, or a stale copy survived a sweep.
 *
 * Adding an entry is the cheap half of retiring a behaviour. Removing one is only correct if the behaviour
 * came back.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SKIP = new Set(['node_modules', 'dist', '.git', 'coverage', '.worktrees', 'build', 'golden']);
const EXTS = ['.ts', '.md', '.html', '.txt', '.cjs', '.mjs'];

/**
 * The gap between two words, across a wrap.
 *
 * These phrases are sentences, and sentences in this repo hard-wrap at about 110 columns — inside Markdown
 * blockquotes and JSDoc comments, whose continuation lines begin `> ` and `* `. So the gap between two words
 * is often a newline plus a marker, and neither a literal space nor `\s+` alone spans it. Scanning line by
 * line cannot see any of it: whether a retired claim is caught then depends on how long the preceding words
 * happen to be, which is not a property anyone controls.
 *
 * `vocabulary-damage.test.ts` learned this first. Carried here, and to `unreleased-install-caveat`. Here it crosses
 * one line end at most: a sentence does not run on past a blank line, and a gap that did would join two copies of
 * a claim in two paragraphs into one hit.
 */
const GAP = String.raw`(?:[^\S\n]+|[^\S\n]*\n[^\S\n]*(?:(?:[>*#]|\/\/)[^\S\n]*)?)`;
const g = (src: string): string => src.replace(/ /g, GAP);

const NO_TIMED_REFRESH =
  '`cache.genTtlMs: 0`, no clock or no registry turns off the timed refresh, and nothing more: the store still ' +
  're-resolves on an eviction, a read that finds its generation swept, or an invalidation. Say "no timed ' +
  'refresh", and point at `seg.pin()` for one instant';

/** The named entities a sentence here is spelled with. A numeric one is decoded whatever it names. */
const ENTITY: Readonly<Record<string, string>> = {
  nbsp: ' ',
  mdash: '—',
  ndash: '–',
  amp: '&',
  quot: '"',
  apos: "'",
};
const codePoint = (entity: string, n: number): string =>
  n <= 0x10ffff ? String.fromCodePoint(n) : entity;

/**
 * The text a reader is given, so markup cannot carry a retired claim past the patterns. Tags, link targets, code
 * spans and emphasis go, as a renderer takes them away; entities are decoded; and a dash reads as the gap it is,
 * which the patterns' word runs then cross. Newlines survive, so a hit's line is still its own.
 */
const plain = (src: string): string =>
  src
    .replace(/<\/?[a-z][^>\n]*>/gi, '') // any tag, on one line: a stray `<` hides the rest of its line at most
    .replace(/!?\[([^\]\n]*)\]\([^)\n]*\)/g, '$1') // a link reads as its text
    .replace(/`/g, '')
    .replace(/(?<=\w)[*_]+|[*_]+(?=\w)/g, '') // emphasis hugs a word; a JSDoc or list marker does not
    .replace(/&#(\d+);/g, (e, d: string) => codePoint(e, Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (e, h: string) => codePoint(e, Number.parseInt(h, 16)))
    .replace(/&([a-z]+);/gi, (e, name: string) => ENTITY[name.toLowerCase()] ?? e)
    .replace(/[\u00a0\u2013\u2014]/g, ' ');

/** `cache.genTtlMs` set to zero, however the sentence spells the setting. */
const TTL_ZERO = String.raw`genTtlMs(?:\s*[:=]\s*|\s+(?:is|of|at|set to)\s+|\s+)0\b`;
/** What turns the timed refresh off: a zero TTL, no clock, or no registry. */
const NO_TIMED_REFRESH_SUBJECT = String.raw`(?:${TTL_ZERO}|\bno (?:clock|registry)\b|\bwithout an? (?:clock|registry)\b)`;

/** Phrases that describe behaviour this library used to have. Each carries what to say instead. */
const RETIRED: ReadonlyArray<{ readonly claim: RegExp; readonly why: string }> = [
  {
    claim: new RegExp(g(String.raw`publish(?:es|ing)? an empty generation over \`?dest`), 'i'),
    why: 'the *Into verbs refuse an empty result over a non-empty destination — say that instead',
  },
  {
    claim: new RegExp(g('an empty result publishes an empty generation'), 'i'),
    why: 'the *Into verbs refuse it; `allowEmpty: true` is the override',
  },
  {
    claim: new RegExp(g('still calls the bulk-load path directly'), 'i'),
    why: 'the *Into verbs route through the guarded loadSegment path',
  },
  {
    claim: new RegExp(g('does not yet cover these verbs'), 'i'), // read in plain text, its bold gone
    why: 'the load guard covers the *Into verbs now',
  },
  // A store with no timed refresh was called a pin — "pin forever", "pins the generation for its lifetime" —
  // across the guide, both privacy notes, shipped doc-comments and the tests. It stopped being true once such a
  // store still moved on: its reader cache evicting the segment, a read finding the generation it holds swept, and
  // an invalidation (its own `load`, `rollback`, `eraseSubject` and `*Into` writes, or `invalidate()`) each
  // re-resolve it. `seg.pin()` is the one thing that holds a generation, and the copies taught readers to reach for
  // `cache.genTtlMs: 0` instead. The patterns read prose, not syntax, so bold and entities are resolved first
  // (`**pins**` is how one copy escaped a first sweep). When a true sentence trips one, reword the sentence: of a
  // real pin, say "for the life of the handle", which none of them matches. A paraphrase can always escape a list
  // of patterns, which is why each hit says what to write instead: every one here is a form a copy was found in.
  {
    claim: new RegExp(
      g(String.raw`\bpin(?:s|ned|ning)? (?:[\w'-]+ ){0,5}(?:forever|permanently|for all time)\b`),
      'i',
    ),
    why: NO_TIMED_REFRESH,
  },
  {
    claim: new RegExp(
      g(
        String.raw`\b(?:keeps|kept|holds|held) (?:[\w'-]+ ){0,3}(?:generation|pointer|snapshot|reader)s? ` +
          String.raw`(?:[\w'-]+ ){0,3}(?:forever|permanently|for all time)\b`,
      ),
      'i',
    ),
    why: NO_TIMED_REFRESH,
  },
  {
    // "For good" is the idiom only where it ends its clause: "held for good reason" is not the claim.
    claim: new RegExp(
      g(
        String.raw`\b(?:pin(?:s|ned|ning)?|holds|held)\b (?:[^.;:]{1,60}? )?(?:(?:for|per|throughout) (?:[\w'-]+ ){0,2}lifetime\b|for good\b(?! \w))`,
      ),
      'i',
    ),
    why: NO_TIMED_REFRESH,
  },
  {
    claim: new RegExp(
      String.raw`\b(?:pins|pinned|pinning)\b(?:(?!\.\s)[^;]){0,80}?${TTL_ZERO}|` +
        String.raw`${TTL_ZERO}(?:(?!\.\s)[^;]){0,80}?\b(?:pins|pinned|pinning)\b`,
      'i',
    ),
    why: NO_TIMED_REFRESH,
  },
  {
    // A store with no timed refresh does move on, so "never" is the retired claim; "never re-reads it on a timer",
    // or "on its own", is not.
    claim: new RegExp(
      g(
        String.raw`${NO_TIMED_REFRESH_SUBJECT}(?:(?!\.\s)[^;]){0,80}?\bnever ` +
          String.raw`(?:re-resolves?|refresh(?:es)?|converges?|re-reads?|observes?|sees?|moves? on)\b` +
          String.raw`(?!(?:(?!\.\s)[^;,]){0,40}?\bon (?:a timer|its own)\b)`,
      ),
      'i',
    ),
    why: NO_TIMED_REFRESH,
  },
  {
    claim: new RegExp(
      g(String.raw`\bonly (?:on|at|with|by|after|through) (?:a |the |its )?timed refresh(?:es)?\b`),
      'i',
    ),
    why:
      'a store re-resolves a segment on four things, and a timed refresh is only one: an eviction, a read that ' +
      'finds its generation swept, and an invalidation are the others',
  },
];

/**
 * Files that DEFINE the rule and so must spell the retired phrases out — this one, and nothing else.
 *
 * History is not scanned: it says what was true when it was written, and would be a worse record rewritten to match
 * today. That is a released section of CHANGELOG.md, and a calibration run's dated report, which describes the
 * harness as that run used it. `[Unreleased]` is not history — it is what ships next — so it is read; so is a living
 * page that sits beside the reports, such as that directory's README.
 */
const DEFINES_THE_RULE = new Set([join('tests', 'docs', 'superseded-behaviour-claims.test.ts')]);
const RUN_REPORT = /^bench[\\/]calibration[\\/]\d{4}-\d{2}-\d{2}-\d+\.md$/;
const isHistory = (rel: string): boolean => RUN_REPORT.test(rel);
/** The part of a file the rule reads: all of it, but of a changelog only what comes before its first release. */
function scanned(rel: string, text: string): string {
  if (basename(rel) !== 'CHANGELOG.md') return text;
  const next = text.indexOf('\n## [', text.indexOf('## [Unreleased]') + 1);
  // Cut from the start, so offsets, and the line numbers read from them, stay the file's own.
  return next < 0 ? text : text.slice(0, next);
}

function textFiles(): string[] {
  const out: string[] = [];
  const walk = (rel: string): void => {
    const abs = join(ROOT, rel);
    if (!existsSync(abs)) return;
    for (const entry of readdirSync(abs)) {
      if (SKIP.has(entry)) continue;
      const child = rel === '.' ? entry : join(rel, entry);
      if (statSync(join(ROOT, child)).isDirectory()) walk(child);
      else if (EXTS.some((e) => entry.endsWith(e))) out.push(child);
    }
  };
  walk('.');
  return out.filter((f) => !DEFINES_THE_RULE.has(f) && !isHistory(f));
}

describe('no document claims behaviour this library has retired', () => {
  const files = textFiles();

  it('is scanning the surfaces where the stale copies actually were', () => {
    // Each of these held one of the four copies. A guard that stopped reaching them would pass silently.
    expect(files).toContain(join('docs', 'guide', 'getting-started.md'));
    expect(files).toContain(join('docs', 'ROADMAP.md'));
    expect(files).toContain(join('packages', 'roaring', 'src', 'index.ts'));
    expect(files.some((f) => f.startsWith('site/'))).toBe(true);
    // The living pages are read, the history beside them is not.
    expect(files).toContain('CHANGELOG.md');
    expect(files).toContain(join('bench', 'calibration', 'README.md'));
    expect(files.some((f) => RUN_REPORT.test(f))).toBe(false);
    expect(files.length).toBeGreaterThan(150);
  });

  // Both directions: each retired form is caught however it wraps, and the sentences that must stay legal are not.
  it.each([
    'with `cache: { genTtlMs: 0 }` ("pin forever"), holds',
    'instead of pinning one generation\n   * forever.',
    'the source **pins** the\n   * first-resolved generation for its lifetime',
    'holds its resolved snapshot for its own lifetime',
    "the fixture pins a segment's generation for the store's lifetime",
    '(pinned per source lifetime)',
    "Each timed intersect now pins its store's pointers (`cache.genTtlMs: 0`)",
    'the source **pins** the **generation** forever',
    'the source <strong>pins</strong> it forever',
    'pins&nbsp;the generation forever',
    'pins the first generation it resolved forever',
    '// the store pins the generation\n  // forever',
    'with `cache.genTtlMs = 0` the store pins it',
    'the fixture pins it for good',
    'a store built with no clock never re-resolves a segment',
    // Markup a renderer takes away: emphasis, code spans, links and tags.
    'the source *pins* the *generation* forever',
    'the source _pins_ the _generation_ forever',
    'the source `pins` the generation forever',
    'the source [pins](#pin) the generation forever',
    'the source <b>pins</b> the generation forever',
    'the source <em>pins</em> the generation forever',
    'the source <i>pins</i> the generation forever',
    'the source <span class="k">pins</span> the generation forever',
    '<a href="#pin">pins</a> the generation forever',
    // Entities, named and numeric, and the dashes they spell.
    'pins the generation &mdash; forever',
    'pins the generation &ndash; forever',
    'pins the generation&#x2014;forever',
    'pins the generation&#8212;forever',
    'the store pins the generation — forever',
    // The "never" form, wrapped, in the plural, and of each thing that turns the timed refresh off.
    'a store with no clock never\n   * re-resolves a segment',
    'a store with no\n   * clock never re-resolves a segment',
    'stores with no clock never re-resolve a segment',
    'a store with no clock never refresh',
    'a store with no registry never re-resolves a segment',
    'with `cache: { genTtlMs: 0 }` the store never re-reads the pointer',
    'with `genTtlMs: 0` it never observes a new generation',
    'cache.genTtlMs: 0 means the store never moves on',
    'a store whose `genTtlMs` is 0 never re-resolves a segment',
    'with `genTtlMs` set to 0 the store pins it',
    // And its synonyms.
    'the store keeps its first generation forever when `genTtlMs` is 0',
    'pins the generation for all time',
    'pins it permanently',
    "a store re-reads a segment's pointer only on a timed refresh",
  ])('catches the retired form %j', (text) => {
    expect(RETIRED.some(({ claim }) => claim.test(plain(text)))).toBe(true);
  });

  it.each([
    'Pass `purgeTombstones: false` to keep every tombstone forever',
    '`seg.pin()` holds a segment at the generation current when you call it, for the life of the handle',
    "a monotonic move forward within that segment's lifetime, never a torn object",
    'a segment approaching ~2³² lifetime chunk-seals',
    '`cache: { genTtlMs: 0 }` turns the timed refresh off. A pinned handle is what holds one generation',
    'A pinned handle holds its generation for the life of the handle',
    'a store with no clock never re-reads a pointer on a timer, and never refreshes on a timer',
    'it can keep answering `true` for a dropped segment indefinitely',
    'the destroyed row is held for good reason',
    'Pass `purgeTombstones: false` and the sweep keeps every tombstone forever',
    'a store with no registry reads the newest generation in the bucket, and never re-resolves on its own',
    'the timed refresh re-reads the pointer once `cache.genTtlMs` lapses, and an eviction re-reads it too',
    'a `snake_case_name` and `a * b` are not emphasis',
  ])('leaves %j alone', (text) => {
    expect(
      RETIRED.filter(({ claim }) => claim.test(plain(text))).map(({ claim }) => claim.source),
    ).toEqual([]);
  });

  it('reads a file as the scan below does: in plain text, and of CHANGELOG.md only what is unreleased', () => {
    const changelog = [
      '# Changelog', // line 1
      '',
      '## [Unreleased]',
      '',
      '- the source **pins** it forever', // line 5: bold, and unreleased
      '',
      '## [0.1.0]',
      '',
      '- pins forever', // released: history
    ].join('\n');
    expect(hitsIn('CHANGELOG.md', changelog).map((h) => h.split(' — ')[0])).toEqual([
      'CHANGELOG.md:5',
    ]);
  });

  it('reads every file through plain(), not only the changelog', () => {
    expect(hitsIn(join('docs', 'x.md'), 'the source **pins** it forever')).toHaveLength(1);
  });

  it('reports every hit, not the first of each pattern', () => {
    const lines = hitsIn('x.md', 'pins it forever\n\npins it forever').map(
      (h) => h.split(' — ')[0],
    );
    expect(lines).toEqual(['x.md:1', 'x.md:3']);
  });

  it("reads a package's changelog as the root one: its released history is not scanned", () => {
    const changelog =
      '# c\n\n## [Unreleased]\n\n- pins it forever\n\n## [0.1.0]\n\n- pins it forever';
    expect(hitsIn(join('packages', 'core', 'CHANGELOG.md'), changelog)).toHaveLength(1);
  });

  it("treats only a calibration run's dated report as history, not every page beside it", () => {
    expect(isHistory(join('bench', 'calibration', '2026-09-14-12345.md'))).toBe(true);
    expect(isHistory(join('bench', 'calibration', 'README.md'))).toBe(false);
    expect(isHistory(join('bench', 'calibration', 'notes.md'))).toBe(false);
    expect(isHistory(join('bench', 'calibration', '2026-09-14-12345.json.md'))).toBe(false);
  });

  it.each(files)('%s', (rel) => {
    expect(hitsIn(rel, readFileSync(join(ROOT, rel), 'utf8'))).toEqual([]);
  });
});

/** Every retired claim a file makes, with its line. Every hit, not the first of each: three copies say so at once. */
function hitsIn(rel: string, text: string): string[] {
  const src = plain(scanned(rel, text));
  const hits: string[] = [];
  for (const { claim, why } of RETIRED) {
    for (const m of src.matchAll(new RegExp(claim.source, `${claim.flags}g`))) {
      const line = src.slice(0, m.index).split('\n').length;
      hits.push(`${rel}:${line} — "${m[0].replace(/\s+/g, ' ')}" is no longer true. ${why}`);
    }
  }
  return hits;
}
