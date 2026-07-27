/**
 * Concrete AES-256-GCM crypto (lives outside `core/`, which lint-bans `node:crypto`). Implements the injected
 * {@link Aead}/{@link IKeystore} seams from `core/crypto`: a `NodeAead` over `aes-256-gcm`, and an in-process
 * **BYOK** keystore that envelope-wraps a per-segment DEK under one or more operator-held KEKs.
 *
 * Default, dependency-free key management: you bring 32-byte KEK(s); we never call a cloud service. KMS/Vault
 * are future optional adapters against the same {@link IKeystore} interface. **The KEK is the
 * one secret to back up** — lose it and that segment's at-rest bytes are unrecoverable by design (re-seed the
 * segment from your source of truth); see the getting-started "Encryption" section.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { Aead, AeadSealed, IKeystore, WrappedDek } from '../core/crypto';
import { IntegrityError, KeyUnavailableError, ValidationError } from '../core/errors';

const KEY_BYTES = 32; // AES-256
const NONCE_BYTES = 12; // GCM standard nonce
const TAG_BYTES = 16; // GCM tag

/** AES-256-GCM AEAD bound to one 32-byte key. A fresh CSPRNG 96-bit nonce per `seal`; `aad` is authenticated,
 * never stored. Nonce-reuse safety: the random-96-bit birthday bound is ~q²/2⁹⁷, negligible below ~2³² seals
 * under one key. A per-segment DEK is **reused across all generations** (compaction re-encrypts under it), so
 * seal count is cumulative over the segment's life — a segment approaching ~2³² lifetime chunk-seals should be
 * re-seeded (a fresh segment ⇒ fresh DEK). Far beyond any realistic workload; noted for completeness. */
export class NodeAead implements Aead {
  private readonly key: Buffer;

  constructor(key: Uint8Array) {
    if (key.length !== KEY_BYTES)
      throw new ValidationError(`AEAD key must be ${KEY_BYTES} bytes, got ${key.length}`);
    this.key = Buffer.from(key);
  }

  seal(plaintext: Uint8Array, aad: Uint8Array): AeadSealed {
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.key, nonce);
    cipher.setAAD(aad);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return { nonce, ciphertext, tag: cipher.getAuthTag() };
  }

  open(sealed: AeadSealed, aad: Uint8Array): Uint8Array {
    if (sealed.nonce.length !== NONCE_BYTES || sealed.tag.length !== TAG_BYTES)
      throw new IntegrityError('AEAD nonce/tag have the wrong length');
    const decipher = createDecipheriv('aes-256-gcm', this.key, sealed.nonce);
    decipher.setAAD(aad);
    decipher.setAuthTag(Buffer.from(sealed.tag));
    try {
      return Buffer.concat([decipher.update(sealed.ciphertext), decipher.final()]);
    } catch {
      // Wrong key, tampered ciphertext/tag, or mismatched AAD — never leak which, never return plaintext.
      throw new IntegrityError(
        'AEAD authentication failed (wrong key, tampered data, or wrong context)',
      );
    }
  }
}

/** Wrap/unwrap a DEK under a KEK with AES-256-GCM, binding the wrapping to its `keyId` via AAD so a wrapping
 * can't be relabelled to another KEK. Stored blob = nonce ‖ ciphertext ‖ tag, base64. */
function wrapKey(dek: Uint8Array, kek: Uint8Array, keyId: string): string {
  const sealed = new NodeAead(kek).seal(dek, new TextEncoder().encode(keyId));
  return Buffer.concat([sealed.nonce, sealed.ciphertext, sealed.tag]).toString('base64');
}

function unwrapKey(wrapped: string, kek: Uint8Array, keyId: string): Uint8Array {
  const blob = Buffer.from(wrapped, 'base64');
  if (blob.length < NONCE_BYTES + TAG_BYTES)
    throw new IntegrityError('wrapped DEK is too short to be valid');
  const nonce = blob.subarray(0, NONCE_BYTES);
  const tag = blob.subarray(blob.length - TAG_BYTES);
  const ciphertext = blob.subarray(NONCE_BYTES, blob.length - TAG_BYTES);
  return new NodeAead(kek).open({ nonce, ciphertext, tag }, new TextEncoder().encode(keyId));
}

/**
 * Options for {@link InProcessKeystore}. `keys` maps a `keyId` → its 32-byte KEK; `activeKeyId` names the KEK
 * new DEKs are wrapped under; an optional `recoveryKeyId` additionally wraps each new DEK under a second
 * (e.g. offline) KEK, so losing the active KEK isn't fatal. Rotating the active KEK needs no data
 * re-encryption: add the new KEK, point `activeKeyId` at it, keep the old one to unwrap existing segments.
 */
export interface InProcessKeystoreOptions {
  readonly keys: Readonly<Record<string, Uint8Array>>;
  readonly activeKeyId: string;
  readonly recoveryKeyId?: string;
}

/**
 * Dependency-free BYOK keystore: envelope-wraps a fresh random per-segment DEK under the active (and optional
 * recovery) KEK using `node:crypto`. No external service. The raw DEK never leaves a returned {@link NodeAead}.
 */
export class InProcessKeystore implements IKeystore {
  private readonly keys: Map<string, Uint8Array>;
  private readonly activeKeyId: string;
  private readonly recoveryKeyId: string | undefined;

  constructor(options: InProcessKeystoreOptions) {
    const entries = Object.entries(options.keys);
    if (entries.length === 0) throw new ValidationError('keystore needs at least one KEK');
    for (const [id, k] of entries) {
      if (k.length !== KEY_BYTES)
        throw new ValidationError(`KEK "${id}" must be ${KEY_BYTES} bytes, got ${k.length}`);
    }
    if (!(options.activeKeyId in options.keys))
      throw new ValidationError(`activeKeyId "${options.activeKeyId}" is not in keys`);
    if (options.recoveryKeyId !== undefined && !(options.recoveryKeyId in options.keys))
      throw new ValidationError(`recoveryKeyId "${options.recoveryKeyId}" is not in keys`);
    this.keys = new Map(entries.map(([id, k]) => [id, Buffer.from(k)]));
    this.activeKeyId = options.activeKeyId;
    this.recoveryKeyId =
      options.recoveryKeyId === options.activeKeyId ? undefined : options.recoveryKeyId;
  }

  // async to satisfy the IKeystore seam (a KMS adapter awaits a network call here); the in-process path is
  // synchronous, but staying async keeps unwrap failures as rejections, matching a remote keystore.
  async createDek(): Promise<{ wrapped: WrappedDek[]; aead: Aead }> {
    const dek = randomBytes(KEY_BYTES);
    const ids = this.recoveryKeyId ? [this.activeKeyId, this.recoveryKeyId] : [this.activeKeyId];
    const wrapped = ids.map((keyId) => ({
      keyId,
      wrapped: wrapKey(dek, this.keys.get(keyId)!, keyId),
    }));
    return { wrapped, aead: new NodeAead(dek) };
  }

  // async for the same reason as createDek — a synchronous unwrap failure surfaces as a promise rejection.
  async openDek(wrapped: readonly WrappedDek[]): Promise<Aead> {
    // Try EVERY held wrapping, not just the first: a DEK is wrapped under both the active KEK and (if
    // configured) the offline recovery KEK precisely so a damaged/tampered active-KEK wrapping can be
    // recovered from the other. Returning on the first held keyId and letting a corrupt unwrap throw would
    // defeat that insurance — the recovery wrapping would never be attempted. So catch a failed unwrap and
    // fall through to the next held wrapping; only give up once none succeeds.
    let anyKekHeld = false;
    let lastUnwrapError: unknown;
    for (const w of wrapped) {
      const kek = this.keys.get(w.keyId);
      if (kek === undefined) continue;
      anyKekHeld = true;
      try {
        return new NodeAead(unwrapKey(w.wrapped, kek, w.keyId));
      } catch (err) {
        lastUnwrapError = err; // held KEK but this wrapping is corrupt/tampered — try the next one
      }
    }
    // A KEK WAS held but every held wrapping failed to unwrap → the wrapping(s) are corrupt/tampered, not
    // missing. Surface that integrity failure in its original type rather than masking it as "no held KEK".
    if (anyKekHeld) throw lastUnwrapError;
    const have = [...this.keys.keys()].join(', ') || '(none)';
    const need = wrapped.map((w) => w.keyId).join(', ') || '(none)';
    throw new KeyUnavailableError(
      `no held KEK can unwrap this DEK — have [${have}], wrappings reference [${need}]. ` +
        `Restore the missing KEK (or its recovery KEK), or rebuild the segment from source.`,
    );
  }
}
