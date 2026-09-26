import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
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
const EXTS = [
  '.ts',
  '.md',
  '.html',
  '.txt',
  '.cjs',
  '.mjs',
  '.js',
  '.yml',
  '.yaml',
  '.json',
  '.svg',
];

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
 * spans, emphasis and doc-comment links go, as a renderer takes them away; entities are decoded, curly quotes
 * straightened, and a dash or a line break reads as the gap it is, which the patterns' word runs then cross.
 * Newlines survive, so a hit's line is still its own.
 */
const plain = (src: string): string =>
  src
    .replace(/<br\b[^<>]*>/gi, ' ')
    // Any tag, its attributes wrapped or not; a `<` in a sentence opens none. What an attribute shows is kept: a
    // `<meta>` description is a search result's text, and `alt`, `title` and `aria-label` are read or shown too.
    .replace(/<\/?[a-z][^<>]*>/gi, (tag) => {
      const shown = [
        ...tag.matchAll(/\b(?:content|alt|title|aria-label)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi),
      ];
      return shown.map((a) => ` ${a[1] ?? a[2]} `).join('') + tag.replace(/[^\n]/g, '');
    })
    .replace(/!?\[([^\]\n]*)\](?:\([^)\n]*\)|\[[^\]\n]*\])/g, '$1') // a link, inline or by reference, reads as its text
    .replace(
      /\{@link(?:code|plain)?\s+([^\s|}]+)(?:\s*\|\s*|\s+)?([^}]*)\}/g,
      (_, name: string, text: string) => (text.trim() === '' ? name : text.trim()),
    )
    .replace(/`/g, '')
    .replace(/(?<=\w)[*_]+|[*_]+(?=\w)/g, '') // emphasis hugs a word; a JSDoc or list marker does not
    .replace(/&#(\d+);/g, (e, d: string) => codePoint(e, Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (e, h: string) => codePoint(e, Number.parseInt(h, 16)))
    .replace(/&([a-z]+);/gi, (e, name: string) => ENTITY[name.toLowerCase()] ?? e)
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/(?<!\w)(["'])([\w-]+)\1(?!\w)/g, '$2') // a word in quotes is the word: the store "pins" it
    .replace(/[\u00a0\u2013\u2014]/g, ' ');

/** `cache.genTtlMs` set to zero, however the sentence spells the setting. */
const TTL_ZERO = String.raw`genTtlMs(?:\s*[:=]\s*|\s+(?:is|of|at|to|set to)\s+|\s+)(?:0|zero)\b`;
/** What turns the timed refresh off: a zero TTL, no clock, or no registry, a bare `IStorageDriver` among them. */
const NO_TIMED_REFRESH_SUBJECT = String.raw`(?:${TTL_ZERO}|\bno (?:injected )?(?:clock|registry)\b|\bwithout an? (?:injected )?(?:clock|registry)\b|\bregistry-less\b|\bbare IStorageDriver\b)`;
/** The end of a table row: its last cell's edge and the line end after it, or a line end before another row. */
const ROW_END = String.raw`\|[^\S\n]*(?:\n|$)|\n(?=[^\n]*\|)`;
/**
 * At most `n` characters of one sentence between a claim's words: never past a blank line or the end of a table row.
 * A row's cells pair, since a settings table says what a setting does in the cell beside it.
 */
const within = (n: number): string => String.raw`(?:(?!\.\s|\n\s*\n|${ROW_END})[^;]){0,${n}}?`;
/** Up to a clause of one paragraph, for a claim whose words may sit apart. */
const SPAN = String.raw`(?:(?!\n\s*\n|${ROW_END})[^.;:])`;
/** Not after a word that negates the claim: "nothing pins a generation forever" is not it. */
const NOT_NEGATED = String.raw`(?<!\b(?:nothing|never|not|no|cannot|can't) )`;
/** A pin as a verb, or "acts as a pin". Not "a pinned handle", which is `seg.pin()`, nor "pins nothing". */
const PIN_WORD = String.raw`(?:\bpin(?:s|ning)?|\bpinned(?! handles?\b))\b`;
/**
 * The same, as the verb a store is said to do, and strict on purpose: a true sentence this refuses is reworded, since
 * each exemption a sentence has earned so far has also let a retired claim through. Only these are not the claim:
 * "pins" after a possessive or a determiner, which is the noun ("two incarnations' pins"), or after `pin()`, its
 * subject; "pinned" after a determiner, the adjective ("the pinned object"); "pins nothing"; and a "pinned handle",
 * which is `seg.pin()`'s.
 */
const PINS = String.raw`(?:(?<!(?:'|\b(?:its|their|the|all|both|of|these|those|whose|two|three|many|several|other|your|our)|\bpin\(\)) )\bpins\b(?! nothing\b)|\bpinning\b|(?<!\b(?:the|a|an|its|their|each|every|one|this|that) )\bpinned\b(?! handles?\b)|\b(?:act|acts|behave|behaves|work|works) (?:as|like) (?:a |one )?(?:[\w'-]+ )?(?:pins?|seg\.pin\(\))(?![\w(]))`;
/** What a store is said never to see: a newer generation, a publish, or a change. */
const NEWER = String.raw`(?:(?:a|the|any) )?(?:(?:new|newer|later|next) (?:generation|publish|pointer|change)s?|publish(?:es)?|changes?)`;
/**
 * What a claim that a store never moves on says it never does. Only "on a timer" ending the claim, just after the verb
 * or its object, is true and exempt: "never re-resolves on a timer", "never re-reads a pointer on a timer". Anything
 * between, or an "or" or "nor" after it, makes it the claim again.
 */
const NEVER_MOVES = String.raw`(?:never (?:re-resolves?|refresh(?:es)?|converges?|re-reads? (?:(?:the|its|a|each) )?(?:pointer|segment)s?|moves? on|(?:observes?|sees?|notices?|picks? up) ${NEWER})|(?:does not|doesn't|will not|won't) (?:re-resolve|refresh|re-read (?:(?:the|its|a|each) )?(?:pointer|segment)s?|move on|(?:observe|see|notice|pick up) ${NEWER}))\b(?! (?:(?:a|the|its|each) (?:segment|pointer|generation)s? )?on a timer\b(?!,? (?:or|nor)\b))`;

/** Phrases that describe behaviour this library used to have, each with what to say instead. */
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
      g(
        NOT_NEGATED +
          String.raw`${PIN_WORD} (?:[\w'(),-]+ ){0,5}(?:forever|permanently|indefinitely|for all time)\b`,
      ),
      'i',
    ),
    why: NO_TIMED_REFRESH,
  },
  {
    // One generation kept for good; "a keep that holds every generation forever" is retention, and true.
    claim: new RegExp(
      g(
        String.raw`\b(?:keeps?|kept|holds?|held|reads?|serves?|served) (?:[\w'-]+ ){0,2}?(?:its|their|the|one|a|that)(?: (?:first|first-resolved|resolved|current|same|single|own))? ` +
          String.raw`(?:generation|pointer|snapshot|reader)s? (?:[\w'(),-]+ ){0,3}` +
          String.raw`(?:forever|permanently|indefinitely|for all time|until (?:it|the (?:process|store)) (?:restarts|is restarted)|for the life of the (?:store|source|process|reader|cache))\b`,
      ),
      'i',
    ),
    why: NO_TIMED_REFRESH,
  },
  {
    // "For good" is the idiom only where it ends its clause: "held for good reason" is not the claim.
    claim: new RegExp(
      g(
        NOT_NEGATED +
          String.raw`${PIN_WORD} (?:${SPAN}{1,60}? )?(?:(?:for|per|throughout) (?:[\w'-]+ ){0,2}lifetime\b|for good\b(?! \w)|for the life of the (?:store|source|process|reader|cache)\b)`,
      ),
      'i',
    ),
    why: NO_TIMED_REFRESH,
  },
  {
    // Held for a lifetime: a generation, snapshot, pointer or reader, not any word ("a row holds its DEK for the
    // segment's lifetime" is true).
    claim: new RegExp(
      g(
        String.raw`\b(?:holds?|held|keeps?|kept)\b (?:${SPAN}{0,40}? )?(?:generation|snapshot|pointer|reader)s? ` +
          String.raw`(?:${SPAN}{0,30}? )?(?:(?:for|per|throughout) (?:[\w'-]+ ){0,2}lifetime\b|for good\b(?! \w)|for the life of the (?:store|source|process|reader|cache)\b)`,
      ),
      'i',
    ),
    why: NO_TIMED_REFRESH,
  },
  {
    // A store with no timed refresh said to pin, in either order.
    claim: new RegExp(
      g(
        String.raw`${PINS}${within(80)}${NO_TIMED_REFRESH_SUBJECT}|${NO_TIMED_REFRESH_SUBJECT}${within(80)}${PINS}`,
      ),
      'i',
    ),
    why: NO_TIMED_REFRESH,
  },
  {
    // A store with no timed refresh does move on, so "never" is the retired claim, in either order.
    claim: new RegExp(
      g(
        String.raw`${NO_TIMED_REFRESH_SUBJECT}${within(80)}\b${NEVER_MOVES}|\b${NEVER_MOVES}${within(60)}${NO_TIMED_REFRESH_SUBJECT}`,
      ),
      'i',
    ),
    why: NO_TIMED_REFRESH,
  },
  {
    // "Never, with no clock": a store's re-resolving, said to stop. Of the timed refresh it is true, and said plainly
    // instead: "with no clock there is no timed refresh".
    claim: new RegExp(
      g(String.raw`\bnever,? (?:if|when|with|for) (?:[\w'-]+ ){0,4}${NO_TIMED_REFRESH_SUBJECT}`),
      'i',
    ),
    why: NO_TIMED_REFRESH,
  },
  {
    // The generation a store with no timed refresh reads, said never to change.
    claim: new RegExp(
      g(
        String.raw`${NO_TIMED_REFRESH_SUBJECT}${within(80)}\b(?:generation|pointer|snapshot)s? (?:never|does not|doesn't|will not|won't) (?:changes?|moves?|advances?)\b|` +
          String.raw`\b(?:generation|pointer|snapshot)s? (?:never|does not|doesn't|will not|won't) (?:changes?|moves?|advances?)\b${within(60)}${NO_TIMED_REFRESH_SUBJECT}`,
      ),
      'i',
    ),
    why: NO_TIMED_REFRESH,
  },
  {
    // A pin holds a generation; a pointer is what a store re-reads. In either order: "its pointer pinned".
    claim: new RegExp(
      g(
        NOT_NEGATED +
          String.raw`\b(?:pin(?:s|ned|ning)? (?:each|every|its|their|the|a|one|that) (?:[\w'-]+ )?pointers?|pinned pointers?|pointers? (?:is |are |stays? |kept |held |left )?pinned)\b`,
      ),
      'i',
    ),
    why: NO_TIMED_REFRESH,
  },
  {
    // A store with no timed refresh, labelled "Pinned" where a sentence or a comment line opens: "Pinned: no refresh
    // at all", "Pinned, it is two". Capitalised, as a label is: `pinned:` in code is a key. Of a real pin, say "a
    // pinned handle".
    claim: /(?:^|[.!?][^\S\n]+|\n)[^\S\n]*(?:(?:\/\/|\*|#+|>|-|\d+\.)[^\S\n]*)?Pinned[:,]/,
    why: NO_TIMED_REFRESH,
  },
  {
    // What the calibration harness does is turn the timed refresh off; it pins nothing.
    claim: new RegExp(
      g(String.raw`\b(?:harness|timed (?:store|intersect|read)s?)(?:'s?)? (?:now )?pins\b`),
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
const { checkRunId } = createRequire(import.meta.url)('../../bench/lib/calibrate-guards.cjs') as {
  checkRunId: (id: string) => string;
};
/**
 * A calibration run's report: a page in that directory named by an id the harness itself would accept for a run, beside
 * the `<id>.json` evidence that run wrote. A page named like one, with no run behind it, is read like any other.
 */
const RUN_REPORT = /^bench[\\/]calibration[\\/](.+)\.md$/;
const isHistory = (rel: string): boolean => {
  const id = RUN_REPORT.exec(rel)?.[1];
  if (id === undefined || !existsSync(join(ROOT, dirname(rel), `${id}.json`))) return false;
  try {
    checkRunId(id);
    return true;
  } catch {
    return false;
  }
};
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
    expect(files.some(isHistory)).toBe(false);
    // And the prose that lives outside Markdown and TypeScript: scripts, workflows and issue forms, data, charts.
    for (const ext of ['.js', '.yml', '.json', '.svg'])
      expect(files.some((f) => f.endsWith(ext))).toBe(true);
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
    // Copies the repo has carried, and the word orders it has used.
    '`0` pins each pointer for as long as the reader keeps the segment open.',
    'A pinned pointer (`genTtlMs: 0`) is not refreshed.',
    'The exception is a source that never re-resolves — no clock injected, no registry, or `cache: { genTtlMs: 0 }`.',
    'until its TTL lapses, and **never** if it has no clock or `cache.genTtlMs: 0`.',
    'A store with no clock pins each segment at the generation it first resolved.',
    'a store with `genTtlMs: 0` acts as a pin',
    'a store with no clock behaves like one big `seg.pin()`',
    'Setting `genTtlMs` to 0 pins the generation',
    'Stores with `genTtlMs: 0` hold their generation forever',
    'the source pins it indefinitely',
    'the store holds its generation for the life of the store',
    'a store with no clock does not re-resolve a segment',
    'A store with no clock never re-resolves a segment on its own: only `invalidate()` moves it.',
    // And markup the first rules did not strip.
    'the source pins every {@link Segment} forever',
    'the source pins the segment\u2019s generation forever',
    'the source pins the generation, forever',
    'the source pins<br>forever',
    'the source [pins][pin] the generation forever',
    'the source pins <span\n  class="k">the</span> generation forever',
    'the fixture pins it for the life of the store',
    // A pin named in the sentence does not make it about a pin: here the store is the subject.
    'Like `seg.pin()`, a store with `genTtlMs: 0` holds its generation forever.',
    'Like a pin, a store with no clock never re-resolves a segment.',
    'A pin, like a store with no clock, never re-resolves.',
    'Take a `seg.pin()` for one instant.\nA store with no clock never re-resolves a segment.',
    'the whole promise of a pin, and the memo is allowed to be up to `cache.genTtlMs` behind — or, on a store with\n * no clock, arbitrarily far behind, since it never refreshes at all.',
    // The other things such a store was said never to do, and "on a timer" that no longer excuses it.
    'a store with no clock never sees a new generation',
    'with `cache.genTtlMs: 0` the store never sees a publish',
    'a store with no clock never re-reads a segment',
    'with `genTtlMs: 0` it never observes a publish',
    'A store with no clock never re-resolves a segment, not even on a timer.',
    'A store with no clock never re-resolves, on a timer or otherwise.',
    'A store with no clock never re-resolves on a timer or otherwise.',
    'A store with no clock never re-resolves a segment — not even on a timer.',
    // A sentence ends at a line end too, so the one before it cannot excuse it.
    'The timed refresh is off.\nA store re-reads the pointer until its TTL lapses, and never if it has no clock.',
    'A store with no clock keeps serving the same generation forever.',
    'With `genTtlMs: 0`, the pinned generation never changes.',
    '| `cache.genTtlMs: 0` | pins each segment at its first generation |',
    '| the fixture pins it | for the life of the store |',
    // What excuses "never" is said before it, not in the sentence after.
    'The store re-reads its pointer until the TTL lapses, and never if it has no clock. The timed refresh is off there.',
    // Labels and reversed orders.
    '// Pinned: no refresh at all, and the model bills none.',
    '// Pinned, it never refreshes, and the report bills none.',
    "Each timed intersect's store has its pointer pinned.",
    'the store keeps each pointer pinned',
    'as the library does when an intersect ends inside its pointer refresh, and which the harness now pins.',
    // Word orders and words an exemption or a narrowing let through.
    '`cache.genTtlMs: 0` pins your segments at the generation they first resolved.',
    'A store with no clock pins segments to the generation it first read.',
    'Setting `genTtlMs: 0` amounts to pinning every segment.',
    'A store with `genTtlMs: 0` ends up pinning each segment.',
    'With `cache.genTtlMs: 0`, reads are pinned reads.',
    'A store with no clock serves pinned generations until it restarts.',
    'A store with `genTtlMs: 0` pins, in effect, the first generation it read.',
    'A store with no clock pins generation 0 until it restarts.',
    'Stores with `genTtlMs: 0` act like pins and never re-resolve.',
    'Stores with `genTtlMs: 0` act like pins.',
    'Stores with `genTtlMs: 0` behave like a pin.',
    'the source "pins" the generation forever',
    'the source \u201cpins\u201d the generation forever',
    'with `genTtlMs: 0` the store "pins" the generation forever',
    'with `genTtlMs: 0` the store \u201cpins\u201d the generation forever',
    'A store with no clock, like a pin, never re-resolves a segment.',
    'Like a store with no clock, a pin never re-resolves.',
    'A pin never re-resolves, and neither does a store with no clock.',
    'With `genTtlMs: 0` the store, just like `seg.pin()`, keeps its first generation forever.',
    '- **Timed refresh**\n  A store re-reads the pointer until its TTL lapses, and never if it has no clock.',
    'The timed refresh is off\nA store re-reads the pointer until its TTL lapses, and never if it has no clock.',
    'A store with no clock never re-resolves on a timer or on an eviction.',
    'A store with no clock never re-resolves on a timer, nor on an eviction.',
    'A store with no clock never re-resolves, because nothing fires on a timer.',
    'A registry-less store never re-resolves a segment.',
    'A store wired with a bare `IStorageDriver` never re-resolves a segment.',
    'A store with no injected clock never re-resolves a segment.',
    'With a `genTtlMs` of zero the store never re-resolves a segment.',
    'A store with no clock never picks up a new generation.',
    'A store with no clock never notices a publish.',
    'A store with `genTtlMs: 0` reads the same generation forever.',
    'A store with `genTtlMs: 0` keeps its first generation until it restarts.',
    '// Pinned, it is two — one per operand — however long the intersect takes.',
    // What an attribute shows is read.
    '<meta\n  name="description"\n  content="Set cache.genTtlMs: 0 and the store pins each segment forever"\n/>',
    '<img src="a.svg" alt="With no clock, the store pins it forever" />',
  ])('catches the retired form %j', (text) => {
    expect(hitsIn('x.md', text)).not.toEqual([]);
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
    'a store with no registry reads the newest generation in the bucket, and never re-resolves on a timer',
    'the timed refresh re-reads the pointer once `cache.genTtlMs` lapses, and an eviction re-reads it too',
    'a `snake_case_name` and `a * b` are not emphasis',
    // True sentences an earlier rule refused: the gate's own advice, negations, and facts about other things.
    '`cache.genTtlMs: 0` means no timed refresh, and for one instant you want a pinned handle, `seg.pin()`.',
    '`cache: { genTtlMs: 0 }` turns the timed refresh off, and a pinned handle is what holds one generation',
    '`cache.genTtlMs: 0` pins nothing: take a `seg.pin()`.',
    'Nothing pins a generation forever — size `keep` to cover the longest job.',
    'A store with no registry never sees a `destroyed` tombstone, since there is no row to hold one.',
    'A `keep` of `Number.MAX_SAFE_INTEGER` holds every generation forever.',
    "The registry row holds the wrapped DEK for the segment's lifetime.",
    '### Stores with no registry\n\nA pinned handle never sees a publish, by design.',
    '| a store with **no clock**, or `cache: { genTtlMs: 0 }` | no bound |\n| a pinned handle (`seg.pin()`) in another store | no bound |',
    "The fingerprint keeps two incarnations' pins apart where the version cannot: on a store with no registry.",
    'On a store with no registry, the pinned object is found by its fingerprint.',
    // A claim's words never pair across a heading's blank line or a table cell's edge.
    '### With no clock\n\nThe loader pins its version to the lockfile',
    '`cache.genTtlMs: 0` turns the timed refresh off, and pinned handles are what hold one generation',
    '| no clock | none |\n| the loader pins its version | yes |',
    '| the loader pins its version | yes |\n| per process lifetime | once |',
    'no clock | none\nthe loader pins its version | yes',
    // `pin()` as the subject of "pins" says what a pin does, on any store.
    'Without a registry, `pin()` pins the newest generation in the bucket.',
    // True sentences about pins on a store with no clock or no registry, and negations.
    'Without a registry, `pin()` pins the newest generation in the bucket.',
    'A store with no clock never re-resolves a segment on a timer: an eviction or an invalidation moves it.',
    '<meta name="description" content="A pinned handle holds one generation for the life of the handle" />',
  ])('leaves %j alone', (text) => {
    expect(hitsIn('x.md', text)).toEqual([]);
  });

  // Strict on purpose: these are true, and each reads as the retired claim. Each one reworded, as the gate asks, passes.
  it.each([
    [
      'A pinned handle never re-resolves, even on a store with no clock.',
      'A pinned handle holds its generation for the life of the handle, even on a store with no clock.',
    ],
    ['Pinning needs no clock.', '`pin()` needs no clock.'],
    [
      'Pinning without a registry costs a LIST and a tail read per pin.',
      'Without a registry, each `pin()` costs a LIST and a tail read.',
    ],
    [
      'Pins taken on a store with no registry each read the tail.',
      'On a store with no registry, each `pin()` reads the tail.',
    ],
    [
      'A store with no clock is not pinned: it still re-resolves on an eviction.',
      'A store with no clock still re-resolves on an eviction.',
    ],
    [
      "A store with no clock isn't pinned to its first generation.",
      'A store with no clock moves past its first generation on an eviction.',
    ],
    [
      'No one pins a generation with `genTtlMs: 0`.',
      '`genTtlMs: 0` holds no generation: it turns the timed refresh off.',
    ],
    [
      'Pinned readers live in the same LRU on a store with no registry.',
      "A pin's readers live in the same LRU on a store with no registry.",
    ],
    [
      'The timed refresh runs every `genTtlMs`, and never with no clock or `genTtlMs: 0`.',
      'The timed refresh runs every `genTtlMs`; with no clock or `genTtlMs: 0` there is none.',
    ],
    [
      'On a store with no clock, a pinned handle never re-resolves.',
      'On a store with no clock, a pinned handle holds its generation for the life of the handle.',
    ],
    [
      "A pinned handle's generation never changes, even with `genTtlMs: 0`.",
      'A pinned handle holds one generation for the life of the handle, even with `genTtlMs: 0`.',
    ],
  ])('refuses %j, though true, and passes it reworded', (refused, reworded) => {
    expect(hitsIn('x.md', refused)).not.toEqual([]);
    expect(hitsIn('x.md', reworded)).toEqual([]);
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

  it('keeps the lines of a tag it reads the attributes of, so a hit after one is on its own line', () => {
    const lines = hitsIn(
      'x.html',
      '<meta\n  name="description"\n  content="x"\n/>\n\npins it forever',
    ).map((h) => h.split(' — ')[0]);
    expect(lines).toEqual(['x.html:6']);
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
    // The published run's report sits beside the evidence it wrote; a page only named like one does not.
    expect(existsSync(join(ROOT, 'bench', 'calibration', '2026-09-23-94416.json'))).toBe(true);
    expect(isHistory(join('bench', 'calibration', '2026-09-23-94416.md'))).toBe(true);
    expect(isHistory(join('bench', 'calibration', '2026-09-14-12345.md'))).toBe(false);
    expect(isHistory(join('bench', 'calibration', '2026-10-01-notes.md'))).toBe(false);
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
