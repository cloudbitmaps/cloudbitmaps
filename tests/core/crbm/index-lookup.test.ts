import { CrbmWriter } from '@/core/crbm/writer';
import { readFileSync } from 'node:fs';
import { CrbmReader, indexCapacity, parseIndex } from '@/core/crbm/reader';
import { BufferSink, BufferReader } from '@/core/blob';
import { IntegrityError } from '@/core/errors';
import { PAYLOAD_START } from '@/core/crbm/format';
import { writeVarint } from '@/core/crbm/varint';

async function build(keys: number[]): Promise<Uint8Array> {
  const sink = new BufferSink();
  const writer = new CrbmWriter(sink, { generation: 1 });
  for (const k of keys) await writer.addChunk(k, Uint8Array.of(k & 0xff, 7, 9), (k % 65_536) + 1);
  await writer.finish();
  return sink.bytes();
}

describe('CrbmReader — lookup over the sorted key array', () => {
  it('finds every present key and none of the absent ones, at both ends of the 16-bit range', async () => {
    const present = [0, 1, 2, 5, 100, 101, 4_096, 40_000, 65_534, 65_535];
    const reader = await CrbmReader.open(new BufferReader(await build(present)));
    const set = new Set(present);
    for (const k of [...present, 3, 4, 6, 99, 102, 4_095, 4_097, 39_999, 65_533]) {
      expect(reader.has(k)).toBe(set.has(k));
      const chunk = await reader.getChunk(k);
      expect(chunk === null).toBe(!set.has(k));
      if (chunk !== null) expect(Array.from(chunk)).toEqual([k & 0xff, 7, 9]);
    }
    expect(reader.has(-1)).toBe(false);
    expect(reader.has(65_536)).toBe(false);
    expect(reader.chunkKeys()).toEqual(present);
    expect(reader.cardinalities().get(65_535)).toBe(65_536);
    expect(reader.cardinalities().get(0)).toBe(1);
  });

  it('holds an empty generation', async () => {
    const reader = await CrbmReader.open(new BufferReader(await build([])));
    expect(reader.chunkKeys()).toEqual([]);
    expect(reader.has(0)).toBe(false);
    expect(reader.retainedIndexBytes).toBe(0);
  });
});

describe('parseIndex — a hostile index allocates no more than it holds', () => {
  const record = (keyDelta: number, gap: number, len: number, card: number): number[] => {
    const out: number[] = [];
    for (const v of [keyDelta, gap, len, card]) writeVarint(out, v);
    return [...out, 1, 2, 3, 4];
  };

  // The arrays are allocated before a record is read, so their size must come from the index's length and nothing
  // the index says: at most one entry per 8 bytes, the smallest record, and never more than one per 16-bit key.
  it('sizes its arrays from the bytes it holds, and never past one entry per key', () => {
    expect(indexCapacity(0)).toBe(0);
    expect(indexCapacity(7)).toBe(0);
    expect(indexCapacity(8)).toBe(1);
    expect(indexCapacity(800)).toBe(100);
    expect(indexCapacity(65_536 * 8)).toBe(65_536);
    expect(indexCapacity(65_536 * 8 + 8)).toBe(65_536);
    expect(indexCapacity(8 * 1024 * 1024)).toBe(65_536);
    const src = readFileSync(
      new URL('../../../packages/core/src/core/crbm/reader.ts', import.meta.url),
      'utf8',
    );
    const body = src.slice(src.indexOf('export function parseIndex('));
    expect(body).toContain('const capacity = indexCapacity(indexBytes.length);');
    expect(body.slice(0, body.indexOf('new Uint16Array'))).toContain('indexCapacity(');
  });

  it('refuses a repeated key, however many records follow', () => {
    const bytes = Uint8Array.from([...record(5, 0, 3, 1), ...record(0, 0, 3, 1)]);
    expect(() => parseIndex(bytes, 1 << 20, 1 << 20)).toThrow(IntegrityError);
  });

  it('trims the arrays to the entries it parsed', () => {
    const bytes = Uint8Array.from([...record(0, 0, 3, 1), ...record(7, 0, 300, 65_536)]);
    const parsed = parseIndex(bytes, 1 << 20, 1 << 20);
    expect(parsed.keys).toEqual(Uint16Array.of(0, 7));
    expect(parsed.cardinalityMinusOne).toEqual(Uint16Array.of(0, 65_535));
    expect(parsed.lengths).toEqual(Uint32Array.of(3, 300));
    expect(parsed.cardinalitySum).toBe(65_537);
  });

  it('refuses a key past 16 bits and a payload past the region', () => {
    expect(() => parseIndex(Uint8Array.from(record(65_536, 0, 3, 1)), 1 << 20, 1 << 20)).toThrow(
      IntegrityError,
    );
    expect(() => parseIndex(Uint8Array.from(record(0, 0, 3, 1)), 8, 1 << 20)).toThrow(
      IntegrityError,
    );
  });

  it('keeps an offset past 4 GiB exactly', () => {
    const big = 0xffff_ffff;
    const bytes = Uint8Array.from([...record(0, big, 3, 1), ...record(1, big, 3, 1)]);
    const parsed = parseIndex(bytes, 2 ** 40, 1 << 20);
    const first = PAYLOAD_START + big;
    expect(parsed.offsets[1]).toBe(first + 3 + big);
    expect(parsed.offsets[1]!).toBeGreaterThan(2 ** 32);
  });
});
