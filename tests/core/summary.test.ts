import { randomBytes } from 'node:crypto';
import { aadFor } from '@/core/crypto';
import type { Aead } from '@/core/crypto';
import { IntegrityError } from '@/core/errors';
import type { RegistryRecord, SealedRegistrySummary } from '@/core/ports';
import {
  clearSummary,
  metadataToCarry,
  openSummary,
  sealSummary,
  summaryAgrees,
  usableSummary,
} from '@/core/summary';
import { InProcessKeystore } from '@/drivers/crypto';

/**
 * The summary a row carries for its current generation: how it is sealed on an encrypted segment, what a reader may
 * use of it, and how it is held against the object it describes.
 */

const REF = { namespace: 'ns', segment: 'seg' };

async function aeadOf(): Promise<Aead> {
  const keystore = new InProcessKeystore({ keys: { k1: randomBytes(32) }, activeKeyId: 'k1' });
  return (await keystore.createDek()).aead;
}

const bytesOf = (sealed: string): Uint8Array => new Uint8Array(Buffer.from(sealed, 'base64'));

/** Whether `needle` occurs in `hay`. */
function contains(hay: Uint8Array, needle: Uint8Array): boolean {
  for (let i = 0; i + needle.length <= hay.length; i++) {
    if (needle.every((b, j) => hay[i + j] === b)) return true;
  }
  return false;
}

const row = (over: Partial<RegistryRecord>): RegistryRecord => ({
  namespace: 'ns',
  segment: 'seg',
  currentGen: 4,
  status: 'active',
  createdAt: 1,
  updatedAt: 1,
  token: 't',
  ...over,
});

describe('a clear summary', () => {
  it('names the generation, the count and the metadata', () => {
    expect(clearSummary(4, 10, { a: 'x' })).toEqual({
      generation: 4,
      cardinality: 10,
      metadata: { a: 'x' },
    });
  });

  it('carries no metadata key when there is none, or when it is empty', () => {
    expect(clearSummary(4, 10)).toStrictEqual({ generation: 4, cardinality: 10 });
    expect(clearSummary(4, 10, {})).toStrictEqual({ generation: 4, cardinality: 10 });
  });
});

describe('a sealed summary', () => {
  it('opens to the count and the metadata it was sealed with', async () => {
    const aead = await aeadOf();
    const sealed = sealSummary(aead, REF, 4, 123_456, { run: 'r1', n: 7 });
    expect(sealed.generation).toBe(4);
    expect(openSummary(aead, REF, sealed)).toEqual({
      cardinality: 123_456,
      metadata: { n: 7, run: 'r1' },
    });
  });

  it('opens to no metadata when it was sealed with none, or with the empty record', async () => {
    const aead = await aeadOf();
    expect(openSummary(aead, REF, sealSummary(aead, REF, 0, 0)).metadata).toBeUndefined();
    expect(openSummary(aead, REF, sealSummary(aead, REF, 0, 9, {})).metadata).toBeUndefined();
    expect(openSummary(aead, REF, sealSummary(aead, REF, 0, 2 ** 32)).cardinality).toBe(2 ** 32);
  });

  it('is the same size for any count, so its length does not give the count away', async () => {
    const aead = await aeadOf();
    const sizes = new Set(
      [0, 9, 10, 99_999, 4_000_000_000, 2 ** 32].map(
        (n) => bytesOf(sealSummary(aead, REF, 4, n, { a: 'x' }).sealed).length,
      ),
    );
    expect(sizes.size).toBe(1);
    // A nonce, a u64, the metadata's 9 bytes and a tag.
    expect([...sizes][0]).toBe(12 + 8 + '{"a":"x"}'.length + 16);
  });

  it('holds neither the count nor the metadata in the clear', async () => {
    const aead = await aeadOf();
    const metadata = { owner: 'a-very-recognisable-owner-name' };
    const sealed = sealSummary(aead, REF, 4, 0x01020304, metadata);
    const framed = bytesOf(sealed.sealed);
    expect(contains(framed, new TextEncoder().encode('a-very-recognisable-owner-name'))).toBe(
      false,
    );
    expect(contains(framed, new Uint8Array([4, 3, 2, 1, 0, 0, 0, 0]))).toBe(false);
    expect(contains(framed, new TextEncoder().encode(String(0x01020304)))).toBe(false);
    expect(JSON.stringify(sealed)).not.toContain('recognisable');
  });

  it('opens metadata of exactly the cap, and a count alone, the largest and smallest it can be', async () => {
    const aead = await aeadOf();
    const metadata = { k: 'x'.repeat(1_016) };
    const sealed = sealSummary(aead, REF, 4, 2 ** 32, metadata);
    expect(bytesOf(sealed.sealed).length).toBe(12 + 8 + 1_024 + 16);
    expect(openSummary(aead, REF, sealed)).toEqual({ cardinality: 2 ** 32, metadata });
    const bare = sealSummary(aead, REF, 4, 0);
    expect(bytesOf(bare.sealed).length).toBe(12 + 8 + 16);
    expect(openSummary(aead, REF, bare)).toEqual({ cardinality: 0, metadata: undefined });
  });

  it('seals under a fresh nonce each time', async () => {
    const aead = await aeadOf();
    expect(sealSummary(aead, REF, 4, 5).sealed).not.toBe(sealSummary(aead, REF, 4, 5).sealed);
  });

  it('does not open moved onto another generation, another segment or another namespace', async () => {
    const aead = await aeadOf();
    const sealed = sealSummary(aead, REF, 4, 5, { a: 'x' });
    // The summary names a generation, and its blob is bound to the one it was sealed for.
    expect(() => openSummary(aead, REF, { generation: 5, sealed: sealed.sealed })).toThrow(
      IntegrityError,
    );
    expect(() => openSummary(aead, { ...REF, segment: 'other' }, sealed)).toThrow(IntegrityError);
    expect(() => openSummary(aead, { ...REF, namespace: 'other' }, sealed)).toThrow(IntegrityError);
    expect(() => openSummary(aead, { segment: 'seg' }, sealed)).toThrow(IntegrityError);
  });

  it('does not open under another key', async () => {
    const sealed = sealSummary(await aeadOf(), REF, 4, 5);
    const other = await aeadOf();
    expect(() => openSummary(other, REF, sealed)).toThrow(IntegrityError);
  });

  it('is bound to its own scope: the other scopes of one generation name different associated data', () => {
    const scopes = ['summary', 'metadata', 'index', 0, 7] as const;
    const aads = new Set(scopes.map((s) => Buffer.from(aadFor(REF, 4, s)).toString('hex')));
    expect(aads.size).toBe(scopes.length);
  });

  it('refuses bytes that were changed, cut off, padded or are not base64', async () => {
    const aead = await aeadOf();
    const { generation, sealed } = sealSummary(aead, REF, 4, 5, { a: 'x' });
    const raw = bytesOf(sealed);
    const reseal = (b: Uint8Array): SealedRegistrySummary => ({
      generation,
      sealed: Buffer.from(b).toString('base64'),
    });
    for (const at of [0, 12, raw.length - 1]) {
      const flipped = raw.slice();
      flipped[at]! ^= 1;
      expect(() => openSummary(aead, REF, reseal(flipped))).toThrow(IntegrityError);
    }
    expect(() => openSummary(aead, REF, reseal(raw.subarray(0, 30)))).toThrow(IntegrityError);
    expect(() => openSummary(aead, REF, reseal(raw.subarray(0, raw.length - 1)))).toThrow(
      IntegrityError,
    );
    expect(() => openSummary(aead, REF, reseal(new Uint8Array([...raw, 0])))).toThrow(
      IntegrityError,
    );
    expect(() => openSummary(aead, REF, reseal(new Uint8Array(0)))).toThrow(IntegrityError);
    for (const text of [
      '!!!!',
      sealed.slice(1),
      `${sealed}=`,
      sealed.replace(/.$/, '*'),
      `-${sealed.slice(1)}`,
    ]) {
      expect(() => openSummary(aead, REF, { generation, sealed: text })).toThrow(IntegrityError);
    }
  });

  it('refuses a count past 2^32 and metadata that breaks the rules, even when it was sealed by the key', async () => {
    const aead = await aeadOf();
    const sealRaw = (plain: Uint8Array): SealedRegistrySummary => {
      const { nonce, ciphertext, tag } = aead.seal(plain, aadFor(REF, 4, 'summary'));
      return { generation: 4, sealed: Buffer.concat([nonce, ciphertext, tag]).toString('base64') };
    };
    const count = (n: bigint): Uint8Array => {
      const b = new Uint8Array(8);
      new DataView(b.buffer).setBigUint64(0, n, true);
      return b;
    };
    expect(() => openSummary(aead, REF, sealRaw(count(2n ** 32n + 1n)))).toThrow(IntegrityError);
    expect(() => openSummary(aead, REF, sealRaw(count(2n ** 64n - 1n)))).toThrow(IntegrityError);
    const withMeta = (text: string): Uint8Array =>
      new Uint8Array([...count(1n), ...new TextEncoder().encode(text)]);
    for (const text of ['{ "a": "x" }', '{"b":1,"a":2}', '[1]', '{}', 'nope']) {
      expect(() => openSummary(aead, REF, sealRaw(withMeta(text)))).toThrow(IntegrityError);
    }
    expect(openSummary(aead, REF, sealRaw(withMeta('{"a":"x"}')))).toEqual({
      cardinality: 1,
      metadata: { a: 'x' },
    });
    // Fewer bytes than a count.
    expect(() => openSummary(aead, REF, sealRaw(new Uint8Array(7)))).toThrow(IntegrityError);
  });
});

describe('what a row lets a reader use of its summary', () => {
  it('is the clear count and metadata, for the generation the row names', () => {
    const r = row({ summary: { generation: 4, cardinality: 9, metadata: { a: 'x' } } });
    expect(usableSummary(REF, r, undefined)).toEqual({ cardinality: 9, metadata: { a: 'x' } });
    const bare = row({ summary: { generation: 4, cardinality: 0 } });
    expect(usableSummary(REF, bare, undefined)).toEqual({ cardinality: 0, metadata: undefined });
  });

  it('is nothing when the row has no summary, or its summary names another generation', () => {
    expect(usableSummary(REF, row({}), undefined)).toBeUndefined();
    expect(
      usableSummary(REF, row({ summary: { generation: 3, cardinality: 9 } }), undefined),
    ).toBeUndefined();
    expect(
      usableSummary(
        REF,
        row({ currentGen: null, summary: { generation: 4, cardinality: 9 } }),
        undefined,
      ),
    ).toBeUndefined();
  });

  it('is nothing on a destroyed row', () => {
    const r = row({ status: 'destroyed', summary: { generation: 4, cardinality: 9 } });
    expect(usableSummary(REF, r, undefined)).toBeUndefined();
  });

  it('is nothing in the clear beside wrapped keys, or sealed on a row with none', async () => {
    const aead = await aeadOf();
    const wrappedDeks = [{ keyId: 'k1', wrapped: 'AAAA' }];
    const clear = row({ wrappedDeks, summary: { generation: 4, cardinality: 9 } });
    expect(usableSummary(REF, clear, aead)).toBeUndefined();
    const sealedOnCleartext = row({ summary: sealSummary(aead, REF, 4, 9) });
    expect(usableSummary(REF, sealedOnCleartext, aead)).toBeUndefined();
  });

  it('opens a sealed summary with the key, and uses nothing without it', async () => {
    const aead = await aeadOf();
    const wrappedDeks = [{ keyId: 'k1', wrapped: 'AAAA' }];
    const r = row({ wrappedDeks, summary: sealSummary(aead, REF, 4, 9, { a: 'x' }) });
    expect(usableSummary(REF, r, aead)).toEqual({ cardinality: 9, metadata: { a: 'x' } });
    expect(usableSummary(REF, r, undefined)).toBeUndefined();
  });

  it('is nothing from a sealed summary that does not open, rather than a failure', async () => {
    const aead = await aeadOf();
    const wrappedDeks = [{ keyId: 'k1', wrapped: 'AAAA' }];
    // Sealed for generation 3, but the row says it describes generation 4.
    const moved = row({
      wrappedDeks,
      summary: { generation: 4, sealed: sealSummary(aead, REF, 3, 9).sealed },
    });
    expect(usableSummary(REF, moved, aead)).toBeUndefined();
    // Another key.
    const other = row({ wrappedDeks, summary: sealSummary(aead, REF, 4, 9) });
    expect(usableSummary(REF, other, await aeadOf())).toBeUndefined();
  });

  it('lets a failure that is not an integrity fault through', async () => {
    const aead = await aeadOf();
    const wrappedDeks = [{ keyId: 'k1', wrapped: 'AAAA' }];
    const r = row({ wrappedDeks, summary: sealSummary(aead, REF, 4, 9) });
    const broken: Aead = {
      seal: aead.seal.bind(aead),
      open: () => {
        throw new RangeError('the key service is down');
      },
    };
    expect(() => usableSummary(REF, r, broken)).toThrow(RangeError);
  });
});

describe('a summary held against the object it describes', () => {
  it('agrees on the same count and the same metadata, whatever the key order', () => {
    expect(summaryAgrees({ cardinality: 5 }, { cardinality: 5 })).toBe(true);
    expect(
      summaryAgrees(
        { cardinality: 5, metadata: { a: 1, b: 'x' } },
        { cardinality: 5, metadata: { b: 'x', a: 1 } },
      ),
    ).toBe(true);
  });

  it('disagrees on a different count', () => {
    expect(summaryAgrees({ cardinality: 5 }, { cardinality: 6 })).toBe(false);
    expect(
      summaryAgrees({ cardinality: 6, metadata: { a: 1 } }, { cardinality: 5, metadata: { a: 1 } }),
    ).toBe(false);
  });

  it('disagrees on different metadata: a value, a key, a type', () => {
    const at = (metadata: Record<string, string | number>) => ({ cardinality: 5, metadata });
    expect(summaryAgrees(at({ a: 1 }), at({ a: 2 }))).toBe(false);
    expect(summaryAgrees(at({ a: 1 }), at({ b: 1 }))).toBe(false);
    expect(summaryAgrees(at({ a: 1 }), at({ a: '1' }))).toBe(false);
    expect(summaryAgrees(at({ a: 1 }), at({ a: 1, b: 2 }))).toBe(false);
  });

  it('disagrees when the object has none and the row has some, and the other way round', () => {
    // The first is what a stripped block looks like: the row's sealed copy says there was metadata.
    expect(summaryAgrees({ cardinality: 5, metadata: { a: 1 } }, { cardinality: 5 })).toBe(false);
    expect(summaryAgrees({ cardinality: 5 }, { cardinality: 5, metadata: { a: 1 } })).toBe(false);
  });

  it('takes the empty record for none', () => {
    expect(summaryAgrees({ cardinality: 5, metadata: {} }, { cardinality: 5 })).toBe(true);
    expect(summaryAgrees({ cardinality: 5 }, { cardinality: 5, metadata: {} })).toBe(true);
  });
});

describe('what an erasure carries into its rewrite', () => {
  const some = { def: 'v7', n: 3 };

  it("is the object's own metadata when it has any, whatever the summary says", () => {
    expect(metadataToCarry(some, undefined)).toEqual(some);
    expect(metadataToCarry(some, { cardinality: 5, metadata: { def: 'other' } })).toEqual(some);
    expect(metadataToCarry(some, { cardinality: 5 })).toEqual(some);
  });

  it("is the authenticated summary's when the object has none and the summary has some", () => {
    expect(metadataToCarry(undefined, { cardinality: 5, metadata: some })).toEqual(some);
    expect(metadataToCarry({}, { cardinality: 5, metadata: some })).toEqual(some);
  });

  it('is none when neither has any, or when there is no authenticated summary', () => {
    expect(metadataToCarry(undefined, undefined)).toBeUndefined();
    expect(metadataToCarry(undefined, { cardinality: 5 })).toBeUndefined();
    expect(metadataToCarry(undefined, { cardinality: 5, metadata: {} })).toBeUndefined();
    expect(metadataToCarry({}, undefined)).toEqual({});
  });
});
