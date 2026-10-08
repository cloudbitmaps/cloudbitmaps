import { randomBytes } from 'node:crypto';
import { CrbmWriter } from '@/core/crbm/writer';
import { CrbmReader } from '@/core/crbm/reader';
import { BufferSink, BufferReader } from '@/core/blob';
import { crc32c } from '@/core/crbm/crc32c';
import {
  FLAG_ENCRYPTED,
  FLAG_EXTENSION,
  FLAG_LITTLE_ENDIAN,
  FOOTER,
  FOOTER_BYTES,
  FOOTER_CRC_COVERAGE,
  PAYLOAD_START,
} from '@/core/crbm/format';
import { IntegrityError, UnsupportedError, ValidationError } from '@/core/errors';
import { aadFor } from '@/core/crypto';
import type { CrbmCrypto } from '@/core/crypto';
import { NodeAead } from '@/drivers/crypto';

interface Chunk {
  chunkKey: number;
  payload: Uint8Array;
  cardinality: number;
}

const SAMPLE: Chunk[] = [
  { chunkKey: 0, payload: Uint8Array.of(1, 2, 3, 4), cardinality: 2 },
  { chunkKey: 5, payload: Uint8Array.of(9, 8, 7), cardinality: 1 },
  { chunkKey: 65_535, payload: Uint8Array.of(255, 0, 128, 64, 32), cardinality: 65_536 },
];

async function build(chunks: Chunk[], generation = 1): Promise<Uint8Array> {
  const sink = new BufferSink();
  const writer = new CrbmWriter(sink, { generation });
  for (const c of chunks) await writer.addChunk(c.chunkKey, c.payload, c.cardinality);
  await writer.finish();
  return sink.bytes();
}

/** Mutate the footer and re-stamp its CRC so the change survives footer-CRC validation. */
function patchFooter(
  bytes: Uint8Array,
  mutate: (view: DataView, footer: Uint8Array) => void,
): Uint8Array {
  const copy = bytes.slice();
  const start = copy.length - FOOTER_BYTES;
  const footer = copy.subarray(start);
  const view = new DataView(copy.buffer, copy.byteOffset + start, FOOTER_BYTES);
  mutate(view, footer);
  view.setUint32(FOOTER.footerCrc32c, crc32c(footer.subarray(0, FOOTER_CRC_COVERAGE)), true);
  return copy;
}

describe('CrbmWriter/CrbmReader round-trip', () => {
  it('reads back every chunk identically and reports the right metadata', async () => {
    const bytes = await build(SAMPLE, 42);
    const reader = await CrbmReader.open(new BufferReader(bytes));

    expect(reader.generation).toBe(42);
    expect(reader.chunkKeys()).toEqual([0, 5, 65_535]);
    expect(reader.count()).toBe(2 + 1 + 65_536); // Σ cardinality == total
    expect(reader.has(5)).toBe(true);
    expect(reader.has(1)).toBe(false);
    expect(await reader.getChunk(999)).toBeNull();

    for (const c of SAMPLE) {
      const got = await reader.getChunk(c.chunkKey);
      expect(got).not.toBeNull();
      expect([...got!]).toEqual([...c.payload]);
    }
  });

  it('handles an empty segment (no chunks)', async () => {
    const reader = await CrbmReader.open(new BufferReader(await build([])));
    expect(reader.chunkKeys()).toEqual([]);
    expect(reader.count()).toBe(0);
    expect(await reader.getChunk(0)).toBeNull();
  });
});

describe('writer input validation', () => {
  it('rejects non-ascending or duplicate chunk keys', async () => {
    const sink = new BufferSink();
    const writer = new CrbmWriter(sink, { generation: 1 });
    await writer.addChunk(5, Uint8Array.of(1), 1);
    await expect(writer.addChunk(5, Uint8Array.of(1), 1)).rejects.toBeInstanceOf(ValidationError);
    await expect(writer.addChunk(3, Uint8Array.of(1), 1)).rejects.toBeInstanceOf(ValidationError);
  });

  it('rejects out-of-range cardinality and empty payloads', async () => {
    const writer = new CrbmWriter(new BufferSink(), { generation: 1 });
    await expect(writer.addChunk(0, Uint8Array.of(1), 0)).rejects.toBeInstanceOf(ValidationError);
    await expect(writer.addChunk(0, Uint8Array.of(1), 70_000)).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(writer.addChunk(0, new Uint8Array(), 1)).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('untrusted bytes', () => {
  it('catches a flipped payload byte by CRC before returning it', async () => {
    const bytes = await build(SAMPLE);
    bytes[PAYLOAD_START] = bytes[PAYLOAD_START]! ^ 0xff; // corrupt the first payload byte
    const reader = await CrbmReader.open(new BufferReader(bytes));
    await expect(reader.getChunk(0)).rejects.toBeInstanceOf(IntegrityError);
  });

  it('rejects a corrupt footer', async () => {
    const bytes = await build(SAMPLE);
    const gi = bytes.length - FOOTER_BYTES + FOOTER.generation;
    bytes[gi] = bytes[gi]! ^ 0xff; // tamper, do NOT re-CRC
    await expect(CrbmReader.open(new BufferReader(bytes))).rejects.toBeInstanceOf(IntegrityError);
  });

  it('rejects a corrupt index (footer CRC still valid)', async () => {
    const bytes = await build(SAMPLE);
    const indexOffset = Number(
      new DataView(bytes.buffer, bytes.byteOffset).getBigUint64(
        bytes.length - FOOTER_BYTES + FOOTER.indexOffset,
        true,
      ),
    );
    bytes[indexOffset] = bytes[indexOffset]! ^ 0xff; // flip a byte inside the index region
    await expect(CrbmReader.open(new BufferReader(bytes))).rejects.toBeInstanceOf(IntegrityError);
  });

  it('rejects a truncated file', async () => {
    const bytes = await build(SAMPLE);
    await expect(CrbmReader.open(new BufferReader(bytes.subarray(0, 10)))).rejects.toBeInstanceOf(
      IntegrityError,
    );
  });

  it('rejects an out-of-bounds index region', async () => {
    const bytes = patchFooter(await build(SAMPLE), (view) => {
      view.setBigUint64(FOOTER.indexLength, BigInt(10n ** 9n), true);
    });
    await expect(CrbmReader.open(new BufferReader(bytes))).rejects.toBeInstanceOf(IntegrityError);
  });
});

describe('speculative tail read', () => {
  it('returns identical results whether the index is in the tail or fetched separately', async () => {
    const bytes = await build(SAMPLE);
    const big = await CrbmReader.open(new BufferReader(bytes), { tailBytes: 1 << 20 });
    const small = await CrbmReader.open(new BufferReader(bytes), { tailBytes: FOOTER_BYTES });
    expect(big.servedFromTail).toBe(true);
    expect(small.servedFromTail).toBe(false);
    expect(small.chunkKeys()).toEqual(big.chunkKeys());
    expect(small.count()).toBe(big.count());
    for (const k of big.chunkKeys()) {
      expect([...(await small.getChunk(k))!]).toEqual([...(await big.getChunk(k))!]);
    }
  });
});

describe('version & feature gating', () => {
  it('rejects an unknown major version', async () => {
    const bytes = patchFooter(await build(SAMPLE), (_view, footer) => {
      footer[FOOTER.versionMajor] = 2;
    });
    await expect(CrbmReader.open(new BufferReader(bytes))).rejects.toBeInstanceOf(UnsupportedError);
  });

  it('tolerates an unknown minor version, and finds the extension block by its flag', async () => {
    const sink = new BufferSink();
    const writer = new CrbmWriter(sink, { generation: 1, metadata: { def: 'v9' } });
    for (const c of SAMPLE) await writer.addChunk(c.chunkKey, c.payload, c.cardinality);
    await writer.finish();
    const bytes = patchFooter(sink.bytes(), (_view, footer) => {
      footer[FOOTER.versionMinor] = 9;
    });
    bytes[5] = 9; // the preamble's minor, which must agree with the footer's
    const reader = await CrbmReader.open(new BufferReader(bytes));
    expect(reader.chunkKeys()).toEqual([0, 5, 65_535]);
    expect(reader.metadata).toEqual({ def: 'v9' });
  });

  it('finds the extension block by its flag, not the minor: a minor above 0 without the flag reads no block', async () => {
    const bytes = patchFooter(await build(SAMPLE), (_view, footer) => {
      footer[FOOTER.versionMinor] = 9;
    });
    bytes[5] = 9;
    const reader = await CrbmReader.open(new BufferReader(bytes));
    expect(reader.metadata).toBeUndefined();
    expect(reader.chunkKeys()).toEqual(
      (await CrbmReader.open(new BufferReader(await build(SAMPLE)))).chunkKeys(),
    );
  });

  it('refuses the extension flag with no block before the index', async () => {
    const bytes = patchFooter(await build(SAMPLE), (view) => {
      view.setUint32(FOOTER.flags, view.getUint32(FOOTER.flags, true) | FLAG_EXTENSION, true);
    });
    await expect(CrbmReader.open(new BufferReader(bytes))).rejects.toThrow(
      /extension block trailer magic/,
    );
  });

  it('rejects an encrypted file when no decryption key is provided', async () => {
    const bytes = patchFooter(await build(SAMPLE), (view) => {
      view.setUint32(FOOTER.flags, FLAG_LITTLE_ENDIAN | FLAG_ENCRYPTED, true);
    });
    await expect(CrbmReader.open(new BufferReader(bytes))).rejects.toBeInstanceOf(ValidationError);
  });

  it('rejects an unknown/reserved flag bit', async () => {
    const bytes = patchFooter(await build(SAMPLE), (view) => {
      view.setUint32(FOOTER.flags, FLAG_LITTLE_ENDIAN | (1 << 5), true);
    });
    await expect(CrbmReader.open(new BufferReader(bytes))).rejects.toBeInstanceOf(UnsupportedError);
  });

  it('rejects a big-endian file (little-endian bit clear)', async () => {
    const bytes = patchFooter(await build(SAMPLE), (view) => {
      view.setUint32(FOOTER.flags, 0, true);
    });
    await expect(CrbmReader.open(new BufferReader(bytes))).rejects.toBeInstanceOf(UnsupportedError);
  });
});

describe('reader hardening', () => {
  it('caps the index region a single object can force the reader to parse', async () => {
    const bytes = await build(SAMPLE); // index is tens of bytes
    await expect(
      CrbmReader.open(new BufferReader(bytes), { maxIndexBytes: 1 }),
    ).rejects.toBeInstanceOf(IntegrityError);
  });

  it('clamps a too-small tailBytes up to the footer size instead of mislabeling corruption', async () => {
    const bytes = await build(SAMPLE);
    const reader = await CrbmReader.open(new BufferReader(bytes), { tailBytes: 4 });
    expect(reader.chunkKeys()).toEqual([0, 5, 65_535]);
  });

  it('rejects a preamble whose version disagrees with the footer (when in the tail)', async () => {
    const bytes = await build(SAMPLE); // small file → whole thing is in the default tail
    bytes[4] = 2; // corrupt preamble version_major; preamble is not under the footer CRC
    await expect(CrbmReader.open(new BufferReader(bytes))).rejects.toBeInstanceOf(IntegrityError);
  });

  it('does the second GET when the index straddles the tail boundary', async () => {
    const many: Chunk[] = Array.from({ length: 12 }, (_v, i) => ({
      chunkKey: i * 100,
      payload: Uint8Array.from({ length: 20 }, (_x, j) => (i + j) & 0xff),
      cardinality: i + 1,
    }));
    const bytes = await build(many);
    const full = await CrbmReader.open(new BufferReader(bytes), { tailBytes: 1 << 20 });
    // Tail covers the footer plus only the trailing slice of the index → forces the range GET.
    const straddle = await CrbmReader.open(new BufferReader(bytes), {
      tailBytes: FOOTER_BYTES + 40,
    });
    expect(straddle.servedFromTail).toBe(false);
    expect(straddle.chunkKeys()).toEqual(full.chunkKeys());
    expect(straddle.count()).toBe(full.count());
    for (const k of full.chunkKeys()) {
      expect([...(await straddle.getChunk(k))!]).toEqual([...(await full.getChunk(k))!]);
    }
  });
});

// Every rule `parseIndex` holds an index to is one the writer keeps, at the edges of the format: nothing the
// writer produces may be refused when it is opened.
describe('what the writer writes always opens', () => {
  const crypto: CrbmCrypto = {
    aead: new NodeAead(randomBytes(32)),
    aadFor: (scope) => aadFor({ segment: 'edge' }, 1, scope),
  };
  const sealedBuild = async (chunks: Chunk[]): Promise<Uint8Array> => {
    const sink = new BufferSink();
    const writer = new CrbmWriter(sink, { generation: 1, crypto });
    for (const c of chunks) await writer.addChunk(c.chunkKey, c.payload, c.cardinality);
    await writer.finish();
    return sink.bytes();
  };
  const all65536: Chunk[] = Array.from({ length: 65_536 }, (_, chunkKey) => ({
    chunkKey,
    payload: Uint8Array.of(chunkKey & 0xff),
    cardinality: chunkKey === 65_535 ? 65_536 : 1,
  }));
  const shapes: Array<[string, Chunk[], number]> = [
    ['an empty segment', [], 0],
    ['one chunk of one byte', [{ chunkKey: 7, payload: Uint8Array.of(1), cardinality: 1 }], 1],
    ['a full chunk', [{ chunkKey: 0, payload: Uint8Array.of(1, 2), cardinality: 65_536 }], 65_536],
    ['65,536 chunks', all65536, 65_535 + 65_536],
  ];

  // Writing and sealing 65,536 chunks one by one took 0.8 to 5.1 s on CI runners, against the 5 s default timeout.
  it.each(shapes)(
    'opens %s, unencrypted and encrypted',
    async (_what, chunks, total) => {
      const plain = await CrbmReader.open(new BufferReader(await build(chunks)));
      expect(plain.chunkKeys()).toEqual(chunks.map((c) => c.chunkKey));
      expect(plain.count()).toBe(total);
      const sealed = await CrbmReader.open(new BufferReader(await sealedBuild(chunks)), { crypto });
      expect(sealed.chunkKeys()).toEqual(chunks.map((c) => c.chunkKey));
      expect(sealed.count()).toBe(total);
    },
    30_000,
  );
});

describe('the writer refuses what no reader opens', () => {
  it('a generation past the safe-integer range, which would be written as another number', () => {
    for (const generation of [1e300, 2 ** 53, Number.MAX_SAFE_INTEGER + 2]) {
      expect(() => new CrbmWriter(new BufferSink(), { generation })).toThrow(ValidationError);
    }
    expect(
      () => new CrbmWriter(new BufferSink(), { generation: Number.MAX_SAFE_INTEGER }),
    ).not.toThrow();
  });

  it('a chunk payload past the decode cap, which every reader refuses at open', async () => {
    const writer = new CrbmWriter(new BufferSink(), { generation: 1 });
    await expect(writer.addChunk(0, new Uint8Array((1 << 20) + 1), 1)).rejects.toBeInstanceOf(
      ValidationError,
    );
  });
});
