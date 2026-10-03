/**
 * Frozen `.crbm` v1 layout constants (format 1.0, with its optional extension block).
 *
 * These byte widths/offsets are pinned by the golden corpus and must never change for v1 —
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
  payloadCodecId: 24, // u16 — which codec wrote the chunk payloads
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
/**
 * The object carries an extension block just before its index (a generation's metadata). Set only when there is
 * something to put in it, so an object without metadata is the same bytes as before the block existed; a reader that
 * does not know the bit refuses the object rather than reading past what it cannot see.
 */
export const FLAG_EXTENSION = 1 << 3;

/** Flag bits a v1 reader understands; any bit outside this mask is an unsupported feature. */
export const KNOWN_FLAGS = FLAG_ENCRYPTED | FLAG_LITTLE_ENDIAN | FLAG_EXTENSION;

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
 * see the `.crbm` format section of the API reference). This field is what lets one container hold either, the same way ZIP tags each member
 * with a compression method.
 *
 * **A codec id, not a roaring-specific one.** A second codec is genuinely expected — `soaring` is a planned
 * Roaring *variant*, so its serialized bytes are unlikely to be roaring-portable, and it lands *after* the `1.0`
 * format freeze. A field frozen under a codec-specific meaning could not be reinterpreted later without a major
 * format version.
 *
 * **Ids are permanent once published.** Add to {@link KNOWN_PAYLOAD_CODEC_IDS} when a codec ships; never
 * reuse or renumber. Ids are deliberately *not* pre-allocated for codecs that do not exist — a reserved number
 * for an unbuilt codec is a guess about a format nobody has designed.
 */
export const PAYLOAD_CODEC_ROARING_PORTABLE = 1;

/**
 * Every payload codec id this reader can decode.
 *
 * The reader validates membership rather than equality with a single constant. That is the whole point of an
 * id registry: an unknown id is rejected with a typed error naming it, so an old reader meeting a
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

/**
 * The extension block, present when the footer sets {@link FLAG_EXTENSION}: `section* ‖ u32 sectionsLength ‖ u32
 * crc32c ‖ "CRBX"`, between the last payload and the index, so the index starts right after it. A reader finds it from
 * `indexOffset`: the trailer is the {@link EXT_TRAILER_BYTES} bytes before the index, and the CRC32C covers the sections
 * and the length field. Each section is `u8 type ‖ u32 length ‖ bytes`, in strictly ascending type order; a reader
 * skips a type it does not know, so a section must be safe to ignore.
 */
export const EXT_MAGIC = Uint8Array.of(0x43, 0x52, 0x42, 0x58); // "CRBX"
/** The trailer: the sections' length (u32), their CRC32C (u32) and {@link EXT_MAGIC}. */
export const EXT_TRAILER_BYTES = 12;
/** A section's header: its type (u8) and its length (u32). */
export const EXT_SECTION_HEADER_BYTES = 5;
/**
 * Cap on the sections of one block, in bytes. A reader refuses a larger block from its trailer alone, before it reads
 * any sections beyond what it already holds (the read that brings the index may already hold up to this much before
 * it), and a writer of any 1.x minor keeps within it, so a later section type stays readable by this reader.
 */
export const MAX_EXT_BYTES = 4 * 1024;
/**
 * Section type 1: the generation's metadata, its canonical JSON in UTF-8. On an encrypted object the section is
 * `nonce ‖ ciphertext ‖ tag`, sealed under the segment's key with the metadata scope of the associated data.
 * Type 0 is not a section type: a reader refuses it.
 */
export const EXT_SECTION_METADATA = 1;

/** Fixed width of a per-chunk CRC32C field in the index (high-entropy → not varint). */
export const CRC32C_BYTES = 4;

/**
 * v1 AEAD framing sizes (AES-256-GCM), fixed by the format exactly like the payload codec id — a
 * different cipher is a new format version. An encrypted chunk payload is stored as `nonce ‖ ciphertext ‖ tag`;
 * the encrypted **index**'s nonce/tag live in the footer's reserved `indexNonce`/`indexTag` slots. Matches
 * {@link FOOTER.indexNonce} (12 B) and {@link FOOTER.indexTag} (16 B).
 */
export const AEAD_NONCE_BYTES = 12;
export const AEAD_TAG_BYTES = 16;
