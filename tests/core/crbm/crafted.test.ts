import { CrbmReader } from '@/core/crbm/reader';
import { CountingReader } from '../../helpers/crbm-extension';
import { BufferReader } from '@/core/blob';
import { crc32c } from '@/core/crbm/crc32c';
import { writeVarint } from '@/core/crbm/varint';
import {
  CONTAINER_CODEC_NONE,
  ELEMENT_WIDTH_32,
  FLAG_LITTLE_ENDIAN,
  FOOTER,
  FOOTER_BYTES,
  FOOTER_CRC_COVERAGE,
  MAGIC,
  PAYLOAD_START,
  KNOWN_PAYLOAD_CODEC_IDS,
  PAYLOAD_CODEC_ROARING_PORTABLE,
  VERSION_MAJOR,
  VERSION_MINOR,
} from '@/core/crbm/format';
import { IntegrityError, UnsupportedError } from '@/core/errors';
import { randomBytes } from 'node:crypto';
import { aadFor } from '@/core/crypto';
import type { CrbmCrypto } from '@/core/crypto';
import { NodeAead } from '@/drivers/crypto';
import {
  AEAD_NONCE_BYTES,
  AEAD_TAG_BYTES,
  DEFAULT_MAX_BITMAP_BYTES,
  DEFAULT_MAX_PAYLOAD_BYTES,
  FLAG_ENCRYPTED,
  MAX_CHUNK_CARDINALITY,
} from '@/core/crbm/format';

interface RawEntry {
  keyDelta: number;
  offDelta: number;
  length: number;
  cardinality: number;
  crc: number;
}

/**
 * Assemble a `.crbm` from a fully-controlled raw index — bypassing the writer's validation so we can
 * forge the malicious bytes a hostile/corrupt storage tier could present. Footer fields are derived
 * from the entries unless overridden.
 */
function assembleCrbm(opts: {
  payloadRegion: Uint8Array;
  rawEntries: RawEntry[];
  generation?: number;
  totalCardinality?: number;
  /** Footer `chunk_count`; defaults to the number of entries (or 0 on an encrypted object). */
  chunkCount?: number;
  /** Seal the index and set the encrypted flag, as the writer does. */
  crypto?: CrbmCrypto;
  /** Footer format fields — default to the valid v1 values; override to forge an unsupported generation. */
  elementWidth?: number;
  payloadCodecId?: number;
  containerCodec?: number;
}): Uint8Array {
  const indexArr: number[] = [];
  let derivedTotal = 0;
  for (const e of opts.rawEntries) {
    writeVarint(indexArr, e.keyDelta);
    writeVarint(indexArr, e.offDelta);
    writeVarint(indexArr, e.length);
    writeVarint(indexArr, e.cardinality);
    indexArr.push(e.crc & 0xff, (e.crc >>> 8) & 0xff, (e.crc >>> 16) & 0xff, (e.crc >>> 24) & 0xff);
    derivedTotal += e.cardinality;
  }
  const plainIndex = Uint8Array.from(indexArr);
  const sealed = opts.crypto?.aead.seal(plainIndex, opts.crypto.aadFor('index'));
  const index = sealed === undefined ? plainIndex : sealed.ciphertext;
  const indexOffset = PAYLOAD_START + opts.payloadRegion.length;
  const total = new Uint8Array(indexOffset + index.length + FOOTER_BYTES);

  total.set(MAGIC, 0);
  total[4] = VERSION_MAJOR;
  total[5] = VERSION_MINOR;
  total.set(opts.payloadRegion, PAYLOAD_START);
  total.set(index, indexOffset);

  const footer = total.subarray(total.length - FOOTER_BYTES);
  const view = new DataView(footer.buffer, footer.byteOffset, FOOTER_BYTES);
  view.setBigUint64(FOOTER.indexOffset, BigInt(indexOffset), true);
  view.setBigUint64(FOOTER.indexLength, BigInt(index.length), true);
  view.setUint32(FOOTER.indexCrc32c, crc32c(index), true);
  view.setUint32(
    FOOTER.flags,
    FLAG_LITTLE_ENDIAN | (sealed === undefined ? 0 : FLAG_ENCRYPTED),
    true,
  );
  if (sealed !== undefined) {
    footer.set(sealed.nonce, FOOTER.indexNonce);
    footer.set(sealed.tag, FOOTER.indexTag);
  }
  view.setUint16(
    FOOTER.payloadCodecId,
    opts.payloadCodecId ?? PAYLOAD_CODEC_ROARING_PORTABLE,
    true,
  );
  footer[FOOTER.elementWidth] = opts.elementWidth ?? ELEMENT_WIDTH_32;
  footer[FOOTER.containerCodec] = opts.containerCodec ?? CONTAINER_CODEC_NONE;
  footer[FOOTER.versionMajor] = VERSION_MAJOR;
  footer[FOOTER.versionMinor] = VERSION_MINOR;
  view.setBigUint64(FOOTER.generation, BigInt(opts.generation ?? 1), true);
  const hidden = sealed !== undefined; // an encrypted footer zeroes both
  view.setUint32(FOOTER.chunkCount, opts.chunkCount ?? (hidden ? 0 : opts.rawEntries.length), true);
  view.setBigUint64(
    FOOTER.totalCardinality,
    BigInt(opts.totalCardinality ?? (hidden ? 0 : derivedTotal)),
    true,
  );
  view.setUint32(FOOTER.footerCrc32c, crc32c(footer.subarray(0, FOOTER_CRC_COVERAGE)), true);
  footer.set(MAGIC, FOOTER.endMagic);
  return total;
}

const open = (bytes: Uint8Array): Promise<CrbmReader> => CrbmReader.open(new BufferReader(bytes));

describe('crafted (hostile) index — reader-side guards', () => {
  it('accepts a well-formed crafted file (sanity for the assembler)', async () => {
    const payload = Uint8Array.of(1, 2, 3, 4, 5, 6);
    const a = payload.subarray(0, 4);
    const b = payload.subarray(4);
    const bytes = assembleCrbm({
      payloadRegion: payload,
      rawEntries: [
        { keyDelta: 0, offDelta: 0, length: 4, cardinality: 2, crc: crc32c(a) },
        { keyDelta: 3, offDelta: 0, length: 2, cardinality: 1, crc: crc32c(b) },
      ],
    });
    const reader = await open(bytes);
    expect(reader.chunkKeys()).toEqual([0, 3]);
    expect([...(await reader.getChunk(3))!]).toEqual([5, 6]);
  });

  // Each guard below is the only one that refuses its forgery: the footer's own CRC is re-stamped to match, and the
  // index bytes are left exactly as written, so nothing later in the open would catch what the guard is for.
  const oneChunk = (): Uint8Array => {
    const payload = Uint8Array.of(1, 2, 3, 4);
    return assembleCrbm({
      payloadRegion: payload,
      rawEntries: [{ keyDelta: 0, offDelta: 0, length: 4, cardinality: 2, crc: crc32c(payload) }],
    });
  };
  const withFooter = (bytes: Uint8Array, edit: (view: DataView) => void): Uint8Array => {
    const out = bytes.slice();
    const footer = out.subarray(out.length - FOOTER_BYTES);
    const view = new DataView(footer.buffer, footer.byteOffset, FOOTER_BYTES);
    edit(view);
    view.setUint32(FOOTER.footerCrc32c, crc32c(footer.subarray(0, FOOTER_CRC_COVERAGE)), true);
    return out;
  };

  it('rejects a footer u64 field past the safe-integer range, each one, as IntegrityError', async () => {
    for (const field of ['indexOffset', 'indexLength', 'totalCardinality', 'generation'] as const) {
      const forged = withFooter(oneChunk(), (v) =>
        v.setBigUint64(FOOTER[field], BigInt(Number.MAX_SAFE_INTEGER) + 2n, true),
      );
      const err = await open(forged).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(err, field).toBeInstanceOf(IntegrityError);
      expect(String(err), field).toMatch(/exceeds safe-integer range/);
    }
  });

  it('rejects an index byte changed without its CRC, before the index is parsed', async () => {
    const bytes = oneChunk();
    const indexOffset = Number(
      new DataView(
        bytes.buffer,
        bytes.byteOffset + bytes.length - FOOTER_BYTES,
        FOOTER_BYTES,
      ).getBigUint64(FOOTER.indexOffset, true),
    );
    const tampered = bytes.slice();
    tampered[indexOffset + 2] = tampered[indexOffset + 2]! ^ 0x01; // the entry's length varint
    await expect(open(tampered)).rejects.toThrow('.crbm index CRC mismatch');
    await expect(open(tampered)).rejects.toBeInstanceOf(IntegrityError);
  });

  it('rejects a duplicate chunkKey (zero delta after the first)', async () => {
    const payload = Uint8Array.of(1, 2);
    const bytes = assembleCrbm({
      payloadRegion: payload,
      rawEntries: [
        {
          keyDelta: 7,
          offDelta: 0,
          length: 1,
          cardinality: 1,
          crc: crc32c(payload.subarray(0, 1)),
        },
        {
          keyDelta: 0,
          offDelta: 0,
          length: 1,
          cardinality: 1,
          crc: crc32c(payload.subarray(1, 2)),
        },
      ],
    });
    await expect(open(bytes)).rejects.toBeInstanceOf(IntegrityError);
  });

  it('rejects a cumulative chunkKey that overflows past 0xffff', async () => {
    const payload = Uint8Array.of(1, 2);
    const bytes = assembleCrbm({
      payloadRegion: payload,
      rawEntries: [
        {
          keyDelta: 60_000,
          offDelta: 0,
          length: 1,
          cardinality: 1,
          crc: crc32c(payload.subarray(0, 1)),
        },
        {
          keyDelta: 60_000,
          offDelta: 0,
          length: 1,
          cardinality: 1,
          crc: crc32c(payload.subarray(1, 2)),
        },
      ],
    });
    await expect(open(bytes)).rejects.toBeInstanceOf(IntegrityError);
  });

  it('rejects an index entry whose payload offset runs past the payload region', async () => {
    const payload = Uint8Array.of(1, 2, 3, 4);
    const bytes = assembleCrbm({
      payloadRegion: payload,
      // offDelta pushes the first payload past the region end.
      rawEntries: [{ keyDelta: 0, offDelta: 100, length: 4, cardinality: 2, crc: crc32c(payload) }],
    });
    await expect(open(bytes)).rejects.toBeInstanceOf(IntegrityError);
  });

  it('rejects a footer total_cardinality that disagrees with the index', async () => {
    const payload = Uint8Array.of(1, 2, 3, 4);
    const bytes = assembleCrbm({
      payloadRegion: payload,
      rawEntries: [{ keyDelta: 0, offDelta: 0, length: 4, cardinality: 2, crc: crc32c(payload) }],
      totalCardinality: 999, // lies: real Σ is 2
    });
    await expect(open(bytes)).rejects.toBeInstanceOf(IntegrityError);
  });

  // ── Format-field validation: the reader must refuse a generation whose payloads it can't
  // safely decode, rather than feed them to the 32-bit portable deserializer and mis-count. These fields
  // are inside FOOTER_CRC_COVERAGE, so a genuine (CRC-valid) future generation still trips the check. ──
  const wellFormed = (over: Partial<Parameters<typeof assembleCrbm>[0]>): Uint8Array => {
    const payload = Uint8Array.of(1, 2, 3, 4);
    return assembleCrbm({
      payloadRegion: payload,
      rawEntries: [{ keyDelta: 0, offDelta: 0, length: 4, cardinality: 2, crc: crc32c(payload) }],
      ...over,
    });
  };

  it('rejects element_width=64 (the reserved >4.29B escape → a future MAJOR version) with UnsupportedError', async () => {
    await expect(open(wellFormed({ elementWidth: 64 }))).rejects.toBeInstanceOf(UnsupportedError);
  });

  it('rejects an unregistered payload_codec_id with UnsupportedError', async () => {
    await expect(open(wellFormed({ payloadCodecId: 2 }))).rejects.toBeInstanceOf(UnsupportedError);
  });

  // The next three exist because an "is in a registry" check can be "equals one constant" with extra steps.
  // Each one would also pass against a reader that compares with a single constant, so read them together rather
  // than individually.

  it.each([...KNOWN_PAYLOAD_CODEC_IDS])('accepts registered payload_codec_id %i', async (id) => {
    // Written as a loop over the registry rather than against the literal `1`, so that registering a second
    // codec extends this test with no edit. A hand-written `expect(open(id=1))` would silently stop covering
    // the new id on the day it matters.
    const reader = await open(wellFormed({ payloadCodecId: id }));
    expect(reader.chunkKeys()).toEqual([0]);
  });

  it('names the offending id AND the registry in the rejection message', async () => {
    // The error is the whole user experience of a foreign generation: someone has pointed a roaring store at
    // another codec's object, and "unsupported" without the number tells them nothing about which codec or
    // what this build can read. Asserting the message keeps that diagnostic from decaying.
    await expect(open(wellFormed({ payloadCodecId: 9 }))).rejects.toThrow(
      /payload_codec_id 9 not supported by this build.*known: 1/s,
    );
  });

  it('registers roaring-portable as id 1, and that id is frozen by the golden corpus', () => {
    // Two assertions that look trivial and are not. The first is the compatibility statement: every generation
    // ever written by this project carries id 1, so 1 can never be reassigned. The second guards the registry
    // itself — it must CONTAIN that id, not replace it.
    expect(PAYLOAD_CODEC_ROARING_PORTABLE).toBe(1);
    expect(KNOWN_PAYLOAD_CODEC_IDS.has(PAYLOAD_CODEC_ROARING_PORTABLE)).toBe(true);
  });

  it('rejects a non-zero container_codec (a future compression/codec) with UnsupportedError', async () => {
    await expect(open(wellFormed({ containerCodec: 1 }))).rejects.toBeInstanceOf(UnsupportedError);
  });

  it('accepts the explicit valid v1 field values (element_width=32, portable, codec=none)', async () => {
    const reader = await open(
      wellFormed({
        elementWidth: ELEMENT_WIDTH_32,
        payloadCodecId: PAYLOAD_CODEC_ROARING_PORTABLE,
        containerCodec: CONTAINER_CODEC_NONE,
      }),
    );
    expect(reader.chunkKeys()).toEqual([0]);
  });

  // The footer is checked before anything in it is trusted, by an open and by the check a pin makes alike.
  const flipped = (at: number): Uint8Array => {
    const bytes = Uint8Array.from(wellFormed({}));
    bytes[bytes.length - FOOTER_BYTES + at]! ^= 0xff;
    return bytes;
  };

  it.each([
    ['its end magic, which its CRC does not cover', FOOTER.endMagic, /end magic mismatch/],
    ['its CRC', FOOTER.footerCrc32c, /footer CRC mismatch/],
    ['the first field its CRC covers', 0, /footer CRC mismatch/],
  ])('refuses a footer with a byte flipped in %s', async (_where, at, message) => {
    await expect(open(flipped(at))).rejects.toThrow(message);
    // At the object's own size only the footer can say which object it is, and a footer that fails its check cannot.
    const pinned = (await open(wellFormed({}))).fingerprint;
    await expect(CrbmReader.sameObject(new BufferReader(flipped(at)), pinned)).rejects.toThrow(
      message,
    );
  });

  it('refuses a footer alone, with no preamble before it, as too small', async () => {
    const whole = wellFormed({});
    const footerOnly = whole.slice(whole.length - FOOTER_BYTES);
    await expect(open(footerOnly)).rejects.toThrow(/too small/);
  });

  it.each([
    ['a footer alone', (whole: Uint8Array) => whole.slice(whole.length - FOOTER_BYTES)],
    ['fifty bytes that are no .crbm at all', () => new Uint8Array(50)],
  ])('says %s is not the object a fingerprint names, by its size alone', async (_what, make) => {
    const whole = wellFormed({});
    const pinned = (await open(whole)).fingerprint;
    expect(await CrbmReader.sameObject(new BufferReader(make(whole)), pinned)).toBe(false);
  });

  it.each([
    ['NaN', () => Number.NaN],
    ['Infinity', () => Number.POSITIVE_INFINITY],
    ['10, less than its own tail', () => 10],
    ['half a byte past its length', (length: number) => length + 0.5],
    ['past 2^53, where a count stops being exact', () => 2 ** 53 + 2],
  ])('refuses a size of %s, which is not a byte count the tail fits in', async (_what, sizeOf) => {
    const bytes = wellFormed({});
    const inner = new BufferReader(bytes);
    const size = sizeOf(bytes.length);
    const blob = {
      getRange: (offset: number, length: number) => inner.getRange(offset, length),
      getTail: async (maxBytes: number) => ({ ...(await inner.getTail(maxBytes)), size }),
    };
    await expect(CrbmReader.open(blob)).rejects.toThrow(/not a byte count its tail fits in/);
    const pinned = (await open(bytes)).fingerprint;
    await expect(CrbmReader.sameObject(blob, pinned)).rejects.toThrow(
      /not a byte count its tail fits in/,
    );
  });

  it("knows an object by its fingerprint from a footer's worth of its bytes, and another of its size by its CRC", async () => {
    const bytes = wellFormed({});
    const inner = new BufferReader(bytes);
    const asked: number[] = [];
    const blob = {
      getRange: (offset: number, length: number) => inner.getRange(offset, length),
      getTail: (maxBytes: number) => {
        asked.push(maxBytes);
        return inner.getTail(maxBytes);
      },
    };
    expect(await CrbmReader.sameObject(blob, (await open(bytes)).fingerprint)).toBe(true);
    expect(asked).toEqual([FOOTER_BYTES]);
    const other = wellFormed({ generation: 2 }); // the same size, and a footer that says another generation
    expect(other.length).toBe(bytes.length);
    expect(await CrbmReader.sameObject(blob, (await open(other)).fingerprint)).toBe(false);
  });

  it('tells an object whose size is a prefix of the pinned size apart by its size alone', async () => {
    const bytes = wellFormed({});
    const pinned = (await open(bytes)).fingerprint;
    const size = String(bytes.length);
    const shorter = new Uint8Array(Number(size.slice(0, -1))); // 194 bytes pinned, 19 bytes now
    expect(await CrbmReader.sameObject(new BufferReader(shorter), pinned)).toBe(false);
  });
});

// An index is checked for internal consistency when it is parsed, because `count()` and the other reads that answer
// from the index alone decode no payload: what the index records is what they report.
describe('index consistency — refused at open, before any payload is read', () => {
  const payload = Uint8Array.of(1, 2, 3, 4, 5, 6);
  const first = {
    keyDelta: 0,
    offDelta: 0,
    length: 4,
    cardinality: 2,
    crc: crc32c(payload.subarray(0, 4)),
  };
  const second = {
    keyDelta: 3,
    offDelta: 0,
    length: 2,
    cardinality: 1,
    crc: crc32c(payload.subarray(4)),
  };
  const valid = (over: Partial<Parameters<typeof assembleCrbm>[0]> = {}): Uint8Array =>
    assembleCrbm({ payloadRegion: payload, rawEntries: [first, second], ...over });

  /** Opens with a tail that holds only the footer, so the index is the one range read an open makes. */
  async function openCounting(
    bytes: Uint8Array,
  ): Promise<{ error: unknown; reads: Array<[number, number]> }> {
    const inner = new BufferReader(bytes);
    const reads: Array<[number, number]> = [];
    const blob = {
      getRange: (offset: number, length: number) => {
        reads.push([offset, length]);
        return inner.getRange(offset, length);
      },
      getTail: (maxBytes: number) => inner.getTail(maxBytes),
    };
    try {
      await CrbmReader.open(blob, { tailBytes: FOOTER_BYTES });
      return { error: undefined, reads };
    } catch (error) {
      return { error, reads };
    }
  }

  const indexRead = (bytes: Uint8Array): [number, number] => {
    const view = new DataView(bytes.buffer, bytes.byteOffset + bytes.length - FOOTER_BYTES);
    return [
      Number(view.getBigUint64(FOOTER.indexOffset, true)),
      Number(view.getBigUint64(FOOTER.indexLength, true)),
    ];
  };

  it('opens a consistent object, and its count is the sum of what the index records', async () => {
    const reader = await open(valid());
    expect(reader.count()).toBe(3);
    expect([...reader.cardinalities()]).toEqual([
      [0, 2],
      [3, 1],
    ]);
    const counted = await openCounting(valid());
    expect(counted.error).toBeUndefined();
    expect(counted.reads).toEqual([indexRead(valid())]); // the index and nothing else
  });

  const refused: Array<[string, () => Uint8Array, RegExp]> = [
    [
      'a chunk key that repeats',
      () => valid({ rawEntries: [first, { ...second, keyDelta: 0 }] }),
      /duplicate chunkKey/,
    ],
    [
      'a chunk key past 0xffff',
      () => valid({ rawEntries: [{ ...first, keyDelta: 0x1_0000 }, second] }),
      /chunkKey .* out of range/,
    ],
    [
      'a cardinality of 0',
      () => valid({ rawEntries: [{ ...first, cardinality: 0 }, second] }),
      /cardinality 0 invalid/,
    ],
    [
      'a cardinality above 65536',
      () => valid({ rawEntries: [{ ...first, cardinality: MAX_CHUNK_CARDINALITY + 1 }, second] }),
      /cardinality 65537 invalid/,
    ],
    [
      'a payload length of 0',
      () => valid({ rawEntries: [{ ...first, length: 0 }, second] }),
      /length 0 invalid/,
    ],
    [
      'a payload length above the cap',
      () => valid({ rawEntries: [{ ...first, length: DEFAULT_MAX_PAYLOAD_BYTES + 1 }, second] }),
      /length \d+ invalid/,
    ],
    [
      'a payload that runs past the payload region, into the index',
      // The region holds 6 bytes; the second payload claims 40, which still ends inside the object.
      () => valid({ rawEntries: [first, { ...second, length: 40 }] }),
      /payload out of bounds/,
    ],
    [
      'a payload that starts past the payload region',
      () => valid({ rawEntries: [first, { ...second, offDelta: 1 }] }),
      /payload out of bounds/,
    ],
    [
      'a footer chunk_count above the entries',
      () => valid({ chunkCount: 3 }),
      /chunk_count 3 != 2/,
    ],
    [
      'a footer chunk_count below the entries',
      () => valid({ chunkCount: 1 }),
      /chunk_count 1 != 2/,
    ],
    [
      'a footer total_cardinality above the sum',
      () => valid({ totalCardinality: 4 }),
      /total_cardinality 4 != /,
    ],
    [
      'a footer total_cardinality below the sum',
      () => valid({ totalCardinality: 2 }),
      /total_cardinality 2 != /,
    ],
  ];

  it.each(refused)(
    'refuses %s with an IntegrityError and reads nothing but the index',
    async (_what, make, message) => {
      const bytes = make();
      await expect(open(bytes)).rejects.toBeInstanceOf(IntegrityError);
      await expect(open(bytes)).rejects.toThrow(message);
      const counted = await openCounting(bytes);
      expect(counted.error).toBeInstanceOf(IntegrityError);
      expect(counted.reads).toEqual([indexRead(bytes)]);
    },
  );

  it('refuses an index whose last record is cut short, with its own CRC and the footer CRC re-forged to match', async () => {
    const [offset, length] = indexRead(valid());
    const cut = Uint8Array.from(valid());
    const view = new DataView(cut.buffer, cut.length - FOOTER_BYTES);
    view.setBigUint64(FOOTER.indexLength, BigInt(length - 2), true);
    view.setUint32(FOOTER.indexCrc32c, crc32c(cut.subarray(offset, offset + length - 2)), true);
    const footer = cut.subarray(cut.length - FOOTER_BYTES);
    view.setUint32(FOOTER.footerCrc32c, crc32c(footer.subarray(0, FOOTER_CRC_COVERAGE)), true);
    await expect(open(cut)).rejects.toThrow(/index truncated|varint truncated/);
  });

  describe('an encrypted object', () => {
    const dek = randomBytes(32);
    const crypto: CrbmCrypto = {
      aead: new NodeAead(dek),
      aadFor: (scope) => aadFor({ segment: 'crafted' }, 1, scope),
    };
    const framed = (length: number): Uint8Array => randomBytes(length);
    const FRAME = AEAD_NONCE_BYTES + AEAD_TAG_BYTES;
    const sealed = (
      length: number,
      over: Partial<Parameters<typeof assembleCrbm>[0]> = {},
    ): Uint8Array => {
      const region = framed(length);
      return assembleCrbm({
        payloadRegion: region,
        rawEntries: [{ keyDelta: 0, offDelta: 0, length, cardinality: 5, crc: crc32c(region) }],
        crypto,
        ...over,
      });
    };
    const openSealed = (bytes: Uint8Array): Promise<CrbmReader> =>
      CrbmReader.open(new BufferReader(bytes), { crypto });

    it('opens, and counts what its decrypted index records', async () => {
      const reader = await openSealed(sealed(FRAME + 3));
      expect(reader.count()).toBe(5);
    });

    it('refuses a payload too short to hold its nonce and tag', async () => {
      await expect(openSealed(sealed(FRAME - 1))).rejects.toBeInstanceOf(IntegrityError);
      await expect(openSealed(sealed(FRAME - 1))).rejects.toThrow(/length 27 invalid/);
    });

    it('refuses a footer that reveals a count or a total', async () => {
      await expect(openSealed(sealed(FRAME + 3, { chunkCount: 1 }))).rejects.toBeInstanceOf(
        IntegrityError,
      );
      await expect(openSealed(sealed(FRAME + 3, { totalCardinality: 5 }))).rejects.toBeInstanceOf(
        IntegrityError,
      );
    });
  });
});

// An entry the engine would refuse to decode (over the 1 MiB decode cap, plus the framing when encrypted) is refused when
// the object is opened, so a corrupt or hostile index cannot make a read window hold bytes that are refused anyway.
describe('payload cap matches the decode cap', () => {
  const FRAME = AEAD_NONCE_BYTES + AEAD_TAG_BYTES;
  const dek = randomBytes(32);
  const crypto: CrbmCrypto = {
    aead: new NodeAead(dek),
    aadFor: (scope) => aadFor({ segment: 'crafted' }, 1, scope),
  };
  const object = (length: number, encrypted: boolean): Uint8Array => {
    const region = new Uint8Array(length);
    return assembleCrbm({
      payloadRegion: region,
      rawEntries: [{ keyDelta: 7, offDelta: 0, length, cardinality: 5, crc: crc32c(region) }],
      ...(encrypted ? { crypto } : {}),
    });
  };
  const openCounted = async (
    bytes: Uint8Array,
    encrypted: boolean,
  ): Promise<{ error: unknown; reader: CountingReader }> => {
    const reader = new CountingReader(bytes);
    try {
      await CrbmReader.open(reader, encrypted ? { crypto } : {});
      return { error: undefined, reader };
    } catch (error) {
      return { error, reader };
    }
  };

  it('derives the payload cap from the decode cap and the framing', () => {
    expect(DEFAULT_MAX_PAYLOAD_BYTES).toBe(DEFAULT_MAX_BITMAP_BYTES + FRAME);
    expect(FRAME).toBe(28);
  });

  it.each([
    ['cleartext', false, DEFAULT_MAX_BITMAP_BYTES],
    ['encrypted', true, DEFAULT_MAX_BITMAP_BYTES + FRAME],
  ] as const)(
    '%s: an entry at the cap opens, one byte over is refused naming the chunk',
    async (_n, enc, cap) => {
      const ok = await openCounted(object(cap, enc), enc);
      expect(ok.error).toBeUndefined();

      const over = await openCounted(object(cap + 1, enc), enc);
      expect(over.error).toBeInstanceOf(IntegrityError);
      expect((over.error as Error).message).toMatch(
        new RegExp(`chunk 7 length ${cap + 1} invalid \\(most is ${cap}\\)`),
      );
      // The first payload starts at PAYLOAD_START: nothing read it (only the index, at most, was requested).
      expect(over.reader.rangeReads.some(([offset]) => offset === PAYLOAD_START)).toBe(false);
      expect(over.reader.ranges).toBeLessThanOrEqual(1);
    },
  );
});
