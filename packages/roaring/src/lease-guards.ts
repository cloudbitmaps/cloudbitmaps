/**
 * The checks a stream makes of a lease: before its first pull, and each time it reads a chunk. Kept apart from the store
 * so each can be held on its own, and so a stream of another shape (a rank read, a plain iterable of ids) is wrapped by
 * the same function.
 *
 * ```
 *   caller ── next() ──> guarded stream ── next() ──> engine's stream
 *                         │  check before the first pull
 *                         │  check again at each chunk (or each item)
 *                         └─ a throwing check ends the engine's stream, then rejects
 *   return() / throw() ─────────────────────────────> engine's stream (ended / thrown into)
 * ```
 *
 * A guarded stream is its own iterator and single-use, as the engine's generator it wraps is: it answers `next`,
 * `return` and `throw`, and iterating it gives it back.
 */

/** An async iterator that is also its own iterable, with `return` and `throw` always present, as a generator's are. */
interface GuardedStream<T> extends AsyncIterableIterator<T> {
  return(value?: unknown): Promise<IteratorResult<T, unknown>>;
  throw(err: unknown): Promise<IteratorResult<T, unknown>>;
}

/** What an id stream is, as far as a guard is concerned: ids, and the same ids a chunk at a time. */
interface IdStream extends AsyncIterable<number> {
  batches(): AsyncIterable<Uint32Array>;
}

/** An id stream that is guarded: the per-id stream is an iterator of its own, and `batches()` is guarded too. */
type GuardedIds = GuardedStream<number> & { batches(): GuardedStream<Uint32Array> };

/** A finished result, new each time: a caller may keep or change what it is handed. */
const done = (value?: unknown): IteratorReturnResult<unknown> => ({ done: true, value });

/**
 * The one guard: `check` runs before the first pull, then once an item is pulled and before it is handed on. Every
 * item is checked, or, when `keyOf` is given, the first item of each run of items with one key (the ids of one chunk).
 * A check that throws ends the inner stream and rejects with its error, and the guarded stream is over: a pull that
 * settles after that is done, whatever the source had already pulled for it. A key is remembered only once its check
 * has passed.
 */
const guard = <T>(
  inner: AsyncIterable<T>,
  check: () => void,
  keyOf?: (item: T) => number,
): GuardedStream<T> => {
  const it = inner[Symbol.asyncIterator]();
  let first = true;
  let over = false;
  let last = -1;
  const end = async (value?: unknown): Promise<unknown> => {
    over = true;
    await it.return?.(value);
    return value;
  };
  const stop = async (err: unknown): Promise<never> => {
    await end();
    throw err;
  };
  /** What a pull hands on: nothing once the stream is over, and an item only after its check passes. */
  const deliver = (
    r: IteratorResult<T, unknown>,
  ): Promise<IteratorResult<T, unknown>> | IteratorResult<T, unknown> => {
    if (over) return done();
    if (r.done === true) return r;
    const key = keyOf?.(r.value);
    if (key === undefined || key !== last) {
      try {
        check();
      } catch (err) {
        return stop(err);
      }
      if (key !== undefined) last = key;
    }
    return r;
  };
  return {
    [Symbol.asyncIterator]() {
      return this;
    },
    async next() {
      if (over) return done();
      if (first) {
        first = false;
        try {
          check();
        } catch (err) {
          return stop(err);
        }
      }
      return deliver(await it.next());
    },
    async return(value?: unknown) {
      return done(await end(value));
    },
    async throw(err: unknown) {
      first = false;
      if (it.throw === undefined) return stop(err);
      let r: IteratorResult<T, unknown>;
      try {
        r = await it.throw(err);
      } catch (thrown) {
        over = true;
        throw thrown;
      }
      return deliver(r);
    },
  };
};

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
): GuardedStream<number> => guard(inner, check, (id) => id >>> 16);

/** {@link guardIdIterable} for an `IdStream`, whose `.batches()` is guarded too. */
export const guardIds = (inner: IdStream, check: () => void): GuardedIds =>
  Object.assign(guardIdIterable(inner, check), {
    batches: () => guardItems(inner.batches(), check),
  });

/**
 * A stream of chunks that checks a lease before the first pull and before each item is handed on: an item is one
 * chunk (a batch of ids, or a chunk an `*Into` writes).
 */
export const guardItems = <T>(inner: AsyncIterable<T>, check: () => void): GuardedStream<T> =>
  guard(inner, check);
