import { createCipheriv } from 'node:crypto';
import { BufferReader, BufferSink } from '@/core/blob';
import type { BlobReader } from '@/core/blob';
import { crc32c } from '@/core/crbm/crc32c';
import { CrbmWriter } from '@/core/crbm/writer';
import type { CrbmWriterOptions } from '@/core/crbm/writer';
import {
  EXT_MAGIC,
  EXT_TRAILER_BYTES,
  FLAG_EXTENSION,
  FOOTER,
  FOOTER_BYTES,
  FOOTER_CRC_COVERAGE,
} from '@/core/crbm/format';
import type { Aead, AeadSealed } from '@/core/crypto';
import { NodeAead } from '@/drivers/crypto';

/** One chunk as a test writes it: raw payload bytes and the cardinality the index records. */
export interface RawChunk {
  readonly chunkKey: number;
  readonly payload: Uint8Array;
  readonly cardinality: number;
}

/** The bytes `CrbmWriter` produces for `chunks` under `options`. */
export async function writeCrbm(
  chunks: readonly RawChunk[],
  options: CrbmWriterOptions,
): Promise<Uint8Array> {
  const sink = new BufferSink();
  const writer = new CrbmWriter(sink, options);
  for (const c of chunks) await writer.addChunk(c.chunkKey, c.payload, c.cardinality);
  await writer.finish();
  return sink.bytes();
}

/**
 * AES-256-GCM with a counter for its nonce, so a writer's output is the same on every run: what a golden file of an
 * encrypted object needs. It decrypts exactly as `NodeAead` does (any nonce), so the reader opens its output with a
 * `NodeAead` of the same key. Never use a counter nonce outside a test.
 */
export class CounterNonceAead implements Aead {
  private counter = 0;
  private readonly open_: NodeAead;

  constructor(private readonly key: Uint8Array) {
    this.open_ = new NodeAead(key);
  }

  seal(plaintext: Uint8Array, aad: Uint8Array): AeadSealed {
    const nonce = new Uint8Array(12);
    new DataView(nonce.buffer).setUint32(8, ++this.counter, false);
    const cipher = createCipheriv('aes-256-gcm', this.key, nonce);
    cipher.setAAD(aad);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return {
      nonce,
      ciphertext: new Uint8Array(ciphertext),
      tag: new Uint8Array(cipher.getAuthTag()),
    };
  }

  open(sealed: AeadSealed, aad: Uint8Array): Uint8Array {
    return this.open_.open(sealed, aad);
  }
}

/** Where a written object's parts sit: its footer view, its index offset, its minor and whether it flags a block. */
export function layoutOf(bytes: Uint8Array): {
  footer: DataView;
  indexOffset: number;
  indexLength: number;
  versionMinor: number;
  flagged: boolean;
} {
  const footer = new DataView(
    bytes.buffer,
    bytes.byteOffset + bytes.length - FOOTER_BYTES,
    FOOTER_BYTES,
  );
  return {
    footer,
    indexOffset: Number(footer.getBigUint64(FOOTER.indexOffset, true)),
    indexLength: Number(footer.getBigUint64(FOOTER.indexLength, true)),
    versionMinor: footer.getUint8(FOOTER.versionMinor),
    flagged: (footer.getUint32(FOOTER.flags, true) & FLAG_EXTENSION) !== 0,
  };
}

/** What a hand-built block's trailer says, each field overridable to forge a malformed one. */
export interface TrailerFields {
  readonly sectionsLength?: number;
  readonly crc?: number;
  readonly magic?: Uint8Array;
}

/** `sections ‖ u32 sectionsLength ‖ u32 crc32c(sections ‖ sectionsLength) ‖ "CRBX"`, each trailer field forgeable. */
export function extensionBlock(sections: Uint8Array, fields: TrailerFields = {}): Uint8Array {
  const block = new Uint8Array(sections.length + EXT_TRAILER_BYTES);
  block.set(sections, 0);
  const view = new DataView(block.buffer);
  view.setUint32(sections.length, fields.sectionsLength ?? sections.length, true);
  view.setUint32(
    sections.length + 4,
    fields.crc ?? crc32c(block.subarray(0, sections.length + 4)),
    true,
  );
  block.set(fields.magic ?? EXT_MAGIC, sections.length + 8);
  return block;
}

/** One section, `u8 type ‖ u32 length ‖ body`, its length forgeable. */
export function section(type: number, body: Uint8Array, length = body.length): Uint8Array {
  const out = new Uint8Array(5 + body.length);
  out[0] = type;
  new DataView(out.buffer).setUint32(1, length, true);
  out.set(body, 5);
  return out;
}

/** UTF-8 bytes of a string. */
export const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

/**
 * Splice `block` into an object without one, between its last payload and its index, as the writer places it: the
 * index moves up by the block's length, the footer sets `FLAG_EXTENSION`, and the footer's CRC is re-stamped. Payload
 * offsets are unaffected, since they are gaps from the start. Bypasses the writer's checks, so a test can present the
 * hostile bytes a storage tier could.
 */
export function spliceBlock(base: Uint8Array, block: Uint8Array): Uint8Array {
  const { indexOffset } = layoutOf(base);
  const out = new Uint8Array(base.length + block.length);
  out.set(base.subarray(0, indexOffset), 0);
  out.set(block, indexOffset);
  out.set(base.subarray(indexOffset), indexOffset + block.length);
  const footer = out.subarray(out.length - FOOTER_BYTES);
  const view = new DataView(footer.buffer, footer.byteOffset, FOOTER_BYTES);
  view.setBigUint64(FOOTER.indexOffset, BigInt(indexOffset + block.length), true);
  view.setUint32(FOOTER.flags, view.getUint32(FOOTER.flags, true) | FLAG_EXTENSION, true);
  view.setUint32(FOOTER.footerCrc32c, crc32c(footer.subarray(0, FOOTER_CRC_COVERAGE)), true);
  return out;
}

/** A `BufferReader` that counts the reads made of it. */
export class CountingReader implements BlobReader {
  tails = 0;
  ranges = 0;
  /** Each range read, as `[offset, length]`, in order. */
  readonly rangeReads: Array<[number, number]> = [];
  private readonly inner: BufferReader;

  constructor(bytes: Uint8Array) {
    this.inner = new BufferReader(bytes);
  }

  getRange(offset: number, length: number): Promise<Uint8Array> {
    this.ranges++;
    this.rangeReads.push([offset, length]);
    return this.inner.getRange(offset, length);
  }

  getTail(maxBytes: number): Promise<{ bytes: Uint8Array; size: number }> {
    this.tails++;
    return this.inner.getTail(maxBytes);
  }
}
