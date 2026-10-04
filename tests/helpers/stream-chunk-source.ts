import { MemoryStorageChunkSource } from './memory-chunk-source';
import type { ChunkRead, ReadChunksOptions, SegmentRef } from '@/core/ports';

/** One stream a {@link StreamChunkSource} was asked to open. */
export interface OpenedStream {
  readonly segment: string;
  readonly keys: readonly number[];
  readonly options: ReadChunksOptions | undefined;
  /** Chunks yielded so far. */
  yielded: number;
  /** Whether the consumer stopped it (its `finally` ran before it was exhausted). */
  closedEarly: boolean;
  finished: boolean;
}

/**
 * A chunk source a test seeds chunk by chunk, with the optional `getChunks` the engine reads through: a stream that
 * answers each key from the seeded bytes, one request for every `perRequest` keys, and records every stream it is
 * asked to open. Its `version` is what `currentVersion` reports, and what each chunk says it was read from unless
 * `readVersion` says otherwise, so a test can make a source answer a newer generation than the one the engine planned
 * under.
 */
export class StreamChunkSource extends MemoryStorageChunkSource {
  readonly opened: OpenedStream[] = [];
  /** `getChunk` calls, by `segment:key`. */
  readonly singles: string[] = [];
  version: string | null = 'v1';
  perRequest = 1_000_000;
  /** The version a chunk says it came from; defaults to {@link version}. */
  readVersion: ((segment: string, key: number) => string | null) | undefined;
  /** Runs before each chunk is yielded, with how many have been. */
  beforeYield: ((stream: OpenedStream, key: number) => Promise<void> | void) | undefined;
  /** Replaces the key of the chunk about to be yielded (a misaligned source). */
  misalign: ((stream: OpenedStream, key: number) => number) | undefined;

  override getChunk(ref: Parameters<MemoryStorageChunkSource['getChunk']>[0]) {
    this.singles.push(`${ref.segment}:${ref.chunkKey}`);
    return super.getChunk(ref);
  }

  currentVersion(): Promise<string | null> {
    return Promise.resolve(this.version);
  }

  async *getChunks(
    ref: SegmentRef,
    keys: readonly number[],
    options?: ReadChunksOptions,
  ): AsyncGenerator<ChunkRead> {
    const stream: OpenedStream = {
      segment: ref.segment,
      keys,
      options,
      yielded: 0,
      closedEarly: false,
      finished: false,
    };
    this.opened.push(stream);
    try {
      for (const [i, key] of keys.entries()) {
        await this.beforeYield?.(stream, key);
        const bytes = await super.getChunk({ ...ref, chunkKey: key });
        const version = this.readVersion ? this.readVersion(ref.segment, key) : this.version;
        // One request per `perRequest` keys, reported as a source reports a request that settled.
        if (i % this.perRequest === 0 && bytes !== null)
          options?.onRequest?.({ bytes: bytes.length, ms: 3 });
        stream.yielded += 1;
        yield {
          key: this.misalign ? this.misalign(stream, key) : key,
          bytes,
          version,
        };
      }
      stream.finished = true;
    } finally {
      if (!stream.finished) stream.closedEarly = true;
    }
  }
}
