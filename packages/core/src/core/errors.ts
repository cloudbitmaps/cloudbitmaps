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
 * `Symbol.for` is identity-stable across copies, bundles and realms, so classify errors with the exported
 * predicates below (never `instanceof`) anywhere an error may cross that boundary.
 */
const ERROR_BRAND: unique symbol = Symbol.for('cloudbitmaps.error');
const TRANSIENT_BRAND: unique symbol = Symbol.for('cloudbitmaps.error.transient');

/** Base class for every error CloudRoaring throws. */
export class CloudRoaringError extends Error {
  /** Cross-bundle brand — see the predicates ({@link isCloudRoaringError}, …). Non-enumerable-ish (symbol key ⇒ not in JSON). */
  readonly [ERROR_BRAND] = true as const;
  constructor(message: string) {
    super(message);
    // Subclass name (works under transpilation since we set it explicitly). Also the discriminator the
    // predicates match on — a runtime string, so it survives bundling where the class identity does not.
    this.name = new.target.name;
  }
}

/** Invalid caller input (bad id, segment name, options). Raised before any storage call. */
export class ValidationError extends CloudRoaringError {}

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
 * moved; `'erased'`: an erasure ran in the store after a call with a feed began, or after a held operand the call reads
 * was made, so what the feed gave it, or what the operand holds, may hold an erased id), under the stable `code`
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
 * An operation would exceed its per-op **denial-of-wallet budget** — too many backend requests for a single
 * `count`/`iterate`/`intersect`/`subjectReport`/`eraseSubject` call — so it is refused **before** fanning out
 * (hard invariant 6). Default-on but generous (normal ops never hit it); tune it
 * per store (`budget`) or per op, or disable with `budget: false`. Deterministic (never retried): the op is too
 * big by policy, not by luck. Each request's bytes are separately capped (the safe-deserialize ceiling), so
 * bounding the request count transitively bounds bytes. Carries the projected count + the limit, never data.
 */
export class BudgetExceededError extends CloudRoaringError {}

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

/**
 * Bundle-safe error predicates — use these, not `instanceof`, wherever an error may cross the core↔driver
 * package boundary (and prefer them in consumer `catch` blocks too, for the same reason). They
 * match the {@link ERROR_BRAND} registry brand + the runtime `name`, both of which survive separate bundling.
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

/** Invalid caller input. */
export function isValidationError(err: unknown): err is ValidationError {
  return isCloudRoaringError(err) && err.name === 'ValidationError';
}
