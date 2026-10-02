import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CrbmWriter } from '@/core/crbm/writer';
import { CrbmReader } from '@/core/crbm/reader';
import { BufferSink, BufferReader } from '@/core/blob';
import { crc32c } from '@/core/crbm/crc32c';
import { FOOTER, FOOTER_BYTES, FOOTER_CRC_COVERAGE } from '@/core/crbm/format';
import { aadFor } from '@/core/crypto';
import type { CrbmCrypto } from '@/core/crypto';
import { ValidationError } from '@/core/errors';
import { NodeAead } from '@/drivers/crypto';
import { CounterNonceAead, layoutOf, writeCrbm } from '../../helpers/crbm-v1_1';

/**
 * Golden-file corpus. `tests/golden/v1.0-basic.crbm` pins the exact v1.0 byte layout
 * forever — it's the artifact future language ports decode against. If this test fails after a
 * code change, the on-disk format changed: that is a breaking change requiring a new format version,
 * not a golden-file update. The two `v1.1-*` files pin format 1.1, the extension block that carries a
 * generation's metadata, in the clear and encrypted, the same way.
 */
const golden = (name: string): Uint8Array =>
  new Uint8Array(readFileSync(fileURLToPath(new URL(`../../golden/${name}`, import.meta.url))));
const GOLDEN_PATH = fileURLToPath(new URL('../../golden/v1.0-basic.crbm', import.meta.url));

// The exact inputs that produced the golden file.
const GENERATION = 7;
const CHUNKS = [
  { chunkKey: 0, payload: Uint8Array.of(0xde, 0xad, 0xbe, 0xef), cardinality: 3 },
  { chunkKey: 256, payload: Uint8Array.of(0x01, 0x02), cardinality: 1 },
  { chunkKey: 4096, payload: Uint8Array.of(0xff), cardinality: 2 },
];

describe('golden .crbm corpus', () => {
  it('the writer reproduces the golden bytes exactly', async () => {
    const sink = new BufferSink();
    const writer = new CrbmWriter(sink, { generation: GENERATION });
    for (const c of CHUNKS) await writer.addChunk(c.chunkKey, c.payload, c.cardinality);
    await writer.finish();

    const golden = new Uint8Array(readFileSync(GOLDEN_PATH));
    expect(Buffer.from(sink.bytes()).toString('hex')).toBe(Buffer.from(golden).toString('hex'));
  });

  it('the reader decodes the golden bytes to the original segment', async () => {
    const golden = new Uint8Array(readFileSync(GOLDEN_PATH));
    const reader = await CrbmReader.open(new BufferReader(golden));

    expect(reader.generation).toBe(GENERATION);
    expect(reader.chunkKeys()).toEqual([0, 256, 4096]);
    expect(reader.count()).toBe(6);
    for (const c of CHUNKS) {
      expect([...(await reader.getChunk(c.chunkKey))!]).toEqual([...c.payload]);
    }
  });

  it('a writer given no metadata, or the empty object, still writes the 1.0 golden bytes', async () => {
    const v10 = golden('v1.0-basic.crbm');
    expect(await writeCrbm(CHUNKS, { generation: GENERATION, metadata: undefined })).toEqual(v10);
    expect(await writeCrbm(CHUNKS, { generation: GENERATION, metadata: {} })).toEqual(v10);
  });
});

// The exact inputs that produced the two v1.1 golden files, beside the chunks above. Key order is deliberately
// not the canonical one, so the files also pin that the writer sorts.
const METADATA = { owner: 'campaigns', def: 'v41', landedAt: 1_790_000_000_000 };
const KEY = Uint8Array.from({ length: 32 }, (_v, i) => i);
const REF = { namespace: 'golden', segment: 'v1.1' };
const goldenCrypto = (aead: CrbmCrypto['aead']): CrbmCrypto => ({
  aead,
  aadFor: (scope) => aadFor(REF, GENERATION, scope),
});

describe('golden .crbm corpus, format 1.1', () => {
  it('the writer reproduces the cleartext 1.1 golden bytes exactly', async () => {
    const bytes = await writeCrbm(CHUNKS, { generation: GENERATION, metadata: METADATA });
    expect(Buffer.from(bytes).toString('hex')).toBe(
      Buffer.from(golden('v1.1-metadata.crbm')).toString('hex'),
    );
  });

  it('the reader decodes the cleartext 1.1 golden to the segment and its metadata', async () => {
    const reader = await CrbmReader.open(new BufferReader(golden('v1.1-metadata.crbm')));
    expect(reader.generation).toBe(GENERATION);
    expect(reader.chunkKeys()).toEqual([0, 256, 4096]);
    expect(reader.count()).toBe(6);
    expect(reader.metadata).toEqual(METADATA);
    for (const c of CHUNKS) {
      expect([...(await reader.getChunk(c.chunkKey))!]).toEqual([...c.payload]);
    }
  });

  it('1.1 is 1.0 plus the block: cut the block out, say minor 0, and the 1.0 golden comes back', () => {
    const v11 = golden('v1.1-metadata.crbm');
    const { indexOffset } = layoutOf(v11);
    const view = new DataView(v11.buffer, v11.byteOffset);
    const sectionsLength = view.getUint32(indexOffset - 12, true);
    const extStart = indexOffset - 12 - sectionsLength;
    const out = new Uint8Array(v11.length - (indexOffset - extStart));
    out.set(v11.subarray(0, extStart), 0);
    out.set(v11.subarray(indexOffset), extStart);
    out[5] = 0;
    const f = out.subarray(out.length - FOOTER_BYTES);
    const fview = new DataView(f.buffer, f.byteOffset, FOOTER_BYTES);
    fview.setBigUint64(FOOTER.indexOffset, BigInt(extStart), true);
    f[FOOTER.versionMinor] = 0;
    fview.setUint32(FOOTER.footerCrc32c, crc32c(f.subarray(0, FOOTER_CRC_COVERAGE)), true);
    expect(out).toEqual(golden('v1.0-basic.crbm'));
  });

  it('the writer reproduces the encrypted 1.1 golden bytes exactly, under a counter nonce', async () => {
    const bytes = await writeCrbm(CHUNKS, {
      generation: GENERATION,
      metadata: METADATA,
      crypto: goldenCrypto(new CounterNonceAead(KEY)),
    });
    expect(Buffer.from(bytes).toString('hex')).toBe(
      Buffer.from(golden('v1.1-metadata-encrypted.crbm')).toString('hex'),
    );
  });

  it('the reader decodes the encrypted 1.1 golden with the key, and the bytes hold no metadata in the clear', async () => {
    const bytes = golden('v1.1-metadata-encrypted.crbm');
    const reader = await CrbmReader.open(new BufferReader(bytes), {
      crypto: goldenCrypto(new NodeAead(KEY)),
    });
    expect(reader.chunkKeys()).toEqual([0, 256, 4096]);
    expect(reader.count()).toBe(6);
    expect(reader.metadata).toEqual(METADATA);
    for (const c of CHUNKS) {
      expect([...(await reader.getChunk(c.chunkKey))!]).toEqual([...c.payload]);
    }
    for (const plain of ['campaigns', 'landedAt', 'v41']) {
      expect(Buffer.from(bytes).includes(Buffer.from(plain))).toBe(false);
    }
    await expect(CrbmReader.open(new BufferReader(bytes))).rejects.toBeInstanceOf(ValidationError);
  });
});
