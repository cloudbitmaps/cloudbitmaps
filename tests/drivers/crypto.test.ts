import { randomBytes } from 'node:crypto';
import { InProcessKeystore, NodeAead } from '@/drivers/crypto';
import { aadFor } from '@/core/crypto';
import { IntegrityError, KeyUnavailableError, ValidationError } from '@/core/errors';
import type { SegmentRef } from '@/index';

const key = (): Uint8Array => randomBytes(32);
const SEG: SegmentRef = { segment: 's' };

describe('NodeAead (AES-256-GCM)', () => {
  it('round-trips plaintext under the right key + AAD', () => {
    const aead = new NodeAead(key());
    const aad = aadFor(SEG, 0, 5);
    const pt = randomBytes(1000);
    const sealed = aead.seal(pt, aad);
    expect(Buffer.from(aead.open(sealed, aad))).toEqual(Buffer.from(pt));
  });

  it('uses a fresh random nonce each time (no nonce reuse for identical plaintext)', () => {
    const aead = new NodeAead(key());
    const aad = aadFor(SEG, 0, 1);
    const a = aead.seal(Uint8Array.of(1, 2, 3), aad);
    const b = aead.seal(Uint8Array.of(1, 2, 3), aad);
    expect(Buffer.from(a.nonce)).not.toEqual(Buffer.from(b.nonce));
    expect(Buffer.from(a.ciphertext)).not.toEqual(Buffer.from(b.ciphertext));
  });

  it('rejects a tampered ciphertext (IntegrityError, never wrong plaintext)', () => {
    const aead = new NodeAead(key());
    const aad = aadFor(SEG, 0, 1);
    const sealed = aead.seal(randomBytes(64), aad);
    const ciphertext = Uint8Array.from(sealed.ciphertext);
    ciphertext[0] = ciphertext[0]! ^ 0xff;
    expect(() => aead.open({ ...sealed, ciphertext }, aad)).toThrow(IntegrityError);
  });

  it('rejects a tampered tag', () => {
    const aead = new NodeAead(key());
    const aad = aadFor(SEG, 0, 1);
    const sealed = aead.seal(randomBytes(64), aad);
    const tag = Uint8Array.from(sealed.tag);
    tag[0] = tag[0]! ^ 0xff;
    expect(() => aead.open({ ...sealed, tag }, aad)).toThrow(IntegrityError);
  });

  it('rejects mismatched AAD — a chunk cannot be relocated to another (segment, gen, chunkKey)', () => {
    const aead = new NodeAead(key());
    const sealed = aead.seal(randomBytes(64), aadFor(SEG, 0, 5));
    // Same key + bytes, but presented as a different chunk / generation / segment → must fail.
    expect(() => aead.open(sealed, aadFor(SEG, 0, 6))).toThrow(IntegrityError);
    expect(() => aead.open(sealed, aadFor(SEG, 1, 5))).toThrow(IntegrityError);
    expect(() => aead.open(sealed, aadFor({ segment: 'other' }, 0, 5))).toThrow(IntegrityError);
    expect(() => aead.open(sealed, aadFor(SEG, 0, 'index'))).toThrow(IntegrityError);
  });

  it('rejects decryption under the wrong key', () => {
    const aad = aadFor(SEG, 0, 1);
    const sealed = new NodeAead(key()).seal(randomBytes(64), aad);
    expect(() => new NodeAead(key()).open(sealed, aad)).toThrow(IntegrityError);
  });

  it('rejects a non-256-bit key', () => {
    expect(() => new NodeAead(randomBytes(16))).toThrow(ValidationError);
  });
});

describe('InProcessKeystore (envelope BYOK)', () => {
  it('createDek → openDek round-trips the same AEAD (encrypt with one, decrypt with the other)', async () => {
    const ks = new InProcessKeystore({ keys: { k1: key() }, activeKeyId: 'k1' });
    const { wrapped, aead } = await ks.createDek();
    expect(wrapped).toHaveLength(1);
    expect(wrapped[0]?.keyId).toBe('k1');

    const aad = aadFor(SEG, 0, 9);
    const sealed = aead.seal(randomBytes(128), aad);
    const reopened = await ks.openDek(wrapped);
    expect(Buffer.from(reopened.open(sealed, aad))).toEqual(Buffer.from(aead.open(sealed, aad)));
  });

  it('multi-wrap: a DEK wrapped under active + recovery KEK opens with EITHER key alone', async () => {
    const activeKek = key();
    const recoveryKek = key();
    const writer = new InProcessKeystore({
      keys: { active: activeKek, recovery: recoveryKek },
      activeKeyId: 'active',
      recoveryKeyId: 'recovery',
    });
    const { wrapped, aead } = await writer.createDek();
    expect(wrapped.map((w) => w.keyId)).toEqual(['active', 'recovery']);
    const aad = aadFor(SEG, 0, 1);
    const sealed = aead.seal(Uint8Array.of(42), aad);

    // Operator who lost the active KEK but kept the offline recovery KEK can still read.
    const recoveryOnly = new InProcessKeystore({
      keys: { recovery: recoveryKek },
      activeKeyId: 'recovery',
    });
    const aeadR = await recoveryOnly.openDek(wrapped);
    expect(Array.from(aeadR.open(sealed, aad))).toEqual([42]);

    // And the active-only operator can read too.
    const activeOnly = new InProcessKeystore({
      keys: { active: activeKek },
      activeKeyId: 'active',
    });
    expect(Array.from((await activeOnly.openDek(wrapped)).open(sealed, aad))).toEqual([42]);
  });

  it('multi-wrap: a CORRUPT active-KEK wrapping falls through to the valid recovery wrapping', async () => {
    // Regression: openDek must try EVERY held wrapping. If the active-KEK wrapping is corrupt/tampered but the
    // operator holds a valid recovery wrapping, the DEK must still open — the recovery KEK is insurance
    // against exactly this, and returning on (or throwing at) the first held keyId would defeat it.
    const activeKek = key();
    const recoveryKek = key();
    const writer = new InProcessKeystore({
      keys: { active: activeKek, recovery: recoveryKek },
      activeKeyId: 'active',
      recoveryKeyId: 'recovery',
    });
    const { wrapped, aead } = await writer.createDek();
    expect(wrapped.map((w) => w.keyId)).toEqual(['active', 'recovery']); // active is tried FIRST
    const aad = aadFor(SEG, 0, 1);
    const sealed = aead.seal(Uint8Array.of(7), aad);

    // Corrupt ONLY the active wrapping (first entry); keep the recovery wrapping intact.
    const damaged = [
      { keyId: 'active', wrapped: Buffer.from('garbage').toString('base64') },
      wrapped[1]!,
    ];
    // Operator holds BOTH KEKs — before the fix, the corrupt active unwrap threw before recovery was tried.
    const holdsBoth = new InProcessKeystore({
      keys: { active: activeKek, recovery: recoveryKek },
      activeKeyId: 'active',
      recoveryKeyId: 'recovery',
    });
    const reopened = await holdsBoth.openDek(damaged);
    expect(Array.from(reopened.open(sealed, aad))).toEqual([7]);
  });

  it('throws KeyUnavailableError when it holds none of the wrapping KEKs (key lost / shredded)', async () => {
    const { wrapped } = await new InProcessKeystore({
      keys: { k1: key() },
      activeKeyId: 'k1',
    }).createDek();
    const other = new InProcessKeystore({ keys: { k2: key() }, activeKeyId: 'k2' });
    await expect(other.openDek(wrapped)).rejects.toBeInstanceOf(KeyUnavailableError);
    // An empty wrapping list (a shredded segment) is likewise unrecoverable.
    await expect(other.openDek([])).rejects.toBeInstanceOf(KeyUnavailableError);
  });

  it('KEK rotation: a DEK wrapped under the old active KEK still opens after rotating, no re-encryption', async () => {
    const k1 = key();
    const { wrapped } = await new InProcessKeystore({
      keys: { v1: k1 },
      activeKeyId: 'v1',
    }).createDek();
    // Operator rotates: adds v2 as active, KEEPS v1 to read existing segments.
    const rotated = new InProcessKeystore({ keys: { v1: k1, v2: key() }, activeKeyId: 'v2' });
    await expect(rotated.openDek(wrapped)).resolves.toBeDefined();
  });

  it('validates KEK sizes + activeKeyId/recoveryKeyId membership at construction', () => {
    expect(() => new InProcessKeystore({ keys: {}, activeKeyId: 'x' })).toThrow(ValidationError);
    expect(() => new InProcessKeystore({ keys: { k: randomBytes(16) }, activeKeyId: 'k' })).toThrow(
      ValidationError,
    );
    expect(() => new InProcessKeystore({ keys: { k: key() }, activeKeyId: 'nope' })).toThrow(
      ValidationError,
    );
    expect(
      () => new InProcessKeystore({ keys: { k: key() }, activeKeyId: 'k', recoveryKeyId: 'nope' }),
    ).toThrow(ValidationError);
  });

  it('rejects a corrupt/foreign wrapped blob under a held keyId (IntegrityError)', async () => {
    const ks = new InProcessKeystore({ keys: { k1: key() }, activeKeyId: 'k1' });
    await expect(
      ks.openDek([{ keyId: 'k1', wrapped: Buffer.from('garbage').toString('base64') }]),
    ).rejects.toBeInstanceOf(IntegrityError);
  });
});
