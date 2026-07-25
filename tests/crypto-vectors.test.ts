import { NodeAead } from '@/index';
import { IntegrityError } from '@/core/errors';

/**
 * Known-answer tests (KATs) for the AES-256-GCM AEAD (test-strategy T6).
 *
 * `tests/drivers/crypto.test.ts` proves the AEAD's *behaviour* (round-trip, tamper-rejection, AAD binding) but
 * only against itself — a self-consistent bug (wrong tag length, mis-ordered nonce, an AAD that isn't actually
 * fed to GCM) could pass every round-trip test. These vectors pin the wiring to **externally published**
 * answers: the canonical McGrew & Viega "The Galois/Counter Mode of Operation" AES-256-GCM test cases (the
 * same vectors reproduced in NIST's GCM validation set). If our GCM parameters (key/nonce widths), tag
 * verification, or AAD feed ever drifted from the standard, `open()` would fail to reproduce the known
 * plaintext. (The on-disk `nonce ‖ ciphertext ‖ tag` byte framing is separately covered by the DEK
 * wrap/unwrap and `.crbm` codec tests.)
 */

const hex = (h: string): Uint8Array => Uint8Array.from(Buffer.from(h, 'hex'));
const EMPTY = new Uint8Array(0);

describe('AES-256-GCM known-answer vectors (McGrew–Viega / NIST)', () => {
  it('Test Case 13 — zero key, zero IV, empty plaintext, empty AAD', () => {
    const key = hex('0000000000000000000000000000000000000000000000000000000000000000');
    const nonce = hex('000000000000000000000000');
    const tag = hex('530f8afbc74536b9a963b4f1c4cb738b');
    const pt = new NodeAead(key).open({ nonce, ciphertext: EMPTY, tag }, EMPTY);
    expect(pt.length).toBe(0);
  });

  it('Test Case 14 — zero key, zero IV, 16-byte zero plaintext, empty AAD', () => {
    const key = hex('0000000000000000000000000000000000000000000000000000000000000000');
    const nonce = hex('000000000000000000000000');
    const ciphertext = hex('cea7403d4d606b6e074ec5d3baf39d18');
    const tag = hex('d0d1c8a799996bf0265b98b5d48ab919');
    const pt = new NodeAead(key).open({ nonce, ciphertext, tag }, EMPTY);
    expect(Buffer.from(pt).toString('hex')).toBe('00000000000000000000000000000000');
  });

  it('Test Case 16 — non-empty plaintext WITH additional authenticated data', () => {
    const key = hex('feffe9928665731c6d6a8f9467308308feffe9928665731c6d6a8f9467308308');
    const nonce = hex('cafebabefacedbaddecaf888');
    const aad = hex('feedfacedeadbeeffeedfacedeadbeefabaddad2');
    const ciphertext = hex(
      '522dc1f099567d07f47f37a32a84427d643a8cdcbfe5c0c97598a2bd2555d1aa8cb08e48590dbb3da7b08b1056828838c5f61e6393ba7a0abcc9f662',
    );
    const tag = hex('76fc6ece0f4e1768cddf8853bb2d551b');
    const pt = new NodeAead(key).open({ nonce, ciphertext, tag }, aad);
    expect(Buffer.from(pt).toString('hex')).toBe(
      'd9313225f88406e5a55909c5aff5269a86a7a9531534f7da2e4c303d8a318a721c3c0c95956809532fcf0e2449a6b525b16aedf5aa0de657ba637b39',
    );
  });

  it('rejects the Test Case 16 vector when the AAD is altered (GCM authenticates the AAD)', () => {
    const key = hex('feffe9928665731c6d6a8f9467308308feffe9928665731c6d6a8f9467308308');
    const nonce = hex('cafebabefacedbaddecaf888');
    const wrongAad = hex('feedfacedeadbeeffeedfacedeadbeefabaddad3'); // last byte d2 → d3
    const ciphertext = hex(
      '522dc1f099567d07f47f37a32a84427d643a8cdcbfe5c0c97598a2bd2555d1aa8cb08e48590dbb3da7b08b1056828838c5f61e6393ba7a0abcc9f662',
    );
    const tag = hex('76fc6ece0f4e1768cddf8853bb2d551b');
    expect(() => new NodeAead(key).open({ nonce, ciphertext, tag }, wrongAad)).toThrow(
      IntegrityError,
    );
  });

  it('emits the standard 96-bit nonce and 128-bit tag on the wire (interop/format guard)', () => {
    const key = hex('0000000000000000000000000000000000000000000000000000000000000000');
    const sealed = new NodeAead(key).seal(hex('abcdef'), EMPTY);
    expect(sealed.nonce.length).toBe(12); // GCM standard 96-bit IV
    expect(sealed.tag.length).toBe(16); // full 128-bit auth tag (never truncated)
    // And it decrypts back under the same key/AAD.
    expect(Buffer.from(new NodeAead(key).open(sealed, EMPTY)).toString('hex')).toBe('abcdef');
  });
});
