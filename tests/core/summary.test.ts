import { randomBytes } from 'node:crypto';
import { aadFor } from '@/core/crypto';
import type { Aead } from '@/core/crypto';
import { IntegrityError } from '@/core/errors';
import type { RegistryRecord, SealedRegistrySummary } from '@/core/ports';
import {
  MAX_TAIL_BYTES,
  clearSummary,
  metadataToCarry,
  openSummary,
  ownSummary,
  sealSummary,
  summaryAgrees,
  summaryOf,
  usableSummary,
} from '@/core/summary';
import { InProcessKeystore } from '@/drivers/crypto';

/**
 * The summary a row carries for its current generation: how it is sealed on an encrypted segment, what a reader may
 * use of it, and how it is held against the object it describes.
 */

const REF = { namespace: 'ns', segment: 'seg' };
/** The fingerprint of the object a summary describes: its size and footer checksum. */
const FP = '4096:7';
/** The bytes of the object's end one open reads. */
const TAIL = 300;

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
  pointerId: 't',
  ...over,
});

describe('a clear summary', () => {
  it('names the generation, the count and the metadata', () => {
    expect(clearSummary(4, 10, FP, TAIL, { a: 'x' })).toEqual({
      generation: 4,
      cardinality: 10,
      fingerprint: FP,
      tailBytes: TAIL,
      metadata: { a: 'x' },
    });
  });

  it('carries no metadata key when there is none, or when it is empty', () => {
    const bare = { generation: 4, cardinality: 10, fingerprint: FP, tailBytes: TAIL };
    expect(clearSummary(4, 10, FP, TAIL)).toStrictEqual(bare);
    expect(clearSummary(4, 10, FP, TAIL, {})).toStrictEqual(bare);
  });
});

describe('a sealed summary', () => {
  it('opens to the count and the metadata it was sealed with', async () => {
    const aead = await aeadOf();
    const sealed = sealSummary(aead, REF, 4, 123_456, FP, TAIL, { run: 'r1', n: 7 });
    expect(sealed.generation).toBe(4);
    expect(openSummary(aead, REF, sealed)).toEqual({
      cardinality: 123_456,
      fingerprint: FP,
      tailBytes: TAIL,
      metadata: { n: 7, run: 'r1' },
    });
  });

  it('opens to no metadata when it was sealed with none, or with the empty record', async () => {
    const aead = await aeadOf();
    expect(openSummary(aead, REF, sealSummary(aead, REF, 0, 0, FP, TAIL)).metadata).toBeUndefined();
    expect(
      openSummary(aead, REF, sealSummary(aead, REF, 0, 9, FP, TAIL, {})).metadata,
    ).toBeUndefined();
    expect(openSummary(aead, REF, sealSummary(aead, REF, 0, 2 ** 32, FP, TAIL)).cardinality).toBe(
      2 ** 32,
    );
  });

  it('is the same size for any count, so its length does not give the count away', async () => {
    const aead = await aeadOf();
    const sizes = new Set(
      [0, 9, 10, 99_999, 4_000_000_000, 2 ** 32].map(
        (n) => bytesOf(sealSummary(aead, REF, 4, n, FP, TAIL, { a: 'x' }).sealed).length,
      ),
    );
    expect(sizes.size).toBe(1);
    // A nonce, the count (u64), the fingerprint (a u64 size and a u32 checksum), the tail size (u32), the metadata's 9
    // bytes and a tag.
    expect([...sizes][0]).toBe(12 + 8 + 8 + 4 + 4 + '{"a":"x"}'.length + 16);
  });

  it('is the same size for any tail size, and holds it only sealed', async () => {
    const aead = await aeadOf();
    const sizes = new Set(
      [104, 300, 70_000, MAX_TAIL_BYTES].map(
        (n) => bytesOf(sealSummary(aead, REF, 4, 5, '20000000:7', n).sealed).length,
      ),
    );
    expect(sizes.size).toBe(1);
    // 0x0a0b0c0d little-endian is 0d 0c 0b 0a, and no run of it is in the sealed bytes.
    const framed = bytesOf(
      sealSummary(aead, REF, 4, 5, '20000000:7', 0x0a0b0c0d % MAX_TAIL_BYTES).sealed,
    );
    expect(contains(framed, new Uint8Array([0x0a, 0x0b, 0x0c, 0x0d]))).toBe(false);
  });

  it('holds neither the count, the size nor the metadata in the clear', async () => {
    const aead = await aeadOf();
    const metadata = { owner: 'a-very-recognisable-owner-name' };
    const sealed = sealSummary(
      aead,
      REF,
      4,
      0x01020304,
      `${0x0a0b0c0d}:${0x05060708}`,
      0x0e0f1011 % MAX_TAIL_BYTES,
      metadata,
    );
    const framed = bytesOf(sealed.sealed);
    expect(contains(framed, new Uint8Array([0x0d, 0x0c, 0x0b, 0x0a, 0, 0, 0, 0]))).toBe(false);
    expect(contains(framed, new Uint8Array([8, 7, 6, 5]))).toBe(false);
    expect(JSON.stringify(sealed)).not.toContain(String(0x0a0b0c0d));
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
    const sealed = sealSummary(aead, REF, 4, 2 ** 32, FP, TAIL, metadata);
    expect(bytesOf(sealed.sealed).length).toBe(12 + 24 + 1_024 + 16);
    expect(openSummary(aead, REF, sealed)).toEqual({
      cardinality: 2 ** 32,
      fingerprint: FP,
      tailBytes: TAIL,
      metadata,
    });
    const bare = sealSummary(aead, REF, 4, 0, FP, TAIL);
    expect(bytesOf(bare.sealed).length).toBe(12 + 24 + 16);
    expect(openSummary(aead, REF, bare)).toEqual({
      cardinality: 0,
      fingerprint: FP,
      tailBytes: TAIL,
      metadata: undefined,
    });
    // The largest size an object can have, the largest checksum, and the most and least a tail can be.
    const largest = `${Number.MAX_SAFE_INTEGER}:${0xffff_ffff}`;
    expect(
      openSummary(aead, REF, sealSummary(aead, REF, 4, 0, largest, MAX_TAIL_BYTES)),
    ).toMatchObject({ fingerprint: largest, tailBytes: MAX_TAIL_BYTES });
    expect(openSummary(aead, REF, sealSummary(aead, REF, 4, 0, '112:7', 104)).tailBytes).toBe(104);
  });

  it('seals under a fresh nonce each time', async () => {
    const aead = await aeadOf();
    expect(sealSummary(aead, REF, 4, 5, FP, TAIL).sealed).not.toBe(
      sealSummary(aead, REF, 4, 5, FP, TAIL).sealed,
    );
  });

  it('does not open moved onto another generation, another segment or another namespace', async () => {
    const aead = await aeadOf();
    const sealed = sealSummary(aead, REF, 4, 5, FP, TAIL, { a: 'x' });
    // The summary names a generation, and its blob is bound to the one it was sealed for.
    expect(() => openSummary(aead, REF, { generation: 5, sealed: sealed.sealed })).toThrow(
      IntegrityError,
    );
    expect(() => openSummary(aead, { ...REF, segment: 'other' }, sealed)).toThrow(IntegrityError);
    expect(() => openSummary(aead, { ...REF, namespace: 'other' }, sealed)).toThrow(IntegrityError);
    expect(() => openSummary(aead, { segment: 'seg' }, sealed)).toThrow(IntegrityError);
  });

  it('does not open under another key', async () => {
    const sealed = sealSummary(await aeadOf(), REF, 4, 5, FP, TAIL);
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
    const { generation, sealed } = sealSummary(aead, REF, 4, 5, FP, TAIL, { a: 'x' });
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
    /** The count, then a fingerprint of `size` and a checksum of 7, then the tail size. */
    const count = (n: bigint, size = 4096n, tail = TAIL): Uint8Array => {
      const b = new Uint8Array(24);
      const view = new DataView(b.buffer);
      view.setBigUint64(0, n, true);
      view.setBigUint64(8, size, true);
      view.setUint32(16, 7, true);
      view.setUint32(20, tail, true);
      return b;
    };
    expect(() => openSummary(aead, REF, sealRaw(count(2n ** 32n + 1n)))).toThrow(IntegrityError);
    expect(() => openSummary(aead, REF, sealRaw(count(2n ** 64n - 1n)))).toThrow(IntegrityError);
    // A size no object can have: smaller than a preamble and a footer, or past 2^53.
    for (const size of [0n, 111n, 2n ** 53n, 2n ** 64n - 1n]) {
      expect(() => openSummary(aead, REF, sealRaw(count(1n, size))), String(size)).toThrow(
        IntegrityError,
      );
    }
    expect(openSummary(aead, REF, sealRaw(count(1n, 112n, 104))).fingerprint).toBe('112:7');
    // A tail size no object of that size can have: under a footer, past the size less a preamble, past the cap a reader
    // fetches for one open, or past 2^32 - 1 as a u32 reads it.
    for (const [size, tail] of [
      [4096n, 0],
      [4096n, 103],
      [4096n, 4089],
      [4096n, 0xffff_ffff],
      [20_000_000n, MAX_TAIL_BYTES + 1],
    ] as const) {
      expect(
        () => openSummary(aead, REF, sealRaw(count(1n, size, tail))),
        `${size} ${tail}`,
      ).toThrow(IntegrityError);
    }
    // And the bounds themselves are legal: a footer's worth, the size less the preamble, and the cap.
    expect(openSummary(aead, REF, sealRaw(count(1n, 4096n, 104))).tailBytes).toBe(104);
    expect(openSummary(aead, REF, sealRaw(count(1n, 4096n, 4088))).tailBytes).toBe(4088);
    expect(openSummary(aead, REF, sealRaw(count(1n, 20_000_000n, MAX_TAIL_BYTES))).tailBytes).toBe(
      MAX_TAIL_BYTES,
    );
    const withMeta = (text: string): Uint8Array =>
      new Uint8Array([...count(1n), ...new TextEncoder().encode(text)]);
    for (const text of ['{ "a": "x" }', '{"b":1,"a":2}', '[1]', '{}', 'nope']) {
      expect(() => openSummary(aead, REF, sealRaw(withMeta(text)))).toThrow(IntegrityError);
    }
    expect(openSummary(aead, REF, sealRaw(withMeta('{"a":"x"}')))).toEqual({
      cardinality: 1,
      fingerprint: FP,
      tailBytes: TAIL,
      metadata: { a: 'x' },
    });
    // Fewer bytes than a count, a fingerprint and a tail size.
    for (const n of [7, 8, 19, 20, 23]) {
      expect(() => openSummary(aead, REF, sealRaw(new Uint8Array(n)))).toThrow(IntegrityError);
    }
  });
});

describe('what a row lets a reader use of its summary', () => {
  it('is the clear count and metadata, for the generation the row names', () => {
    const r = row({
      summary: {
        generation: 4,
        cardinality: 9,
        fingerprint: FP,
        tailBytes: TAIL,
        metadata: { a: 'x' },
      },
    });
    expect(usableSummary(REF, r, undefined)).toEqual({
      cardinality: 9,
      fingerprint: FP,
      tailBytes: TAIL,
      metadata: { a: 'x' },
    });
    const bare = row({
      summary: { generation: 4, cardinality: 0, fingerprint: FP, tailBytes: TAIL },
    });
    expect(usableSummary(REF, bare, undefined)).toEqual({
      cardinality: 0,
      fingerprint: FP,
      tailBytes: TAIL,
      metadata: undefined,
    });
  });

  it('is nothing when the row has no summary, or its summary names another generation', () => {
    expect(usableSummary(REF, row({}), undefined)).toBeUndefined();
    expect(
      usableSummary(
        REF,
        row({ summary: { generation: 3, cardinality: 9, fingerprint: FP, tailBytes: TAIL } }),
        undefined,
      ),
    ).toBeUndefined();
    expect(
      usableSummary(
        REF,
        row({
          currentGen: null,
          summary: { generation: 4, cardinality: 9, fingerprint: FP, tailBytes: TAIL },
        }),
        undefined,
      ),
    ).toBeUndefined();
  });

  it('is nothing on a destroyed row', () => {
    const r = row({
      status: 'destroyed',
      summary: { generation: 4, cardinality: 9, fingerprint: FP, tailBytes: TAIL },
    });
    expect(usableSummary(REF, r, undefined)).toBeUndefined();
  });

  it('is nothing in the clear beside wrapped keys, or sealed on a row with none', async () => {
    const aead = await aeadOf();
    const wrappedDeks = [{ keyId: 'k1', wrapped: 'AAAA' }];
    const clear = row({
      wrappedDeks,
      summary: { generation: 4, cardinality: 9, fingerprint: FP, tailBytes: TAIL },
    });
    expect(usableSummary(REF, clear, aead)).toBeUndefined();
    const sealedOnCleartext = row({ summary: sealSummary(aead, REF, 4, 9, FP, TAIL) });
    expect(usableSummary(REF, sealedOnCleartext, aead)).toBeUndefined();
  });

  it('opens a sealed summary with the key, and uses nothing without it', async () => {
    const aead = await aeadOf();
    const wrappedDeks = [{ keyId: 'k1', wrapped: 'AAAA' }];
    const r = row({ wrappedDeks, summary: sealSummary(aead, REF, 4, 9, FP, TAIL, { a: 'x' }) });
    expect(usableSummary(REF, r, aead)).toEqual({
      cardinality: 9,
      fingerprint: FP,
      tailBytes: TAIL,
      metadata: { a: 'x' },
    });
    expect(usableSummary(REF, r, undefined)).toBeUndefined();
  });

  it('is nothing from a sealed summary that does not open, rather than a failure', async () => {
    const aead = await aeadOf();
    const wrappedDeks = [{ keyId: 'k1', wrapped: 'AAAA' }];
    // Sealed for generation 3, but the row says it describes generation 4.
    const moved = row({
      wrappedDeks,
      summary: { generation: 4, sealed: sealSummary(aead, REF, 3, 9, FP, TAIL).sealed },
    });
    expect(usableSummary(REF, moved, aead)).toBeUndefined();
    // Another key.
    const other = row({ wrappedDeks, summary: sealSummary(aead, REF, 4, 9, FP, TAIL) });
    expect(usableSummary(REF, other, await aeadOf())).toBeUndefined();
  });

  // A shipped registry refuses such a row when it reads it; a registry of your own may hand one over. A clear summary
  // whose fingerprint names no object is not used, as a sealed one that does not open is not, rather than reaching a
  // read that compares it with the object's.
  it('is nothing from a clear summary whose fingerprint names no object, rather than a failure', () => {
    for (const fingerprint of [5, '', '7', '0:1', '4096:4294967296', undefined]) {
      const r = row({
        summary: {
          generation: 4,
          cardinality: 9,
          fingerprint,
        } as unknown as RegistryRecord['summary'],
      });
      expect(usableSummary(REF, r, undefined), String(fingerprint)).toBeUndefined();
    }
  });

  // The same rule for the tail size: a clear summary whose `tailBytes` no object of its size can have is not used.
  it('is nothing from a clear summary whose tailBytes no object of its size can have, rather than a failure', () => {
    for (const tailBytes of [
      undefined,
      103,
      4089,
      4096,
      1.5,
      -1,
      '300',
      null,
      MAX_TAIL_BYTES + 1,
    ]) {
      const r = row({
        summary: {
          generation: 4,
          cardinality: 9,
          fingerprint: FP,
          tailBytes,
        } as unknown as RegistryRecord['summary'],
      });
      expect(usableSummary(REF, r, undefined), String(tailBytes)).toBeUndefined();
    }
    for (const tailBytes of [104, 4088]) {
      const r = row({ summary: { generation: 4, cardinality: 9, fingerprint: FP, tailBytes } });
      expect(usableSummary(REF, r, undefined), String(tailBytes)).toMatchObject({ tailBytes });
    }
  });

  it('lets a failure that is not an integrity fault through', async () => {
    const aead = await aeadOf();
    const wrappedDeks = [{ keyId: 'k1', wrapped: 'AAAA' }];
    const r = row({ wrappedDeks, summary: sealSummary(aead, REF, 4, 9, FP, TAIL) });
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

describe('the summary of an object a writer wrote or a rollback opened', () => {
  const description = (tailBytes: number) => ({
    cardinality: 9,
    fingerprint: '20000000:7',
    tailBytes,
    metadata: { a: 'x' },
  });

  it('is clear on a cleartext segment and sealed on an encrypted one, with the same tail size', async () => {
    expect(summaryOf(REF, 4, description(300), undefined)).toEqual({
      generation: 4,
      cardinality: 9,
      fingerprint: '20000000:7',
      tailBytes: 300,
      metadata: { a: 'x' },
    });
    const aead = await aeadOf();
    const sealed = summaryOf(REF, 4, description(300), aead) as SealedRegistrySummary;
    expect(openSummary(aead, REF, sealed)).toMatchObject({ tailBytes: 300, cardinality: 9 });
  });

  // A reader accepts bytes between an object's index and its footer, so an object this library did not write can report
  // a tail the registry would refuse to record; the row is then legal without a summary.
  it('is no summary when the tail is above the most a summary records, clear or sealed, and one at the cap is recorded', async () => {
    const aead = await aeadOf();
    expect(summaryOf(REF, 4, description(MAX_TAIL_BYTES + 1), undefined)).toBeUndefined();
    expect(summaryOf(REF, 4, description(MAX_TAIL_BYTES + 1), aead)).toBeUndefined();
    expect(summaryOf(REF, 4, description(9_437_312), aead)).toBeUndefined();
    expect(summaryOf(REF, 4, description(MAX_TAIL_BYTES), undefined)).toMatchObject({
      tailBytes: MAX_TAIL_BYTES,
    });
    expect(summaryOf(REF, 4, description(MAX_TAIL_BYTES), aead)).toBeDefined();
  });

  it('is built by ownSummary for an object this library wrote, which refuses a tail it cannot have written', async () => {
    expect(ownSummary(REF, 4, description(300), undefined)).toMatchObject({ tailBytes: 300 });
    expect(() => ownSummary(REF, 4, description(MAX_TAIL_BYTES + 1), undefined)).toThrow(
      IntegrityError,
    );
  });

  it('records the cap the reader fetches for one open: an index, an extension block with its trailer, and a footer', () => {
    expect(MAX_TAIL_BYTES).toBe(8 * 1024 * 1024 + 4 * 1024 + 12 + 104);
    expect(MAX_TAIL_BYTES).toBe(8_392_820);
  });
});
