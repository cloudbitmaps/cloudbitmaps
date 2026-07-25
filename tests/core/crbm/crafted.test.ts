import { CrbmReader } from '@/core/crbm/reader';
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
  ROARING_PORTABLE_ID,
  VERSION_MAJOR,
  VERSION_MINOR,
} from '@/core/crbm/format';
import { IntegrityError, UnsupportedError } from '@/core/errors';

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
  /** Footer format fields — default to the valid v1 values; override to forge an unsupported generation. */
  elementWidth?: number;
  serializationId?: number;
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
  const index = Uint8Array.from(indexArr);
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
  view.setUint32(FOOTER.flags, FLAG_LITTLE_ENDIAN, true);
  view.setUint16(FOOTER.roaringSerializationId, opts.serializationId ?? ROARING_PORTABLE_ID, true);
  footer[FOOTER.elementWidth] = opts.elementWidth ?? ELEMENT_WIDTH_32;
  footer[FOOTER.containerCodec] = opts.containerCodec ?? CONTAINER_CODEC_NONE;
  footer[FOOTER.versionMajor] = VERSION_MAJOR;
  footer[FOOTER.versionMinor] = VERSION_MINOR;
  view.setBigUint64(FOOTER.generation, BigInt(opts.generation ?? 1), true);
  view.setUint32(FOOTER.chunkCount, opts.rawEntries.length, true);
  view.setBigUint64(FOOTER.totalCardinality, BigInt(opts.totalCardinality ?? derivedTotal), true);
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

  it('rejects a footer total_cardinality that disagrees with the index (F2)', async () => {
    const payload = Uint8Array.of(1, 2, 3, 4);
    const bytes = assembleCrbm({
      payloadRegion: payload,
      rawEntries: [{ keyDelta: 0, offDelta: 0, length: 4, cardinality: 2, crc: crc32c(payload) }],
      totalCardinality: 999, // lies: real Σ is 2
    });
    await expect(open(bytes)).rejects.toBeInstanceOf(IntegrityError);
  });

  // ── Format-field validation (gap #6): the reader must refuse a generation whose payloads it can't
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

  it('rejects an unknown roaring_serialization_id (a different serialization) with UnsupportedError', async () => {
    await expect(open(wellFormed({ serializationId: 2 }))).rejects.toBeInstanceOf(UnsupportedError);
  });

  it('rejects a non-zero container_codec (a future compression/codec) with UnsupportedError', async () => {
    await expect(open(wellFormed({ containerCodec: 1 }))).rejects.toBeInstanceOf(UnsupportedError);
  });

  it('accepts the explicit valid v1 field values (element_width=32, portable, codec=none)', async () => {
    const reader = await open(
      wellFormed({
        elementWidth: ELEMENT_WIDTH_32,
        serializationId: ROARING_PORTABLE_ID,
        containerCodec: CONTAINER_CODEC_NONE,
      }),
    );
    expect(reader.chunkKeys()).toEqual([0]);
  });
});
