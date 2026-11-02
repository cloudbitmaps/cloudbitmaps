import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { BufferReader } from '@/core/blob';
import type { BlobReader } from '@/core/blob';
import { crc32c } from '@/core/crbm/crc32c';
import { fingerprintFor } from '@/core/crbm/fingerprint';
import {
  FLAG_LITTLE_ENDIAN,
  FOOTER,
  FOOTER_BYTES,
  FOOTER_CRC_COVERAGE,
  MAGIC,
  PAYLOAD_START,
  VERSION_MAJOR,
  VERSION_MINOR,
  PAYLOAD_CODEC_ROARING_PORTABLE,
  ELEMENT_WIDTH_32,
  CONTAINER_CODEC_NONE,
} from '@/core/crbm/format';
import { CrbmReader } from '@/core/crbm/reader';
import { aadFor } from '@/core/crypto';
import type { CrbmCrypto } from '@/core/crypto';
import { IntegrityError } from '@/core/errors';
import { NodeAead } from '@/drivers/crypto';
import { forgeCrc } from '../../helpers/crc-forge';
import {
  extensionBlock,
  layoutOf,
  section,
  spliceBlock,
  writeCrbm,
} from '../../helpers/crbm-extension';
import type { RawChunk } from '../../helpers/crbm-extension';
import { fixedEntropy } from '../../helpers/entropy';
import { writeVarint } from '../../helpers/varint';

/**
 * The reader refuses every byte no writer writes: a non-zero reserved field, slack between the index and the footer,
 * a gap between payloads, bytes after the last one. Each of these was free input to the footer CRC, and so to an
 * object's fingerprint. Every object below has its CRCs recomputed, so only the check under test can refuse it.
 */
const open = (bytes: Uint8Array, crypto?: CrbmCrypto): Promise<CrbmReader> =>
  CrbmReader.open(new BufferReader(bytes), crypto === undefined ? {} : { crypto });

const CHUNKS: RawChunk[] = [
  { chunkKey: 0, payload: Uint8Array.of(1, 2, 3, 4), cardinality: 3 },
  { chunkKey: 9, payload: Uint8Array.of(5, 6), cardinality: 1 },
];

const cryptoFor = (dek: Uint8Array, segment = 'seg', generation = 4): CrbmCrypto => ({
  aead: new NodeAead(dek),
  aadFor: (scope) => aadFor({ segment }, generation, scope),
});

/** `bytes` with its footer changed by `edit`, and the footer CRC computed again. */
function refooted(
  bytes: Uint8Array,
  edit: (footer: Uint8Array, view: DataView) => void,
): Uint8Array {
  const out = Uint8Array.from(bytes);
  const footer = out.subarray(out.length - FOOTER_BYTES);
  const view = new DataView(footer.buffer, footer.byteOffset, FOOTER_BYTES);
  edit(footer, view);
  view.setUint32(FOOTER.footerCrc32c, crc32c(footer.subarray(0, FOOTER_CRC_COVERAGE)), true);
  return out;
}

/** A cleartext object laid out by hand: `gaps[i]` zero bytes before payload i, `tailGap` after the last, `slack` before the footer. */
function laidOut(opts: {
  readonly gaps?: readonly number[];
  readonly tailGap?: number;
  readonly slack?: number;
  readonly noChunks?: boolean;
  readonly indexNonce?: Uint8Array;
}): Uint8Array {
  const chunks = opts.noChunks === true ? [] : CHUNKS;
  const region: number[] = [];
  const index: number[] = [];
  let prevKey = 0;
  let total = 0;
  chunks.forEach((c, i) => {
    const gap = opts.gaps?.[i] ?? 0;
    for (let g = 0; g < gap; g++) region.push(0);
    writeVarint(index, c.chunkKey - prevKey);
    writeVarint(index, gap);
    writeVarint(index, c.payload.length);
    writeVarint(index, c.cardinality);
    const crc = crc32c(c.payload);
    index.push(crc & 0xff, (crc >>> 8) & 0xff, (crc >>> 16) & 0xff, (crc >>> 24) & 0xff);
    region.push(...c.payload);
    prevKey = c.chunkKey;
    total += c.cardinality;
  });
  for (let g = 0; g < (opts.tailGap ?? 0); g++) region.push(0);
  const slack = opts.slack ?? 0;
  const indexOffset = PAYLOAD_START + region.length;
  const out = new Uint8Array(indexOffset + index.length + slack + FOOTER_BYTES);
  out.set(MAGIC, 0);
  out[4] = VERSION_MAJOR;
  out[5] = VERSION_MINOR;
  out.set(region, PAYLOAD_START);
  out.set(index, indexOffset);
  const footer = out.subarray(out.length - FOOTER_BYTES);
  const view = new DataView(footer.buffer, footer.byteOffset, FOOTER_BYTES);
  view.setBigUint64(FOOTER.indexOffset, BigInt(indexOffset), true);
  view.setBigUint64(FOOTER.indexLength, BigInt(index.length), true);
  view.setUint32(FOOTER.indexCrc32c, crc32c(Uint8Array.from(index)), true);
  view.setUint32(FOOTER.flags, FLAG_LITTLE_ENDIAN, true);
  view.setUint16(FOOTER.payloadCodecId, PAYLOAD_CODEC_ROARING_PORTABLE, true);
  footer[FOOTER.elementWidth] = ELEMENT_WIDTH_32;
  footer[FOOTER.containerCodec] = CONTAINER_CODEC_NONE;
  footer[FOOTER.versionMajor] = VERSION_MAJOR;
  footer[FOOTER.versionMinor] = VERSION_MINOR;
  view.setBigUint64(FOOTER.generation, 4n, true);
  if (opts.indexNonce !== undefined) footer.set(opts.indexNonce, FOOTER.indexNonce);
  view.setUint32(FOOTER.chunkCount, chunks.length, true);
  view.setBigUint64(FOOTER.totalCardinality, BigInt(total), true);
  view.setUint32(FOOTER.footerCrc32c, crc32c(footer.subarray(0, FOOTER_CRC_COVERAGE)), true);
  footer.set(MAGIC, FOOTER.endMagic);
  return out;
}

const dek = randomBytes(32);
const encrypted = (): Promise<Uint8Array> =>
  writeCrbm(CHUNKS, { generation: 4, crypto: cryptoFor(dek) });
const cleartext = (): Promise<Uint8Array> => writeCrbm(CHUNKS, { generation: 4 });

describe('the reader refuses bytes no writer writes', () => {
  describe('a footer field that carries no meaning', () => {
    it.each([
      ['a non-zero reserved2', (f: Uint8Array) => (f[FOOTER.reserved2] = 1), /reserved2/],
      ['a non-zero key_id (first byte)', (f: Uint8Array) => (f[FOOTER.keyId] = 1), /key_id/],
      ['a non-zero key_id (last byte)', (f: Uint8Array) => (f[FOOTER.keyId + 15] = 0x80), /key_id/],
    ])('refuses %s, cleartext and encrypted', async (_what, edit, message) => {
      const clear = refooted(await cleartext(), (f) => edit(f));
      await expect(open(clear)).rejects.toThrow(message);
      await expect(open(clear)).rejects.toBeInstanceOf(IntegrityError);
      const sealed = refooted(await encrypted(), (f) => edit(f));
      await expect(open(sealed, cryptoFor(dek))).rejects.toThrow(message);
      await expect(open(sealed, cryptoFor(dek))).rejects.toBeInstanceOf(IntegrityError);
    });

    it('refuses a non-zero index_tag on a cleartext object', async () => {
      const forged = refooted(await cleartext(), (f) => (f[FOOTER.indexTag + 5] = 7));
      await expect(open(forged)).rejects.toThrow(/index_tag/);
      await expect(open(forged)).rejects.toBeInstanceOf(IntegrityError);
    });

    it('still reads an encrypted object, whose index_tag is the index tag', async () => {
      const reader = await open(await encrypted(), cryptoFor(dek));
      expect(reader.chunkKeys()).toEqual([0, 9]);
    });

    it.each([
      ['all zero', new Uint8Array(12)],
      ['random', randomBytes(12)],
    ])('still reads a cleartext object whose index_nonce is %s', async (_what, nonce) => {
      const bytes = await writeCrbm(CHUNKS, { generation: 4, entropy: fixedEntropy(nonce) });
      expect((await open(bytes)).chunkKeys()).toEqual([0, 9]);
    });
  });

  describe('the preamble', () => {
    it.each([6, 7])('refuses a non-zero byte %i when the tail covers the front', async (at) => {
      const bytes = Uint8Array.from(await cleartext());
      bytes[at] = 1;
      await expect(open(bytes)).rejects.toThrow(/preamble reserved/);
      await expect(open(bytes)).rejects.toBeInstanceOf(IntegrityError);
    });

    it('does not read the front of a large object to check it', async () => {
      const big = Uint8Array.of(...Array.from({ length: 300 }, (_, i) => i & 0xff));
      const bytes = await writeCrbm([{ chunkKey: 0, payload: big, cardinality: 3 }], {
        generation: 4,
      });
      bytes[6] = 1;
      const reads: Array<[number, number]> = [];
      const blob: BlobReader = {
        getTail: async (n: number) => ({
          bytes: bytes.subarray(bytes.length - n),
          size: bytes.length,
        }),
        getRange: async (offset: number, length: number) => {
          reads.push([offset, length]);
          return bytes.subarray(offset, offset + length);
        },
      };
      const reader = await CrbmReader.open(blob, { tailBytes: FOOTER_BYTES });
      expect(reader.chunkKeys()).toEqual([0]);
      expect(reads.every(([offset]) => offset > 0)).toBe(true);
    });
  });

  describe('slack between the index and the footer', () => {
    it('refuses it, cleartext and encrypted', async () => {
      const clear = await cleartext();
      const { indexOffset, indexLength } = layoutOf(clear);
      const pad = (bytes: Uint8Array, from: number): Uint8Array => {
        const out = new Uint8Array(bytes.length + 3);
        out.set(bytes.subarray(0, from), 0);
        out.set(bytes.subarray(from), from + 3);
        return out;
      };
      await expect(open(pad(clear, indexOffset + indexLength))).rejects.toThrow(
        /does not end where the footer begins/,
      );
      const enc = await encrypted();
      const l = layoutOf(enc);
      const padded = pad(enc, l.indexOffset + l.indexLength);
      await expect(open(padded, cryptoFor(dek))).rejects.toBeInstanceOf(IntegrityError);
      await expect(open(laidOut({ slack: 1 }))).rejects.toBeInstanceOf(IntegrityError);
    });
  });

  describe('gaps between payloads', () => {
    it('refuses a gap before the first payload, between two, and after the last', async () => {
      await expect(open(laidOut({ gaps: [1] }))).rejects.toThrow(/gap before its payload/);
      await expect(open(laidOut({ gaps: [0, 2] }))).rejects.toThrow(/gap before its payload/);
      await expect(open(laidOut({ tailGap: 1 }))).rejects.toThrow(
        /not at the end of the payload region/,
      );
      for (const bytes of [
        laidOut({ gaps: [1] }),
        laidOut({ gaps: [0, 2] }),
        laidOut({ tailGap: 1 }),
      ]) {
        await expect(open(bytes)).rejects.toBeInstanceOf(IntegrityError);
      }
    });

    it('reads the same object laid out with none', async () => {
      const reader = await open(laidOut({}));
      expect(reader.chunkKeys()).toEqual([0, 9]);
      expect([...(await reader.getChunk(9))!]).toEqual([5, 6]);
    });

    it('reads an object with no chunks', async () => {
      const reader = await open(laidOut({ noChunks: true }));
      expect(reader.chunkKeys()).toEqual([]);
      expect((await open(await writeCrbm([], { generation: 4 }))).chunkKeys()).toEqual([]);
    });

    it('reads an object with an extension block', async () => {
      const withMeta = await writeCrbm(CHUNKS, { generation: 4, metadata: { a: 'b' } });
      expect((await open(withMeta)).metadata).toEqual({ a: 'b' });
    });
  });

  describe('a pinned fingerprint', () => {
    it('is refused, not matched, for an object with a free field', async () => {
      const clear = await cleartext();
      const reader = await open(clear);
      const forged = refooted(clear, (f) => (f[FOOTER.keyId] = 1));
      await expect(
        CrbmReader.sameObject(new BufferReader(forged), reader.fingerprint),
      ).rejects.toBeInstanceOf(IntegrityError);
      expect(await CrbmReader.sameObject(new BufferReader(clear), reader.fingerprint)).toBe(true);
    });
  });
});

describe('the attack: an old encrypted object at a retaken generation number', () => {
  it('is accepted as the new object on a reader that ignores the free bytes, and refused by this one', async () => {
    const crypto = cryptoFor(dek, 'orders', 5);
    // The old object, which held an id an erasure then removed, and the object now stored at the number.
    const old = await writeCrbm(
      [{ chunkKey: 0, payload: Uint8Array.of(1, 2, 3, 4), cardinality: 3 }],
      {
        generation: 5,
        crypto,
      },
    );
    const current = await writeCrbm(
      [
        { chunkKey: 0, payload: Uint8Array.of(7, 7, 7, 7, 7, 7, 7), cardinality: 2 },
        { chunkKey: 1, payload: Uint8Array.of(8, 8, 8, 8, 8), cardinality: 2 },
        { chunkKey: 2, payload: Uint8Array.of(6, 6, 6), cardinality: 1 },
      ],
      { generation: 5, crypto },
    );
    expect(current.length).toBeGreaterThan(old.length);
    const target = current.length;
    // Pad the old object to the size of the new one (bytes between its index and its footer), then solve four
    // key_id bytes so its footer CRC32C is the new object's.
    const { indexOffset, indexLength } = layoutOf(old);
    const wantCrc = layoutOf(current).footer.getUint32(FOOTER.footerCrc32c, true);
    const padded = new Uint8Array(target);
    padded.set(old.subarray(0, indexOffset + indexLength), 0);
    padded.set(old.subarray(old.length - FOOTER_BYTES), target - FOOTER_BYTES);
    const footerStart = target - FOOTER_BYTES;
    padded.set(
      forgeCrc(
        padded.subarray(footerStart, footerStart + FOOTER_CRC_COVERAGE),
        FOOTER.keyId,
        wantCrc,
      ),
      footerStart,
    );
    new DataView(padded.buffer).setUint32(footerStart + FOOTER.footerCrc32c, wantCrc, true);
    const sameSizeTarget = wantCrc;
    const fingerprint = fingerprintFor(padded.length, sameSizeTarget);
    // The attack's premise: the forged object's fingerprint is the one a pin or a receipt holds.
    expect(fingerprint).toBe(fingerprintFor(current.length, wantCrc));
    await expect(
      CrbmReader.sameObject(new BufferReader(padded), fingerprint),
    ).rejects.toBeInstanceOf(IntegrityError);
    await expect(open(padded, crypto)).rejects.toBeInstanceOf(IntegrityError);
    // The genuine object is still the same object as itself.
    expect(
      await CrbmReader.sameObject(
        new BufferReader(current),
        fingerprintFor(current.length, wantCrc),
      ),
    ).toBe(true);
  });
});

describe('what an encrypted footer leaves free', () => {
  it('is versionMinor, the generation (which an open through the engine holds to the key) and the extension flag as the padding of an unknown section', async () => {
    const bytes = await encrypted();
    const crypto = cryptoFor(dek);
    // Each footer field the CRC covers, flipped at its first and its last bit with the CRC computed again. The tail
    // read is a footer's worth, so the preamble (which repeats versionMinor) is not read, as for a large object.
    const accepted = new Set<number>();
    for (let at = 0; at < FOOTER_CRC_COVERAGE; at++) {
      for (const bit of [0, 7]) {
        const forged = refooted(bytes, (f) => (f[at]! ^= 1 << bit));
        const opened = await CrbmReader.open(new BufferReader(forged), {
          crypto,
          tailBytes: FOOTER_BYTES,
        }).then(
          () => true,
          () => false,
        );
        if (opened) accepted.add(at);
      }
    }
    // Byte 39, the top of the generation, is refused: 2^56 is not a safe integer.
    expect([...accepted]).toEqual([FOOTER.versionMinor, ...range(FOOTER.generation, 7)]);

    // The one remaining way to reach a size: a block of an unknown section type, which also sets the flag.
    const padded = spliceBlock(bytes, extensionBlock(section(2, new Uint8Array(40))));
    expect((await open(padded, crypto)).chunkKeys()).toEqual([0, 9]);
    expect(padded.length - bytes.length).toBe(5 + 40 + 12);
  });
});

const range = (from: number, count: number): number[] =>
  Array.from({ length: count }, (_, i) => from + i);
