/**
 * No error message carries an id, a bound or a value derived from one: an id that is refused is often an identifier
 * that was never meant to be one (a phone number, a 64-bit user id), and applications log error messages.
 */
import { describe, expect, it } from 'vitest';
import { ValidationError } from '@/index';
import { batchWorld } from '../helpers/batch-world';
import { feedOf } from '../helpers/combine-feed';

const SENTINEL = 14155551234;
const DIGITS = String(SENTINEL);
const BAD_VALUES: unknown[] = [SENTINEL, -SENTINEL, SENTINEL + 0.5, String(SENTINEL), Number.NaN];

async function messageOf(run: () => unknown): Promise<string> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(ValidationError);
    return (error as Error).message;
  }
  throw new Error('expected a refusal');
}

async function drain(stream: AsyncIterable<unknown>): Promise<void> {
  for await (const _ of stream) void _;
}

function expectNoId(message: string): void {
  expect(message).not.toContain(DIGITS);
  expect(message.replaceAll('4294967295', '')).not.toMatch(/\d{9,}/);
  // A value that is not an integer is not echoed either.
  expect(message).not.toContain('14155551234.5');
}

describe('an error message never carries an id', () => {
  it('has, load, store.memory, eraseSubject, subjectReport, iterate bounds and the feed', async () => {
    const w = await batchWorld({ s: [1, 2, 3] });
    const seg = w.store.segment('s');
    const messages: string[] = [];
    for (const bad of BAD_VALUES) {
      const v = bad as number;
      messages.push(await messageOf(() => seg.has(v)));
      messages.push(await messageOf(() => w.store.load({ segment: 't' }, [1, v])));
      messages.push(await messageOf(() => w.store.memory([1, v])));
      messages.push(await messageOf(() => w.store.eraseSubject(v, { namespace: 'n' })));
      messages.push(await messageOf(() => w.store.subjectReport(v, { namespace: 'n' })));
      messages.push(await messageOf(() => drain(seg.iterate({ after: v }))));
      messages.push(await messageOf(() => drain(seg.iterate({ through: v }))));
    }
    for (const bad of BAD_VALUES) {
      const v = bad as number;
      for (const bound of [{ after: v }, { through: v }]) {
        messages.push(
          await messageOf(() =>
            w.store.materializeMany({
              keep: 1,
              operands: { a: seg },
              outputs: [{ dest: w.store.segment('out'), expr: { and: ['a', 'a'] } }],
              ...bound,
            }),
          ),
        );
      }
    }
    for (const message of messages) expectNoId(message);
    // Still says what is wrong.
    expect(messages[0]).toMatch(/an id must be an integer from 0 to 4294967295/);
  });

  it('a refused feed says what is wrong without an id', async () => {
    const w = await batchWorld({ a: [1, 2, 3] });
    const seg = w.store.segment('a');
    const HIGH = 3_000_000_123;
    const key = HIGH >>> 16;
    const one = (ids: number[]): { key: number; operands: { f: Uint32Array } } => ({
      key,
      operands: { f: Uint32Array.from(ids) },
    });
    const cases: Array<[string, unknown[], number]> = [
      ...[SENTINEL, -SENTINEL, SENTINEL + 0.5].map((bad): [string, unknown[], number] => [
        'a key out of range',
        [{ key: bad, operands: { f: Uint32Array.from([HIGH]) } }],
        1,
      ]),
      ['ids outside the key', [{ key: 0, operands: { f: Uint32Array.from([HIGH]) } }], 1],
      ['ids not ascending', [one([HIGH + 1, HIGH])], 2],
      [
        'a key that goes back',
        [one([HIGH]), { key: 1, operands: { f: Uint32Array.from([65_536]) } }],
        2,
      ],
      ['a wrong count', [one([HIGH])], 999],
    ];
    for (const [why, records, count] of cases) {
      const messages: string[] = [];
      try {
        const run = await w.store.materializeMany({
          keep: 1,
          operands: { a: seg },
          maxBufferedBytes: 64 * 1024 * 1024,
          outputs: [{ dest: w.store.segment('out'), expr: { and: ['a', 'f'] } }],
          feed: { names: ['f'], records: feedOf(records), counts: { f: count } },
        });
        for (const o of run.outputs) {
          if (!o.published) messages.push((o as { error: Error }).error.message);
        }
      } catch (error) {
        messages.push((error as Error).message);
      }
      expect(messages.length, `${why} is refused`).toBeGreaterThan(0);
      for (const message of messages) {
        expectNoId(message);
        expect(message, why).not.toContain(String(HIGH));
      }
    }
  });

  it('a load given a bare number as its input does not echo it', async () => {
    const w = await batchWorld();
    const message = await messageOf(() =>
      w.store.load({ segment: 't' }, SENTINEL as unknown as number[]),
    );
    expectNoId(message);
  });
});
