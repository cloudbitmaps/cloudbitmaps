/**
 * `CrbmReader` — speculative-tail-read reader for one `.crbm` generation.
 *
 * `open()` fetches the object's tail in **one GET** (footer + usually the whole index), verifies the
 * footer/index CRCs, and parses the delta+varint index into parallel typed arrays. `getChunk()` then range-GETs a single
 * payload and verifies its CRC32C **before** any native deserialize — every byte from storage is
 * untrusted.
 *
 * **Encryption.** When the footer's `FLAG_ENCRYPTED` is set, a {@link CrbmCrypto} must be supplied:
 * the index is AES-256-GCM-decrypted (nonce/tag from the footer) and each chunk payload is decrypted after its
 * on-disk CRC passes. The footer's `chunkCount`/`totalCardinality` are zero on an encrypted object (metadata is
 * hidden), so both are derived from the decrypted index; AEAD authentication (incl. the per-location AAD)
 * replaces the cleartext-count cross-check.
 *
 * **The extension block.** An object whose footer sets `FLAG_EXTENSION` carries an extension block just before the
 * index, found from the trailer at `indexOffset - 12`. `open()` reads it with the index, from the tail or from the same range read,
 * checks its trailer, its CRC32C, its sections and the metadata in them before anything trusts them, and holds payloads
 * to the bytes before it. An object without the flag has no block, and is read exactly as before.
 */
import { IntegrityError, isIntegrityError, UnsupportedError, ValidationError } from '../errors';
import type { BlobReader } from '../blob';
import type { CrbmCrypto } from '../crypto';
import { MAX_METADATA_BYTES, metadataFromBytes } from '../metadata';
import type { ChunkRead, GenerationMetadata } from '../ports';
import { crc32c } from './crc32c';
import { ChunkWindow } from '../chunk-window';
import { validateChunkKeyOrder } from '../validate';
import { MAX_RANGES_IN_FLIGHT, planChunkReads } from './plan-reads';
import type { ChunkExtent, PlannedRead } from './plan-reads';
import { readVarint } from './varint';
import {
  AEAD_NONCE_BYTES,
  AEAD_TAG_BYTES,
  CONTAINER_CODEC_NONE,
  CRC32C_BYTES,
  DEFAULT_MAX_INDEX_BYTES,
  DEFAULT_MAX_BITMAP_BYTES,
  DEFAULT_MAX_PAYLOAD_BYTES,
  DEFAULT_TAIL_BYTES,
  ELEMENT_WIDTH_32,
  EXT_MAGIC,
  EXT_SECTION_HEADER_BYTES,
  EXT_SECTION_METADATA,
  EXT_TRAILER_BYTES,
  FLAG_ENCRYPTED,
  FLAG_EXTENSION,
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
  MAX_EXT_BYTES,
  PAYLOAD_CODEC_ROARING_PORTABLE,
  VERSION_MAJOR,
} from './format';

/**
 * A parsed index as parallel typed arrays, one slot per entry, ascending by key. Typed arrays hold each field at
 * its own width with no per-entry object, so the retained heap is the arrays' byte length and nothing else.
 * `cardinalityMinusOne` stores `cardinality - 1` because a chunk's cardinality runs `[1, 65536]` and 65,536 does
 * not fit a `u16`; an offset is a `f64` because an object past 4 GiB puts a payload beyond a `u32`.
 */
export interface ParsedIndex {
  readonly keys: Uint16Array;
  readonly cardinalityMinusOne: Uint16Array;
  readonly lengths: Uint32Array;
  readonly crcs: Uint32Array;
  readonly offsets: Float64Array;
  /** Σ cardinality over every entry. */
  readonly cardinalitySum: number;
}

/**
 * Retained JS heap for one parsed index entry, in bytes: the `u16` key, the `u16` cardinality-minus-one, the `u32`
 * length, the `u32` CRC and the `f64` offset of {@link ParsedIndex}. It is the exact byte length of the arrays
 * (checked against the measured heap by a test), and weights the reader-cache byte bound
 * ({@link CrbmReader.retainedIndexBytes}).
 */
export const RETAINED_BYTES_PER_INDEX_ENTRY = 20;

/**
 * The weight of a decoded metadata record, per byte of its canonical JSON and per key: what the record retains,
 * measured (`tests/core/crbm/metadata-heap.test.ts`) at about one byte a byte, plus about 130 a key when its keys are
 * unique to it, as each segment's own keys are. Counting both, with room, keeps the reader cache's byte bound honest
 * for the costly shape and over-counts the cheap ones.
 */
const RETAINED_BYTES_PER_METADATA_BYTE = 2;
const RETAINED_BYTES_PER_METADATA_KEY = 160;

/** The fewest bytes one index record takes: four one-byte varints and the four-byte payload CRC. */
const MIN_INDEX_RECORD_BYTES = 4 + CRC32C_BYTES;

/**
 * How many entries `parseIndex` makes room for, from the index's length alone: what its bytes could hold at the
 * smallest record, and never more than one entry per 16-bit key. A hostile index cannot make the reader allocate more.
 */
export function indexCapacity(indexLength: number): number {
  return Math.min(0x1_0000, Math.floor(indexLength / MIN_INDEX_RECORD_BYTES));
}

export interface CrbmReaderOptions {
  /** Speculative tail size in bytes (default 256 KB; clamped up to at least the footer size). */
  readonly tailBytes?: number;
  /** Hard cap on a single chunk payload length (default: the 1 MiB decode cap, plus the 28-byte nonce and tag on an encrypted object). The engine decodes under `maxBitmapBytes`; raise this with it. */
  readonly maxPayloadBytes?: number;
  /** Hard cap on the whole index region fetched/parsed from one object (default 8 MB). */
  readonly maxIndexBytes?: number;
  /**
   * Decryption context for an encrypted object (its DEK's AEAD + AAD builder). Required iff the object's footer sets
   * `FLAG_ENCRYPTED`: an encrypted object opened without one throws {@link ValidationError}, and an object that is
   * not encrypted, opened with one, is refused with {@link IntegrityError}.
   */
  readonly crypto?: CrbmCrypto;
  /**
   * Opaque marker for the *incarnation of the name* this object belongs to — the caller's own identity for the
   * registry row it resolved. The reader never interprets it; it carries it so a caller holding an open reader
   * can tell "the same generation of the same segment" from "the same generation NUMBER of a segment that was
   * deleted and re-created", which the number alone cannot express.
   */
  readonly lineage?: unknown;
}

function magicMatches(bytes: Uint8Array, offset: number): boolean {
  return (
    bytes[offset] === MAGIC[0] &&
    bytes[offset + 1] === MAGIC[1] &&
    bytes[offset + 2] === MAGIC[2] &&
    bytes[offset + 3] === MAGIC[3]
  );
}

/** What names an object: its size, then its footer's CRC. One spelling, for an open reader and a footer read alone. */
const sizePart = (size: number): string => `${size}:`;
/** An object's fingerprint, from its size and its footer's CRC (see {@link CrbmReader.fingerprint}). */
export const fingerprintFor = (size: number, footerCrc: number): string =>
  `${sizePart(size)}${footerCrc}`;

/**
 * Refuses a `size` that is not a whole byte count its own tail fits in. The size is the tier's word too: one that
 * is not would turn off every bounds check an open makes against it.
 */
function checkSize(tail: Uint8Array, size: number): void {
  if (!Number.isSafeInteger(size) || size < tail.length) {
    throw new IntegrityError(`.crbm size is not a byte count its tail fits in: ${size}`);
  }
}

/** The footer at the end of `tail`, once its size, magic and CRC hold, with its view and its CRC. */
function checkedFooter(
  tail: Uint8Array,
  size: number,
): { footer: Uint8Array; fview: DataView; storedFooterCrc: number } {
  checkSize(tail, size);
  if (size < PREAMBLE_BYTES + FOOTER_BYTES || tail.length < FOOTER_BYTES) {
    throw new IntegrityError(`.crbm too small: ${size}B`);
  }
  const footer = tail.subarray(tail.length - FOOTER_BYTES);
  if (!magicMatches(footer, FOOTER.endMagic)) {
    throw new IntegrityError('.crbm end magic mismatch');
  }
  const fview = new DataView(footer.buffer, footer.byteOffset, footer.byteLength);
  const storedFooterCrc = fview.getUint32(FOOTER.footerCrc32c, true);
  if (crc32c(footer.subarray(0, FOOTER_CRC_COVERAGE)) !== storedFooterCrc) {
    throw new IntegrityError('.crbm footer CRC mismatch');
  }
  return { footer, fview, storedFooterCrc };
}

/**
 * Whether the object behind `blob` says it is encrypted, from one tail read of a footer's worth, with no key and no
 * index; a footer that fails its own checks throws, as an open would. For a caller that must not open an object with
 * the key it holds: an erasure looking for an id in a cleartext object under an encrypted segment, and a rollback
 * checking that its target is what the row says.
 */
export async function footerSaysEncrypted(blob: BlobReader): Promise<boolean> {
  const { bytes: tail, size } = await blob.getTail(FOOTER_BYTES);
  const { fview } = checkedFooter(tail, size);
  return (fview.getUint32(FOOTER.flags, true) & FLAG_ENCRYPTED) !== 0;
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
    /** See {@link CrbmReaderOptions.lineage} — carried, never interpreted. */
    readonly lineage: unknown,
    readonly totalCardinality: number,
    private readonly index: ParsedIndex,
    /**
     * True when `open()` satisfied the index, and any extension block, from the tail GET alone (no second range
     * read).
     */
    readonly servedFromTail: boolean,
    /** Set iff the object is encrypted — used to decrypt each chunk payload in {@link getChunk}. */
    private readonly crypto: CrbmCrypto | undefined,
    /** The footer's own CRC, as verified at open: it covers the index's CRC, the chunk count and the generation. */
    private readonly footerCrc: number,
    /**
     * The metadata the generation was written with, checked and decrypted at open; `undefined` when it has none
     * (every format 1.0 object). Frozen: every caller shares one copy.
     */
    readonly metadata: GenerationMetadata | undefined,
    /** What that metadata adds to {@link retainedBytes}; 0 when there is none. */
    private readonly metadataWeight: number,
    /** Where the chunk payloads end: the extension block's start when there is one, else the index's. */
    private readonly payloadEnd: number,
  ) {}

  /**
   * Which object this reader opened, as its size and its footer's CRC. The footer covers the index's CRC, so two
   * objects with the same fingerprint hold the same chunks, as far as a CRC can tell; a pin compares it to know that
   * the object it reopens is the one it pinned, since a purged and reloaded name reuses the generation number.
   */
  get fingerprint(): string {
    return fingerprintFor(this.objectSize, this.footerCrc);
  }

  /** Total object bytes (from the one-GET tail read) — for grounded storage cost. */
  get sizeBytes(): number {
    return this.objectSize;
  }

  /**
   * Retained JS heap of this reader's parsed index — the weight the storage reader cache bounds on (a wide
   * segment's parsed index, not its payloads, dominates the reader's footprint): the exact byte length of the
   * arrays that hold it, {@link RETAINED_BYTES_PER_INDEX_ENTRY} per entry.
   */
  get retainedIndexBytes(): number {
    const { keys, cardinalityMinusOne, lengths, crcs, offsets } = this.index;
    return (
      keys.byteLength +
      cardinalityMinusOne.byteLength +
      lengths.byteLength +
      crcs.byteLength +
      offsets.byteLength
    );
  }

  /**
   * What this reader holds, the weight the storage reader cache bounds on: its parsed index
   * ({@link retainedIndexBytes}), plus a weight for the metadata it decoded, from its canonical length and its number
   * of keys. Equal to {@link retainedIndexBytes} for a generation with no metadata. A cache heuristic, not a contract:
   * how the metadata is weighed may change in any release.
   */
  get retainedBytes(): number {
    return this.retainedIndexBytes + this.metadataWeight;
  }

  /** Per-chunk cardinality (`chunkKey → count`) from the parsed index — no payload reads. */
  cardinalities(): Map<number, number> {
    const { keys, cardinalityMinusOne } = this.index;
    const out = new Map<number, number>();
    for (let i = 0; i < keys.length; i++) out.set(keys[i]!, cardinalityMinusOne[i]! + 1);
    return out;
  }

  /**
   * Whether the object behind `blob` is the one `fingerprint` names ({@link fingerprint}), from one tail read of a
   * footer's worth, with no key and no index, since the footer is stored in the clear and checked by its own CRC.
   * Another size is another object, whatever its bytes hold: a short one that is no `.crbm` at all is not the one
   * pinned. At the same size the footer's CRC says, and a footer that fails its own checks says nothing about which
   * object is there, so this throws, as an open would. What a pin asks, to tell the object it opened from one that
   * has since been stored under its key, whoever wrote it.
   */
  static async sameObject(blob: BlobReader, fingerprint: string): Promise<boolean> {
    const { bytes: tail, size } = await blob.getTail(FOOTER_BYTES);
    checkSize(tail, size);
    if (!fingerprint.startsWith(sizePart(size))) return false;
    return fingerprintFor(size, checkedFooter(tail, size).storedFooterCrc) === fingerprint;
  }

  static async open(blob: BlobReader, options: CrbmReaderOptions = {}): Promise<CrbmReader> {
    // Always fetch at least a footer's worth, regardless of a smaller caller request.
    const tailBytes = Math.max(options.tailBytes ?? DEFAULT_TAIL_BYTES, FOOTER_BYTES);
    const maxIndexBytes = options.maxIndexBytes ?? DEFAULT_MAX_INDEX_BYTES;
    const { bytes: tail, size } = await blob.getTail(tailBytes);
    const { footer, fview, storedFooterCrc } = checkedFooter(tail, size);
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
    // A key is given only for an encrypted segment. A cleartext object under one was never one of its generations:
    // a publish never adds a key to a segment that has generations, and refuses a cleartext object onto a row with
    // one. So it is forged, corrupt, a cleartext write that never published, or one an earlier release published
    // while racing the segment's first keyed load, and its index and metadata are not believed.
    if (!encrypted && options.crypto !== undefined) {
      throw new IntegrityError(
        `.crbm generation ${generation} is not encrypted, but it was opened with a key: a cleartext object where an ` +
          'encrypted one belongs is forged, corrupt, or a write that never published (a crash, before the ' +
          "segment's key was made); a load's collection, dropSegment or deleting the object removes it",
      );
    }
    const versionMinor = footer[FOOTER.versionMinor]!;
    const hasExtension = (flags & FLAG_EXTENSION) !== 0;

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
      if (!magicMatches(tail, 0) || tail[4] !== versionMajor || tail[5] !== versionMinor) {
        throw new IntegrityError('.crbm preamble magic/version mismatch with footer');
      }
    }

    // --- Index: already in the tail, or one more GET ---
    // With the block flagged, the range read starts a whole block's worth before the index, so a block of any size it may hold comes
    // with the index: the block costs bytes, never a request, unless the tail ends inside it.
    const lowest = hasExtension
      ? Math.max(PAYLOAD_START, indexOffset - EXT_TRAILER_BYTES - MAX_EXT_BYTES)
      : indexOffset;
    let region: Uint8Array;
    let regionStart: number;
    let servedFromTail: boolean;
    if (indexOffset >= tailCoversFrom) {
      region = tail;
      regionStart = tailCoversFrom;
      servedFromTail = true;
    } else {
      region = await blob.getRange(lowest, indexOffset + indexLength - lowest);
      regionStart = lowest;
      servedFromTail = false;
    }
    const indexBytes = region.subarray(
      indexOffset - regionStart,
      indexOffset - regionStart + indexLength,
    );
    if (crc32c(indexBytes) !== indexCrc) {
      throw new IntegrityError('.crbm index CRC mismatch');
    }

    // Decrypt the index (nonce/tag from the footer) before parsing; AAD binds it to this (segment, generation).
    // A wrong key / tampered index / wrong context fails here as an IntegrityError — never a wrong parse. Before the
    // extension block, so a wrong key is reported here, as one, and not at the sealed metadata.
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

    // --- Extension block (flagged): sections ‖ u32 sectionsLength ‖ u32 crc32c ‖ "CRBX", just before the index ---
    let payloadEnd = indexOffset;
    let metadata: GenerationMetadata | undefined;
    let metadataLength = 0;
    if (hasExtension) {
      const trailerStart = indexOffset - EXT_TRAILER_BYTES;
      if (trailerStart < PAYLOAD_START) {
        throw new IntegrityError('.crbm flags an extension block, but has no room for one');
      }
      // The block's bytes come from what is already fetched, or, when the tail ends inside the block, from one read.
      let window = { bytes: region, start: regionStart };
      if (trailerStart < regionStart) {
        window = { bytes: await blob.getRange(lowest, indexOffset - lowest), start: lowest };
        servedFromTail = false;
      }
      const trailer = within(window.bytes, window.start, trailerStart, indexOffset);
      const tview = new DataView(trailer.buffer, trailer.byteOffset, trailer.byteLength);
      if (!EXT_MAGIC.every((b, i) => trailer[8 + i] === b)) {
        throw new IntegrityError('.crbm extension block trailer magic mismatch');
      }
      const sectionsLength = tview.getUint32(0, true);
      if (sectionsLength > MAX_EXT_BYTES) {
        throw new IntegrityError(
          `.crbm extension block ${sectionsLength}B exceeds cap ${MAX_EXT_BYTES}B`,
        );
      }
      const extStart = trailerStart - sectionsLength;
      if (extStart < PAYLOAD_START) {
        throw new IntegrityError(`.crbm extension block of ${sectionsLength}B out of bounds`);
      }
      // The CRC covers the sections and the length field after them.
      let covered: Uint8Array;
      if (extStart >= window.start) {
        covered = within(window.bytes, window.start, extStart, trailerStart + 4);
      } else {
        covered = await blob.getRange(extStart, sectionsLength + 4);
        servedFromTail = false;
        if (covered.length !== sectionsLength + 4) {
          throw new IntegrityError('.crbm extension block read short');
        }
      }
      if (crc32c(covered) !== tview.getUint32(4, true)) {
        throw new IntegrityError('.crbm extension block CRC mismatch');
      }
      ({ metadata, metadataLength } = extensionContents(
        covered.subarray(0, sectionsLength),
        options.crypto,
      ));
      payloadEnd = extStart;
    }

    // Payloads live in [PAYLOAD_START, payloadEnd), which ends at the extension block when there is one; an
    // encrypted payload is at least its nonce and tag.
    const index = parseIndex(
      indexForParse,
      payloadEnd,
      options.maxPayloadBytes ?? (encrypted ? DEFAULT_MAX_PAYLOAD_BYTES : DEFAULT_MAX_BITMAP_BYTES),
      encrypted ? AEAD_NONCE_BYTES + AEAD_TAG_BYTES : 1,
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
      // Cleartext: the footer total + count must match the index — don't trust the footer blindly.
      if (index.keys.length !== chunkCount) {
        throw new IntegrityError(
          `.crbm chunk_count ${chunkCount} != ${index.keys.length} index entries`,
        );
      }
      if (index.cardinalitySum !== totalCardinality) {
        throw new IntegrityError(
          `.crbm total_cardinality ${totalCardinality} != Σ index cardinality ${index.cardinalitySum}`,
        );
      }
    }

    return new CrbmReader(
      blob,
      size,
      generation,
      options.lineage,
      index.cardinalitySum,
      index,
      servedFromTail,
      options.crypto,
      storedFooterCrc,
      metadata,
      metadata === undefined
        ? 0
        : RETAINED_BYTES_PER_METADATA_BYTE * metadataLength +
            RETAINED_BYTES_PER_METADATA_KEY * Object.keys(metadata).length,
      payloadEnd,
    );
  }

  /** Chunk keys present in this generation, ascending. */
  chunkKeys(): number[] {
    return Array.from(this.index.keys);
  }

  /** Segment cardinality from the footer (no payload reads) — the cheap `count()` path. */
  count(): number {
    return this.totalCardinality;
  }

  /** The slot holding `chunkKey` (binary search over the ascending keys), or -1 when this generation has none. */
  private slotOf(chunkKey: number): number {
    const keys = this.index.keys;
    let lo = 0;
    let hi = keys.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const k = keys[mid]!;
      if (k === chunkKey) return mid;
      if (k < chunkKey) lo = mid + 1;
      else hi = mid - 1;
    }
    return -1;
  }

  has(chunkKey: number): boolean {
    return this.slotOf(chunkKey) >= 0;
  }

  /**
   * Range-GET one chunk's payload, verifying its CRC32C before returning. Returns `null` if the chunk is
   * absent. Throws `IntegrityError` on a CRC mismatch (the bytes must never reach the native
   * deserializer). The returned buffer is a **read-only view** owned by the reader/driver — callers must
   * not mutate it.
   */
  async getChunk(chunkKey: number): Promise<Uint8Array | null> {
    const slot = this.slotOf(chunkKey);
    if (slot < 0) return null;
    const offset = this.index.offsets[slot]!;
    const length = this.index.lengths[slot]!;
    // Re-validate bounds at read time (defense in depth — a buggy caller or future mutable index path).
    if (offset < PAYLOAD_START || offset + length > this.objectSize - FOOTER_BYTES) {
      throw new IntegrityError(`chunk ${chunkKey} payload out of bounds`);
    }
    return this.openChunk(slot, chunkKey, await this.blob.getRange(offset, length));
  }

  /**
   * Check one chunk's stored bytes against the index, and open them: the CRC32C first, then, on an encrypted object,
   * the AEAD with the chunk's own associated data. The one check every read of a chunk goes through, whether the
   * bytes came from a range of their own or from a slice of a larger one.
   */
  private openChunk(slot: number, chunkKey: number, bytes: Uint8Array): Uint8Array {
    if (crc32c(bytes) !== this.index.crcs[slot]) {
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

  /**
   * The next needed chunk of the range in `cur`, checked and opened, as a stream hands it out; the range is let go of
   * when this is its last chunk.
   */
  private nextChunk(
    cur: { range: LandedRange | undefined; at: number },
    slot: number,
    key: number,
    first: boolean,
  ): Omit<ChunkRead, 'version'> {
    const range = cur.range!;
    const chunk = range.read.chunks[cur.at++]!;
    if (cur.at === range.read.chunks.length) cur.range = undefined;
    const from = chunk.offset - range.read.offset;
    const bytes = this.openChunk(slot, chunk.key, range.bytes.subarray(from, from + chunk.length));
    return first
      ? { key, bytes, request: { bytes: range.read.length, ms: range.ms } }
      : { key, bytes };
  }

  /**
   * Read several chunks as a stream, one storage request per merged range ({@link planChunkReads}) rather than one per
   * chunk. `chunkKeys` are in ascending order, a key may repeat, and anything else is a {@link ValidationError}. One
   * item comes out per position of `chunkKeys`, in order: the chunk's bytes, or `null` where this generation has none,
   * as {@link getChunk} answers for an absent key. A key given twice is read once and answered at both positions with
   * the same view. The first chunk out of each range carries `request`, what that range cost.
   *
   * The whole key list is planned once, up front, against this one generation's index. The ranges then run through a
   * window of `options.concurrency` reads ({@link MAX_RANGES_IN_FLIGHT} by default) that counts a range until the
   * consumer has taken it, so a stream never holds more than that many ranges, in flight or landed, however many keys
   * it was given or how slowly it is read; with `options.ramp` the window opens 1, 2, 4 … wide. A range is at most 1 MiB
   * unless it is one chunk, which is at most the payload cap, so the bound is that many times the per-chunk cap
   * (1 MiB, and 28 bytes more for an encrypted chunk). Nothing is read until the first item is asked for, and a
   * consumer that stops launches no more: ranges already in flight finish and are dropped, and a failure of one of
   * those is never raised.
   *
   * Every chunk is held to the check a read of it alone gets: its slice of the range must match its index entry's
   * CRC32C, and on an encrypted object it opens under its own associated data, so a chunk moved to another place in
   * the object, or another key's bytes, is refused. The bytes in a gap between needed chunks are never parsed. A
   * range that comes back shorter than asked is an {@link IntegrityError}, and a chunk that fails its check ends the
   * stream with that error when its turn comes, as a read of it alone would fail.
   *
   * `options.readRange`, when given, runs each range read, so a caller can retry one request without repeating the
   * others; `options.now` times each request for `request.ms` (a reader has no clock of its own, so 0 without it).
   * A plain chunk is a writable view into the range it was read in: copy a chunk to keep it.
   */
  async *readChunks(
    chunkKeys: readonly number[],
    options: {
      readonly concurrency?: number;
      readonly ramp?: boolean | number;
      readonly readRange?: <T>(read: () => Promise<T>) => Promise<T>;
      readonly now?: () => number;
    } = {},
  ): AsyncGenerator<Omit<ChunkRead, 'version'>> {
    const width = options.concurrency ?? MAX_RANGES_IN_FLIGHT;
    if (!Number.isInteger(width) || width < 1) {
      throw new ValidationError(
        `concurrency must be a positive integer; got ${options.concurrency}`,
      );
    }
    validateChunkKeyOrder(chunkKeys);
    const ramp = options.ramp ?? false;
    if (typeof ramp === 'number' && (!Number.isInteger(ramp) || ramp < 1)) {
      throw new ValidationError(`ramp must be a boolean or a positive integer; got ${ramp}`);
    }
    const readRange = options.readRange ?? (<T>(read: () => Promise<T>): Promise<T> => read());
    const now = options.now ?? ((): number => 0);
    const slots = chunkKeys.map((key) => this.slotOf(key));
    const needed = [...new Set(slots.filter((slot) => slot >= 0))];
    const extents: ChunkExtent[] = needed.map((slot) => ({
      key: this.index.keys[slot]!,
      offset: this.index.offsets[slot]!,
      length: this.index.lengths[slot]!,
    }));
    const reads = planChunkReads(extents, { start: PAYLOAD_START, end: this.payloadEnd });
    let closed = false;
    const window = new ChunkWindow<{ bytes: Uint8Array; ms: number }>(
      reads.map((_, i) => i),
      async (i) => {
        const read = reads[i]!;
        const startedAt = now();
        // Checked before each attempt, so a stream that was abandoned does not go on retrying: an attempt already
        // sent finishes, and nothing further is sent.
        const bytes = await readRange(() => {
          if (closed) throw new StreamClosed();
          return this.blob.getRange(read.offset, read.length);
        });
        if (bytes.length !== read.length) {
          throw new IntegrityError(
            `.crbm range [${read.offset}, +${read.length}) read short (${bytes.length} bytes)`,
          );
        }
        return { bytes, ms: Math.max(0, now() - startedAt) };
      },
      width,
      ramp !== false,
      typeof ramp === 'number' ? ramp : 1,
    );
    let next = 0; // the next range to take
    // The range being handed out, and where in it. It is let go of with its last chunk, before the next range is
    // asked for, so a stream holds `width` ranges and not one more.
    const cur: { range: LandedRange | undefined; at: number } = { range: undefined, at: 0 };
    let last: Omit<ChunkRead, 'version'> | undefined;
    try {
      for (const [i, key] of chunkKeys.entries()) {
        if (slots[i]! < 0) {
          yield { key, bytes: null };
          continue;
        }
        if (last !== undefined && last.key === key) {
          yield { key, bytes: last.bytes };
          if (chunkKeys[i + 1] !== key) last = undefined;
          continue;
        }
        last = undefined;
        let first = false;
        if (cur.range === undefined) {
          const taken = await window.take();
          cur.range = { read: reads[next++]!, ...taken };
          cur.at = 0;
          first = true;
        }
        // Built by a call of its own and handed straight out, so no local of this loop keeps the chunk, or the range
        // it is a view into, alive while the consumer is slow.
        if (chunkKeys[i + 1] === key) {
          last = this.nextChunk(cur, slots[i]!, key, first);
          yield last;
        } else {
          yield this.nextChunk(cur, slots[i]!, key, first);
        }
      }
    } catch (err) {
      // A failed stream lets the reads it still has in flight settle before the error goes on, so a caller that
      // carries on (the source, which heals) does not have those and a new window open at once. They send no
      // retry of their own.
      closed = true;
      await window.settle();
      throw err;
    } finally {
      closed = true;
    }
  }
}

/** A range that has landed, with the needed chunks it carries. */
interface LandedRange {
  readonly read: PlannedRead;
  readonly bytes: Uint8Array;
  readonly ms: number;
}

/** Raised inside a range read of a stream that was abandoned or failed, so a retrying runner stops. Never surfaces. */
class StreamClosed extends Error {
  constructor() {
    super('the chunk stream was closed');
  }
}

/** `bytes[from, to)` of a buffer that starts at object offset `start`, or an IntegrityError when it holds less. */
function within(bytes: Uint8Array, start: number, from: number, to: number): Uint8Array {
  if (from < start || to > start + bytes.length) {
    throw new IntegrityError('.crbm extension block read short');
  }
  return bytes.subarray(from - start, to - start);
}

function extensionCorrupt(message: string): never {
  throw new IntegrityError(`.crbm extension block: ${message}`);
}

/**
 * Read the sections of an extension block, its bytes before the trailer, once their CRC has passed. Each section is
 * `u8 type ‖ u32 length ‖ bytes`, in strictly ascending type order, and together they fill the region exactly. Type 1
 * is the generation's metadata, held to the metadata rules and its canonical form (and opened first with `crypto`,
 * under the metadata scope, when the object is encrypted); a type this build does not know is a later build's, and
 * is skipped. Returns the metadata, or `undefined` when the block has none. Every other shape is an
 * {@link IntegrityError}.
 *
 * Exported for the coverage-guided fuzz harness, which drives it directly, past the block's CRC; not public API.
 */
export function parseExtension(
  sections: Uint8Array,
  crypto: CrbmCrypto | undefined,
): GenerationMetadata | undefined {
  return extensionContents(sections, crypto).metadata;
}

/** {@link parseExtension}'s walk, with the canonical length of the metadata it decoded, for the reader's weight. */
function extensionContents(
  sections: Uint8Array,
  crypto: CrbmCrypto | undefined,
): { metadata: GenerationMetadata | undefined; metadataLength: number } {
  const view = new DataView(sections.buffer, sections.byteOffset, sections.byteLength);
  let metadata: GenerationMetadata | undefined;
  let metadataLength = 0;
  let lastType = 0;
  let pos = 0;
  while (pos < sections.length) {
    if (sections.length - pos < EXT_SECTION_HEADER_BYTES)
      extensionCorrupt('a section header is cut off');
    const type = sections[pos]!;
    const length = view.getUint32(pos + 1, true);
    pos += EXT_SECTION_HEADER_BYTES;
    // Starting from 0 refuses type 0, a repeated type and a type out of order with one comparison.
    if (type <= lastType) {
      extensionCorrupt(
        type === 0
          ? 'section type 0 is not a section type'
          : `section type ${type} after ${lastType}`,
      );
    }
    if (length > sections.length - pos) extensionCorrupt(`section ${type} runs past the block`);
    const body = sections.subarray(pos, pos + length);
    pos += length;
    lastType = type;
    if (type === EXT_SECTION_METADATA)
      ({ metadata, metadataLength } = metadataSection(body, crypto));
  }
  return { metadata, metadataLength };
}

/** The metadata section's record: its canonical JSON, opened first when the object is encrypted. */
function metadataSection(
  body: Uint8Array,
  crypto: CrbmCrypto | undefined,
): { metadata: GenerationMetadata; metadataLength: number } {
  if (crypto === undefined) {
    return { metadata: metadataFromBytes(body, extensionCorrupt), metadataLength: body.length };
  }
  const framing = AEAD_NONCE_BYTES + AEAD_TAG_BYTES;
  if (body.length <= framing || body.length > framing + MAX_METADATA_BYTES) {
    extensionCorrupt(`sealed metadata of ${body.length}B is not a nonce, up to 1 KiB and a tag`);
  }
  let plain: Uint8Array;
  try {
    plain = crypto.aead.open(
      {
        nonce: body.subarray(0, AEAD_NONCE_BYTES),
        ciphertext: body.subarray(AEAD_NONCE_BYTES, body.length - AEAD_TAG_BYTES),
        tag: body.subarray(body.length - AEAD_TAG_BYTES),
      },
      crypto.aadFor('metadata'),
    );
  } catch (err) {
    if (!isIntegrityError(err)) throw err;
    // The index has opened under the same key and generation, so the key is right: the causes left are these, and a
    // CrbmCrypto written before the extension block existed, which maps only chunk keys and the index, is one of them.
    extensionCorrupt(
      "the sealed metadata does not open: tampered bytes, a block moved from another object, or a CrbmCrypto whose aadFor does not map the 'metadata' scope",
    );
  }
  return { metadata: metadataFromBytes(plain, extensionCorrupt), metadataLength: plain.length };
}

// Exported for the coverage-guided fuzz harness, which fuzzes the hand-written index parser
// directly on raw bytes — bypassing the CRC wall that mutational fuzzing can't cross. NOT part of the public
// API surface (`src/index.ts`); reached only via `src/testing/fuzz-core.ts` → the gitignored `fuzz/build/`.
//
// This is where an index is checked for internal consistency, once per open: `count()` and every other read that
// answers from the index alone trust what it records without decoding a payload. Every entry's key is in range
// and strictly above the last; its cardinality is in `[1, 65536]`; its payload is non-empty (at least
// `minPayloadBytes`), within `maxPayloadBytes`, and lies inside the payload region `[PAYLOAD_START, payloadEnd)`.
// Offsets are stored as unsigned gaps after the previous payload, so payloads ascend and never overlap by
// construction. `open` then holds the sum and the count to the footer's, where the footer records them.
//
// Not checked here, because the format does not record enough: an encrypted footer hides the count and the total
// (the index's AEAD tag stands in for them), and a cardinality is not compared with its payload, since only the
// codec can read a payload, and no read compares them afterwards: a payload whose bits disagree with its entry's
// cardinality decodes to what it holds, and `count()` still reports the entry's.
export function parseIndex(
  indexBytes: Uint8Array,
  payloadEnd: number,
  maxPayloadBytes: number,
  minPayloadBytes = 1,
): ParsedIndex {
  // The arrays are sized from what the index could hold, never from what it claims: every record takes at least
  // MIN_INDEX_RECORD_BYTES and keys are unique within 16 bits, so a hostile index cannot make this allocate more
  // than its own bytes (and 65,536 slots) could fill.
  const capacity = indexCapacity(indexBytes.length);
  const keys = new Uint16Array(capacity);
  const cardinalityMinusOne = new Uint16Array(capacity);
  const lengths = new Uint32Array(capacity);
  const crcs = new Uint32Array(capacity);
  const offsets = new Float64Array(capacity);
  let count = 0;
  let pos = 0;
  let prevKey = 0;
  let prevEnd = PAYLOAD_START;
  let cardinalitySum = 0;

  // Parse entries until the index region is exactly consumed (chunk_count is hidden on encrypted objects, so
  // the byte length is the bound — readVarint throws on any overrun, so a malformed index fails cleanly).
  for (let i = 0; pos < indexBytes.length; i++) {
    const keyDeltaRead = readVarint(indexBytes, pos);
    const offDeltaRead = readVarint(indexBytes, keyDeltaRead.next);
    const lenRead = readVarint(indexBytes, offDeltaRead.next);
    const cardRead = readVarint(indexBytes, lenRead.next);
    const keyDelta = keyDeltaRead.value;
    const offDelta = offDeltaRead.value;
    const len = lenRead.value;
    const card = cardRead.value;
    pos = cardRead.next;
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

    const chunkKey = prevKey + keyDelta;
    const offset = prevEnd + offDelta;
    // Unsigned deltas mean keys can only stay flat or rise; a 0 delta after the first is a duplicate.
    if (i > 0 && keyDelta === 0) {
      throw new IntegrityError(`.crbm index has a duplicate chunkKey ${chunkKey}`);
    }
    if (chunkKey > 0xffff) throw new IntegrityError(`.crbm chunkKey ${chunkKey} out of range`);
    if (len < minPayloadBytes || len > maxPayloadBytes) {
      throw new IntegrityError(
        `.crbm chunk ${chunkKey} length ${len} invalid (most is ${maxPayloadBytes})`,
      );
    }
    if (card < 1 || card > MAX_CHUNK_CARDINALITY) {
      throw new IntegrityError(`.crbm chunk ${chunkKey} cardinality ${card} invalid`);
    }
    // `offset` cannot start below the preamble: it is the previous payload's end plus an unsigned gap.
    if (offset + len > payloadEnd) {
      throw new IntegrityError(`.crbm chunk ${chunkKey} payload out of bounds`);
    }

    keys[count] = chunkKey;
    cardinalityMinusOne[count] = card - 1;
    lengths[count] = len;
    crcs[count] = crc;
    offsets[count] = offset;
    count++;
    cardinalitySum += card;
    prevKey = chunkKey;
    prevEnd = offset + len;
  }
  // The loop ends only when pos === indexBytes.length exactly (each entry consumes a whole record; a partial
  // trailing record makes readVarint or the CRC bound throw), so there are never unconsumed trailing bytes.
  // Trim to the entries parsed, so the arrays' byte length is exactly what the reader retains.
  if (count === capacity) {
    return { keys, cardinalityMinusOne, lengths, crcs, offsets, cardinalitySum };
  }
  return {
    keys: keys.slice(0, count),
    cardinalityMinusOne: cardinalityMinusOne.slice(0, count),
    lengths: lengths.slice(0, count),
    crcs: crcs.slice(0, count),
    offsets: offsets.slice(0, count),
    cardinalitySum,
  };
}
