import fc from 'fast-check';
import { PAYLOAD_START } from '@/core/crbm/format';
import { writeVarint } from '../../helpers/varint';
import { CrbmWriter } from '@/core/crbm/writer';
import { IntegrityError } from '@/core/errors';

interface Entry {
  chunkKey: number;
  offset: number;
  length: number;
  cardinality: number;
  crc32c: number;
}

/** The index encoding as it was before it wrote into a preallocated buffer: the oracle. */
function oracleEncode(entries: readonly Entry[]): Uint8Array {
  const out: number[] = [];
  let prevKey = 0;
  let prevEnd = PAYLOAD_START;
  for (const e of entries) {
    writeVarint(out, e.chunkKey - prevKey);
    writeVarint(out, e.offset - prevEnd);
    writeVarint(out, e.length);
    writeVarint(out, e.cardinality);
    out.push(
      e.crc32c & 0xff,
      (e.crc32c >>> 8) & 0xff,
      (e.crc32c >>> 16) & 0xff,
      (e.crc32c >>> 24) & 0xff,
    );
    prevKey = e.chunkKey;
    prevEnd = e.offset + e.length;
  }
  return Uint8Array.from(out);
}

function actualEncode(entries: readonly Entry[]): Uint8Array {
  const writer = Object.create(CrbmWriter.prototype) as { entries: readonly Entry[] };
  writer.entries = entries;
  return (writer as unknown as { encodeIndex(): Uint8Array }).encodeIndex();
}

/** Each field is a delta, so entries are built by accumulating them; the values sit at varint length boundaries. */
interface Deltas {
  keyDelta: number;
  gap: number;
  length: number;
  cardinality: number;
  crc32c: number;
}

function toEntries(deltas: readonly Deltas[]): Entry[] {
  const entries: Entry[] = [];
  let key = 0;
  let end = PAYLOAD_START;
  for (const d of deltas) {
    key += d.keyDelta;
    const offset = end + d.gap;
    entries.push({
      chunkKey: key,
      offset,
      length: d.length,
      cardinality: d.cardinality,
      crc32c: d.crc32c,
    });
    end = offset + d.length;
  }
  return entries;
}

const EDGES = [
  0,
  1,
  126,
  127,
  128,
  129,
  16_382,
  16_383,
  16_384,
  16_385,
  2 ** 21 - 1,
  2 ** 21,
  2 ** 28 - 1,
  2 ** 28,
  2 ** 31,
  2 ** 32 - 2,
  2 ** 32 - 1,
];
const edgeOrAny = fc.oneof(
  { weight: 3, arbitrary: fc.constantFrom(...EDGES) },
  { weight: 1, arbitrary: fc.integer({ min: 0, max: 2 ** 32 - 1 }) },
);
const deltas = fc.record({
  keyDelta: edgeOrAny,
  gap: edgeOrAny,
  length: edgeOrAny,
  cardinality: edgeOrAny,
  crc32c: fc.oneof(
    fc.constantFrom(0, 1, 0xff, 0x100, 0xffff, 0x1_0000, 0xff_ffff, 0xffff_ffff),
    fc.nat(0xffff_ffff),
  ),
});

describe('CrbmWriter.encodeIndex matches the array-building encoding byte for byte', () => {
  it('gives the same bytes for random entry lists with values at varint boundaries', () => {
    fc.assert(
      fc.property(fc.array(deltas, { maxLength: 64 }), (list) => {
        const entries = toEntries(list);
        expect(Buffer.from(actualEncode(entries)).equals(Buffer.from(oracleEncode(entries)))).toBe(
          true,
        );
      }),
      { numRuns: 500 },
    );
  });

  it('encodes no entries as no bytes', () => {
    expect(actualEncode([]).length).toBe(0);
    expect(oracleEncode([]).length).toBe(0);
  });

  it('encodes one entry of every boundary value in every field', () => {
    for (const v of EDGES) {
      const entries = toEntries([{ keyDelta: v, gap: v, length: v, cardinality: v, crc32c: v }]);
      expect(Buffer.from(actualEncode(entries)).equals(Buffer.from(oracleEncode(entries)))).toBe(
        true,
      );
    }
  });

  it('encodes the 65,536 entries a segment can have', () => {
    const list: Deltas[] = [];
    for (let i = 0; i < 65_536; i++) {
      list.push({
        keyDelta: i === 0 ? 0 : 1,
        gap: EDGES[i % EDGES.length]! % 1_000_000,
        length: EDGES[(i * 7) % EDGES.length]! % 70_000,
        cardinality: 1 + (i % 65_536),
        crc32c: (Math.imul(i, 2_654_435_761) >>> 0) as number,
      });
    }
    const entries = toEntries(list);
    expect(entries.length).toBe(65_536);
    expect(Buffer.from(actualEncode(entries)).equals(Buffer.from(oracleEncode(entries)))).toBe(
      true,
    );
  });

  it('refuses a value that is not a u32, as before', () => {
    const entries = toEntries([
      { keyDelta: 1, gap: 0, length: 2 ** 32, cardinality: 1, crc32c: 0 },
    ]);
    expect(() => actualEncode(entries)).toThrow(RangeError);
    expect(() => oracleEncode(entries)).toThrow(RangeError);
  });
});

describe('CrbmWriter.encodeIndex checks its own sizing', () => {
  /** An entry whose length reads as 1 in the sizing pass and 300 in the writing pass, so the two passes disagree. */
  function shifting(): Entry {
    let reads = 0;
    return {
      chunkKey: 1,
      offset: PAYLOAD_START,
      get length(): number {
        reads += 1;
        return reads <= 2 ? 1 : 300;
      },
      cardinality: 5,
      crc32c: 7,
    };
  }

  it('throws IntegrityError, and not a truncated index, when the passes disagree', () => {
    expect(() => actualEncode([shifting()])).toThrow(IntegrityError);
  });

  it('returns exactly the bytes it sized when they agree', () => {
    const entries = toEntries([{ keyDelta: 1, gap: 0, length: 300, cardinality: 5, crc32c: 7 }]);
    expect(actualEncode(entries).length).toBe(1 + 1 + 2 + 1 + 4);
  });
});
