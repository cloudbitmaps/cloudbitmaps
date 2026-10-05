/**
 * The checks a stream makes of a lease: before its first pull, and each time it reads a chunk. Kept apart from the store
 * so each can be held on its own, and so a stream of another shape (a rank read, a plain iterable of ids) is wrapped by
 * the same function.
 */
import type { CodecBitmap } from '@cloudbitmaps/core';
/** What an id stream is, as far as a guard is concerned: ids, and the same ids a chunk at a time. */
interface IdStream extends AsyncIterable<number> {
  batches(): AsyncIterable<Uint32Array>;
}

/** A combine's chunks, as an `*Into` writes them. */
type ChunkStream = AsyncIterable<{ chunkKey: number; bitmap: CodecBitmap }>;

/**
 * A stream of ascending ids that checks a lease before it first pulls, and each time it reads a chunk after that: once
 * the engine has the next chunk and before an id of it is yielded, so nothing of a chunk fetched past the lease is
 * served. Ids ascend, so a chunk is entered when `id >>> 16` changes. The check before the first pull is what stops a
 * stream built while the lease was live, and pulled after it ended, ending empty without ever checking. A throw ends the
 * engine's reads. Used only when a handle in the call holds a lease: a call with none returns the engine's stream
 * untouched. It takes any async iterable of ids, so a stream with no `.batches()` (a rank read) is wrapped the same way.
 */
export const guardIdIterable = (
  inner: AsyncIterable<number>,
  check: () => void,
): AsyncIterable<number> => ({
  [Symbol.asyncIterator]: (): AsyncIterator<number> => {
    const it = inner[Symbol.asyncIterator]();
    let chunk = -1;
    let first = true;
    const stop = async (err: unknown): Promise<never> => {
      await it.return?.();
      throw err;
    };
    return {
      async next() {
        if (first) {
          first = false;
          try {
            check();
          } catch (err) {
            return stop(err);
          }
        }
        const r = await it.next();
        if (r.done === true) return r;
        const key = r.value >>> 16;
        if (key !== chunk) {
          try {
            check();
          } catch (err) {
            return stop(err);
          }
          chunk = key;
        }
        return r;
      },
      async return() {
        await it.return?.();
        return { done: true, value: undefined };
      },
    };
  },
});

/** {@link guardIdIterable} for an `IdStream`, whose `.batches()` is guarded too. */
export const guardIds = (inner: IdStream, check: () => void): IdStream => ({
  [Symbol.asyncIterator]: () => guardIdIterable(inner, check)[Symbol.asyncIterator](),
  batches: () => guardItems(inner.batches(), check),
});

/**
 * A stream of chunks (a batch of ids, or a chunk an `*Into` writes) that checks a lease before the first pull and before
 * each item is handed on: an item is one chunk.
 */
export const guardItems = <T>(inner: AsyncIterable<T>, check: () => void): AsyncIterable<T> => ({
  [Symbol.asyncIterator]: (): AsyncIterator<T> => {
    const it = inner[Symbol.asyncIterator]();
    let first = true;
    const stop = async (err: unknown): Promise<never> => {
      await it.return?.();
      throw err;
    };
    return {
      async next() {
        if (first) {
          first = false;
          try {
            check();
          } catch (err) {
            return stop(err);
          }
        }
        const r = await it.next();
        if (r.done === true) return r;
        try {
          check();
        } catch (err) {
          return stop(err);
        }
        return r;
      },
      async return() {
        await it.return?.();
        return { done: true, value: undefined };
      },
    };
  },
});

/** A chunk stream (what an `*Into` writes) that checks a lease before the first pull and before each chunk. */
export const guardChunks = (inner: ChunkStream, check: () => void): ChunkStream =>
  guardItems(inner, check);
