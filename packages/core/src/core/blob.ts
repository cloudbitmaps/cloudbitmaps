/**
 * The byte-IO seam the `.crbm` codec reads/writes through.
 *
 * Deliberately tiny and driver-independent: a `BlobSink` is a streaming append target (the writer needs
 * no random access), a `BlobReader` supports the speculative tail read + bounded range reads. An
 * `IStorageDriver` adapts a `GenKey` to these; the in-memory impls below let the format be
 * golden-tested and let the in-memory storage tier hold a real `.crbm` with no filesystem.
 */
import { ValidationError } from './errors';

/**
 * Streaming append target for a single object being written. A caller may reuse the buffer it passed to `write` once
 * the write resolves, so a sink that holds bytes past that copies them.
 */
export interface BlobSink {
  write(bytes: Uint8Array): Promise<void>;
}

/**
 * Random/tail read access to a single finished object. The total size comes back from `getTail` (the
 * codec's entry point), so there's no separate `size()` — keeping the seam minimal for driver authors.
 */
export interface BlobReader {
  /** Exactly `length` bytes starting at `offset`. Out-of-range is a `ValidationError`, never a short read. */
  getRange(offset: number, length: number): Promise<Uint8Array>;
  /**
   * The last `min(maxBytes, size)` bytes plus the total size — the one-GET footer+index path. `maxBytes` is a safe
   * integer, zero or less for an empty tail; any other length is refused with `ValidationError`.
   */
  getTail(maxBytes: number): Promise<{ bytes: Uint8Array; size: number }>;
}

/**
 * Check the length a tail read asks for, the one rule every tail read holds to (each storage driver's `getTail` and
 * {@link BufferReader.getTail}): a safe integer. Zero or less answers an empty tail with the size, and a length past
 * the object's size answers the whole object. Anything else is refused with `ValidationError` before anything is read:
 * `NaN`, a fraction (a negative one too), an infinity of either sign, and a whole number past the safe range (2^53 or
 * more, or -2^53 or less), so no reader takes one for some other length.
 */
export function checkTailLength(maxBytes: number): void {
  if (!Number.isSafeInteger(maxBytes)) {
    throw new ValidationError(`invalid tail length ${String(maxBytes)}`);
  }
}

/** In-memory `BlobSink` that accumulates written bytes; `bytes()` returns the concatenation. */
export class BufferSink implements BlobSink {
  private readonly chunks: Uint8Array[] = [];
  private length = 0;

  write(bytes: Uint8Array): Promise<void> {
    // Copy into a plain Uint8Array: callers may reuse their buffer after write() resolves, and on a Node Buffer
    // `slice()` is a view of it, not a copy.
    this.chunks.push(new Uint8Array(bytes));
    this.length += bytes.length;
    return Promise.resolve();
  }

  bytes(): Uint8Array {
    const out = new Uint8Array(this.length);
    let offset = 0;
    for (const chunk of this.chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  }
}

/** In-memory `BlobReader` over a fixed byte buffer. */
export class BufferReader implements BlobReader {
  constructor(private readonly buffer: Uint8Array) {}

  getRange(offset: number, length: number): Promise<Uint8Array> {
    if (
      !Number.isInteger(offset) ||
      !Number.isInteger(length) ||
      offset < 0 ||
      length < 0 ||
      offset + length > this.buffer.length
    ) {
      throw new ValidationError(
        `range [${offset}, ${offset + length}) out of bounds for ${this.buffer.length}-byte blob`,
      );
    }
    return Promise.resolve(this.buffer.subarray(offset, offset + length));
  }

  getTail(maxBytes: number): Promise<{ bytes: Uint8Array; size: number }> {
    try {
      checkTailLength(maxBytes);
    } catch (err) {
      return Promise.reject(err);
    }
    const size = this.buffer.length;
    const take = Math.min(Math.max(maxBytes, 0), size);
    return Promise.resolve({ bytes: this.buffer.subarray(size - take), size });
  }
}
