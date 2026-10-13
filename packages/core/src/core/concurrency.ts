/**
 * Bounded-concurrency fan-out — the missing primitive for running async work over many items without either
 * a thundering herd (unbounded `Promise.all` → N simultaneous object-store calls) or full serial latency
 * (`for await`). Pure + I/O-free, so it lives in `core/`; callers inject the async work.
 */

import { requirePositiveInteger } from './check';

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
  requirePositiveInteger(limit, 'concurrency limit');
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

/**
 * `Promise.all` over `items` with at most `limit` calls of `fn` in flight: the results in input order, or the first
 * failure, at once. Unlike {@link mapWithConcurrency} it does not wait for the calls still in flight before it rejects,
 * as `Promise.all` does not; it starts no call after a failure, and what the calls in flight answer is dropped. For reads
 * a caller abandons on the first fault, never for work that must finish or be accounted for once begun. When every item
 * fits under `limit` it is `Promise.all` itself, so a small fan-out costs and interleaves exactly as `Promise.all` does.
 */
export function boundedAll<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  try {
    requirePositiveInteger(limit, 'concurrency limit');
  } catch (err) {
    return Promise.reject(err);
  }
  if (items.length > limit) return inWaves(items, limit, fn);
  const calls: Promise<R>[] = [];
  for (const item of items) {
    try {
      calls.push(fn(item));
    } catch (err) {
      // The calls already made still run; settle them, so one that rejects later is not left unhandled.
      void Promise.allSettled(calls);
      return Promise.reject(err);
    }
  }
  return Promise.all(calls);
}

/** {@link boundedAll} over more items than `limit`: `limit` workers, each taking the next item as its last settles. */
async function inWaves<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let failed = false;
  const worker = async (): Promise<void> => {
    while (!failed && next < items.length) {
      const i = next++;
      try {
        results[i] = await fn(items[i]!);
      } catch (err) {
        failed = true;
        throw err;
      }
    }
  };
  await Promise.all(Array.from({ length: limit }, () => worker()));
  return results;
}
