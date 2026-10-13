/** What {@link ChunkWindow}'s source answers when it has no read left. */
const DONE: unique symbol = Symbol('done');

/**
 * An ordered window of reads: up to `max` reads open ahead of the one being consumed, handed back in key order.
 * With `ramp`, the window opens 1, 2, 4 … wide (or at `rampStart`, then doubling) up to `max` instead of `max` at once, so a consumer that stops
 * after a few chunks has fetched a handful, not a full window.
 *
 * `T` is whatever one read yields (a decoded chunk, or the raw bytes of one), and `K` what names a read to launch: a
 * chunk key, or a planned range. The reads to launch are a list, or an iterator pulled from only as the window opens
 * a read, so a long plan is never made ahead of what the window can hold. Each read is wrapped to resolve and
 * never reject, so a read nobody consumes (the consumer stopped, or an earlier chunk failed) cannot raise an
 * unhandled rejection; its error surfaces from {@link take} only if the consumer reaches that chunk. Memory is
 * bounded by the window: at most `max` results are held ahead.
 *
 * Internal to core: not exported from any entry point.
 */
export class ChunkWindow<T, K = number> {
  private readonly open: Array<Promise<{ value: T; error?: { cause: unknown } }>> = [];
  private launched = 0;
  private taken = 0;
  private readonly list: readonly K[] | undefined;
  private readonly source: Iterator<K> | undefined;
  /** What the source threw, so a later {@link take} throws it again rather than reading the spent source as done. */
  private failure: { readonly cause: unknown } | undefined;

  constructor(
    keys: readonly K[] | Iterator<K>,
    private readonly fetch: (key: K) => Promise<T>,
    private readonly max: number,
    private readonly ramp: boolean,
    /** With `ramp`, the width the window opens at (default 1). */
    private readonly rampStart = 1,
  ) {
    if (Array.isArray(keys)) this.list = keys as readonly K[];
    else this.source = keys as Iterator<K>;
  }

  /** The next read to launch, or {@link DONE} when there is none. */
  private nextKey(): K | typeof DONE {
    if (this.list !== undefined) {
      return this.launched < this.list.length ? this.list[this.launched]! : DONE;
    }
    if (this.failure !== undefined) throw this.failure.cause;
    try {
      const step = this.source!.next();
      return step.done === true ? DONE : step.value;
    } catch (cause) {
      this.failure = { cause };
      throw cause;
    }
  }

  /** Resolves once every read launched and not yet taken has settled; it never rejects, as the reads never do. */
  async settle(): Promise<void> {
    await Promise.all(this.open);
  }

  /** The next read's result in key order, or the error that read raised. */
  async take(): Promise<T> {
    const width = this.ramp
      ? Math.min(this.max, Math.max(this.rampStart, 2 ** Math.min(this.taken, 30)))
      : this.max;
    while (this.launched - this.taken < width) {
      const key = this.nextKey();
      if (key === DONE) break;
      this.launched += 1;
      this.open.push(
        this.fetch(key).then(
          (value) => ({ value }),
          (cause: unknown) => ({ value: undefined as T, error: { cause } }),
        ),
      );
    }
    const slot = await this.open.shift()!;
    this.taken += 1;
    if (slot.error) throw slot.error.cause;
    return slot.value;
  }
}
