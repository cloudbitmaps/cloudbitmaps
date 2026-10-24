/**
 * No error message carries an id, a bound or a value derived from one: an id that is refused is often an identifier
 * that was never meant to be one (a phone number, a 64-bit user id), and applications log error messages.
 */
import { describe, expect, it } from 'vitest';
import { RoaringBitmap, ValidationError } from '@/index';
import { batchWorld } from '../helpers/batch-world';
import { feedOf } from '../helpers/combine-feed';
import { craftPortable } from '../helpers/portable-bytes';

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
  it('has, load, eraseSubject, subjectReport, iterate bounds and the feed', async () => {
    const w = await batchWorld({ s: [1, 2, 3] });
    const seg = w.store.segment('s');
    const messages: string[] = [];
    for (const bad of BAD_VALUES) {
      const v = bad as number;
      messages.push(await messageOf(() => seg.has(v)));
      messages.push(await messageOf(() => w.store.load({ segment: 't' }, [1, v])));
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

  it('a load names the position of a refused id, never its value', async () => {
    const w = await batchWorld({ s: [1, 2, 3] });
    const message = await messageOf(() => w.store.load({ segment: 's' }, [1, 5_000_000_000]));
    expect(message).toBe(
      'ids[1]: an id must be an integer from 0 to 4294967295; got a number above 4294967295 (ids are 32-bit)',
    );
    expect(message).not.toContain('5000000000');
    // The error the id check raised stays as the cause.
    const err = await w.store.load({ segment: 's' }, [1, 5_000_000_000]).catch((e: unknown) => e);
    expect(((err as Error).cause as Error).message).toBe(
      'an id must be an integer from 0 to 4294967295; got a number above 4294967295 (ids are 32-bit)',
    );
    // From an async source, and past a flush of the pending buffer (it holds 2^20 ids).
    async function* feed(): AsyncGenerator<number> {
      yield 7;
      yield -1;
    }
    expect(await messageOf(() => w.store.load({ segment: 's' }, feed()))).toMatch(
      /^ids\[1\]: .*negative number$/,
    );
    const many = Array.from({ length: (1 << 20) + 10 }, (_, i) => i);
    many.push(1.5);
    expect(await messageOf(() => w.store.load({ segment: 's' }, many))).toMatch(
      /^ids\[1048586\]: .*number with a fraction$/,
    );
  });

  it('a sorted load names the position of an id out of order or refused, never its value', async () => {
    const w = await batchWorld({ s: [1, 2, 3] });
    const sorted = { sorted: true } as const;
    // Ids of ten digits, which the message must not repeat: 1,270,648,346 and on.
    const high = [SENTINEL - 1_000, SENTINEL - 10, SENTINEL - 20].map((v) => v % 2 ** 32);
    const lower = await messageOf(() => w.store.load({ segment: 's' }, high, sorted));
    expect(lower).toMatch(/^ids\[2\]: lower than the id before it/);
    const messages = [lower];
    for (const bad of BAD_VALUES) {
      messages.push(
        await messageOf(() => w.store.load({ segment: 't' }, [1, bad as number], sorted)),
      );
    }
    for (const message of messages) {
      expectNoId(message);
      for (const id of high) expect(message).not.toContain(String(id));
    }
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

describe('a RoaringBitmap error message never carries an id', () => {
  const messageSync = (run: () => unknown): string => {
    try {
      run();
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      return (error as Error).message;
    }
    throw new Error('expected a refusal');
  };

  it('the constructor, add, addMany, has, remove and removeMany say what is wrong and never the value', () => {
    const messages: string[] = [];
    for (const bad of BAD_VALUES) {
      const v = bad as number;
      const b = new RoaringBitmap([1]);
      messages.push(messageSync(() => new RoaringBitmap([1, v])));
      messages.push(messageSync(() => new RoaringBitmap(new Set([1, v]))));
      messages.push(messageSync(() => b.add(v)));
      messages.push(messageSync(() => b.addMany([v])));
      messages.push(messageSync(() => b.has(v)));
      messages.push(messageSync(() => b.remove(v)));
      messages.push(messageSync(() => b.removeMany([v])));
    }
    for (const message of messages) expectNoId(message);
    expect(messages[0]).toMatch(/an id must be an integer from 0 to 4294967295; got /);
  });

  it('names a wrong kind of value by its kind, a BigInt, a Symbol and an object included', () => {
    const b = new RoaringBitmap();
    expect(messageSync(() => b.has(14155551234n as unknown as number))).toMatch(/got a bigint$/);
    expect(messageSync(() => b.has(Symbol('14155551234') as unknown as number))).toMatch(
      /got a symbol$/,
    );
    expect(messageSync(() => b.has({ toString: () => DIGITS } as unknown as number))).toMatch(
      /got an object$/,
    );
  });

  it('the decode door says why bytes are refused without a container key, an offset value or an id', () => {
    // Keys 51,234 then 40,000 are out of order, and 51,234 must not appear.
    const messages = [
      craftPortable([
        { key: 51_234, kind: 'array', values: [1] },
        { key: 40_000, kind: 'array', values: [2] },
      ]),
      craftPortable([
        { key: 51_234, kind: 'array', values: [1] },
        { key: 51_234, kind: 'array', values: [2] },
      ]),
      new Uint8Array(0),
      new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]),
    ].map((bytes) => messageSync(() => RoaringBitmap.deserialize(bytes)));
    expect(messages[0]).toMatch(/not strictly ascending/);
    for (const message of messages) {
      expect(message).not.toContain('51234');
      expect(message).not.toContain('40000');
    }
  });
});
