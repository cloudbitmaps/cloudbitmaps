import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The security document and the privacy notes cite nothing private, and every guarantee `SECURITY.md` makes names the
 * test that holds it.
 *
 * WHY THESE TWO CHECKS. A security page is read by people deciding whether to trust the library, and each sentence on it
 * is a claim they cannot check without the repository. Two things make a claim uncheckable. A pointer to a document the
 * public cannot open (an internal path, a decision number, a correction number, a plan id) implies evidence and
 * withholds it: say the substance instead. And a guarantee with no named test is a promise nothing fails when it is
 * broken. `internal-citations.test.ts` catches the general shape of a private id everywhere in the repository; this file
 * is the narrower, stricter gate for the three pages that make promises to users, and it also knows the private paths
 * and plan ids, which no general pattern can.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** The pages that make written promises to users, repository copy and the copy npm publishes. */
const PAGES = ['SECURITY.md', 'PRIVACY.md', join('packages', 'roaring', 'PRIVACY.md')];

/**
 * Each way a page can point at something only the maintainers can open. A hit is reported with its kind and text.
 *
 * Deliberately not matched, because a reader can resolve each: a path under `docs/guide/` or `tests/`, a GitHub
 * advisory id, a `#N` pull request or issue of this repository, and the ordinary words "decision", "correction" and
 * "plan" with no number after them.
 */
const PRIVATE_POINTERS: ReadonlyArray<readonly [string, RegExp]> = [
  ['internal path', /docs[/\\]internal\b|\bcloudbitmaps-internal\b|\binternal repo(?:sitory)?\b/i],
  ['internal document number', /\b\d\d-[A-Z][A-Z-]{3,}(?:\.md)?\b/],
  ['decision-log file', /\bDECISIONS(?:\.md)?\b/],
  ['decision number', /\bADR[\s-]*#?\d+|\bdecisions?\s*#?\s*\d+/i],
  ['correction number', /\bcorrections?\s*#?\s*\d+/i],
  ['plan id', /\bSR-\s*\d+\b/],
  ['plan item', /\bplan items?\b|\bsecurity review\s+(?:of|item|finding)\b/i],
  ['review finding id', /\bfindings?\s+[A-Z]\d+\b/i],
];

/** Every private pointer in `text`, with markdown emphasis and code ticks removed first so they cannot hide one. */
export function privatePointers(text: string): string[] {
  const plain = text.replace(/[`*_]/g, '').replace(/\s+/g, ' ');
  const hits: string[] = [];
  for (const [kind, re] of PRIVATE_POINTERS) {
    for (const m of plain.matchAll(new RegExp(re.source, `${re.flags.replace('g', '')}g`))) {
      hits.push(`${kind}: "${m[0]}"`);
    }
  }
  return hits;
}

/** The body of the section whose heading line is exactly `heading`, up to the next heading of the same level. */
export function sectionBody(md: string, heading: string): string | undefined {
  const lines = md.split('\n');
  const start = lines.findIndex((l) => l === heading);
  if (start < 0) return undefined;
  const level = /^#+/.exec(heading)?.[0].length ?? 2;
  const end = lines.findIndex((l, i) => i > start && new RegExp(`^#{1,${level}} `).test(l));
  return lines.slice(start + 1, end < 0 ? undefined : end).join('\n');
}

/** The test files a text names: backticked repository paths ending `.test.ts`. */
export function namedTests(text: string): string[] {
  return [...text.matchAll(/`(tests\/[A-Za-z0-9_./-]+\.test\.ts)`/g)].map((m) => m[1] ?? '');
}

/**
 * Problems with the guarantees table: each row of the section's table (after the header and rule) must name at least
 * one test file in its last cell, and each file named must exist.
 */
export function guaranteeProblems(md: string, exists: (rel: string) => boolean): string[] {
  const body = sectionBody(md, '## What the library guarantees, and the limit of each');
  if (body === undefined)
    return ['the section "What the library guarantees, and the limit of each" is missing'];
  const rows = body
    .split('\n')
    .filter((l) => l.startsWith('|'))
    .slice(2);
  const problems: string[] = [];
  if (rows.length < 8) problems.push(`the table has ${rows.length} guarantee rows, fewer than 8`);
  for (const row of rows) {
    const cells = row.split('|').slice(1, -1);
    const name = (cells[0] ?? '').trim().slice(0, 50);
    const held = namedTests(cells[cells.length - 1] ?? '');
    if (held.length === 0) problems.push(`row "${name}" names no test file`);
    for (const f of held)
      if (!exists(f)) problems.push(`row "${name}" names ${f}, which does not exist`);
  }
  return problems;
}

const GOOD_TABLE = [
  '## What the library guarantees, and the limit of each',
  '',
  '| Guarantee | Limit | Held by |',
  '| --- | --- | --- |',
  ...Array.from({ length: 8 }, (_, i) => `| g${i} | l | \`tests/a${i}.test.ts\` |`),
  '',
  '## Next',
  '',
  '| x | y | z |',
  '| --- | --- | --- |',
  '| outside | the | section |',
].join('\n');

/**
 * Text built at run time. The examples below must contain the very ids the gate refuses, and `internal-citations.test.ts`
 * reads this file as prose; spelling an id out whole here would make this file cite what it forbids.
 */
const spelled = (...parts: string[]): string => parts.join('');

describe('the pages that make promises cite nothing private', () => {
  it.each(PAGES)('%s names no internal path, decision, correction or plan id', (rel) => {
    expect(privatePointers(readFileSync(join(ROOT, rel), 'utf8'))).toEqual([]);
  });

  it.each([
    ['an internal path', spelled('see docs/internal/', '40', '-SECURITY.md for the review')],
    ['an internal repo', 'recorded in the cloudbitmaps-internal repository'],
    ['the internal repo, in words', 'the Internal Repo holds the plan'],
    ['a numbered internal doc, in code ticks', spelled('the `', '40', '-SECURITY` document')],
    ['a decision log file', 'listed in DECISIONS.md'],
    ['an ADR number', spelled('as ADR ', '214', ' decided')],
    ['an ADR number, hyphenated and bold', 'as **ADR-88** decided'],
    ['a decision number', spelled('decision ', '#12', ' says so')],
    ['a correction number', 'fixed by correction 31'],
    ['a plan id', 'tracked as SR-4'],
    ['a plan id inside a parenthesis', 'a keyed fingerprint (SR-5)'],
    ['a plan item', 'the plan item that lands it'],
    ['a plan id split across a wrap', 'tracked as SR-\n4'],
  ])('catches %s', (_name, text) => {
    expect(privatePointers(text)).not.toEqual([]);
  });

  it.each([
    ['a public guide path', 'see [production](docs/guide/production.md#permissions)'],
    ['a test path', 'held by `tests/core/chunk-checks.test.ts`'],
    ['a GitHub advisory id', 'GHSA-w5hq-g745-h8pq is not reachable'],
    ['a pull request of this repository', 'added in (#431)'],
    [
      'the words with no number',
      'a decision to wrap the key, a correction to a count, a plan for rotation',
    ],
    ['an algorithm name with digits', 'AES-256-GCM, CRC32C, SHA-256 and SLSA-3 style attestations'],
    ['a hard invariant, which the public AGENTS.md lists', 'hard invariant 5'],
    ['a year-month date', 'since 2026-10-26'],
  ])('stays quiet on %s', (_name, text) => {
    expect(privatePointers(text)).toEqual([]);
  });
});

describe('every guarantee SECURITY.md makes names a test that exists', () => {
  const exists = (rel: string) => existsSync(join(ROOT, rel));

  it('holds for the real document', () => {
    expect(guaranteeProblems(readFileSync(join(ROOT, 'SECURITY.md'), 'utf8'), exists)).toEqual([]);
  });

  it('reads a well-formed table as clean, and only the section counts', () => {
    expect(guaranteeProblems(GOOD_TABLE, () => true)).toEqual([]);
  });

  it('catches a missing section', () => {
    expect(guaranteeProblems('# Security\n\n## Reporting\n', () => true)).toHaveLength(1);
  });

  it('catches a row that names no test', () => {
    const md = GOOD_TABLE.replace('`tests/a3.test.ts`', 'a test somewhere');
    expect(guaranteeProblems(md, () => true)).toEqual(['row "g3" names no test file']);
  });

  it('catches a test file that does not exist', () => {
    expect(guaranteeProblems(GOOD_TABLE, (rel) => rel !== 'tests/a5.test.ts')).toEqual([
      'row "g5" names tests/a5.test.ts, which does not exist',
    ]);
  });

  it('catches a table that shrank below the floor', () => {
    const md = GOOD_TABLE.replace('| g7 | l | `tests/a7.test.ts` |\n', '');
    expect(guaranteeProblems(md, () => true)).toEqual([
      'the table has 7 guarantee rows, fewer than 8',
    ]);
  });

  it('does not count a path named outside backticks or outside the table', () => {
    expect(namedTests('see tests/a.test.ts and `docs/guide/x.md` and `tests/b.test.ts`')).toEqual([
      'tests/b.test.ts',
    ]);
  });
});
