/**
 * `CrbmReader` — speculative-tail-read reader for one `.crbm` generation.
 *
 * `open()` fetches the object's tail in **one GET** (footer + usually the whole index), verifies the
 * footer/index CRCs, and parses the delta+varint index into a map. `getChunk()` then range-GETs a single
 * payload and verifies its CRC32C **before** any native deserialize — every byte from storage is
 * untrusted (F3/F4).
 *
 * **Encryption (Phase 4e).** When the footer's `FLAG_ENCRYPTED` is set, a {@link CrbmCrypto} must be supplied:
 * the index is AES-256-GCM-decrypted (nonce/tag from the footer) and each chunk payload is decrypted after its
 * on-disk CRC passes. The footer's `chunkCount`/`totalCardinality` are zero on an encrypted object (metadata is
 * hidden), so both are derived from the decrypted index; AEAD authentication (incl. the per-location AAD)
 * replaces the cleartext-count cross-check.
 */
import { IntegrityError, UnsupportedError, ValidationError } from '../errors';
import type { BlobReader } from '../blob';
import type { CrbmCrypto } from '../crypto';
import { crc32c } from './crc32c';
import { readVarint } from './varint';
import {
  AEAD_NONCE_BYTES,
  AEAD_TAG_BYTES,
  CONTAINER_CODEC_NONE,
  CRC32C_BYTES,
  DEFAULT_MAX_INDEX_BYTES,
  DEFAULT_MAX_PAYLOAD_BYTES,
  DEFAULT_TAIL_BYTES,
  ELEMENT_WIDTH_32,
  FLAG_ENCRYPTED,
  FLAG_LITTLE_ENDIAN,
  FOOTER,
  FOOTER_BYTES,
  FOOTER_CRC_COVERAGE,
  KNOWN_FLAGS,
  MAGIC,
  MAX_CHUNK_CARDINALITY,
  PAYLOAD_START,
  PREAMBLE_BYTES,
  KNOWN_PAYLOAD_CODEC_IDS,
  PAYLOAD_CODEC_ROARING_PORTABLE,
  VERSION_MAJOR,
} from './format';

export interface CrbmIndexEntry {
  readonly chunkKey: number;
  readonly offset: number;
  readonly length: number;
  readonly cardinality: number;
  readonly crc32c: number;
}

/**
 * Estimated retained JS heap for one parsed index entry, used to weight the reader-cache byte bound
 * ({@link CrbmReader.retainedIndexBytes}). In V8 an entry costs: a `Map` slot (~48–64 B: two pointer slots +
 * hash chaining), the {@link CrbmIndexEntry} object (~40–56 B: header + 5 fields, where `offset`/`crc32c`
 * routinely exceed the 2³¹ SMI range and box as heap doubles, +16 B each), and one `orderedKeys` array slot
 * (~8 B) — realistically ~130–160 B. Rounded UP to 160 so the bound **over-counts** (a configured N-byte
 * ceiling pins ≤ N of real heap, never more), keeping the aggregate memory guarantee on the safe side. A
 * stable upper proxy, not an exact figure.
 */
const RETAINED_BYTES_PER_INDEX_ENTRY = 160;

export interface CrbmReaderOptions {
  /** Speculative tail size in bytes (default 256 KB; clamped up to at least the footer size). */
  readonly tailBytes?: number;
  /** Hard cap on a single chunk payload length (default 16 MB). */
  readonly maxPayloadBytes?: number;
  /** Hard cap on the whole index region fetched/parsed from one object (default 8 MB). */
  readonly maxIndexBytes?: number;
  /** Decryption context for an encrypted object (its DEK's AEAD + AAD builder). Required iff `FLAG_ENCRYPTED`. */
  readonly crypto?: CrbmCrypto;
}

function magicMatches(bytes: Uint8Array, offset: number): boolean {
  return (
    bytes[offset] === MAGIC[0] &&
    bytes[offset + 1] === MAGIC[1] &&
    bytes[offset + 2] === MAGIC[2] &&
    bytes[offset + 3] === MAGIC[3]
  );
}

/** Read a u64 footer field, rejecting values past JS safe-integer range (precision would be lost). */
function readU64(view: DataView, offset: number, field: string): number {
  const big = view.getBigUint64(offset, true);
  if (big > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new IntegrityError(`.crbm ${field} ${big} exceeds safe-integer range`);
  }
  return Number(big);
}

export class CrbmReader {
  private constructor(
    private readonly blob: BlobReader,
    private readonly objectSize: number,
    readonly generation: number,
    readonly totalCardinality: number,
    private readonly entries: Map<number, CrbmIndexEntry>,
    private readonly orderedKeys: number[],
    /** True when `open()` satisfied the index from the tail GET alone (no second range read). */
    readonly servedFromTail: boolean,
    /** Set iff the object is encrypted — used to decrypt each chunk payload in {@link getChunk}. */
    private readonly crypto: CrbmCrypto | undefined,
  ) {}

  /** Total object bytes (from the one-GET tail read) — for grounded storage cost (Phase 5b). */
  get sizeBytes(): number {
    return this.objectSize;
  }

  /**
   * Estimated retained JS heap of this reader's parsed index — the weight the cold reader cache bounds on
   * (gap #1: a wide segment's index dominates the reader's footprint). `entries.size` scales with the number
   * of resident chunks (≤ 65536), so this is `entries.size × {@link RETAINED_BYTES_PER_INDEX_ENTRY}`.
   */
  get retainedIndexBytes(): number {
    return this.entries.size * RETAINED_BYTES_PER_INDEX_ENTRY;
  }

  /** Per-chunk cardinality (`chunkKey → count`) from the parsed index — no payload reads (Phase 5c cheap count). */
  cardinalities(): Map<number, number> {
    const out = new Map<number, number>();
    for (const [chunkKey, entry] of this.entries) out.set(chunkKey, entry.cardinality);
    return out;
  }

  static async open(blob: BlobReader, options: CrbmReaderOptions = {}): Promise<CrbmReader> {
    // Always fetch at least a footer's worth, regardless of a smaller caller request.
    const tailBytes = Math.max(options.tailBytes ?? DEFAULT_TAIL_BYTES, FOOTER_BYTES);
    const maxPayloadBytes = options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES;
    const maxIndexBytes = options.maxIndexBytes ?? DEFAULT_MAX_INDEX_BYTES;
    const { bytes: tail, size } = await blob.getTail(tailBytes);

    if (size < PREAMBLE_BYTES + FOOTER_BYTES || tail.length < FOOTER_BYTES) {
      throw new IntegrityError(`.crbm too small: ${size}B`);
    }

    // --- Footer (last 104 bytes of the tail) ---
    const footer = tail.subarray(tail.length - FOOTER_BYTES);
    if (!magicMatches(footer, FOOTER.endMagic)) {
      throw new IntegrityError('.crbm end magic mismatch');
    }
    const fview = new DataView(footer.buffer, footer.byteOffset, footer.byteLength);
    const storedFooterCrc = fview.getUint32(FOOTER.footerCrc32c, true);
    if (crc32c(footer.subarray(0, FOOTER_CRC_COVERAGE)) !== storedFooterCrc) {
      throw new IntegrityError('.crbm footer CRC mismatch');
    }
    const versionMajor = footer[FOOTER.versionMajor]!;
    if (versionMajor !== VERSION_MAJOR) {
      throw new UnsupportedError(`.crbm major version ${versionMajor} not supported`);
    }
    const flags = fview.getUint32(FOOTER.flags, true);
    const encrypted = (flags & FLAG_ENCRYPTED) !== 0;
    if (encrypted && options.crypto === undefined) {
      throw new ValidationError('.crbm is encrypted but no decryption key (crypto) was provided');
    }
    if ((flags & FLAG_LITTLE_ENDIAN) === 0) {
      throw new UnsupportedError('.crbm big-endian layout not supported (v1 is little-endian)');
    }
    if ((flags & ~KNOWN_FLAGS) !== 0) {
      throw new UnsupportedError(`.crbm has unknown flag bits set: 0x${flags.toString(16)}`);
    }

    // Payload-decoding contract: the
    // reader must decode with the *same* element width, roaring serialization, and container codec the writer
    // stamped — a mismatch means the payloads are a format this v1 (32-bit, portable, uncompressed) reader can't
    // safely deserialize, so reject up front rather than feed them to the 32-bit deserializer and mis-count
    // fleet-wide. A 64-bit generation is the reserved >4.29 B-ids/segment escape and is a **major**-version bump
    // (auto-rejected here), never a silent minor one. All three fields are inside FOOTER_CRC_COVERAGE (verified).
    const elementWidth = footer[FOOTER.elementWidth]!;
    if (elementWidth !== ELEMENT_WIDTH_32) {
      throw new UnsupportedError(
        `.crbm element_width ${elementWidth} not supported (v1 reads 32-bit ids; 64-bit is a future major version)`,
      );
    }
    // Membership, not equality: the field says which codec wrote the payloads, and this reader accepts every
    // id it can actually decode. An unknown one fails closed rather than being handed to a decoder that would
    // misread it — see KNOWN_PAYLOAD_CODEC_IDS for why that direction is the safe one.
    const payloadCodecId = fview.getUint16(FOOTER.payloadCodecId, true);
    if (!KNOWN_PAYLOAD_CODEC_IDS.has(payloadCodecId)) {
      throw new UnsupportedError(
        `.crbm payload_codec_id ${payloadCodecId} not supported by this build ` +
          `(known: ${[...KNOWN_PAYLOAD_CODEC_IDS].join(', ')}; ` +
          `${PAYLOAD_CODEC_ROARING_PORTABLE}=roaring portable). A generation written by a different codec ` +
          `is rejected rather than decoded — a store uses one codec throughout.`,
      );
    }
    const containerCodec = footer[FOOTER.containerCodec]!;
    if (containerCodec !== CONTAINER_CODEC_NONE) {
      throw new UnsupportedError(
        `.crbm container_codec ${containerCodec} not supported (v1 defines only ${CONTAINER_CODEC_NONE}=none)`,
      );
    }

    const indexOffset = readU64(fview, FOOTER.indexOffset, 'index_offset');
    const indexLength = readU64(fview, FOOTER.indexLength, 'index_length');
    const indexCrc = fview.getUint32(FOOTER.indexCrc32c, true);
    const chunkCount = fview.getUint32(FOOTER.chunkCount, true);
    const totalCardinality = readU64(fview, FOOTER.totalCardinality, 'total_cardinality');
    const generation = readU64(fview, FOOTER.generation, 'generation');

    // Bounds + size cap on the index region before trusting/fetching it.
    if (indexOffset < PAYLOAD_START || indexOffset + indexLength > size - FOOTER_BYTES) {
      throw new IntegrityError(
        `.crbm index region [${indexOffset}, +${indexLength}) out of bounds`,
      );
    }
    if (indexLength > maxIndexBytes) {
      throw new IntegrityError(`.crbm index ${indexLength}B exceeds cap ${maxIndexBytes}B`);
    }

    // Validate the front preamble too, but only when this GET already covers it (no extra request).
    const tailCoversFrom = size - tail.length;
    if (tailCoversFrom === 0) {
      if (!magicMatches(tail, 0) || tail[4] !== versionMajor) {
        throw new IntegrityError('.crbm preamble magic/version mismatch with footer');
      }
    }

    // --- Index: already in the tail, or one more GET ---
    let indexBytes: Uint8Array;
    let servedFromTail: boolean;
    if (indexOffset >= tailCoversFrom) {
      const start = indexOffset - tailCoversFrom;
      indexBytes = tail.subarray(start, start + indexLength);
      servedFromTail = true;
    } else {
      indexBytes = await blob.getRange(indexOffset, indexLength);
      servedFromTail = false;
    }
    if (crc32c(indexBytes) !== indexCrc) {
      throw new IntegrityError('.crbm index CRC mismatch');
    }

    // Decrypt the index (nonce/tag from the footer) before parsing; AAD binds it to this (segment, generation).
    // A wrong key / tampered index / wrong context fails here as an IntegrityError — never a wrong parse.
    const indexForParse = encrypted
      ? options.crypto!.aead.open(
          {
            nonce: footer.subarray(FOOTER.indexNonce, FOOTER.indexNonce + AEAD_NONCE_BYTES),
            ciphertext: indexBytes,
            tag: footer.subarray(FOOTER.indexTag, FOOTER.indexTag + AEAD_TAG_BYTES),
          },
          options.crypto!.aadFor('index'),
        )
      : indexBytes;

    const { entries, orderedKeys, cardinalitySum } = parseIndex(
      indexForParse,
      size,
      maxPayloadBytes,
    );
    if (encrypted) {
      // Footer count/cardinality are zeroed on an encrypted object; the decrypted index is authoritative (and
      // already AEAD-authenticated, AAD-bound to this object), so derive the total from it.
      if (chunkCount !== 0 || totalCardinality !== 0) {
        throw new IntegrityError(
          '.crbm encrypted footer must zero chunk_count + total_cardinality',
        );
      }
    } else {
      // F2 (cleartext): the footer total + count must match the index — don't trust the footer blindly.
      if (entries.size !== chunkCount) {
        throw new IntegrityError(
          `.crbm chunk_count ${chunkCount} != ${entries.size} index entries`,
        );
      }
      if (cardinalitySum !== totalCardinality) {
        throw new IntegrityError(
          `.crbm total_cardinality ${totalCardinality} != Σ index cardinality ${cardinalitySum}`,
        );
      }
    }

    return new CrbmReader(
      blob,
      size,
      generation,
      cardinalitySum,
      entries,
      orderedKeys,
      servedFromTail,
      options.crypto,
    );
  }

  /** Chunk keys present in this generation, ascending. */
  chunkKeys(): number[] {
    return this.orderedKeys.slice();
  }

  /** Segment cardinality from the footer (no payload reads) — the cheap `count()` path. */
  count(): number {
    return this.totalCardinality;
  }

  has(chunkKey: number): boolean {
    return this.entries.has(chunkKey);
  }

  /**
   * Range-GET one chunk's payload, verifying its CRC32C before returning. Returns `null` if the chunk is
   * absent. Throws `IntegrityError` on a CRC mismatch (the bytes must never reach the native
   * deserializer). The returned buffer is a **read-only view** owned by the reader/driver — callers must
   * not mutate it.
   */
  async getChunk(chunkKey: number): Promise<Uint8Array | null> {
    const e = this.entries.get(chunkKey);
    if (e === undefined) return null;
    // Re-validate bounds at read time (defense in depth — a buggy caller or future mutable index path).
    if (e.offset < PAYLOAD_START || e.offset + e.length > this.objectSize - FOOTER_BYTES) {
      throw new IntegrityError(`chunk ${chunkKey} payload out of bounds`);
    }
    const bytes = await this.blob.getRange(e.offset, e.length);
    if (crc32c(bytes) !== e.crc32c) {
      throw new IntegrityError(`chunk ${chunkKey} payload CRC mismatch`);
    }
    if (this.crypto === undefined) return bytes;
    // Encrypted: on-disk frame is nonce ‖ ciphertext ‖ tag. Decrypt (AAD-bound to this chunkKey) after the CRC
    // passes — a wrong key / tamper / relocated chunk fails as an IntegrityError, never a wrong payload.
    if (bytes.length < AEAD_NONCE_BYTES + AEAD_TAG_BYTES) {
      throw new IntegrityError(`chunk ${chunkKey} encrypted payload too short`);
    }
    return this.crypto.aead.open(
      {
        nonce: bytes.subarray(0, AEAD_NONCE_BYTES),
        ciphertext: bytes.subarray(AEAD_NONCE_BYTES, bytes.length - AEAD_TAG_BYTES),
        tag: bytes.subarray(bytes.length - AEAD_TAG_BYTES),
      },
      this.crypto.aadFor(chunkKey),
    );
  }
}

// Exported for the coverage-guided fuzz harness (test-strategy T3), which fuzzes the hand-written index parser
// directly on raw bytes — bypassing the CRC wall that mutational fuzzing can't cross. NOT part of the public
// API surface (`src/index.ts`); reached only via `src/testing/fuzz-support.ts` → the gitignored `fuzz/build/`.
export function parseIndex(
  indexBytes: Uint8Array,
  objectSize: number,
  maxPayloadBytes: number,
): { entries: Map<number, CrbmIndexEntry>; orderedKeys: number[]; cardinalitySum: number } {
  const entries = new Map<number, CrbmIndexEntry>();
  const orderedKeys: number[] = [];
  let pos = 0;
  let prevKey = 0;
  let prevEnd = PAYLOAD_START;
  let cardinalitySum = 0;

  // Parse entries until the index region is exactly consumed (chunk_count is hidden on encrypted objects, so
  // the byte length is the bound — readVarint throws on any overrun, so a malformed index fails cleanly).
  for (let i = 0; pos < indexBytes.length; i++) {
    const keyDelta = readVarint(indexBytes, pos);
    const offDelta = readVarint(indexBytes, keyDelta.next);
    const len = readVarint(indexBytes, offDelta.next);
    const card = readVarint(indexBytes, len.next);
    pos = card.next;
    if (pos + CRC32C_BYTES > indexBytes.length) {
      throw new IntegrityError('.crbm index truncated (missing payload CRC)');
    }
    const crc =
      (indexBytes[pos]! |
        (indexBytes[pos + 1]! << 8) |
        (indexBytes[pos + 2]! << 16) |
        (indexBytes[pos + 3]! << 24)) >>>
      0;
    pos += CRC32C_BYTES;

    const chunkKey = prevKey + keyDelta.value;
    const offset = prevEnd + offDelta.value;
    // Unsigned deltas mean keys can only stay flat or rise; a 0 delta after the first is a duplicate.
    if (i > 0 && keyDelta.value === 0) {
      throw new IntegrityError(`.crbm index has a duplicate chunkKey ${chunkKey}`);
    }
    if (chunkKey > 0xffff) throw new IntegrityError(`.crbm chunkKey ${chunkKey} out of range`);
    if (len.value === 0 || len.value > maxPayloadBytes) {
      throw new IntegrityError(`.crbm chunk ${chunkKey} length ${len.value} invalid`);
    }
    if (card.value < 1 || card.value > MAX_CHUNK_CARDINALITY) {
      throw new IntegrityError(`.crbm chunk ${chunkKey} cardinality ${card.value} invalid`);
    }
    if (offset < PAYLOAD_START || offset + len.value > objectSize - FOOTER_BYTES) {
      throw new IntegrityError(`.crbm chunk ${chunkKey} payload out of bounds`);
    }

    entries.set(chunkKey, {
      chunkKey,
      offset,
      length: len.value,
      cardinality: card.value,
      crc32c: crc,
    });
    orderedKeys.push(chunkKey);
    cardinalitySum += card.value;
    prevKey = chunkKey;
    prevEnd = offset + len.value;
  }
  // The loop ends only when pos === indexBytes.length exactly (each entry consumes a whole record; a partial
  // trailing record makes readVarint or the CRC bound throw), so there are never unconsumed trailing bytes.
  return { entries, orderedKeys, cardinalitySum };
}
