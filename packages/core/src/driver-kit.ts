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

// The typed errors a driver must throw, and the predicates that classify one across package copies.
// (`instanceof` does not hold between two packages — each carries its own copy of these classes.)
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
// where a registry row lives. Every cloud registry driver re-exports the four `registry*` helpers verbatim,
// so the key layout is defined once here rather than three times — two drivers disagreeing about where a row
// lives would be a silent cross-driver incompatibility on the same bucket.
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
