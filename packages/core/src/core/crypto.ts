/**
 * Encryption seams — the **pure** interfaces `core/` depends on so the codec can encrypt/decrypt without
 * importing `node:crypto` (lint-banned here, like `Clock`/`Rng`/drivers). Concrete AES-256-GCM lives outside
 * `core/` (`src/drivers/crypto.ts`) and is injected. The envelope scheme: a per-segment DEK wrapped under an
 * operator-held KEK, so discarding the DEK crypto-shreds the segment,
 * [DECISIONS #19]. Per-chunk AEAD over the `.crbm` payloads + index; a per-segment **DEK** wrapped (envelope
 * encryption) under one or more **KEK**s by an {@link IKeystore}; the wrapped DEK(s) live in the registry, so
 * crypto-shred = delete them.
 */

/** One AEAD result: a fresh per-message nonce, the ciphertext, and the authentication tag. */
export interface AeadSealed {
  readonly nonce: Uint8Array;
  readonly ciphertext: Uint8Array;
  readonly tag: Uint8Array;
}

/**
 * Authenticated encryption bound to a single key (a segment's DEK). `aad` (associated data) is authenticated
 * but not encrypted — the codec passes each chunk's `(namespace, segment, generation, chunkKey)` identity
 * ({@link aadFor}), so a chunk's ciphertext can't be silently relocated to another segment/generation/chunk or
 * the index, even by someone who can rewrite Cold objects. The seam is symmetric and self-framing-agnostic:
 * the caller decides where the nonce/tag go (inline with a chunk, or in the footer for the index).
 */
export interface Aead {
  /** Encrypt `plaintext`, authenticating `aad`. Returns a fresh nonce + ciphertext + tag. */
  seal(plaintext: Uint8Array, aad: Uint8Array): AeadSealed;
  /**
   * Decrypt + verify. Throws {@link IntegrityError} on **any** mismatch (wrong key, tampered ciphertext/tag,
   * or `aad` that doesn't match what was sealed) — never returns wrong-but-plausible plaintext.
   */
  open(sealed: AeadSealed, aad: Uint8Array): Uint8Array;
}

/**
 * A DEK wrapped under one KEK. A segment stores a **list** of these (one per KEK it was wrapped under — e.g.
 * an active KEK plus an offline recovery KEK), so losing one KEK isn't fatal and KEK rotation needs no
 * data re-encryption. `keyId` names which KEK; `wrapped` is the opaque wrapped-key blob (base64). Carries no
 * plaintext key material — safe to store in the registry next to the (encrypted) data.
 */
export interface WrappedDek {
  readonly keyId: string;
  readonly wrapped: string;
}

/**
 * Envelope key management — the injected seam between the codec and however the operator holds key material
 * (in-process BYOK by default; KMS/Vault as optional adapters later). Async so a remote keystore (KMS) fits
 * the same interface. Never exposes raw key bytes to `core/`: it returns an {@link Aead} bound to the DEK.
 */
export interface IKeystore {
  /**
   * Mint a fresh per-segment DEK, wrapped under the active KEK (and any recovery KEK). Returns the wrapping(s)
   * to persist in the registry plus an {@link Aead} to encrypt this segment's chunks with.
   */
  createDek(): Promise<{ wrapped: WrappedDek[]; aead: Aead }>;
  /**
   * Reconstruct the {@link Aead} from a segment's stored wrappings by unwrapping with any KEK currently held.
   * Throws {@link KeyUnavailableError} if it holds none of the referenced KEKs (lost key, or a shredded
   * segment whose wrappings were deleted).
   */
  openDek(wrapped: readonly WrappedDek[]): Promise<Aead>;
}

/**
 * What the encrypting codec needs: the {@link Aead} for this segment's DEK plus a way to build the AAD for a
 * given scope (`'index'` or a chunkKey). Built per (segment, generation) by the cold-source bridge so the
 * codec itself stays segment-agnostic.
 */
export interface CrbmCrypto {
  readonly aead: Aead;
  aadFor(scope: number | 'index'): Uint8Array;
}

const AAD_VERSION = 1;
const SCOPE_CHUNK = 0;
const SCOPE_INDEX = 1;

/**
 * Build the AEAD associated-data binding a chunk (or the index) to its exact location:
 * `v1 ‖ len(namespace) ‖ namespace ‖ len(segment) ‖ segment ‖ generation ‖ scope ‖ chunkKey`. Length-prefixed
 * so distinct `(namespace, segment)` pairs can never collide. Pure (no crypto) — just the authenticated label.
 */
export function aadFor(
  ref: { readonly namespace?: string; readonly segment: string },
  generation: number,
  scope: number | 'index',
): Uint8Array {
  const enc = new TextEncoder();
  const ns = enc.encode(ref.namespace ?? '');
  const seg = enc.encode(ref.segment);
  const out = new Uint8Array(1 + 2 + ns.length + 2 + seg.length + 8 + 1 + 4);
  const view = new DataView(out.buffer);
  let o = 0;
  out[o] = AAD_VERSION;
  o += 1;
  view.setUint16(o, ns.length, true);
  o += 2;
  out.set(ns, o);
  o += ns.length;
  view.setUint16(o, seg.length, true);
  o += 2;
  out.set(seg, o);
  o += seg.length;
  view.setBigUint64(o, BigInt(generation), true);
  o += 8;
  out[o] = scope === 'index' ? SCOPE_INDEX : SCOPE_CHUNK;
  o += 1;
  view.setUint32(o, scope === 'index' ? 0 : scope, true);
  return out;
}
