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
  payloadCodecId: 24, // u16 — was `roaringSerializationId`; same offset, same width, wider meaning
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
 * **Which codec produced the chunk payloads.** Recorded in the footer, validated on read.
 *
 * `.crbm` is a shared container: the index, the CRC32Cs, the AEAD framing and the generation model are all
 * codec-independent, and **only the chunk payload bytes belong to a flavor** (hence *Chunked Remote BitMap* —
 * see `04-CRBM-FORMAT`). This field is what lets one container hold either, the same way ZIP tags each member
 * with a compression method.
 *
 * **Why this is not named `roaringSerializationId` any more.** It was, and the name was a trap waiting for the
 * `1.0` format freeze. A second codec is genuinely expected — `soaring` is a planned Roaring *variant*, so its
 * serialized bytes are unlikely to be roaring-portable, and it lands *after* `1.0`. A field frozen under a
 * codec-specific name cannot be reinterpreted later without a major format version, so generalizing it is a
 * one-line change now and an expensive one after the freeze. The byte layout is untouched: same offset (24),
 * same width (u16), same golden corpus.
 *
 * **Ids are permanent once published.** Add to {@link KNOWN_PAYLOAD_CODEC_IDS} when a codec ships; never
 * reuse or renumber. Ids are deliberately *not* pre-allocated for codecs that do not exist — a reserved number
 * for an unbuilt codec is a guess about a format nobody has designed.
 */
export const PAYLOAD_CODEC_ROARING_PORTABLE = 1;

/**
 * Every payload codec id this reader can decode.
 *
 * The reader validates membership rather than equality with a single constant. That is the whole point of the
 * generalization: an unknown id is rejected with a typed error naming it, so an old reader meeting a
 * future-codec generation **fails closed** — the correct direction, and the reason a store built on one codec
 * can never silently misread another's bytes as its own. (The homogeneity contract means one store is one
 * codec, so meeting a foreign generation implies misconfiguration, and a loud rejection is exactly what you
 * want there.)
 */
export const KNOWN_PAYLOAD_CODEC_IDS: ReadonlySet<number> = new Set([
  PAYLOAD_CODEC_ROARING_PORTABLE,
]);

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
