/*
 * The contract a storage-driver package builds against.
 *
 * `@cloudbitmaps/s3`, `@cloudbitmaps/gcs` and `@cloudbitmaps/azure-blob` live outside this package but are
 * built from its internals: the driver ports they implement, the typed errors they must throw, and the
 * object-store registry that gives an S3-shaped service compare-and-swap semantics. A subpath is how a
 * separate package reaches them without reaching into core's source.
 *
 * WHY A SUBPATH AND NOT THE MAIN ENTRY. Two reasons pull the same way. The main entry is what a flavor
 * builds on, and none of it needs `ObjectStoreRegistry`, so widening that entry here would move in the
 * opposite direction of keeping it to what a flavor uses. And a driver's contract deserves to be a deliberate list rather than whatever core
 * happens to export: everything below is imported by at least one driver or the flavor's export CLI today, so
 * the surface is the real dependency and not a guess. A third-party driver builds against exactly this.
 *
 * It is versioned public API. Anything added here is something we support; anything removed is a breaking
 * change for a driver package — including ours, which is the point of making it explicit.
 *
 * Not quite self-sufficient, and worth saying rather than letting someone discover it: a registry driver
 * that does NOT extend `ObjectStoreRegistry` needs `Token`, `RegCaps`, `RegistryRecord`, `NewRegistryRecord`,
 * `RegistryPatch` and `RegistryWriteOptions` to write `IRegistryDriver`'s method signatures, and those come from
 * `@cloudbitmaps/core`'s main entry. The contract is this subpath PLUS those record types.
 *
 * WHAT A DRIVER MUST DO. The port doc comments (`IStorageDriver`, `IRegistryDriver`) carry the full list, each with
 * the caller that depends on it. In short:
 *
 *  - Storage: `putImmutable` is write-once and throws `WriteConflictError` on a collision; a missing object makes
 *    `getRange`/`getTail` throw `NotFoundError`; an out-of-range read throws `ValidationError`; `getTail` returns
 *    the true total size; `delete` is idempotent; `list` is strongly consistent, read-after-delete.
 *  - Registry: `create` and `compareAndSwap` are atomic conditional writes that throw `WriteConflictError` when
 *    they lose; a token is not reused (2^-128 per pair of incarnations of a name); `delete` is idempotent, and `delete(ref, expected)` lands only while the
 *    row still carries `expected`, else it throws `WriteConflictError`; `list` yields tombstones and every field.
 *  - Either: never replay a conditional write without telling the replay apart (send it once, or recognise your
 *    own write on the read-back), and raise a transient fault as `TransientError`.
 *
 * PORT CHANGES are recorded in the root `CHANGELOG.md`, under **Added**, **Changed** or **Breaking** like any
 * other. A parameter added to a port method is optional, so an existing driver keeps compiling and keeps its old
 * behaviour until it implements the parameter: `IRegistryDriver.delete`'s optional expected token is the current
 * example, and a driver that ignores it deletes unfenced, as before.
 */

// The ports a driver implements, and the brand that marks a pair of halves as a backend. `brandAsBackend` also
// checks that each half is a driver, so a plain `{ storage, registry }` object can be branded with it.
export type {
  GenKey,
  IRegistryDriver,
  IStorageDriver,
  SegmentRef,
  StorageBackend,
  StorageCaps,
} from './core/ports';
export { brandAsBackend, STORAGE_BACKEND } from './core/ports';

// The metrics sink a store hands a backend that implements `StorageBackend.attachMetrics`, and the event union it emits to.
export type { IMetricsSink, MetricEvent } from './core/metrics';

// The typed errors a driver must throw, and the predicates that classify one.
//
// In an ordinary install `instanceof` holds: every package here leaves `@cloudbitmaps/core` external, so one
// copy of these classes is shared. Throw and catch them normally. The predicates matter where that stops
// being true — a bundler that inlines core into two outputs, two major versions side by side in one tree, a
// worker or vm realm — because each is `Symbol.for`-branded and so identifies the error by brand rather than
// by prototype identity. Prefer them in library code that cannot see how it will be bundled.
export {
  IntegrityError,
  isIntegrityError,
  isNotFoundError,
  isTransientError,
  isValidationError,
  isWriteConflictError,
  NotFoundError,
  TransientError,
  ValidationError,
  WriteConflictError,
} from './core/errors';

// Validation a driver applies at its own boundary, and the sink `putImmutable` hands the writer: the object's
// bytes arrive through its `write`, and the driver commits them once the writer returns.
export { validateSegmentRef } from './core/validate';
export type { BlobSink } from './core/blob';

// Compare-and-swap over a plain object store. Every cloud registry driver is a thin adapter over this, which
// is why all three pass one conformance suite: the OCC semantics live here, not in the drivers.
export {
  MAX_ROW_BYTES,
  ObjectStoreRegistry,
  ObjectVersionRaced,
} from './drivers/_shared/object-registry';
export type { ObjectRegistryStore, ObjectRow } from './drivers/_shared/object-registry';

// Key construction: how a segment name and namespace become an object key (or a filesystem path), and how a
// prefix is normalized. The layout has exactly one definition here — two drivers disagreeing about a row's key
// would be a silent cross-driver incompatibility on the same bucket — and where a registry row lives is part of
// `ObjectStoreRegistry`, which all three cloud drivers reach it through.
export {
  encodeNameForKey,
  encodeNameForPath,
  namespaceKeyPart,
  namespacePathPart,
} from './drivers/_shared/keys';
export { normalizeObjectPrefix, prefixPart } from './drivers/_shared/object-registry-keys';
