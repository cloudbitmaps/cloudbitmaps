import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CrbmWriter } from '@/core/crbm/writer';
import { CrbmReader } from '@/core/crbm/reader';
import { BufferSink, BufferReader } from '@/core/blob';
import { crc32c } from '@/core/crbm/crc32c';
import { FLAG_EXTENSION, FOOTER, FOOTER_BYTES, FOOTER_CRC_COVERAGE } from '@/core/crbm/format';
import { aadFor } from '@/core/crypto';
import type { CrbmCrypto } from '@/core/crypto';
import { ValidationError } from '@/core/errors';
import { NodeAead } from '@/drivers/crypto';
import { CounterNonceAead, layoutOf, writeCrbm } from '../../helpers/crbm-extension';
import { GOLDEN_NONCE, fixedEntropy, zeroEntropy } from '../../helpers/entropy';

/**
 * Golden-file corpus. `tests/golden/v1.0-basic.crbm` pins the exact v1.0 byte layout
 * forever — it's the artifact future language ports decode against. If this test fails after a
 * code change, the on-disk format changed: that is a breaking change requiring a new format version,
 * not a golden-file update. Every object in the corpus is as it was written, with the footer's write-identity field all
 * zero, which a writer drawing zero entropy reproduces; the `-write-identity` files beside them carry a fixed identity. The two `v1.0-metadata*` files pin the extension block that carries a generation's
 * metadata, flagged in the footer, in the clear and encrypted, the same way.
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
    const writer = new CrbmWriter(sink, { entropy: zeroEntropy, generation: GENERATION });
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
    expect(
      await writeCrbm(CHUNKS, {
        generation: GENERATION,
        metadata: undefined,
        entropy: zeroEntropy,
      }),
    ).toEqual(v10);
    expect(
      await writeCrbm(CHUNKS, {
        generation: GENERATION,
        metadata: {},
        entropy: zeroEntropy,
      }),
    ).toEqual(v10);
  });
});

// The exact inputs that produced the two metadata golden files, beside the chunks above. Key order is deliberately
// not the canonical one, so the files also pin that the writer sorts.
const METADATA = { owner: 'campaigns', def: 'v41', landedAt: 1_790_000_000_000 };
const KEY = Uint8Array.from({ length: 32 }, (_v, i) => i);
const REF = { namespace: 'golden', segment: 'metadata' };
const goldenCrypto = (aead: CrbmCrypto['aead']): CrbmCrypto => ({
  aead,
  aadFor: (scope) => aadFor(REF, GENERATION, scope),
});

describe('golden .crbm corpus, with the extension block', () => {
  it('the writer reproduces the cleartext metadata golden bytes exactly', async () => {
    const bytes = await writeCrbm(CHUNKS, {
      generation: GENERATION,
      metadata: METADATA,
      entropy: zeroEntropy,
    });
    expect(Buffer.from(bytes).toString('hex')).toBe(
      Buffer.from(golden('v1.0-metadata.crbm')).toString('hex'),
    );
  });

  it('the reader decodes the cleartext metadata golden to the segment and its metadata', async () => {
    const reader = await CrbmReader.open(new BufferReader(golden('v1.0-metadata.crbm')));
    expect(reader.generation).toBe(GENERATION);
    expect(reader.chunkKeys()).toEqual([0, 256, 4096]);
    expect(reader.count()).toBe(6);
    expect(reader.metadata).toEqual(METADATA);
    for (const c of CHUNKS) {
      expect([...(await reader.getChunk(c.chunkKey))!]).toEqual([...c.payload]);
    }
  });

  it('an object with metadata is the plain one plus the block: cut the block out, clear the flag, and the plain golden comes back', () => {
    const withBlock = golden('v1.0-metadata.crbm');
    const { indexOffset } = layoutOf(withBlock);
    const view = new DataView(withBlock.buffer, withBlock.byteOffset);
    const sectionsLength = view.getUint32(indexOffset - 12, true);
    const extStart = indexOffset - 12 - sectionsLength;
    const out = new Uint8Array(withBlock.length - (indexOffset - extStart));
    out.set(withBlock.subarray(0, extStart), 0);
    out.set(withBlock.subarray(indexOffset), extStart);
    const f = out.subarray(out.length - FOOTER_BYTES);
    const fview = new DataView(f.buffer, f.byteOffset, FOOTER_BYTES);
    fview.setBigUint64(FOOTER.indexOffset, BigInt(extStart), true);
    fview.setUint32(FOOTER.flags, fview.getUint32(FOOTER.flags, true) & ~FLAG_EXTENSION, true);
    fview.setUint32(FOOTER.footerCrc32c, crc32c(f.subarray(0, FOOTER_CRC_COVERAGE)), true);
    expect(out).toEqual(golden('v1.0-basic.crbm'));
  });

  it('the writer reproduces the encrypted metadata golden bytes exactly, under a counter nonce', async () => {
    const bytes = await writeCrbm(CHUNKS, {
      generation: GENERATION,
      metadata: METADATA,
      crypto: goldenCrypto(new CounterNonceAead(KEY)),
    });
    expect(Buffer.from(bytes).toString('hex')).toBe(
      Buffer.from(golden('v1.0-metadata-encrypted.crbm')).toString('hex'),
    );
  });

  it('the reader decodes the encrypted metadata golden with the key, and the bytes hold no metadata in the clear', async () => {
    const bytes = golden('v1.0-metadata-encrypted.crbm');
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

/**
 * A cleartext generation's footer `indexNonce` is its write identity, drawn per write. The corpus objects above carry an
 * all-zero field, which a reader takes like any other. Each `-write-identity` file is its original with the fixed
 * identity in that field and the footer checksum that covers it recomputed, and nothing else.
 */
const withIdentity = (original: Uint8Array): Uint8Array => {
  const out = Uint8Array.from(original);
  const f = out.subarray(out.length - FOOTER_BYTES);
  f.set(GOLDEN_NONCE, FOOTER.indexNonce);
  new DataView(f.buffer, f.byteOffset, FOOTER_BYTES).setUint32(
    FOOTER.footerCrc32c,
    crc32c(f.subarray(0, FOOTER_CRC_COVERAGE)),
    true,
  );
  return out;
};
const slot = (bytes: Uint8Array): Uint8Array => {
  const at = bytes.length - FOOTER_BYTES + FOOTER.indexNonce;
  return bytes.subarray(at, at + 12);
};

describe('golden .crbm corpus, the write identity in the footer', () => {
  it.each([
    ['v1.0-basic', undefined],
    ['v1.0-metadata', METADATA],
  ])(
    '%s: a fixed-entropy writer reproduces the write-identity file, which is the original plus the field',
    async (name, metadata) => {
      const original = golden(`${name}.crbm`);
      const identity = golden(`${name}-write-identity.crbm`);
      expect([...slot(original)]).toEqual(new Array(12).fill(0));
      expect([...slot(identity)]).toEqual([...GOLDEN_NONCE]);
      expect(identity).toEqual(withIdentity(original));
      expect(
        await writeCrbm(CHUNKS, {
          generation: GENERATION,
          metadata,
          entropy: fixedEntropy(GOLDEN_NONCE),
        }),
      ).toEqual(identity);
    },
  );

  it('v1.0-load: the write-identity file is the original plus the field', () => {
    expect(golden('v1.0-load-write-identity.crbm')).toEqual(withIdentity(golden('v1.0-load.crbm')));
  });

  it('the reader accepts both, and the identity is in the fingerprint', async () => {
    for (const name of ['v1.0-basic', 'v1.0-metadata', 'v1.0-load']) {
      const a = await CrbmReader.open(new BufferReader(golden(`${name}.crbm`)));
      const b = await CrbmReader.open(new BufferReader(golden(`${name}-write-identity.crbm`)));
      expect(b.count()).toBe(a.count());
      expect(b.chunkKeys()).toEqual(a.chunkKeys());
      expect(b.fingerprint).not.toBe(a.fingerprint);
      expect(b.fingerprint.split(':')[0]).toBe(a.fingerprint.split(':')[0]);
    }
  });

  it('the basic original keeps the fingerprint it always had', async () => {
    const reader = await CrbmReader.open(new BufferReader(golden('v1.0-basic.crbm')));
    expect(reader.fingerprint).toBe('145:3558123930');
  });

  it('a reader takes a cleartext object whatever its nonce holds', async () => {
    for (const fill of [0x00, 0xff, 0x5a]) {
      const bytes = await writeCrbm(CHUNKS, {
        generation: GENERATION,
        entropy: fixedEntropy(new Uint8Array(12).fill(fill)),
      });
      expect((await CrbmReader.open(new BufferReader(bytes))).count()).toBe(6);
    }
  });
});
