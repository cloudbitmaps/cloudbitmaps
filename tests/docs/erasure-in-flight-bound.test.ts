import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MAX_RANGES_IN_FLIGHT } from '@/core/crbm/plan-reads';
import { DEFAULT_INTERSECT_CONCURRENCY } from '@/core/engine';

/**
 * The privacy note and the erasure guide promise the same bound on what a read already in progress can still yield
 * after an erasure, and it is the code's.
 *
 * WHY THIS EXISTS. The promise is a compliance one: PRIVACY.md is what an auditor reads, and docs/guide/erasure.md is
 * what an operator follows. The two were written apart, and when the engine's read-ahead changed unit (chunk keys, then
 * ranges), the guide was brought to it and the note was not, which left a written promise that the code no longer
 * matched. Each states the bound in one sentence of one shape:
 *
 *   up to N chunks for `iterate` and `count`, and up to `concurrency` + 1 keys (M by default) for a combine
 *
 * and the gate reads that sentence out of each document, with its line breaks undone, and holds every copy to the
 * same N and M, and both to the library's own default windows (the engine's, and the chunk stream's, which must agree):
 * N is the window, and M is the window and the key a combine is handing out, which it can yield too.
 * `tests/core/stream-re-resolve.test.ts` counts both in a read past its ramp-up.
 *
 * KNOWN LIMIT. The gate reads the one sentence's numbers. It cannot tell that a paragraph around it contradicts it in
 * words, which is what the review of a change to this promise is for.
 */
const ROOT = join(__dirname, '..', '..');
const DOCS = ['PRIVACY.md', 'packages/roaring/PRIVACY.md', 'docs/guide/erasure.md'] as const;

const BOUND =
  /up to (\d+) chunks for `iterate` and `count`, and up to `concurrency` \+ 1 keys \((\d+) by default\) for a combine/g;

/** Every bound a text states, as `[iterate and count, combine default]`, with its line breaks undone. */
export function boundsIn(text: string): Array<[number, number]> {
  return [...text.replace(/\s+/g, ' ').matchAll(BOUND)].map((m) => [Number(m[1]), Number(m[2])]);
}

describe('the in-flight bound after an erasure', () => {
  it.each(DOCS)('%s states it once, and it is the library default window', (rel) => {
    const found = boundsIn(readFileSync(join(ROOT, rel), 'utf8'));
    expect(found, `${rel} must state the bound in the one sentence shape`).toHaveLength(1);
    // the iterate and count window, and the combine's default `concurrency` and the key in hand: the engine's window,
    // and the reader's own
    expect(found[0]).toEqual([DEFAULT_INTERSECT_CONCURRENCY, DEFAULT_INTERSECT_CONCURRENCY + 1]);
    expect(DEFAULT_INTERSECT_CONCURRENCY).toBe(MAX_RANGES_IN_FLIGHT);
  });

  it('is the same in every document that makes the promise', () => {
    const all = DOCS.map((rel) => JSON.stringify(boundsIn(readFileSync(join(ROOT, rel), 'utf8'))));
    expect(new Set(all).size).toBe(1);
  });

  it('notices a copy that changed its numbers or its words, and ignores look-alikes', () => {
    const sentence =
      'up to 32 chunks for `iterate` and `count`, and up to `concurrency` + 1\nkeys (33 by default) for a combine';
    expect(boundsIn(`A read ${sentence}.`)).toEqual([[32, 33]]);
    // a changed number is read as the changed number
    expect(boundsIn(sentence.replace('up to 32 chunks', 'up to 8 chunks'))).toEqual([[8, 33]]);
    expect(boundsIn(sentence.replace('(33 by default)', '(8 by default)'))).toEqual([[32, 8]]);
    // a reworded sentence is not the bound, so it is found missing rather than read as something else
    expect(boundsIn(sentence.replace('for a combine', 'for combines'))).toEqual([]);
    expect(boundsIn(sentence.replace('`iterate` and `count`', '`iterate`'))).toEqual([]);
    // the earlier wording, without the key in hand, is not the bound either
    expect(
      boundsIn(
        'up to 32 chunks for `iterate` and `count`, and up to `concurrency` keys (32 by default) for a combine',
      ),
    ).toEqual([]);
    // look-alikes elsewhere: a window of 32 chunk reads, a pointer refresh, a different bound
    expect(boundsIn('up to 32 chunks ahead of the writer, and up to 32 reads in flight')).toEqual(
      [],
    );
    expect(boundsIn('up to `concurrency` ranges per operand (32 by default)')).toEqual([]);
    expect(
      boundsIn('up to `concurrency` + 1 keys per operand (33 by default) for a combine'),
    ).toEqual([]);
  });
});
