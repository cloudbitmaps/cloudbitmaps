/**
 * `CrbmWriter` — streaming, constant-memory writer for one immutable `.crbm` generation.
 *
 * Chunks are appended in **ascending chunkKey order**; the writer holds only the small index in memory
 * (offsets aren't known until payloads are written — which is exactly why the index is a footer).
 *
 * **Encryption (opt-in via `crypto`).** When a {@link CrbmCrypto} is supplied, each chunk payload is
 * AES-256-GCM-sealed (`nonce ‖ ciphertext ‖ tag`, AAD = its chunkKey) and the whole index is sealed too (its
 * nonce/tag go in the footer). The footer then sets `FLAG_ENCRYPTED` and **zeroes `chunkCount` +
 * `totalCardinality`** so a leaked object reveals neither how many chunks nor how many ids it holds — the
 * reader derives both from the decrypted index. The per-chunk CRC covers the *encrypted* on-disk bytes.
 *
 * **Metadata (opt-in via `metadata`).** A generation given metadata is written as format 1.1: an extension block
 * between the last payload and the index carries the metadata's canonical JSON, sealed like the index when the
 * generation is encrypted. Without metadata the bytes are format 1.0 exactly.
 */
import { ValidationError } from '../errors';
import type { AeadSealed, CrbmCrypto } from '../crypto';
import { metadataBytes } from '../metadata';
import type { GenerationMetadata } from '../ports';
import { crc32c } from './crc32c';
import { writeVarint } from './varint';
import type { BlobSink } from '../blob';
import {
  CONTAINER_CODEC_NONE,
  ELEMENT_WIDTH_32,
  EXT_MAGIC,
  EXT_SECTION_HEADER_BYTES,
  EXT_SECTION_METADATA,
  EXT_TRAILER_BYTES,
  FLAG_ENCRYPTED,
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
  VERSION_MINOR_EXTENSION,
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
  /** The metadata's canonical JSON, copied at construction; `undefined` writes format 1.0. */
  private readonly metadata: Uint8Array | undefined;

  constructor(
    private readonly sink: BlobSink,
    private readonly options: CrbmWriterOptions,
  ) {
    if (!Number.isInteger(options.generation) || options.generation < 0) {
      throw new ValidationError(
        `generation must be a non-negative integer; got ${options.generation}`,
      );
    }
    this.metadata = metadataBytes(options.metadata, (message) => {
      throw new ValidationError(message);
    });
  }

  /** The format minor this object is written as: 1.1 when it carries metadata, else 1.0. */
  private get versionMinor(): number {
    return this.metadata === undefined ? VERSION_MINOR : VERSION_MINOR_EXTENSION;
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
    }
    const indexOffset = this.offset;
    await this.sink.write(indexRegion);
    this.offset += indexRegion.length;

    const footer = this.buildFooter(indexOffset, indexRegion, indexNonce, indexTag);
    await this.sink.write(footer);
    this.finished = true;
  }

  private async ensurePreamble(): Promise<void> {
    if (this.preambleWritten) return;
    const preamble = new Uint8Array(PREAMBLE_BYTES);
    preamble.set(MAGIC, 0);
    preamble[4] = VERSION_MAJOR;
    preamble[5] = this.versionMinor;
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

  private encodeIndex(): Uint8Array {
    const out: number[] = [];
    let prevKey = 0;
    let prevEnd = PAYLOAD_START;
    for (const e of this.entries) {
      writeVarint(out, e.chunkKey - prevKey);
      writeVarint(out, e.offset - prevEnd);
      writeVarint(out, e.length);
      writeVarint(out, e.cardinality);
      // crc32c is high-entropy → fixed 4-byte LE, not varint.
      out.push(
        e.crc32c & 0xff,
        (e.crc32c >>> 8) & 0xff,
        (e.crc32c >>> 16) & 0xff,
        (e.crc32c >>> 24) & 0xff,
      );
      prevKey = e.chunkKey;
      prevEnd = e.offset + e.length;
    }
    return Uint8Array.from(out);
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
    view.setUint32(FOOTER.flags, FLAG_LITTLE_ENDIAN | (encrypted ? FLAG_ENCRYPTED : 0), true);
    view.setUint16(
      FOOTER.payloadCodecId,
      this.options.payloadCodecId ?? PAYLOAD_CODEC_ROARING_PORTABLE,
      true,
    );
    footer[FOOTER.elementWidth] = this.options.elementWidth ?? ELEMENT_WIDTH_32;
    footer[FOOTER.containerCodec] = CONTAINER_CODEC_NONE;
    footer[FOOTER.versionMajor] = VERSION_MAJOR;
    footer[FOOTER.versionMinor] = this.versionMinor;
    // When encrypted, the index's AEAD nonce/tag live in these reserved slots; key_id stays zero (the wrapped
    // DEKs live in the registry, not the object). Unencrypted: all crypto fields stay zero.
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
