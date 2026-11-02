import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A pinned handle in another store is bounded: it re-reads its segment's row every `cache.genTtlMs` and fails once the
 * segment is destroyed or its generation erased. The erasure guide and the two copies of the privacy note state that in
 * one table row, and the three must give it in the same words: an auditor reads the note, an operator follows the
 * guide, and the two once disagreed about the number a pin was held to.
 *
 * The gate reads the one row that starts with the pinned handle, undoes its line breaks, and holds every copy to the
 * same text, to the interval in it, and to saying no more that the pin has "no bound". The row for a store with no timed
 * refresh keeps that wording legitimately, and is not this row.
 *
 * KNOWN LIMIT. It reads one row. A paragraph that contradicts the row in words is what a review of the change is for.
 */
const ROOT = join(__dirname, '..', '..');
const DOCS = ['PRIVACY.md', 'packages/roaring/PRIVACY.md', 'docs/guide/erasure.md'] as const;

const PINNED_ROW = /^\| a pinned handle \(`seg\.pin\(\)`\) in another store[^\n]*$/gm;
const LEASED_ROW = /^\| a leased pinned handle/m;
const INTERVAL = 'within `cache.genTtlMs` (default 2 s), while the registry can be read';

/** The table rows that start with the pinned handle, with their line breaks undone. */
export function pinnedRows(text: string): string[] {
  return [...text.matchAll(PINNED_ROW)].map((m) => m[0].replace(/\s+/g, ' '));
}

/** What is wrong with a document's pinned row, or `[]`. */
export function problemsIn(text: string): string[] {
  const rows = pinnedRows(text);
  if (rows.length !== 1) return [`${rows.length} pinned rows, expected 1`];
  const out: string[] = [];
  if (!rows[0]!.includes(INTERVAL)) out.push('does not state the `cache.genTtlMs` interval');
  if (/no bound/i.test(rows[0]!)) out.push('says no bound');
  if (LEASED_ROW.test(text)) out.push('still has a separate row for a leased pin');
  return out;
}

const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8');

describe('the pinned handle row of the erasure table', () => {
  it.each(DOCS)('%s gives it the interval, and not "no bound"', (rel) => {
    expect(problemsIn(read(rel))).toEqual([]);
  });

  it('is the same words in every document', () => {
    const rows = DOCS.map((rel) => pinnedRows(read(rel))[0]);
    expect(new Set(rows).size).toBe(1);
  });

  describe('fires on a mutated copy, and not on its look-alikes', () => {
    const real = read('docs/guide/erasure.md');
    /** `text` with `change` applied to the pinned row alone: the other rows state the interval too. */
    const inRow = (text: string, change: (row: string) => string): string =>
      text.replace(PINNED_ROW, change);
    const mutations: Array<[string, (t: string) => string]> = [
      [
        'the old unbounded wording',
        (t) => inRow(t, (row) => row.replace(INTERVAL, '**no bound**: until that store evicts')),
      ],
      [
        'a changed interval',
        (t) => inRow(t, (row) => row.replace('(default 2 s)', '(default 20 s)')),
      ],
      ['the row removed', (t) => t.replace(PINNED_ROW, '')],
      ['a second pinned row', (t) => t.replace(PINNED_ROW, (row) => `${row}\n${row}`)],
      [
        'a separate leased row',
        (t) =>
          t.replace(
            PINNED_ROW,
            (row) =>
              `${row}\n| a leased pinned handle (\`seg.pin({ leaseUntil })\`) | until its lease ends |`,
          ),
      ],
    ];
    it.each(mutations)('%s', (_name, mutate) => {
      const mutated = mutate(real);
      expect(mutated).not.toBe(real);
      expect(problemsIn(mutated)).not.toEqual([]);
    });

    it('a copy that changed one word differs from the others', () => {
      const changed = pinnedRows(
        inRow(real, (row) =>
          row.replace('an outage of the registry stretches it', 'an outage stretches it'),
        ),
      );
      expect(changed).not.toEqual(pinnedRows(read('PRIVACY.md')));
    });

    it('ignores look-alikes: the no-timed-refresh row, the pinAt row, prose, and a wrapped row', () => {
      const wrapped = `| a pinned handle (\`seg.pin()\`) in another store, leased or not | ${INTERVAL}; fine |`;
      expect(problemsIn(wrapped)).toEqual([]);
      const others = [
        '| another store with **no registry**, or with `cache: { genTtlMs: 0 }` | **no bound** |',
        '| `seg.pinAt` of a generation the erasure rewrote | a pinned handle in another store |',
        'A pinned handle (`seg.pin()`) in another store has no bound only without a timed refresh.',
      ].join('\n');
      expect(pinnedRows(others)).toEqual([]);
      expect(problemsIn(`${wrapped}\n${others}`)).toEqual([]);
    });
  });
});
