import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The privacy notes and the erasure guide say, in one shape, what an erasure that runs during a `materializeMany`
 * call does and does not reach. The statement is a compliance one, read by an auditor in PRIVACY.md and followed by an
 * operator in the guide, and the three copies are written apart, so the gate holds each to the same two sentences.
 *
 * KNOWN LIMIT. It reads the sentences, not the paragraphs around them: a surrounding sentence that contradicts them
 * in words is for the review of a change to this promise.
 */
const ROOT = join(__dirname, '..', '..');
const DOCS = ['PRIVACY.md', 'packages/roaring/PRIVACY.md', 'docs/guide/erasure.md'] as const;

export const SENTENCES = [
  "An output of a `materializeMany` call can carry an id that was erased while the call ran, for as long as the call ran: the call reads each operand at the generation it pinned, and an output's publish is a load, so an erasure that lands after the chunks were read does not reach what the call holds, unless the output subtracts a pinned operand that the erasure rewrote, which the call re-reads just before the publishes and refuses.",
  "An erasure that rewrites a destination while the call runs makes that output's publish lose with `WriteConflictError`; after any call that overlapped an erasure, re-run `eraseSubject` and keep both ledgers.",
];

/** How many times `sentence` occurs in `text`, with its line breaks undone. */
export function occurrences(text: string, sentence: string): number {
  return text.replace(/\s+/g, ' ').split(sentence).length - 1;
}

describe('what an erasure during a batch reaches', () => {
  it.each(DOCS)('%s states both sentences once', (rel) => {
    const text = readFileSync(join(ROOT, rel), 'utf8');
    for (const sentence of SENTENCES) {
      expect(occurrences(text, sentence), `${rel}: ${sentence.slice(0, 50)}`).toBe(1);
    }
  });

  it('notices a copy that changed a word, and ignores a look-alike', () => {
    const [first] = SENTENCES as [string, string];
    const text = `Before. ${first.replace(' ran,', '\nran,')} After.`;
    expect(occurrences(text, first)).toBe(1);
    expect(occurrences(text.replace('pinned', 'opened'), first)).toBe(0);
    expect(occurrences(text.replace('refuses', 'allows'), first)).toBe(0);
    expect(occurrences('An output of a call can carry an id that was erased', first)).toBe(0);
  });
});
