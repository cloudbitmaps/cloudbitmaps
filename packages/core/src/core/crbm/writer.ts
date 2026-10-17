/**
 * `CrbmWriter` — streaming, constant-memory writer for one immutable `.crbm` generation.
 *
 * Chunks are appended in **ascending chunkKey order**; the writer holds only the small index in memory
 * (offsets aren't known until payloads are written — which is exactly why the index is a footer).
 *
 * **Encryption (opt-in via `crypto`).** When a {@link CrbmCrypto} is supplied, each chunk payload is
 * AES-256-GCM-sealed (`nonce ‖ ciphertext ‖ tag`, AAD = its chunkKey) and the whole index is sealed too (its
 * nonce/tag go in the footer). The footer then sets `FLAG_ENCRYPTED` and **zeroes `chunkCount` +
 * `totalCardinality`**, so neither number is stored in the clear — the reader derives both from the decrypted
 * index. Nothing is padded: the index's length bounds the number of chunks (an entry is 8 to 24 bytes) and the
 * payload region's length bounds the set's size. The per-chunk CRC covers the *encrypted* on-disk bytes.
 *
 * **Metadata (opt-in via `metadata`).** A generation given metadata carries an extension block between the last payload
 * and the index, flagged in the footer (`FLAG_EXTENSION`), holding the metadata's canonical JSON, sealed like the index
 * when the generation is encrypted. Without metadata the bytes are exactly those of an object written before the
 * block existed, apart from the footer's write identity.
 *
 * **Write identity.** Every generation's footer `indexNonce` is random per write: for an encrypted one it is the index's
 * AEAD nonce, for a cleartext one it is 12 bytes drawn from the injected `entropy`. The footer CRC covers it, so an
 * object's fingerprint names one write, never just a set of ids.
 */
import { ValidationError } from '../errors';
import type { Entropy } from '../determinism';
import type { AeadSealed, CrbmCrypto } from '../crypto';
import { metadataBytes } from '../metadata';
import type { GenerationMetadata } from '../ports';
import { requireInteger } from '../check';
import { crc32c } from './crc32c';
import { varintLength, writeVarintAt } from './varint';
import type { BlobSink } from '../blob';
import {
  AEAD_NONCE_BYTES,
  DEFAULT_MAX_BITMAP_BYTES,
  CONTAINER_CODEC_NONE,
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
  MAGIC,
  MAX_CHUNK_CARDINALITY,
  PAYLOAD_START,
  PREAMBLE_BYTES,
  PAYLOAD_CODEC_ROARING_PORTABLE,
  VERSION_MAJOR,
  VERSION_MINOR,
} from './format';

export interface CrbmWriterOptions {
  /** Self-describing generation number (also encoded in the object key). */
  readonly generation: number;
  /**
   * Which codec produced the chunk payloads. Defaults to {@link PAYLOAD_CODEC_ROARING_PORTABLE}.
   *
   * A codec id rather than a roaring-specific one, because `.crbm` is a shared container and a second codec is
   * expected before the format freezes.
   */
  readonly payloadCodecId?: number;
  readonly elementWidth?: number;
  /** When set, payloads + index are AES-256-GCM-encrypted, bound to `(segment, generation, scope)` via AAD. */
  readonly crypto?: CrbmCrypto;
  /**
   * Where the write's identity comes from: a cleartext generation draws 12 bytes from it, once, when the writer is
   * constructed (so a source that is missing or returns the wrong shape fails before the first byte is written),
   * and stores them in the footer's `indexNonce` slot, so two writes of the same ids at the same number are not the
   * same object. An encrypted generation draws nothing here: the slot already holds the index's AEAD nonce, which
   * `crypto` drew for that seal. Required, so a writer cannot be built that leaves the slot zero: a zero slot names
   * no write, and the reader still accepts one.
   */
  readonly entropy: Entropy;
  /**
   * The generation's metadata, checked against the metadata rules and copied as its canonical JSON when the writer
   * is constructed, so a later change to the caller's object never reaches the object. A value that breaks a rule
   * throws {@link ValidationError} from the constructor, before a byte is written. None, or the empty object, writes
   * format 1.0.
   */
  readonly metadata?: GenerationMetadata;
}

interface IndexEntry {
  readonly chunkKey: number;
  readonly offset: number;
  readonly length: number;
  readonly cardinality: number;
  readonly crc32c: number;
}

export class CrbmWriter {
  private readonly entries: IndexEntry[] = [];
  private offset = PAYLOAD_START;
  private lastKey = -1;
  private totalCardinality = 0;
  private preambleWritten = false;
  private finished = false;
  /** The metadata's canonical JSON, copied at construction; `undefined` leaves the footer's extension flag clear. */
  private readonly metadata: Uint8Array | undefined;
  /** Bytes written so far, the footer included once {@link finish} has run. */
  private written = 0;
  /** Where the chunk payloads end: the extension block's start when there is metadata, else the index's. */
  private payloadEnd = 0;
  private footerCrc32c: number | undefined;
  /** A cleartext generation's write identity, drawn at construction; `undefined` for an encrypted one. */
  private readonly writeIdentity: Uint8Array | undefined;

  constructor(
    private readonly sink: BlobSink,
    private readonly options: CrbmWriterOptions,
  ) {
    requireInteger(options.generation, { min: 0, what: 'generation' });
    this.metadata = metadataBytes(options.metadata, (message) => {
      throw new ValidationError(message);
    });
    this.writeIdentity =
      options.crypto === undefined ? drawWriteIdentity(options.entropy) : undefined;
  }

  /**
   * Append one chunk's payload (the roaring-serialized bytes) with its cardinality. `chunkKey` must be
   * strictly greater than the previous one (ascending, no duplicates); `cardinality` is `[1, 65536]`.
   */
  async addChunk(chunkKey: number, payload: Uint8Array, cardinality: number): Promise<void> {
    if (this.finished) throw new ValidationError('CrbmWriter already finished');
    if (!Number.isInteger(chunkKey) || chunkKey < 0 || chunkKey > 0xffff) {
      throw new ValidationError(`chunkKey must be a u16; got ${chunkKey}`);
    }
    if (chunkKey <= this.lastKey) {
      throw new ValidationError(
        `chunkKey ${chunkKey} not strictly ascending (last ${this.lastKey})`,
      );
    }
    if (!Number.isInteger(cardinality) || cardinality < 1 || cardinality > MAX_CHUNK_CARDINALITY) {
      throw new ValidationError(
        `cardinality must be in [1, ${MAX_CHUNK_CARDINALITY}]; got ${cardinality}`,
      );
    }
    if (payload.length === 0) throw new ValidationError('chunk payload must be non-empty');
    // Past the decode cap every reader refuses the object at open: refused here, before anything is written.
    if (payload.length > DEFAULT_MAX_BITMAP_BYTES) {
      throw new ValidationError(
        `chunk payload of ${payload.length} bytes is over the ${DEFAULT_MAX_BITMAP_BYTES}-byte cap a reader opens`,
      );
    }

    await this.ensurePreamble();
    // Encrypt (if configured) to the on-disk bytes; the CRC + index length cover what actually lands on disk.
    const crypto = this.options.crypto;
    const stored = crypto ? framed(crypto.aead.seal(payload, crypto.aadFor(chunkKey))) : payload;
    await this.sink.write(stored);
    this.entries.push({
      chunkKey,
      offset: this.offset,
      length: stored.length,
      cardinality,
      crc32c: crc32c(stored),
    });
    this.offset += stored.length;
    this.totalCardinality += cardinality;
    this.lastKey = chunkKey;
  }

  /**
   * Write the extension block (when there is metadata), the index region and the fixed footer. After this the object
   * is complete and immutable.
   */
  async finish(): Promise<void> {
    if (this.finished) throw new ValidationError('CrbmWriter already finished');
    await this.ensurePreamble();
    this.payloadEnd = this.offset;

    if (this.metadata !== undefined) {
      const block = this.extensionBlock(this.metadata);
      await this.sink.write(block);
      this.offset += block.length;
    }

    const indexPlain = this.encodeIndex();
    // Encrypt the index too (its nonce/tag go in the footer); a leaked object then reveals no chunk metadata.
    let indexRegion = indexPlain;
    let indexNonce: Uint8Array | undefined;
    let indexTag: Uint8Array | undefined;
    if (this.options.crypto !== undefined) {
      const sealed = this.options.crypto.aead.seal(indexPlain, this.options.crypto.aadFor('index'));
      indexRegion = sealed.ciphertext;
      indexNonce = sealed.nonce;
      indexTag = sealed.tag;
    } else {
      // A cleartext generation's slot is its write identity: footer CRC covers it, so the object's fingerprint, and
      // every proof that compares one, names this write and not just these ids.
      indexNonce = this.writeIdentity;
    }
    const indexOffset = this.offset;
    await this.sink.write(indexRegion);
    this.offset += indexRegion.length;

    const footer = this.buildFooter(indexOffset, indexRegion, indexNonce, indexTag);
    await this.sink.write(footer);
    this.written = this.offset + footer.length;
    this.footerCrc32c = new DataView(footer.buffer, footer.byteOffset).getUint32(
      FOOTER.footerCrc32c,
      true,
    );
    this.finished = true;
  }

  /**
   * The finished object's size and its footer's CRC: what names it, as a reader's fingerprint does. A writer that
   * has to tell its own object from another stored later under the same key compares these with the object's
   * footer. `tailBytes` is the bytes after the chunk payloads (any extension block, the index and the footer), which
   * is what {@link CrbmReader.tailBytes} reports for the object. Throws before {@link finish}.
   */
  get identity(): {
    readonly size: number;
    readonly footerCrc: number;
    readonly tailBytes: number;
  } {
    if (this.footerCrc32c === undefined) throw new ValidationError('CrbmWriter not finished');
    return {
      size: this.written,
      footerCrc: this.footerCrc32c,
      tailBytes: this.written - this.payloadEnd,
    };
  }

  private async ensurePreamble(): Promise<void> {
    if (this.preambleWritten) return;
    const preamble = new Uint8Array(PREAMBLE_BYTES);
    preamble.set(MAGIC, 0);
    preamble[4] = VERSION_MAJOR;
    preamble[5] = VERSION_MINOR;
    // bytes 6-7 reserved = 0
    await this.sink.write(preamble);
    this.preambleWritten = true;
  }

  /**
   * The extension block: one metadata section (`u8 type ‖ u32 length ‖ bytes`), then the trailer
   * (`u32 sectionsLength ‖ u32 crc32c(sections ‖ sectionsLength) ‖ "CRBX"`). Encrypted, the section holds
   * `nonce ‖ ciphertext ‖ tag`, sealed with the metadata scope of the associated data.
   */
  private extensionBlock(metadata: Uint8Array): Uint8Array {
    const crypto = this.options.crypto;
    const body = crypto ? framed(crypto.aead.seal(metadata, crypto.aadFor('metadata'))) : metadata;
    const sectionsLength = EXT_SECTION_HEADER_BYTES + body.length;
    const block = new Uint8Array(sectionsLength + EXT_TRAILER_BYTES);
    const view = new DataView(block.buffer);
    block[0] = EXT_SECTION_METADATA;
    view.setUint32(1, body.length, true);
    block.set(body, EXT_SECTION_HEADER_BYTES);
    view.setUint32(sectionsLength, sectionsLength, true);
    view.setUint32(sectionsLength + 4, crc32c(block.subarray(0, sectionsLength + 4)), true);
    block.set(EXT_MAGIC, sectionsLength + 8);
    return block;
  }

  /**
   * The index region: per entry, four varints (key delta, offset gap, length, cardinality) and a fixed 4-byte
   * little-endian crc32c. A first pass sizes the region exactly, so the bytes are written once into one buffer and no
   * intermediate array is built.
   */
  private encodeIndex(): Uint8Array {
    let size = 0;
    let prevKey = 0;
    let prevEnd = PAYLOAD_START;
    for (const e of this.entries) {
      size +=
        varintLength(e.chunkKey - prevKey) +
        varintLength(e.offset - prevEnd) +
        varintLength(e.length) +
        varintLength(e.cardinality) +
        4;
      prevKey = e.chunkKey;
      prevEnd = e.offset + e.length;
    }
    const out = new Uint8Array(size);
    let pos = 0;
    prevKey = 0;
    prevEnd = PAYLOAD_START;
    for (const e of this.entries) {
      pos = writeVarintAt(out, pos, e.chunkKey - prevKey);
      pos = writeVarintAt(out, pos, e.offset - prevEnd);
      pos = writeVarintAt(out, pos, e.length);
      pos = writeVarintAt(out, pos, e.cardinality);
      // crc32c is high-entropy → fixed 4-byte LE, not varint.
      out[pos++] = e.crc32c & 0xff;
      out[pos++] = (e.crc32c >>> 8) & 0xff;
      out[pos++] = (e.crc32c >>> 16) & 0xff;
      out[pos++] = (e.crc32c >>> 24) & 0xff;
      prevKey = e.chunkKey;
      prevEnd = e.offset + e.length;
    }
    return out;
  }

  private buildFooter(
    indexOffset: number,
    indexRegion: Uint8Array,
    indexNonce: Uint8Array | undefined,
    indexTag: Uint8Array | undefined,
  ): Uint8Array {
    const encrypted = this.options.crypto !== undefined;
    const footer = new Uint8Array(FOOTER_BYTES);
    const view = new DataView(footer.buffer);
    view.setBigUint64(FOOTER.indexOffset, BigInt(indexOffset), true);
    view.setBigUint64(FOOTER.indexLength, BigInt(indexRegion.length), true);
    view.setUint32(FOOTER.indexCrc32c, crc32c(indexRegion), true);
    view.setUint32(
      FOOTER.flags,
      FLAG_LITTLE_ENDIAN |
        (encrypted ? FLAG_ENCRYPTED : 0) |
        (this.metadata === undefined ? 0 : FLAG_EXTENSION),
      true,
    );
    view.setUint16(
      FOOTER.payloadCodecId,
      this.options.payloadCodecId ?? PAYLOAD_CODEC_ROARING_PORTABLE,
      true,
    );
    footer[FOOTER.elementWidth] = this.options.elementWidth ?? ELEMENT_WIDTH_32;
    footer[FOOTER.containerCodec] = CONTAINER_CODEC_NONE;
    footer[FOOTER.versionMajor] = VERSION_MAJOR;
    footer[FOOTER.versionMinor] = VERSION_MINOR;
    // `indexNonce` is always set: encrypted, it is the index's AEAD nonce (its tag goes beside it); cleartext, it is
    // the write's random identity and `indexTag` stays zero. key_id stays zero (the wrapped DEKs live in the
    // registry, not the object).
    if (indexNonce !== undefined) footer.set(indexNonce, FOOTER.indexNonce);
    if (indexTag !== undefined) footer.set(indexTag, FOOTER.indexTag);
    view.setBigUint64(FOOTER.generation, BigInt(this.options.generation), true);
    // Hide chunk count + cardinality on an encrypted object (a leak reveals neither); the reader derives both
    // from the decrypted index. Cleartext objects keep them for the O(1) count()/validation path.
    view.setUint32(FOOTER.chunkCount, encrypted ? 0 : this.entries.length, true);
    view.setBigUint64(FOOTER.totalCardinality, BigInt(encrypted ? 0 : this.totalCardinality), true);
    view.setUint32(FOOTER.footerCrc32c, crc32c(footer.subarray(0, FOOTER_CRC_COVERAGE)), true);
    footer.set(MAGIC, FOOTER.endMagic);
    return footer;
  }
}

/** The on-disk frame of one sealed blob, `nonce ‖ ciphertext ‖ tag`. */
function framed(sealed: AeadSealed): Uint8Array {
  const out = new Uint8Array(sealed.nonce.length + sealed.ciphertext.length + sealed.tag.length);
  out.set(sealed.nonce, 0);
  out.set(sealed.ciphertext, sealed.nonce.length);
  out.set(sealed.tag, sealed.nonce.length + sealed.ciphertext.length);
  return out;
}

/**
 * A write's identity: 12 fresh bytes from the injected source, copied so a source that reuses its buffer cannot alias
 * two writers. A missing source, or one that returns anything but a `Uint8Array` of exactly 12 bytes, is a
 * {@link ValidationError} that says what came back.
 */
function drawWriteIdentity(entropy: Entropy | undefined): Uint8Array {
  if (typeof entropy !== 'function') {
    throw new ValidationError(
      "a cleartext CrbmWriter needs an entropy source (`entropy`) for its write's identity",
    );
  }
  const drawn: unknown = entropy(AEAD_NONCE_BYTES);
  if (!(drawn instanceof Uint8Array)) {
    throw new ValidationError(
      `the entropy source must return a Uint8Array of ${AEAD_NONCE_BYTES} bytes for a write's identity; got ${
        Array.isArray(drawn) ? 'an array' : typeof drawn
      }`,
    );
  }
  if (drawn.length !== AEAD_NONCE_BYTES) {
    throw new ValidationError(
      `the entropy source must return ${AEAD_NONCE_BYTES} bytes for a write's identity; got ${drawn.length}`,
    );
  }
  return Uint8Array.from(drawn);
}
