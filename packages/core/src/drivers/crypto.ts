/**
 * Concrete AES-256-GCM crypto (lives outside `core/`, which lint-bans `node:crypto`). Implements the injected
 * {@link Aead}/{@link IKeystore} seams from `core/crypto`: a `NodeAead` over `aes-256-gcm`, and an in-process
 * **BYOK** keystore that envelope-wraps a per-segment DEK under one or more operator-held KEKs.
 *
 * Default, dependency-free key management: you bring 32-byte KEK(s); we never call a cloud service. KMS/Vault
 * are future optional adapters against the same {@link IKeystore} interface. **The KEK is the
 * one secret to back up** — lose it and that segment's at-rest bytes are unrecoverable by design (re-seed the
 * segment from your source of truth); see the encryption guide.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { Aead, AeadSealed, IKeystore, WrappedDek } from '../core/crypto';
import { refuseUnknownOptions } from './_shared/options';
import { IntegrityError, KeyUnavailableError, ValidationError } from '../core/errors';

const UTF8 = new TextEncoder();
const KEY_BYTES = 32; // AES-256
const NONCE_BYTES = 12; // GCM standard nonce
const TAG_BYTES = 16; // GCM tag

/** A `Uint8Array`, a `Buffer` among them, from this realm or another. */
const isBytes = (v: unknown): v is Uint8Array =>
  Object.prototype.toString.call(v) === '[object Uint8Array]';

/**
 * A copy of key bytes in a buffer of their own. `Buffer.from` takes small buffers from a slab of Node's shared pool (8 KiB on Node 22,
 * 64 KiB on recent Node 24), so a held key would pin the whole slab it came from for as long as it lives, and keep key bytes beside unrelated data.
 */
function ownKey(key: Uint8Array): Buffer {
  const own = Buffer.alloc(key.length);
  own.set(key);
  return own;
}

/** AES-256-GCM AEAD bound to one 32-byte key. A fresh CSPRNG 96-bit nonce per `seal`; `aad` is authenticated,
 * never stored. Nonce-reuse safety: the random-96-bit birthday bound is ~q²/2⁹⁷, negligible below ~2³² seals
 * under one key. A per-segment DEK is **reused across all generations** (every load and rewrite encrypts under it), so
 * seal count is cumulative over the segment's life — a segment approaching ~2³² lifetime chunk-seals should be
 * re-seeded (a fresh segment ⇒ fresh DEK). A segment at the 65,536-chunk maximum reaches it after about 65,500 loads
 * or rewrites (230 days at one every 5 minutes): load into a fresh segment, or load less often, before then. */
export class NodeAead implements Aead {
  private readonly key: Buffer;

  constructor(key: Uint8Array) {
    if (!isBytes(key))
      throw new ValidationError('AEAD key must be a Uint8Array of key bytes, not text');
    if (key.length !== KEY_BYTES)
      throw new ValidationError(`AEAD key must be ${KEY_BYTES} bytes, got ${key.length}`);
    this.key = ownKey(key);
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
  const sealed = new NodeAead(kek).seal(dek, UTF8.encode(keyId));
  return Buffer.concat([sealed.nonce, sealed.ciphertext, sealed.tag]).toString('base64');
}

function unwrapKey(wrapped: string, kek: Uint8Array, keyId: string): Uint8Array {
  const blob = Buffer.from(wrapped, 'base64');
  if (blob.length < NONCE_BYTES + TAG_BYTES)
    throw new IntegrityError('wrapped DEK is too short to be valid');
  const nonce = blob.subarray(0, NONCE_BYTES);
  const tag = blob.subarray(blob.length - TAG_BYTES);
  const ciphertext = blob.subarray(NONCE_BYTES, blob.length - TAG_BYTES);
  return new NodeAead(kek).open({ nonce, ciphertext, tag }, UTF8.encode(keyId));
}

/**
 * Options for {@link InProcessKeystore}. `keys` maps a `keyId` → its 32-byte KEK; `activeKeyId` names the KEK
 * new DEKs are wrapped under; an optional `recoveryKeyId` additionally wraps each new DEK under a second
 * (e.g. offline) KEK, so losing the active KEK isn't fatal. Rotating the active KEK needs no data
 * re-encryption: add the new KEK, point `activeKeyId` at it, keep the old one to unwrap existing segments. An option
 * it does not take, such as a misspelt `recoveryKeyId`, throws `ValidationError`.
 */
export interface InProcessKeystoreOptions {
  /** Each key-encryption key (KEK) by its id: 32 bytes each, at least one. */
  readonly keys: Readonly<Record<string, Uint8Array>>;
  /** The id of the KEK new data keys are wrapped under. It must be in `keys`. */
  readonly activeKeyId: string;
  /**
   * The id of a second KEK each new data key is also wrapped under, such as an offline one. Absent for none, and the
   * same id as `activeKeyId` means none too; it must be in `keys` when given.
   */
  readonly recoveryKeyId?: string;
}

/**
 * Dependency-free BYOK keystore: envelope-wraps a fresh random per-segment DEK under the active (and optional
 * recovery) KEK using `node:crypto`. No external service. The raw DEK never leaves the `Aead` it returns.
 */
export class InProcessKeystore implements IKeystore {
  private readonly keys: Map<string, Uint8Array>;
  private readonly activeKeyId: string;
  private readonly recoveryKeyId: string | undefined;

  /**
   * Builds a keystore from `options`; throws `ValidationError` for no options object, an option it does not take
   * (a misspelt `recoveryKeyId` would otherwise leave no recovery wrapping), a `keys` that is not an object, an
   * `activeKeyId` or `recoveryKeyId` that is not a string, no keys, a key given as text rather than a
   * `Uint8Array`, a key that is not 32 bytes, or an `activeKeyId` or `recoveryKeyId` that is not in `keys`. A
   * `recoveryKeyId` equal to `activeKeyId` means no recovery key.
   */
  constructor(options: InProcessKeystoreOptions) {
    refuseUnknownOptions('InProcessKeystore', options, ['keys', 'activeKeyId', 'recoveryKeyId']);
    const keys: unknown = options.keys;
    const proto: unknown =
      keys === null || typeof keys !== 'object' ? null : Object.getPrototypeOf(keys);
    if (
      keys === null ||
      typeof keys !== 'object' ||
      (proto !== Object.prototype && proto !== null)
    ) {
      throw new ValidationError(
        'InProcessKeystore: `keys` must be a plain object of key id to 32-byte Uint8Array KEK, not a Map or an array',
      );
    }
    if (typeof options.activeKeyId !== 'string') {
      throw new ValidationError(
        'InProcessKeystore: `activeKeyId` must be a string naming one of `keys`',
      );
    }
    if (options.recoveryKeyId !== undefined && typeof options.recoveryKeyId !== 'string') {
      throw new ValidationError(
        'InProcessKeystore: `recoveryKeyId` must be a string naming one of `keys`, or absent for none',
      );
    }
    const entries = Object.entries(keys);
    if (entries.length === 0) throw new ValidationError('keystore needs at least one KEK');
    for (const [id, k] of entries) {
      // Text of the right length would pass the length check and become a key of printable characters, with no key
      // derivation: an environment variable passed as it is.
      if (!isBytes(k))
        throw new ValidationError(`KEK "${id}" must be a Uint8Array of key bytes, not text`);
      if (k.length !== KEY_BYTES)
        throw new ValidationError(`KEK "${id}" must be ${KEY_BYTES} bytes, got ${k.length}`);
    }
    this.keys = new Map(entries.map(([id, k]) => [id, ownKey(k)]));
    // Membership is against the keys given, not the names an object inherits (`constructor`, `toString`).
    if (!this.keys.has(options.activeKeyId))
      throw new ValidationError(`activeKeyId "${String(options.activeKeyId)}" is not in keys`);
    if (options.recoveryKeyId !== undefined && !this.keys.has(options.recoveryKeyId))
      throw new ValidationError(`recoveryKeyId "${String(options.recoveryKeyId)}" is not in keys`);
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
    // The ids the wrappings name, not the ids this keystore holds: the message reaches ledgers and logs, and the held
    // keys are not the reader's to see.
    const need = wrapped.map((w) => w.keyId).join(', ') || '(none)';
    throw new KeyUnavailableError(
      `no held KEK can unwrap this DEK — the wrappings reference [${need}]. ` +
        `Restore the missing KEK (or its recovery KEK), or rebuild the segment from source.`,
    );
  }
}
