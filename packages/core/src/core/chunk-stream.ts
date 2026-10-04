import { IntegrityError } from './errors';
import type { ChunkRead } from './ports';

/**
 * One operand's chunks as the source streams them, taken a key at a time. The engine asks for keys in ascending order
 * and the stream yields them in that order, so each `take` is the next item; `take` calls the iterator at once, before
 * anything is awaited, which is what keeps concurrent takes lined up with the keys they were made for (an async
 * generator answers overlapping `next()` calls in the order they were made).
 *
 * A stream that fails fails every take after the one that met it with the same error, and a stream that ends before the
 * key asked for, or answers another key, is an {@link IntegrityError}: a source that misaligns its answers must not
 * hand one chunk's bytes to another key.
 *
 * Internal to core: not exported from any entry point.
 */
export class ChunkStream {
  private readonly iterator: AsyncIterator<ChunkRead>;
  private failure: { readonly error: unknown } | undefined;

  constructor(stream: AsyncIterable<ChunkRead>) {
    this.iterator = stream[Symbol.asyncIterator]();
  }

  /** The chunk for `key`, which must be the next key the stream was opened over. */
  take(key: number): Promise<ChunkRead> {
    if (this.failure !== undefined) return Promise.reject(this.failure.error);
    return this.iterator.next().then(
      (step) => {
        if (step.done === true) {
          throw this.failure?.error ?? new IntegrityError(`chunk stream ended before chunk ${key}`);
        }
        if (step.value.key !== key) {
          throw new IntegrityError(
            `chunk stream answered chunk ${step.value.key} where ${key} was due`,
          );
        }
        return step.value;
      },
      (error: unknown) => {
        this.failure ??= { error };
        throw error;
      },
    );
  }

  /** Stop the stream: no further range is started, and ranges already in flight finish and are dropped. */
  close(): void {
    this.iterator.return?.(undefined).catch(() => undefined);
  }
}
