/**
 * A generation's summary on its registry row: how a writer builds it, how a reader opens it, and how it is held
 * against the object it describes.
 *
 * The row carries a cached description of the current generation, `{ generation, cardinality, fingerprint, metadata? }`,
 * written by the same compare-and-swap that moves the pointer. The fingerprint names the generation's object, by its
 * size and footer checksum, as `CrbmReader.fingerprint` does. On a cleartext segment the values are in the clear. On an
 * encrypted one the row holds `{ generation, sealed }` instead: the cardinality as a fixed-width little-endian u64, the
 * object's size as a u64 and its footer checksum as a u32, then the metadata's canonical JSON if there is any, sealed
 * under the segment's data key with the summary scope of the associated data, which binds it to its namespace, segment
 * and generation. The numbers are fixed-width so the ciphertext's length reveals only the metadata's size, never how
 * many digits the count or the size has. Pure: no I/O.
 *
 * The generation's `.crbm` object stays the truth, and the summary is a copy of it. {@link summaryAgrees} is the
 * comparison of one with the other, and the fingerprint is what a reader holds every object it opens against.
 */
import type { Aead } from './crypto';
import { aadFor } from './crypto';
import { IntegrityError, isIntegrityError } from './errors';
import { fingerprintFor, fingerprintParts } from './crbm/reader';
import {
  MAX_METADATA_BYTES,
  canonicalMetadataJson,
  metadataBytes,
  metadataFromBytes,
} from './metadata';
import type {
  ClearRegistrySummary,
  GenerationMetadata,
  RegistryRecord,
  RegistrySummary,
  SealedRegistrySummary,
  SegmentRef,
} from './ports';

/** The 12-byte nonce and 16-byte tag AES-256-GCM frames a sealed blob with, which the `.crbm` format fixes too. */
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
/** The cardinality, sealed as a little-endian u64. */
const COUNT_BYTES = 8;
/** The object's size, sealed as a little-endian u64, then its footer checksum as a little-endian u32. */
const SIZE_BYTES = 8;
const CRC_BYTES = 4;
/** The fixed part of a sealed summary's plaintext: the count and the fingerprint. */
const FIXED_BYTES = COUNT_BYTES + SIZE_BYTES + CRC_BYTES;
/** A generation holds at most every 32-bit id. */
const MAX_CARDINALITY = 2 ** 32;

/** What a summary says about a generation: its id count, and its metadata when it has any. */
export interface GenerationDescription {
  readonly cardinality: number;
  readonly metadata?: GenerationMetadata | undefined;
}

/** What a row's summary says: the generation's description, and the fingerprint of the object it describes. */
export interface SummaryDescription extends GenerationDescription {
  readonly fingerprint: string;
}

/** The size of the object a fingerprint names, in bytes: what `stat()` reports from a row's summary. */
export function sizeOfFingerprint(fingerprint: string): number {
  const parts = fingerprintParts(fingerprint);
  if (parts === undefined)
    throw new IntegrityError('registry record summary: a malformed fingerprint');
  return parts.size;
}

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Padded standard base64. */
function toBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!;
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    out += BASE64[a >> 2]! + BASE64[((a & 3) << 4) | ((b ?? 0) >> 4)]!;
    out += b === undefined ? '=' : BASE64[((b & 15) << 2) | ((c ?? 0) >> 6)]!;
    out += c === undefined ? '=' : BASE64[c & 63]!;
  }
  return out;
}

/** The bytes of padded standard base64, or `undefined` for text that is not. */
function fromBase64(text: string): Uint8Array | undefined {
  if (text.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(text)) return undefined;
  const pad = text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0;
  const out = new Uint8Array((text.length / 4) * 3 - pad);
  let o = 0;
  for (let i = 0; i < text.length; i += 4) {
    const n =
      (BASE64.indexOf(text[i]!) << 18) |
      (BASE64.indexOf(text[i + 1]!) << 12) |
      (Math.max(BASE64.indexOf(text[i + 2]!), 0) << 6) |
      Math.max(BASE64.indexOf(text[i + 3]!), 0);
    if (o < out.length) out[o++] = (n >> 16) & 255;
    if (o < out.length) out[o++] = (n >> 8) & 255;
    if (o < out.length) out[o++] = n & 255;
  }
  return out;
}

/**
 * The clear summary of a generation on a cleartext segment, naming its object by `fingerprint`. `metadata` is left off
 * when there is none.
 */
export function clearSummary(
  generation: number,
  cardinality: number,
  fingerprint: string,
  metadata?: GenerationMetadata,
): ClearRegistrySummary {
  return metadata === undefined || Object.keys(metadata).length === 0
    ? { generation, cardinality, fingerprint }
    : { generation, cardinality, fingerprint, metadata };
}

/**
 * The sealed summary of a generation on an encrypted segment: the cardinality as a u64, the object's size as a u64 and
 * its footer checksum as a u32, then the metadata's canonical JSON, sealed under `aead` and bound to `ref` and
 * `generation`.
 */
export function sealSummary(
  aead: Aead,
  ref: SegmentRef,
  generation: number,
  cardinality: number,
  fingerprint: string,
  metadata?: GenerationMetadata,
): SealedRegistrySummary {
  const meta = metadataBytes(metadata, (message) => {
    throw new IntegrityError(`summary metadata: ${message}`);
  });
  const parts = fingerprintParts(fingerprint);
  if (parts === undefined) throw new IntegrityError('summary: a malformed fingerprint');
  const plain = new Uint8Array(FIXED_BYTES + (meta?.length ?? 0));
  const view = new DataView(plain.buffer);
  view.setBigUint64(0, BigInt(cardinality), true);
  view.setBigUint64(COUNT_BYTES, BigInt(parts.size), true);
  view.setUint32(COUNT_BYTES + SIZE_BYTES, parts.footerCrc, true);
  if (meta !== undefined) plain.set(meta, FIXED_BYTES);
  const { nonce, ciphertext, tag } = aead.seal(plain, aadFor(ref, generation, 'summary'));
  const framed = new Uint8Array(nonce.length + ciphertext.length + tag.length);
  framed.set(nonce, 0);
  framed.set(ciphertext, nonce.length);
  framed.set(tag, nonce.length + ciphertext.length);
  return { generation, sealed: toBase64(framed) };
}

/**
 * What a sealed summary says, opened with `aead` under the summary scope of `ref` and the summary's own generation.
 * The bytes are untrusted: a blob that is not base64, is the wrong size, fails its authentication (tampered, or moved
 * from another generation's row), or holds a count outside 0 to 2^32, a size no object can have, or metadata that
 * breaks the rules, is an {@link IntegrityError}.
 */
export function openSummary(
  aead: Aead,
  ref: SegmentRef,
  summary: SealedRegistrySummary,
): SummaryDescription {
  const fail = (message: string): never => {
    throw new IntegrityError(`registry record summary: ${message}`);
  };
  const framed = fromBase64(summary.sealed);
  const framing = NONCE_BYTES + TAG_BYTES;
  if (
    framed === undefined ||
    framed.length < framing + FIXED_BYTES ||
    framed.length > framing + FIXED_BYTES + MAX_METADATA_BYTES
  ) {
    fail(
      'the sealed summary is not a nonce, a count, a fingerprint, up to 1 KiB of metadata and a tag',
    );
  }
  const bytes = framed as Uint8Array;
  let plain: Uint8Array;
  try {
    plain = aead.open(
      {
        nonce: bytes.subarray(0, NONCE_BYTES),
        ciphertext: bytes.subarray(NONCE_BYTES, bytes.length - TAG_BYTES),
        tag: bytes.subarray(bytes.length - TAG_BYTES),
      },
      aadFor(ref, summary.generation, 'summary'),
    );
  } catch (err) {
    if (!isIntegrityError(err)) throw err;
    return fail(
      'the sealed summary does not open: tampered bytes, or a summary moved from another generation',
    );
  }
  if (plain.length < FIXED_BYTES)
    fail('the sealed summary is shorter than its count and fingerprint');
  const view = new DataView(plain.buffer, plain.byteOffset, plain.byteLength);
  const count = view.getBigUint64(0, true);
  if (count > BigInt(MAX_CARDINALITY)) fail(`cardinality ${count} is outside 0 to 2^32`);
  const size = view.getBigUint64(COUNT_BYTES, true);
  const fingerprint = fingerprintFor(Number(size), view.getUint32(COUNT_BYTES + SIZE_BYTES, true));
  if (size > BigInt(Number.MAX_SAFE_INTEGER) || fingerprintParts(fingerprint) === undefined) {
    fail(`the object size ${size} is not one a .crbm object can have`);
  }
  const metadata =
    plain.length === FIXED_BYTES ? undefined : metadataFromBytes(plain.subarray(FIXED_BYTES), fail);
  return { cardinality: Number(count), metadata, fingerprint };
}

/**
 * What a row's summary says of its current generation, or `undefined` when it says nothing a reader may use. It is
 * used only for the generation it names, on an active row, and in the shape the row's keys call for: clear on a row
 * with no wrapped keys, sealed on a row with them. A sealed one is opened with `aead`, and is unusable without it,
 * or when it does not open, so a summary a tamperer moved or rewrote is never believed. Never throws for a bad
 * summary: the row's copy is a cache, and a copy that cannot be used is a copy that is not there.
 */
export function usableSummary(
  ref: SegmentRef,
  row: RegistryRecord,
  aead: Aead | undefined,
): SummaryDescription | undefined {
  const summary: RegistrySummary | undefined = row.summary;
  if (summary === undefined || row.status !== 'active' || summary.generation !== row.currentGen) {
    return undefined;
  }
  const keyed = row.wrappedDeks !== undefined && row.wrappedDeks.length > 0;
  if ('sealed' in summary) {
    if (!keyed || aead === undefined) return undefined;
    try {
      return openSummary(aead, ref, summary);
    } catch (err) {
      if (isIntegrityError(err)) return undefined;
      throw err;
    }
  }
  if (keyed) return undefined;
  return {
    cardinality: summary.cardinality,
    metadata: summary.metadata,
    fingerprint: summary.fingerprint,
  };
}

/**
 * The canonical form of a metadata record, or `undefined` for none. The empty record is none: a generation without
 * metadata carries none, and the two are never told apart.
 */
function canonicalOrNone(metadata: GenerationMetadata | undefined): string | undefined {
  if (metadata === undefined) return undefined;
  const json = canonicalMetadataJson(metadata, (message) => {
    throw new IntegrityError(`metadata: ${message}`);
  });
  return json === '{}' ? undefined : json;
}

/**
 * Whether a summary's description of a generation is what its object holds: the same id count and the same metadata,
 * compared in canonical form, so key order never matters. A summary with metadata over an object with none, and the
 * reverse, disagree: whether an encrypted object's metadata block is present is not authenticated (stripping it needs
 * no key), so the row's sealed copy is what a missing block is held against.
 */
export function summaryAgrees(
  summary: GenerationDescription,
  object: GenerationDescription,
): boolean {
  return (
    summary.cardinality === object.cardinality &&
    canonicalOrNone(summary.metadata) === canonicalOrNone(object.metadata)
  );
}

/**
 * The metadata an erasure carries into its rewrite of a generation: the object's own, except that an object with none
 * whose row's authenticated summary of the same generation has some gets the row's. Whether an encrypted object has a
 * metadata block is not authenticated, so a block stripped from one reads as none, and the sealed summary on the row is
 * the one copy that says there was a block; carrying it keeps the rewrite from erasing the record of what it dropped.
 * Pass `authenticated` only for a summary that was opened (a clear one has no more authority than the block it sits
 * beside). Never refuses: a rewrite over a stripped block is still an erasure.
 */
export function metadataToCarry(
  object: GenerationMetadata | undefined,
  authenticated: GenerationDescription | undefined,
): GenerationMetadata | undefined {
  const empty = (metadata: GenerationMetadata | undefined): boolean =>
    metadata === undefined || Object.keys(metadata).length === 0;
  return empty(object) && authenticated !== undefined && !empty(authenticated.metadata)
    ? authenticated.metadata
    : object;
}

/**
 * The summary of a generation of `ref`, describing the object `description.fingerprint` names, clear or sealed under
 * `aead` as the segment's keys call for.
 */
export function summaryOf(
  ref: SegmentRef,
  generation: number,
  description: SummaryDescription,
  aead: Aead | undefined,
): RegistrySummary {
  const { cardinality, fingerprint, metadata } = description;
  return aead === undefined
    ? clearSummary(generation, cardinality, fingerprint, metadata)
    : sealSummary(aead, ref, generation, cardinality, fingerprint, metadata);
}
