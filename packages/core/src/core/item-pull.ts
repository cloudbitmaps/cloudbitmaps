/**
 * Pulls the items of an async iterator one at a time so that the code relaying them never holds the one it just
 * handed on. A binding of a generator's body (`for await (const item of …)`, `yield*`) is kept in the generator's
 * frame across its next `yield`, so the relay would hold the previous item, and whatever buffer it is a view into,
 * for as long as it waits for the next. Here the item sits in the pull between {@link advance} and {@link take}, and
 * `take` clears it before it returns.
 *
 * ```ts
 * const pull = new ItemPull(source);
 * try {
 *   while (await pull.advance()) yield pull.take((item) => wrap(item));
 * } finally {
 *   await pull.close();
 * }
 * ```
 *
 * Internal to core: not exported from any entry point.
 */
export class ItemPull<A> {
  private readonly iterator: AsyncIterator<A>;
  private item: A | undefined;

  constructor(source: AsyncIterable<A>) {
    this.iterator = source[Symbol.asyncIterator]();
  }

  /** Waits for the next item and keeps it inside; `false` once the source has ended. A failure of the source throws. */
  async advance(): Promise<boolean> {
    const step = await this.iterator.next();
    if (step.done === true) return false;
    this.item = step.value;
    return true;
  }

  /** Hands over the item {@link advance} fetched, through `map`, and forgets it. */
  take<B>(map: (item: A) => B): B {
    const item = this.item as A;
    this.item = undefined;
    return map(item);
  }

  /** Ends the source early (a consumer that stopped), as leaving a `for await` does. */
  async close(): Promise<void> {
    this.item = undefined;
    await this.iterator.return?.();
  }
}
