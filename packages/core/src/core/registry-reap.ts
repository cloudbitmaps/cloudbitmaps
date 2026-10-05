/**
 * The tombstone reaper: remove the `deleted: true` rows with no incarnation id from a registry.
 *
 * A release before 0.12 never removed a row it deleted: it kept a `{ deleted: true }` envelope with the token counter
 * advanced, and its tokens are bare counters with no incarnation id. Since 0.12 a delete removes a row born with an
 * incarnation id for good, but still keeps one that has none (including a row born before 0.12 that a 0.12+ release
 * deletes), so no call removes these envelopes, and every full listing of the registry still reads each (one GET
 * apiece). This is the one call that removes them. Both kinds are safe to remove.
 *
 * **What it touches.** Only a row that is `deleted: true` and carries no incarnation id, whatever its `status`: the
 * sweep's own purge tombstone, `deleted: true` with `status: 'destroyed'` and a bare token, is removed. Never a live
 * row, never a `destroyed` row that is not `deleted` (a crypto-shred's or a `dropSegment`'s tombstone, the attestation
 * of an erasure, which carries no stamp the reaper could tell from another), never a deleted row with an incarnation
 * id. So it cannot clean a bucket completely: the `destroyed` tombstones `dropSegment` leaves stay, and so does a
 * tombstone a 0.12+ release wrote while `conditionalDelete` was off (it has an incarnation id, every full listing still
 * reads it, and the reaper refuses to run on such a registry).
 *
 * **What it needs.** Every delete is conditioned on the version the reaper read, so a `create` that lands over the
 * envelope first wins and the delete is refused; the registry must say it applies that precondition
 * (`capabilities().conditionalDelete`), else `CapabilityError` before any request. Where the gate is detected (S3 true
 * only on an AWS host) that fence is real. On an endpoint that ignores `If-Match` (MinIO, fake-gcs-server), a
 * `conditionalDelete: true` you set makes this an unfenced delete: run it with every writer stopped. And the caller
 * must say that no process on a release before 0.12 still writes this registry (`confirmNoLegacyWriters: true`),
 * because such a process, re-creating a removed name from counter 0, would issue the removed row's tokens again.
 *
 * **A racing re-create.** A `create` whose own read saw the envelope and whose write meets the removal gets
 * `WriteConflictError`, and the registry does not retry it: the caller retries, and finds no row.
 *
 * **Not resumable.** Each run lists and reads every key from the start, so R rows cost R GETs whatever the `limit`; a
 * dry run with a `limit` reports the same first rows every time. `limited` is set when the limit was spent and keys
 * remained, whether or not any of them is removable. An object that cannot be read or parsed stops the run with an error
 * naming its key; scope the run with `namespace` to get past one.
 */
import { UnsupportedError, ValidationError } from './errors';
import type {
  IRegistryDriver,
  ReapLegacyTombstonesOptions,
  ReapLegacyTombstonesResult,
} from './ports';
import { validateUserNamespace } from './validate';

/** Rows one call removes when no `limit` says otherwise. */
export const DEFAULT_REAP_LIMIT = 1000;

/** The keys `reapRegistryTombstones` takes. */
export interface ReapRegistryTombstonesOptions {
  /** Only rows in this namespace. Omit to cover every namespace, the library's own bookkeeping rows included. */
  readonly namespace?: string;
  /** Count what a real run would remove, and remove nothing. Needs no `confirmNoLegacyWriters`. */
  readonly dryRun?: boolean;
  /** Required `true` for a real run: no process on a release before 0.12 writes this registry. */
  readonly confirmNoLegacyWriters?: boolean;
  /** The most rows to remove in this call (default {@link DEFAULT_REAP_LIMIT}); a run that stops on it says `limited`. */
  readonly limit?: number;
}

/** What a reap found and did: see {@link ReapLegacyTombstonesResult}. */
export type ReapRegistryTombstonesResult = ReapLegacyTombstonesResult;

/**
 * Remove the `deleted: true` rows with no incarnation id from `registry`, or count them (`dryRun`).
 *
 * Cost over R rows read and E removed: `ceil(R / 1000)` LIST requests, R GETs and E DELETEs.
 */
export async function reapRegistryTombstones(
  registry: IRegistryDriver,
  options: ReapRegistryTombstonesOptions = {},
): Promise<ReapRegistryTombstonesResult> {
  const dryRun = options.dryRun === true;
  if (!dryRun && options.confirmNoLegacyWriters !== true) {
    throw new ValidationError(
      'reapRegistryTombstones: a real run needs `confirmNoLegacyWriters: true`, your statement that no process on a ' +
        'release before 0.12 writes this registry (one that did would issue a removed row’s tokens again). ' +
        'Pass `dryRun: true` to see what would be removed.',
    );
  }
  const limit = options.limit ?? DEFAULT_REAP_LIMIT;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new ValidationError(
      `reapRegistryTombstones: \`limit\` must be a positive integer; got ${String(limit)}`,
    );
  }
  if (options.namespace !== undefined) validateUserNamespace(options.namespace);
  if (registry.reapLegacyTombstones === undefined) {
    throw new UnsupportedError(
      'reapRegistryTombstones: this registry keeps no deleted rows of a release before 0.12 to remove ' +
        '(only the object-store registries, S3, GCS and Azure Blob, do)',
    );
  }
  const request: ReapLegacyTombstonesOptions =
    options.namespace === undefined
      ? { dryRun, limit }
      : { namespace: options.namespace, dryRun, limit };
  return registry.reapLegacyTombstones(request);
}
