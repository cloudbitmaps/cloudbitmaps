import { randomBytes } from 'node:crypto';
import { CrbmReader } from '@/core/crbm/reader';
import { CrbmWriter } from '@/core/crbm/writer';
import { BufferReader, BufferSink } from '@/core/blob';
import { aadFor } from '@/core/crypto';
import type { CrbmCrypto } from '@/core/crypto';
import { NodeAead } from '@/drivers/crypto';
import { crc32c } from '@/core/crbm/crc32c';
import { FOOTER, FOOTER_CRC_COVERAGE } from '@/core/crbm/format';
import { IntegrityError, UnsupportedError, ValidationError } from '@/core/errors';
import type { SegmentRef } from '@/index';

const SEG: SegmentRef = { segment: 'secrets' };
const GEN = 7;

/** A CrbmCrypto bound to a DEK + a (segment, generation) — what the cold-source bridge builds per object. */
function cryptoFor(dek: Uint8Array, generation = GEN, ref = SEG): CrbmCrypto {
  return { aead: new NodeAead(dek), aadFor: (scope) => aadFor(ref, generation, scope) };
}

const CHUNKS = [
  { chunkKey: 0, payload: randomBytes(64), cardinality: 10 },
  { chunkKey: 5, payload: randomBytes(200), cardinality: 42 },
  { chunkKey: 65_535, payload: randomBytes(33), cardinality: 1 },
];

async function writeEncrypted(crypto: CrbmCrypto): Promise<Uint8Array> {
  const sink = new BufferSink();
  const writer = new CrbmWriter(sink, { generation: GEN, crypto });
  for (const c of CHUNKS) await writer.addChunk(c.chunkKey, c.payload, c.cardinality);
  await writer.finish();
  return sink.bytes();
}

describe('CrbmWriter/CrbmReader — encryption (Phase 4e)', () => {
  it('round-trips an encrypted generation (chunks + index) with the right key', async () => {
    const dek = randomBytes(32);
    const bytes = await writeEncrypted(cryptoFor(dek));
    const reader = await CrbmReader.open(new BufferReader(bytes), { crypto: cryptoFor(dek) });

    expect(reader.chunkKeys()).toEqual([0, 5, 65_535]);
    expect(reader.count()).toBe(10 + 42 + 1); // derived from the decrypted index
    for (const c of CHUNKS) {
      const got = await reader.getChunk(c.chunkKey);
      expect(Buffer.from(got!)).toEqual(Buffer.from(c.payload));
    }
  });

  it('hides metadata on disk: plaintext absent, footer chunkCount + totalCardinality zeroed', async () => {
    const dek = randomBytes(32);
    const bytes = await writeEncrypted(cryptoFor(dek));

    // No plaintext payload leaks into the object.
    for (const c of CHUNKS) {
      expect(Buffer.from(bytes).includes(Buffer.from(c.payload))).toBe(false);
    }
    // Footer metadata is zeroed (a leaked object reveals neither chunk count nor cardinality).
    const footer = bytes.subarray(bytes.length - 104);
    const view = new DataView(footer.buffer, footer.byteOffset, footer.byteLength);
    expect(view.getUint32(FOOTER.chunkCount, true)).toBe(0);
    expect(view.getBigUint64(FOOTER.totalCardinality, true)).toBe(0n);
  });

  it('rejects opening an encrypted object without a key (ValidationError)', async () => {
    const bytes = await writeEncrypted(cryptoFor(randomBytes(32)));
    await expect(CrbmReader.open(new BufferReader(bytes))).rejects.toBeInstanceOf(ValidationError);
  });

  it('rejects the wrong key (index decrypt fails → IntegrityError, never a wrong parse)', async () => {
    const bytes = await writeEncrypted(cryptoFor(randomBytes(32)));
    await expect(
      CrbmReader.open(new BufferReader(bytes), { crypto: cryptoFor(randomBytes(32)) }),
    ).rejects.toBeInstanceOf(IntegrityError);
  });

  it('AAD binds to (segment, generation): right key but wrong generation context fails', async () => {
    const dek = randomBytes(32);
    const bytes = await writeEncrypted(cryptoFor(dek, GEN));
    await expect(
      CrbmReader.open(new BufferReader(bytes), { crypto: cryptoFor(dek, GEN + 1) }),
    ).rejects.toBeInstanceOf(IntegrityError);
    await expect(
      CrbmReader.open(new BufferReader(bytes), {
        crypto: cryptoFor(dek, GEN, { segment: 'other' }),
      }),
    ).rejects.toBeInstanceOf(IntegrityError);
  });

  it('detects a tampered chunk payload at read time (IntegrityError)', async () => {
    const dek = randomBytes(32);
    const bytes = await writeEncrypted(cryptoFor(dek));
    // Flip a byte inside the first chunk's payload region (just past the 8-byte preamble).
    bytes[12] = bytes[12]! ^ 0xff;
    const reader = await CrbmReader.open(new BufferReader(bytes), { crypto: cryptoFor(dek) });
    // CRC over the encrypted frame catches it (and AEAD would too) — never returns wrong plaintext.
    await expect(reader.getChunk(0)).rejects.toBeInstanceOf(IntegrityError);
  });

  it('rejects an unsupported format field on an ENCRYPTED object too — even with the right key (gap #6)', async () => {
    const dek = randomBytes(32);
    const bytes = await writeEncrypted(cryptoFor(dek));
    // element_width lives in the CLEARTEXT footer (readable without the key). Forge a 64-bit generation and
    // recompute the footer CRC it's covered by. The format-field guard runs BEFORE the index decrypt, so even
    // the correct key must yield UnsupportedError, never a mis-decode.
    const footer = bytes.subarray(bytes.length - 104);
    footer[FOOTER.elementWidth] = 64;
    const view = new DataView(footer.buffer, footer.byteOffset, footer.byteLength);
    view.setUint32(FOOTER.footerCrc32c, crc32c(footer.subarray(0, FOOTER_CRC_COVERAGE)), true);
    await expect(
      CrbmReader.open(new BufferReader(bytes), { crypto: cryptoFor(dek) }),
    ).rejects.toBeInstanceOf(UnsupportedError);
  });

  it('a cleartext object still opens with no crypto (encryption is opt-in)', async () => {
    const sink = new BufferSink();
    const writer = new CrbmWriter(sink, { generation: GEN });
    for (const c of CHUNKS) await writer.addChunk(c.chunkKey, c.payload, c.cardinality);
    await writer.finish();
    const reader = await CrbmReader.open(new BufferReader(sink.bytes()));
    expect(reader.count()).toBe(53);
    expect(Buffer.from((await reader.getChunk(5))!)).toEqual(Buffer.from(CHUNKS[1]!.payload));
  });
});
