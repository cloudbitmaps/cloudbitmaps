import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The privacy notes and the erasure guide say, in one shape, what an erasure that runs during a `materializeMany`
 * call does and does not reach. The statement is a compliance one, read by an auditor in PRIVACY.md and followed by an
 * operator in the guide, and the three copies are written apart, so the gate holds each to the same three sentences and to the lead sentence that opens the paragraph.
 * It holds the three sentences of a call with a feed to the same standard.
 *
 * KNOWN LIMIT. It reads the sentences, not the paragraphs around them: a surrounding sentence that contradicts them
 * in words is for the review of a change to this promise.
 */
const ROOT = join(__dirname, '..', '..');
const DOCS = ['PRIVACY.md', 'packages/roaring/PRIVACY.md', 'docs/guide/erasure.md'] as const;

/** The sentence that opens the paragraph in each document: the same words, with the guide's link to the section. */
export const LEADS: Record<string, string> = {
  'PRIVACY.md':
    "A `store.materializeMany` call computes many `*Into` outputs in passes that read each operand once per group, and its window is the call's length, not one read's.",
  'packages/roaring/PRIVACY.md':
    "A `store.materializeMany` call computes many `*Into` outputs in passes that read each operand once per group, and its window is the call's length, not one read's.",
  'docs/guide/erasure.md':
    "A [`store.materializeMany`](loading.md#many-outputs-from-one-pass-materializemany) call computes many `*Into` outputs in passes that read each operand once per group, and its window is the call's length, not one read's.",
};

export const SENTENCES = [
  "An output of a `materializeMany` call can carry an id that was erased while the call ran, for as long as the call ran: the call reads each operand at the generation it pinned, and an output's publish is a load, so an erasure that lands after the chunks were read does not reach what the call holds, unless the output subtracts a pinned operand that the erasure rewrote, which the call re-reads just before the publishes and refuses.",
  "An erasure that rewrites a destination before that output's publish starts does not stop the publish, which, subject to the output's own `guard` and the refusal of an empty result over a non-empty destination, writes on top of the erasure's generation; an erasure that lands inside the publish's own write, between its pointer read and its pointer write, makes the publish lose with `WriteConflictError`; after any call that overlapped an erasure, re-run `eraseSubject` and keep both ledgers.",
  '`eraseSubject` deletes the generation it rewrites even when a call holds it pinned, so a pin does not outlive an erasure, and an output that still needs a deleted operand generation fails with `NotFoundError`.',
  "A `materializeMany` call with a feed is refused at its next record, and immediately before each fed output's publish (after the output has waited for its room in the memory budget), once `eraseSubject` has started in this store, one already running when the call began included: nothing is published from operands the call read before the erasure returned, and the one record in hand when the erasure lands is processed and discarded.",
  "An erasure that starts after a fed output's last check and finishes before that publish's pointer write is not caught by the counter, and its window is the publish's own object write and pointer write, which lasts as long as the object takes to upload; the fences above still apply to what it touched.",
  "Only this store's `eraseSubject` moves the counter such a call reads, so an erasure by any other path (another store, another process, or the free function `eraseIdFromSegment` in this process) is not seen by it, and is bounded by nothing.",
  "A `materializeMany` call that reads an in-memory operand from `store.memory` fails the outputs that read it, before any request and immediately before each of their publishes, once `eraseSubject` has started in this store since the operand began to be made, one already running when it began included; an erasure by any path but this store's `eraseSubject` is not seen by such an operand, and is bounded by nothing.",
];

/** How many times `sentence` occurs in `text`, with its line breaks undone. */
export function occurrences(text: string, sentence: string): number {
  return text.replace(/\s+/g, ' ').split(sentence).length - 1;
}

describe('what an erasure during a batch reaches', () => {
  it.each(DOCS)('%s states both sentences once', (rel) => {
    const text = readFileSync(join(ROOT, rel), 'utf8');
    expect(occurrences(text, LEADS[rel]!), `${rel}: the lead sentence`).toBe(1);
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
    const held = SENTENCES[SENTENCES.length - 1]!;
    expect(occurrences(`x. ${held} y.`, held)).toBe(1);
    expect(
      occurrences(held.replace('since the operand began to be made', 'before it ends'), held),
    ).toBe(0);
  });
});
