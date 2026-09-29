import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { lineOf, unwrap } from '../helpers/prose';

/**
 * The library is described by what it is, not by what it used to be. The code and its comments (which ship in the
 * `.d.ts` files and sourcemaps), the docs, the READMEs and the site say what is true now; how a function, a field or
 * a page came to be that way is in the git history. `earlier-releases.test.ts` keeps earlier versions out; this
 * keeps out the wording that tells the library's past without naming a version:
 * - a habit in the past ("the message used to say", "this branch used to do");
 * - "previously" and "formerly";
 * - a component the library does not have (a warm, delta or live tier, anything NoSQL), or "the removed",
 *   "previous", "legacy" or "retired" tier, registry, layout, API, option or form;
 * - "the library no longer …", "no longer ships", "no longer supported", "deprecated";
 * - an earlier version or draft of the text itself ("an earlier version of this comment", "the first draft");
 * - "before this fix", "since the rename", "until now";
 * - "was renamed", "renamed from", "was removed in favour of", "was replaced by".
 *
 * These catch honest drift: a stale sentence, a paraphrase of one, the same claim wrapped differently. No list of
 * phrases stops the past being told in words it has never seen. "No longer", "is now", "is gone" and "has since
 * been" are not refused, because they describe run time as often as history ("a segment the id is no longer in",
 * "the bit is gone"). Where a refused phrase is true of run time ("a previously published generation", "the DEK
 * used to encrypt each chunk"), the sentence is reworded ("an earlier published generation", "the DEK that
 * encrypts"); the patterns stay.
 *
 * Read: `packages/[pkg]/src`, `docs/`, `site/`, and the Markdown at the root and in each package, but the
 * changelog, whose job is the history. The tests, scripts and benches are not read: their comments record why a check
 * exists, which is often the defect it was written for. Text is read across wrapped lines and joined strings
 * (`tests/helpers/prose.ts`), so a wrap cannot split a phrase.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

const PAST = {
  'a habit in the past': new RegExp(
    String.raw`(?<![,(—–:;][ \t]*|\b(?:is|are|was|were|be|been|being|gets?|got|also|only|not|mainly|typically|often|then)[ \t]+)\bused[ \t]+to\b`,
    'g',
  ),
  'previously or formerly': /\b(?:previously|formerly)\b/gi,
  'a component the library does not have':
    /\b(?:warm|delta|live)[ \t-]+(?:[\w-]+[ \t-]+)?tiers?\b|\bNoSQL\b|\bthe[ \t]+(?:removed|former|old|previous|prior|legacy|retired|earlier)[ \t]+(?:\w+[ \t]+)?(?:tier|registry|grammar|layout|API|package|option|name|form)s?\b/gi,
  'the library no longer':
    /\b(?:the library|this library|CloudBitmaps|the package)[ \t]+(?:\w+[ \t]+)?no[ \t]+longer\b|\bno[ \t]+longer[ \t]+(?:ships|supported|owed)\b|\b(?:is|are|was|now)[ \t]+deprecated\b/gi,
  'an earlier version of the text':
    /\b(?:an|the)[ \t]+(?:earlier|first)[ \t]+(?:version|draft|form)[ \t]+(?:of[ \t]+(?:this|the)[ \t]+\w+|skipped|returned|showed|said|claimed|pushed|did)\b|\bthe[ \t]+(?:earlier|first)[ \t]+(?:form|draft)\b|\bin[ \t]+the[ \t]+first[ \t]+draft\b/gi,
  'a change as a point in time':
    /\b(?:before|until|since)[ \t]+(?:that|this|the)[ \t]+(?:fix|rewrite|rename|refactor)\b|\buntil[ \t]+now\b/gi,
  'a rename or a removal':
    /\b(?:was|were|has been|have been)[ \t]+renamed\b|\brenamed[ \t]+from\b|\b(?:was|were|ha(?:s|ve)[ \t]+been)[ \t]+(?:removed|replaced)[ \t]+(?:in[ \t]+favou?r[ \t]+of|by)\b/gi,
} as const;

/**
 * The only lines that may match, each named by its file and a phrase of its own. Every entry must still match, so
 * the list shrinks rather than goes stale.
 *
 * The July 2026 calibration run measured a registry and a write path the library does not have, and these lines
 * say so beside its figures. Whether the figures stay is open; until it is decided, these are its exceptions.
 * Two backends refuse, by name, what a caller wiring them the way an earlier release did would pass: the
 * local-filesystem backend a `cold/` directory, and the GCS backend a `storage` option. Whether those refusals
 * stay is open too.
 */
const EXCEPTIONS: ReadonlyArray<readonly [file: string, phrase: string]> = [
  ['README.md', 'pointer in a NoSQL table the library no longer ships'],
  ['docs/benchmarks.md', 'a retired one: the pointer lived in a NoSQL table'],
  [
    'docs/benchmarks.md',
    'The registry in that run was a NoSQL table. **CloudBitmaps no longer ships one**',
  ],
  ['docs/benchmarks.md', "topology's NoSQL uses: the delta tier the library no longer has"],
  ['docs/benchmarks.md', 'was billed to the NoSQL registry, whose line items are withheld'],
  ['docs/benchmarks.md', 'Generation resolution ran against a NoSQL table'],
  ['docs/ROADMAP.md', 'figures described the removed warm tier'],
  ['docs/ROADMAP.md', 'other half metered the removed delta tier'],
  ['packages/roaring/README.md', 'which kept the pointer in a NoSQL registry that no longer ships'],
  ['site/benchmarks.html', 'was billed to a NoSQL registry that no longer ships'],
  [
    'site/benchmarks.html',
    "The other half's line items metered a NoSQL delta tier the library no longer has",
  ],
  ['site/benchmarks.html', 'Its other half metered a NoSQL delta tier the library no longer has'],
  ['site/benchmarks.html', 'Generation resolution ran against a NoSQL table in the July run'],
  ['site/llms.txt', 'which kept the pointer in a NoSQL registry that no longer ships'],
  [
    'packages/core/src/drivers/backends.ts',
    'It refuses a store written before the tier was renamed',
  ],
  ['packages/core/src/drivers/backends.ts', 'this store was written before the tier was renamed'],
  ['packages/gcs/src/backend.ts', 'not `storage` (which was the old GcsStorageDriver option)'],
];

const BINARY = /\.(?:png|jpe?g|gif|webp|ico|woff2?|ttf|otf|pdf|gz|tgz|zip|crbm|wasm|node)$/i;
const READ = [
  /^packages\/[^/]+\/src\//,
  /^docs\//,
  /^site\//,
  /^[^/]+\.md$/,
  /^packages\/[^/]+\/[^/]+\.md$/,
];
// The changelog is the history; `CLAUDE.md` is a link to `AGENTS.md`, which is read.
const SKIP = new Set(['CHANGELOG.md', 'CLAUDE.md']);

function filesRead(): string[] {
  return execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' })
    .split('\0')
    .filter((f) => f !== '' && !SKIP.has(f) && !BINARY.test(f) && READ.some((re) => re.test(f)))
    .sort();
}

/** Every phrase in `text` that tells the library's past: where it starts and ends in the unwrapped text, its line and kind. */
export function pastTense(
  text: string,
): Array<{ start: number; end: number; line: number; kind: string; found: string }> {
  const out: Array<{ start: number; end: number; line: number; kind: string; found: string }> = [];
  const { flat, at } = unwrap(text);
  for (const [kind, re] of Object.entries(PAST)) {
    for (const m of flat.matchAll(re)) {
      const start = m.index ?? 0;
      out.push({
        start,
        end: start + m[0].length,
        line: lineOf(text, at[start] ?? 0),
        kind,
        found: m[0],
      });
    }
  }
  return out;
}

/**
 * The hits in `text` no exception covers. An exception covers a hit only when the hit lies wholly inside one of the
 * places its phrase appears, so a new phrase on the same line is still reported; `used` collects the exceptions that
 * covered something.
 */
function uncovered(file: string, text: string, used: Set<number>): string[] {
  const { flat } = unwrap(text);
  const spans: Array<{ e: number; start: number; end: number }> = [];
  EXCEPTIONS.forEach(([f, phrase], e) => {
    if (f !== file) return;
    for (let i = flat.indexOf(phrase); i >= 0; i = flat.indexOf(phrase, i + 1)) {
      spans.push({ e, start: i, end: i + phrase.length });
    }
  });
  const out: string[] = [];
  for (const hit of pastTense(text)) {
    const span = spans.find((s) => s.start <= hit.start && hit.end <= s.end);
    if (span) used.add(span.e);
    else out.push(`${file}:${hit.line} (${hit.kind}) ${hit.found}`);
  }
  return out;
}

describe('the library is described as it is', () => {
  it('in its code, docs and site', () => {
    const offenders: string[] = [];
    const used = new Set<number>();
    for (const file of filesRead()) {
      const text = readFileSync(join(ROOT, file), 'utf8');
      if (text.includes('\0')) continue;
      offenders.push(...uncovered(file, text, used));
    }
    expect(offenders).toEqual([]);
    const stale = EXCEPTIONS.filter((_, i) => !used.has(i)).map(([f, phrase]) => `${f}: ${phrase}`);
    expect(stale).toEqual([]);
  });

  it('lets an exception cover its own phrase only, so a new one on the same line is reported', () => {
    const file = 'README.md';
    const text = readFileSync(join(ROOT, file), 'utf8');
    const phrase = EXCEPTIONS.find(([f]) => f === file)?.[1] ?? '';
    expect(text).toContain(phrase);
    expect(uncovered(file, text, new Set())).toEqual([]);
    const planted = text.replace(phrase, `${phrase}, formerly`);
    expect(uncovered(file, planted, new Set())).toHaveLength(1);
  });

  it('reads the shipped source, the docs and the site', () => {
    const files = filesRead();
    for (const f of [
      'packages/roaring/src/index.ts',
      'docs/guide/getting-started.md',
      'site/llms.txt',
      'README.md',
    ]) {
      expect(files).toContain(f);
    }
    expect(files).not.toContain('CHANGELOG.md');
  });

  it('refuses each kind', () => {
    for (const text of [
      'The message used to say "a newer load".',
      'what this branch used to do',
      'It sits here rather than on the base type, where it used to.',
      'this previously lived on `.trade-list strong`',
      'the formerly required option',
      'the warm tier and its knobs',
      'a live-tier write',
      'the delta tier',
      'a NoSQL registry',
      'the removed registry',
      'the old option form',
      'CloudBitmaps no longer ships one',
      'the library no longer has a flusher',
      'a table that no longer ships',
      'the option was renamed',
      "an undefined value is refused because it used ' +\n        'to be a no-op",
      'the message used\n * to say "a newer load"',
      '// kept the pointer in a table the library no\n// longer ships',
      'A live write tier shipped in this milestone',
      'an earlier version of this comment said otherwise',
      'An earlier version skipped the check',
      'the sweep got this wrong in the first draft',
      'Before that fix the two columns disagreed',
      'until now there was no way to do it',
      'the option is deprecated',
      'an encoding no longer supported',
      'renamed from `cold`',
      'it was removed in favour of `load()`',
      'the scan was replaced by the index',
      'the previous layout',
      'the legacy option form',
      'the retired tier',
    ]) {
      expect(pastTense(text), text).toHaveLength(1);
    }
  });

  it('passes what happens at run time, and "used to" as a purpose', () => {
    for (const text of [
      'a segment the id is no longer in is not listed',
      'the bit is gone, but no run holds a receipt for it',
      'whether this generation is now the current one',
      'a segment that has never been loaded reads as empty',
      '### The storage interfaces (used to type `storage` / `registry`)',
      'Estimated retained heap for one entry, used to weight the byte bound',
      'set iff the object is encrypted — used to decrypt each chunk',
      'Used to drop one segment’s decoded chunks.',
      'the key is used to look it up',
      'it can also be used to seed a test',
      'the storage tier and the cache tier',
      'the old generation is collected once the new one is current',
      'the live row no longer says "expired"',
      'what the key is used\n   * to look up',
      'the old\n\nregistry section',
      'the old\n *\n * registry section',
      'which keeps the old\n## Registry layout',
      'the previous version of a segment',
      'the first version of each name',
      'a segment that no longer exists',
      'an earlier published generation',
      'what it has since been given',
    ]) {
      expect(pastTense(text), text).toEqual([]);
    }
  });
});
