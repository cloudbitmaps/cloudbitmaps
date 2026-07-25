/**
 * Frozen `.crbm` v1.0 layout constants.
 *
 * These byte widths/offsets are pinned by the Phase-2a golden corpus and must never change for v1 —
 * a new layout is a new format version. All multi-byte integers are little-endian (v1 fixes LE).
 */

/** 4-byte magic at both file ends: "CRBM". */
export const MAGIC = Uint8Array.of(0x43, 0x52, 0x42, 0x4d);

export const VERSION_MAJOR = 1;
export const VERSION_MINOR = 0;

/** Front preamble: magic(4) + version_major(1) + version_minor(1) + reserved(2). */
export const PREAMBLE_BYTES = 8;

/** Payloads begin immediately after the preamble. */
export const PAYLOAD_START = PREAMBLE_BYTES;

/** Fixed footer size (v1.0). */
export const FOOTER_BYTES = 104;

/** Byte offsets of each field within the 104-byte footer. */
export const FOOTER = {
  indexOffset: 0, // u64
  indexLength: 8, // u64
  indexCrc32c: 16, // u32
  flags: 20, // u32
  roaringSerializationId: 24, // u16
  elementWidth: 26, // u8
  containerCodec: 27, // u8
  versionMajor: 28, // u8
  versionMinor: 29, // u8
  reserved2: 30, // u16
  generation: 32, // u64
  indexNonce: 40, // 12 B
  indexTag: 52, // 16 B
  keyId: 68, // 16 B
  chunkCount: 84, // u32
  totalCardinality: 88, // u64
  footerCrc32c: 96, // u32 — covers footer bytes [0, 96)
  endMagic: 100, // char[4]
} as const;

/** Footer bytes covered by `footer_crc32c` (everything before the CRC field). */
export const FOOTER_CRC_COVERAGE = FOOTER.footerCrc32c; // 96

/** `flags` bit positions. */
export const FLAG_ENCRYPTED = 1 << 0;
export const FLAG_INDEX_COMPRESSED = 1 << 1; // reserved
export const FLAG_LITTLE_ENDIAN = 1 << 2; // =1 in v1

/** Flag bits a v1 reader understands; any bit outside this mask is an unsupported feature. */
export const KNOWN_FLAGS = FLAG_ENCRYPTED | FLAG_LITTLE_ENDIAN;

/**
 * Default element width: 32-bit ids (the u32 member space). `64` is the *reserved* escape above the
 * ~4.29 B-ids/segment u32 ceiling; a v1 (32-bit) reader must **reject** a 64-bit generation rather than feed
 * it to the 32-bit deserializer (which would mis-count fleet-wide). A future 64-bit generation is therefore a
 * **major**-version bump (auto-rejected by old readers), never a silent minor one — see
 * {@link CrbmReader.open} validates this.
 */
export const ELEMENT_WIDTH_32 = 32;

/**
 * CRoaring "portable" serialization id recorded in the footer. Phase 1's `SafeBitmap` serializes with
 * the portable format; this records that choice so a reader can confirm it can decode the payloads. A
 * generation stamped with any other id is rejected ({@link UnsupportedError}) — a different serialization is
 * a format change, not a payload a v1 reader may guess at.
 */
export const ROARING_PORTABLE_ID = 1;

/**
 * The only container codec v1 defines: `0` = none (payloads are stored as the portable roaring serialization
 * with no extra container-level transform). A non-zero codec is a future format feature; a v1 reader rejects
 * it ({@link UnsupportedError}) rather than mis-decode. Stamped by the writer, validated by the reader.
 */
export const CONTAINER_CODEC_NONE = 0;

/**
 * Default speculative-tail-read size. The spec's worst-case index (a full 16-bit span) is ~400–650 KB,
 * so 256 KB collapses the read to a single GET for the vast majority of real (sparse/medium) segments;
 * only near-full-span segments take the documented second GET.
 */
export const DEFAULT_TAIL_BYTES = 256 * 1024;

/**
 * Hard cap on the index region a reader will fetch/parse from one (untrusted) object. The index is read
 * whole on the cheap `open()`/`count()` path, so it must be bounded before allocation — generously
 * above the ~650 KB full-span worst case, well below a denial-of-wallet allocation.
 */
export const DEFAULT_MAX_INDEX_BYTES = 8 * 1024 * 1024;

/** Hard cap on a single chunk payload, defending the native deserializer against oversized input. */
export const DEFAULT_MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;

/** A chunk's cardinality is in `[1, 65536]` (empty chunks are never written). */
export const MAX_CHUNK_CARDINALITY = 0x1_0000;

/** Fixed width of a per-chunk CRC32C field in the index (high-entropy → not varint). */
export const CRC32C_BYTES = 4;

/**
 * v1 AEAD framing sizes (AES-256-GCM), fixed by the format exactly like the roaring serialization id — a
 * different cipher is a new format version. An encrypted chunk payload is stored as `nonce ‖ ciphertext ‖ tag`;
 * the encrypted **index**'s nonce/tag live in the footer's reserved `indexNonce`/`indexTag` slots. Matches
 * {@link FOOTER.indexNonce} (12 B) and {@link FOOTER.indexTag} (16 B).
 */
export const AEAD_NONCE_BYTES = 12;
export const AEAD_TAG_BYTES = 16;
