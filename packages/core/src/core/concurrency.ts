/**
 * Bounded-concurrency fan-out — the missing primitive for running async work over many items without either
 * a thundering herd (unbounded `Promise.all` → N simultaneous S3/DynamoDB calls) or full serial latency
 * (`for await`). Pure + I/O-free, so it lives in `core/`; callers inject the async work.
 */

import { ValidationError } from './errors';

/**
 * Run `fn` over `items` with at most `limit` promises in flight at once, returning results in **input order**
 * (regardless of completion order). If any `fn` rejects, the pool stops scheduling new work, lets the in-flight
 * tasks settle, and rejects with the **first** error — callers that must not abort on one failure (e.g. an
 * erasure ledger that records per-item faults) should catch inside `fn` so it never rejects.
 *
 * `items` is a materialized array on purpose: every caller here already enumerates its source (registry list,
 * S3 page, chunk map), so an array keeps the pool trivial and race-free (no shared-iterator hazard).
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new ValidationError(`concurrency limit must be a positive integer; got ${limit}`);
  }
  const results = new Array<R>(items.length);
  let next = 0;
  let failed = false;
  let firstError: unknown;
  const worker = async (): Promise<void> => {
    while (!failed) {
      const i = next++;
      if (i >= items.length) return;
      try {
        results[i] = await fn(items[i]!, i);
      } catch (err) {
        if (!failed) {
          failed = true; // first failure wins; stop scheduling new items (in-flight ones still settle)
          firstError = err;
        }
        return;
      }
    }
  };
  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  if (failed) throw firstError;
  return results;
}
