/*
 * The contract a storage-driver package builds against.
 *
 * `@cloudbitmaps/s3`, `@cloudbitmaps/gcs` and `@cloudbitmaps/azure-blob` live outside this package but are
 * built from its internals: the driver ports they implement, the typed errors they must throw, and the
 * object-store registry that gives an S3-shaped service compare-and-swap semantics. Before the split those
 * were relative imports inside one package; a subpath is what replaces reaching across a package boundary.
 *
 * WHY A SUBPATH AND NOT THE MAIN ENTRY. Two reasons pull the same way. The main entry is what every
 * application imports, and none of them needs `ObjectStoreRegistry` or the SDK-retry classifiers — shrinking
 * that entry to the documented surface is its own piece of work, and widening it here would move in the
 * opposite direction. And a driver's contract deserves to be a deliberate list rather than whatever core
 * happens to export: everything below is imported by at least one driver today, so the surface is the real
 * dependency and not a guess. A third-party driver builds against exactly this.
 *
 * It is versioned public API. Anything added here is something we support; anything removed is a breaking
 * change for a driver package — including ours, which is the point of making it explicit.
 *
 * Not quite self-sufficient, and worth saying rather than letting someone discover it: a registry driver
 * that does NOT extend `ObjectStoreRegistry` needs `Token`, `RegCaps`, `RegistryRecord`, `NewRegistryRecord`
 * and `RegistryPatch` to write `IRegistryDriver`'s method signatures, and those come from
 * `@cloudbitmaps/core`'s main entry. The contract is this subpath PLUS those record types.
 */

// The ports a driver implements, and the brand that marks a pair of halves as a backend.
export type {
  GenKey,
  IRegistryDriver,
  IStorageDriver,
  SegmentRef,
  StorageBackend,
  StorageCaps,
} from './core/ports';
export { brandAsBackend, STORAGE_BACKEND } from './core/ports';

// The typed errors a driver must throw, and the predicates that classify one.
//
// In an ordinary install `instanceof` holds: every package here leaves `@cloudbitmaps/core` external, so one
// copy of these classes is shared. Throw and catch them normally. The predicates matter where that stops
// being true — a bundler that inlines core into two outputs, two major versions side by side in one tree, a
// worker or vm realm — because each is `Symbol.for`-branded and so identifies the error by brand rather than
// by prototype identity. Prefer them in library code that cannot see how it will be bundled.
export {
  IntegrityError,
  isNotFoundError,
  isValidationError,
  isWriteConflictError,
  NotFoundError,
  TransientError,
  ValidationError,
  WriteConflictError,
} from './core/errors';

// Validation a driver applies at its own boundary, and the sink a range read writes into.
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

// Key construction: how a segment name and namespace become an object key, how a prefix is normalized, and
// where a registry row lives. The layout has exactly one definition here — two drivers disagreeing about a
// row's key would be a silent cross-driver incompatibility on the same bucket — and all three reach it
// through `ObjectStoreRegistry`. `@cloudbitmaps/s3` also re-exports the four `registry*` helpers from its
// own internal key module, for the call sites and tests that already name them there; that re-export is not
// on its public surface, so this stays one definition rather than becoming a second one.
export { encodeNameForKey, namespaceKeyPart } from './drivers/_shared/keys';
export {
  normalizeObjectPrefix,
  parseRegistryKey,
  prefixPart,
  registryListPrefix,
  registryObjectKey,
  registryPrefix,
} from './drivers/_shared/object-registry-keys';

// Retry classification shared by the SDK-backed drivers — which failures are transient, and which are ours.
export {
  errorName,
  httpStatus,
  isNetworkOrTimeout,
  isSdkRetryable,
  isServerSide,
} from './drivers/_shared/aws-errors';
