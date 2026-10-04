/**
 * An ordered window of reads: up to `max` reads open ahead of the one being consumed, handed back in key order.
 * With `ramp`, the window opens 1, 2, 4 … wide (or at `rampStart`, then doubling) up to `max` instead of `max` at once, so a consumer that stops
 * after a few chunks has fetched a handful, not a full window.
 *
 * `T` is whatever one read yields (a decoded chunk, or the raw bytes of one). Each read is wrapped to resolve and
 * never reject, so a read nobody consumes (the consumer stopped, or an earlier chunk failed) cannot raise an
 * unhandled rejection; its error surfaces from {@link take} only if the consumer reaches that chunk. Memory is
 * bounded by the window: at most `max` results are held ahead.
 *
 * Internal to core: not exported from any entry point.
 */
export class ChunkWindow<T> {
  private readonly open: Array<Promise<{ value: T; error?: { cause: unknown } }>> = [];
  private launched = 0;
  private taken = 0;

  constructor(
    private readonly keys: readonly number[],
    private readonly fetch: (chunkKey: number) => Promise<T>,
    private readonly max: number,
    private readonly ramp: boolean,
    /** With `ramp`, the width the window opens at (default 1). */
    private readonly rampStart = 1,
  ) {}

  /** Resolves once every read launched and not yet taken has settled; it never rejects, as the reads never do. */
  async settle(): Promise<void> {
    await Promise.all(this.open);
  }

  /** The next read's result in key order, or the error that read raised. */
  async take(): Promise<T> {
    const width = this.ramp
      ? Math.min(this.max, Math.max(this.rampStart, 2 ** Math.min(this.taken, 30)))
      : this.max;
    while (this.launched < this.keys.length && this.launched - this.taken < width) {
      this.open.push(
        this.fetch(this.keys[this.launched++]!).then(
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
