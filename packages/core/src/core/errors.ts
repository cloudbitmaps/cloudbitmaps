/**
 * Typed errors — callers learn *why* something failed, never by parsing strings. Retry is not the engine's job: a
 * driver classifies its backend's failures into this vocabulary, and the store's read wrapper retries the
 * transient ones through `withRetry`.
 */

/**
 * Registry-symbol brands, so an error stays classifiable when the class object is not shared.
 *
 * In an ordinary install there is ONE copy of these classes and `instanceof` holds everywhere — across the
 * flavor, the driver packages and core itself — because every package leaves `@cloudbitmaps/*` external and
 * resolves core at runtime rather than inlining it.
 *
 * What still breaks it is a SECOND copy: a version skew between our packages that the installer could not
 * dedupe, or a bundler that emits core twice. Then a driver throws a class the catching side's `instanceof`
 * does not match — and silently, because a `catch` that stops matching just falls through, defeating
 * transient retry and the publish path's conflict handling with no error of its own.
 *
 * `Symbol.for` is identity-stable across copies, bundles and realms, so classify errors with `errorKind`
 * (never `instanceof`) anywhere an error may cross that boundary.
 */
const ERROR_BRAND: unique symbol = Symbol.for('cloudbitmaps.error');
const TRANSIENT_BRAND: unique symbol = Symbol.for('cloudbitmaps.error.transient');

/**
 * Each class's name as written. A minifying bundler renames the classes themselves, so the name an error carries, which
 * `errorKind` matches on and a log prints, comes from here: strings no minifier touches. A class not listed (an
 * application's own subclass) keeps the name its class has.
 */
const NAMES = new WeakMap<abstract new (...args: never[]) => unknown, string>();

/** Base class for every error CloudRoaring throws. */
export class CloudRoaringError extends Error {
  /** Cross-bundle brand — see {@link errorKind}. Non-enumerable-ish (symbol key ⇒ not in JSON). */
  readonly [ERROR_BRAND] = true as const;
  constructor(message: string) {
    super(message);
    // Also the discriminator `errorKind` matches on: a runtime string, so it survives a second copy of the package
    // where the class identity does not, and a minifier where the class's own name does not.
    this.name = NAMES.get(new.target) ?? new.target.name;
  }
}

/**
 * Invalid input, which the same call fails on again. Most is refused before any storage call (a bad id, segment name
 * or option); some is found by the call itself: a read past the end of an object, or a bucket or container a cloud
 * driver finds does not exist.
 */
export class ValidationError extends CloudRoaringError {}

/** What a contention {@link WriteConflictError} ends with: the call is safe to run again. */
export const CONTENTION_NEXT_STEP =
  "; another writer changed the segment's row while this call ran. Re-run the call: it reads the row afresh";

/** An OCC conditional write/delete lost the race — the row changed since it was read. */
export class WriteConflictError extends CloudRoaringError {}

/** Bytes from a tier are corrupt, oversized, or fail a checksum/format check. */
export class IntegrityError extends CloudRoaringError {}

/**
 * A requested object/row does not exist. Part of the driver error vocabulary: every storage driver this
 * library ships, the in-memory one included, throws it for a read of a generation object that is not there.
 * A registry `get` of a row that is not there returns `null` instead.
 */
export class NotFoundError extends CloudRoaringError {}

/**
 * A read of a leased pin came after its lease ended, by `until` or by `release()`. Thrown at every read site of the
 * handle, including a leased handle used as an operand or an exclude of a combine, and never answered empty: a
 * handle that read empty here would be an opt-out list that suppresses nobody. Carries the instant the lease ended
 * and why; never an id or a key.
 */
export class LeaseExpiredError extends CloudRoaringError {
  /** Epoch-ms the lease was taken until. */
  readonly until: number;
  /** `'expired'` when the clock reached `until`, `'released'` after `release()`. */
  readonly reason: 'expired' | 'released';
  constructor(message: string, until: number, reason: 'expired' | 'released') {
    super(message);
    this.until = until;
    this.reason = reason;
  }
}

/**
 * A segment already has as many live leases as one row records, so another cannot be taken. Nothing was written.
 * Release one, wait for one to end, or share one lease across the tasks of a job.
 */
export class LeaseLimitError extends CloudRoaringError {}

/**
 * An operand a call relied on changed while the call ran, so what the call built from it is not published. Carries the
 * operand's name in the call and why it is stale (`'moved'`: it was pinned at a generation and its pointer has since
 * moved; `'erased'`: an erasure ran in the store after a call with a feed began, so what the feed gave it may hold an
 * erased id), under the stable `code`
 * `'stale-operand'`. Deterministic: run the call again against the current operand.
 */
export class StaleOperandError extends CloudRoaringError {
  readonly code = 'stale-operand' as const;
  /** The operand's name in the call that found it stale. */
  readonly operand: string;
  /** Why it is stale. */
  readonly reason: 'moved' | 'erased';
  constructor(message: string, operand: string, reason: 'moved' | 'erased') {
    super(message);
    this.operand = operand;
    this.reason = reason;
  }
}

/**
 * This build/configuration cannot perform the requested operation, though nothing is malformed. Two uses:
 * (1) **format** — the bytes are well-formed but unreadable here (an unknown `.crbm` major version) —
 * distinct from `IntegrityError` (corruption); and (2)
 * **store configuration** — an operation this store's wiring doesn't support (e.g. a lifecycle helper like
 * `eraseSubject`/`retireExpired` called on a store built without a storage backend). Raised at
 * operation time, before any mutation.
 */
export class UnsupportedError extends CloudRoaringError {}

/**
 * A driver cannot meet a capability the chosen topology requires (e.g. a Storage driver without range
 * reads). Raised fail-fast at wiring time, never mid-operation.
 */
export class CapabilityError extends CloudRoaringError {}

/**
 * An operation would exceed one of its per-op **denial-of-wallet bounds** — too many backend requests
 * (`budget.maxRequests`), too many bytes held at once by a combine (`maxBufferedBytes`), or too many registry rows
 * in a scan (`maxScanSegments`) — so it is refused, before the fan-out where it can be known beforehand (hard
 * invariant 6). Default-on but generous (normal ops never hit it); tune each per store or per op, or disable the
 * request budget with `budget: false`. Deterministic (never retried): the op is too big by policy, not by luck.
 * Each request's bytes are separately capped (the safe-deserialize ceiling), so bounding the request count
 * transitively bounds bytes.
 *
 * Carries an option name and two numbers, and no data: `option` names the option to raise, `limit` is the bound in
 * force, and `spent` is what the call had reached when it was refused. What `spent` measures depends on `option`:
 *
 * - `'budget.maxRequests'`: the requests the call needs, which raising the option to it lets through. For a plan, it
 *   is the planned reads (with the reads already taken, when a run plans again); an enumeration that
 *   stops at the bound reports `limit + 1`, a lower bound.
 * - `'maxBufferedBytes'`: a **lower bound** on the bytes the call needs resident: what it held plus what it asked
 *   for at the moment it was refused. Raising the limit to `spent` can be refused again, further on, because the
 *   call had not finished growing. The one figure that lets an output through is the per-output refusal's, which
 *   the message gives as "raise maxBufferedBytes to at least N". Otherwise raise the limit with room to spare, or
 *   split the outputs across calls.
 * - `'maxScanSegments'`: `limit + 1`, a lower bound: the scan stops at the first row past the bound (for the retention
 *   sweep's due-index scan, the first due-index pointer, unread, which may be stale), so it never learns the fleet's
 *   size.
 *
 * The message states the same limit.
 */
export class BudgetExceededError extends CloudRoaringError {
  /** The option to raise to let the call through. */
  readonly option: 'budget.maxRequests' | 'maxBufferedBytes' | 'maxScanSegments';
  /** The bound in force: requests, bytes or rows, by `option`. */
  readonly limit: number;
  /**
   * What the call had reached when refused. By `option`: the requests the call needs (`'budget.maxRequests'`), a
   * lower bound on the resident bytes it needs (`'maxBufferedBytes'`), or `limit + 1` (`'maxScanSegments'`).
   */
  readonly spent: number;
  constructor(
    message: string,
    details: {
      readonly option: 'budget.maxRequests' | 'maxBufferedBytes' | 'maxScanSegments';
      readonly limit: number;
      readonly spent: number;
    },
  ) {
    super(message);
    this.option = details.option;
    this.limit = details.limit;
    this.spent = details.spent;
  }
}

/**
 * An encrypted segment's data key (DEK) cannot be unwrapped because the keystore holds none of the
 * key-encryption-keys (KEKs) its wrappings reference — the KEK was never configured, rotated away without
 * keeping the old key, or lost. Deterministic (never retried): without a KEK the ciphertext is unreadable by
 * design. The flip side of crypto-shred — when this is *intended* (a destroyed segment) the registry row is
 * already a `destroyed` tombstone; when it's *not*, restore the missing KEK (or its recovery KEK). Carries no
 * key material.
 */
export class KeyUnavailableError extends CloudRoaringError {}

/**
 * A **transient** infrastructure fault — throttling, a 5xx, a dropped connection, a client-side request
 * timeout. Retrying a read that failed this way is safe; a write that failed this way may still have landed, so
 * its caller re-runs the call rather than replaying the request. Drivers classify their backend's retryable faults and raise this (the
 * SDK-specific knowledge stays in the SDK-specific driver); the retry layer (`core/retry`) retries **only**
 * this class, never a deterministic error like {@link ValidationError}, {@link IntegrityError},
 * {@link NotFoundError}, or {@link WriteConflictError} (retrying those is pointless or wrong). The original
 * error is preserved in `cause` so callers can still inspect it.
 *
 * Note for logging hygiene: `cause` is the **raw SDK error**, which may carry operational
 * metadata (endpoint host, request IDs, `$metadata`). The library's own `message` is identifier-only and safe
 * to log; if you serialize the whole error *chain*, be aware you're including that metadata.
 */
export class TransientError extends CloudRoaringError {
  /** A second brand so a transient fault is classifiable cross-bundle. */
  readonly [TRANSIENT_BRAND] = true as const;
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    if (options && 'cause' in options) this.cause = options.cause;
  }
}

// The names, registered once the classes exist. A class added above and left out here is named by the minifier.
NAMES.set(CloudRoaringError, 'CloudRoaringError');
NAMES.set(ValidationError, 'ValidationError');
NAMES.set(WriteConflictError, 'WriteConflictError');
NAMES.set(IntegrityError, 'IntegrityError');
NAMES.set(NotFoundError, 'NotFoundError');
NAMES.set(LeaseExpiredError, 'LeaseExpiredError');
NAMES.set(LeaseLimitError, 'LeaseLimitError');
NAMES.set(StaleOperandError, 'StaleOperandError');
NAMES.set(UnsupportedError, 'UnsupportedError');
NAMES.set(CapabilityError, 'CapabilityError');
NAMES.set(BudgetExceededError, 'BudgetExceededError');
NAMES.set(KeyUnavailableError, 'KeyUnavailableError');
NAMES.set(TransientError, 'TransientError');

/**
 * Bundle-safe error predicates. Core's own modules use these, not `instanceof`, wherever an error may cross the
 * core↔driver package boundary. They match the {@link ERROR_BRAND} registry brand + the runtime `name`, both of
 * which survive separate bundling. No entry exports them: callers outside core use {@link errorKind}.
 */
function hasBrand(err: unknown, brand: symbol): boolean {
  return (
    typeof err === 'object' && err !== null && (err as Record<symbol, unknown>)[brand] === true
  );
}

/** Any error thrown by CloudRoaring (any tier, any bundle). */
export function isCloudRoaringError(err: unknown): err is CloudRoaringError {
  return hasBrand(err, ERROR_BRAND);
}

/** An OCC conditional write/delete lost the race — retry the read-modify-write, don't fail. */
export function isWriteConflictError(err: unknown): err is WriteConflictError {
  return isCloudRoaringError(err) && err.name === 'WriteConflictError';
}

/**
 * The mark {@link unsettledConflict} puts on a conflict: a registry write that may have landed before it met it.
 * Registered, like the other brands, so a publish built from another copy of the package reads a driver's mark.
 */
const UNSETTLED_BRAND: unique symbol = Symbol.for('cloudbitmaps.error.unsettled-conflict');

/**
 * A {@link WriteConflictError} for a registry `create` or `compareAndSwap` that may have landed before it met the
 * conflict, so the conflict does not prove the write was refused. Throw it where your backend's client may have sent
 * the write more than once and the read-back finds another writer's write over the row: a row is overwritten, so that
 * writer may have swapped in over this write after it landed. Throw a plain `WriteConflictError` for a conflict that
 * does prove it: a write sent once, or a check your driver made before sending anything.
 *
 * It is a `WriteConflictError` in every other way: `errorKind` names it `'WriteConflictError'`, `instanceof` holds on
 * the same copy of the package, and every caller that handles a conflict handles it. A load's publish reads the row
 * again, as after any conflict, and takes the write as its own when the row shows it there; otherwise it treats the
 * write as one that may have landed, as after a `TransientError`, and a load refused after it carries
 * `unanswered: true` on its `segment.load-refused` audit event. The mark is a registered `Symbol.for` brand, read
 * across copies of the package. It is lost when the error is cloned or copied into a new one, and a conflict raised
 * anywhere but a registry write is read as the plain conflict it also is.
 */
export function unsettledConflict(message: string): WriteConflictError {
  const err = new WriteConflictError(message);
  Object.defineProperty(err, UNSETTLED_BRAND, { value: true });
  return err;
}

/**
 * Whether `err` is a conflict a driver raised with {@link unsettledConflict}: a {@link WriteConflictError}, by brand
 * and name as {@link isWriteConflictError} reads it, that carries the unsettled mark. It reads the registered brand,
 * so it holds for an error from another copy of the package. Like the other predicates, no entry exports it.
 */
export function isUnsettledConflict(err: unknown): boolean {
  return isWriteConflictError(err) && hasBrand(err, UNSETTLED_BRAND);
}

/** A retryable transient infrastructure fault. The retry layer keys on this. */
export function isTransientError(err: unknown): err is TransientError {
  return hasBrand(err, TRANSIENT_BRAND);
}

/** A read came after its pin's lease ended. */
export function isLeaseExpiredError(err: unknown): err is LeaseExpiredError {
  return isCloudRoaringError(err) && err.name === 'LeaseExpiredError';
}

/** An operand a call relied on changed while it ran. */
export function isStaleOperandError(err: unknown): err is StaleOperandError {
  return isCloudRoaringError(err) && err.name === 'StaleOperandError';
}

/** A segment has no room for another live lease. */
export function isLeaseLimitError(err: unknown): err is LeaseLimitError {
  return isCloudRoaringError(err) && err.name === 'LeaseLimitError';
}

/** A requested object/row does not exist. */
export function isNotFoundError(err: unknown): err is NotFoundError {
  return isCloudRoaringError(err) && err.name === 'NotFoundError';
}

/** Corrupt/oversized/failed-checksum bytes from a tier. */
export function isIntegrityError(err: unknown): err is IntegrityError {
  return isCloudRoaringError(err) && err.name === 'IntegrityError';
}

/**
 * Invalid caller input; also the error a cloud driver raises for a bucket or container it finds does not exist.
 */
export function isValidationError(err: unknown): err is ValidationError {
  return isCloudRoaringError(err) && err.name === 'ValidationError';
}

/** This build or this store's wiring cannot do what was asked, though nothing is malformed. */
export function isUnsupportedError(err: unknown): err is UnsupportedError {
  return isCloudRoaringError(err) && err.name === 'UnsupportedError';
}

/** A driver lacks a capability the store's wiring needs. */
export function isCapabilityError(err: unknown): err is CapabilityError {
  return isCloudRoaringError(err) && err.name === 'CapabilityError';
}

/** A call would pass its per-op request budget, so it was refused before fanning out. */
export function isBudgetExceededError(err: unknown): err is BudgetExceededError {
  return isCloudRoaringError(err) && err.name === 'BudgetExceededError';
}

/** No key the keystore holds can unwrap an encrypted segment's data key. */
export function isKeyUnavailableError(err: unknown): err is KeyUnavailableError {
  return isCloudRoaringError(err) && err.name === 'KeyUnavailableError';
}

/** The name of one of the library's error classes, as `errorKind` returns it. */
export type ErrorKind =
  | 'CloudRoaringError'
  | 'ValidationError'
  | 'WriteConflictError'
  | 'IntegrityError'
  | 'NotFoundError'
  | 'UnsupportedError'
  | 'CapabilityError'
  | 'TransientError'
  | 'KeyUnavailableError'
  | 'BudgetExceededError'
  | 'LeaseExpiredError'
  | 'LeaseLimitError'
  | 'StaleOperandError';

/**
 * Every {@link ErrorKind}, as a record so that a kind added to the type and left out here fails to compile. Not
 * exported: a declaration that named it would put it in the public surface.
 */
const KIND_NAMES: Record<ErrorKind, true> = {
  CloudRoaringError: true,
  ValidationError: true,
  WriteConflictError: true,
  IntegrityError: true,
  NotFoundError: true,
  UnsupportedError: true,
  CapabilityError: true,
  TransientError: true,
  KeyUnavailableError: true,
  BudgetExceededError: true,
  LeaseExpiredError: true,
  LeaseLimitError: true,
  StaleOperandError: true,
};

/**
 * Which of the library's error classes `err` is, or `undefined` when it is none of them. Works on every copy of
 * the package, every bundle and every realm, where `instanceof` can silently stop matching: it reads the
 * `Symbol.for` brands and the error's `name`. An application's own subclass of one class returns
 * `'CloudRoaringError'`, except a subclass of `TransientError`, which returns `'TransientError'`; an error
 * cloned out of a worker (the brand is gone) returns `undefined`.
 */
export function errorKind(err: unknown): ErrorKind | undefined {
  if (hasBrand(err, TRANSIENT_BRAND)) return 'TransientError';
  if (!hasBrand(err, ERROR_BRAND)) return undefined;
  const name = (err as { name?: unknown }).name;
  return typeof name === 'string' && Object.hasOwn(KIND_NAMES, name)
    ? (name as ErrorKind)
    : 'CloudRoaringError';
}
