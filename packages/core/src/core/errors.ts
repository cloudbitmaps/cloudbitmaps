/**
 * Typed errors — callers learn *why* something failed, never by parsing strings. Retry is the driver
 * decorators' job, not the engine's: a driver classifies its backend's failures into this vocabulary, and
 * `withRetry` decides what is transient.
 */

/**
 * Registry-symbol brands. The package ships as multiple bundles — the core entry and the `./s3` / `./dynamodb`
 * subpaths — and the builder inlines `core/errors` into each. A driver in a subpath bundle therefore throws a
 * *different* class object than the one the core engine/retry code would `instanceof`-check, so `instanceof`
 * silently returns false across that boundary in the published CJS package (defeating OCC/transient retry and
 * compaction race-handling). These `Symbol.for` brands are identity-stable across bundles/realms; classify
 * errors with the exported predicates below (never `instanceof`) anywhere an error may cross the boundary.
 */
const ERROR_BRAND: unique symbol = Symbol.for('cloud-roaring.error');
const TRANSIENT_BRAND: unique symbol = Symbol.for('cloud-roaring.error.transient');

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
 * A requested object/row does not exist. Part of the driver error vocabulary; thrown by
 * persistent drivers from Phase 2 — the Phase-1 engine + in-memory drivers return `null` instead.
 */
export class NotFoundError extends CloudRoaringError {}

/**
 * This build/configuration cannot perform the requested operation, though nothing is malformed. Two uses:
 * (1) **format** — the bytes are well-formed but unreadable here (an unknown `.crbm` major version, an
 * encrypted file before the crypto path exists) — distinct from `IntegrityError` (corruption); and (2)
 * **store configuration** — an operation this store's wiring doesn't support (e.g. a lifecycle helper like
 * `compact`/`eraseSubject` called on a store built without a raw cold driver + registry). Raised at
 * operation time, before any mutation.
 */
export class UnsupportedError extends CloudRoaringError {}

/**
 * A driver cannot meet a capability the chosen topology requires (e.g. a Cold driver without range
 * reads). Raised fail-fast at wiring time, never mid-operation.
 */
export class CapabilityError extends CloudRoaringError {}

/**
 * An operation would exceed its per-op **denial-of-wallet budget** — too many backend requests for a single
 * `count`/`iterate`/`intersect`/`subjectReport`/`eraseSubject` call — so it is refused **before** fanning out
 * (Decision #3 / invariant T3). Default-on but generous (normal ops never hit it); tune it
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
 * A **transient** infrastructure fault that is safe to retry — throttling, a 5xx, a dropped connection,
 * a client-side request timeout. Drivers classify their backend's retryable faults and raise this (the
 * SDK-specific knowledge stays in the SDK-specific driver); the retry layer (`core/retry`) retries **only**
 * this class, never a deterministic error like {@link ValidationError}, {@link IntegrityError},
 * {@link NotFoundError}, or {@link WriteConflictError} (retrying those is pointless or wrong). The original
 * error is preserved in `cause` so callers can still inspect it.
 *
 * Note for logging hygiene (threat-model S12): `cause` is the **raw SDK error**, which may carry operational
 * metadata (endpoint host, request IDs, `$metadata`). The library's own `message` is identifier-only and safe
 * to log; if you serialize the whole error *chain*, be aware you're including that metadata.
 */
export class TransientError extends CloudRoaringError {
  /** A second brand so the whole transient subtree (incl. {@link TimeoutError}) is classifiable cross-bundle. */
  readonly [TRANSIENT_BRAND] = true as const;
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    if (options && 'cause' in options) this.cause = options.cause;
  }
}

/**
 * A single attempt exceeded its time budget. Subclass of {@link TransientError} so the retry layer treats a
 * timeout as retryable by default — a stalled request often succeeds on a fresh connection. Raised by a
 * driver whose injected client reports a request timeout — setting one on your injected client is the
 * recommended way to bound a hang.
 */
export class TimeoutError extends TransientError {}

/**
 * Bundle-safe error predicates — use these, not `instanceof`, wherever an error may cross the core↔driver
 * (`./s3` / `./dynamodb`) boundary (and prefer them in consumer `catch` blocks too, for the same reason). They
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

/** A retryable transient infrastructure fault (incl. {@link TimeoutError}). The retry layer keys on this. */
export function isTransientError(err: unknown): err is TransientError {
  return hasBrand(err, TRANSIENT_BRAND);
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
