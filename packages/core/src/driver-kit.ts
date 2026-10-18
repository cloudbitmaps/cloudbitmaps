/*
 * The contract a storage-driver package builds against.
 *
 * `@cloudbitmaps/s3`, `@cloudbitmaps/gcs` and `@cloudbitmaps/azure-blob` live outside this package but are
 * built from its internals: the driver ports they implement, the typed errors they must throw, and the
 * object-store registry that gives an S3-shaped service compare-and-swap semantics. A subpath is how a
 * separate package reaches them without reaching into core's source.
 *
 * WHY A SUBPATH AND NOT THE MAIN ENTRY. The main entry is the engine the flavor builds on, and it is internal:
 * outside the stability promise, free to change in any minor release. A driver's contract has to be public, and
 * it deserves to be a deliberate list rather than whatever core happens to export: the ports a driver implements,
 * the errors it throws, the helpers it builds on, and every type those signatures name. A third-party driver
 * builds against exactly this.
 *
 * It is versioned public API. Anything added here is something we support; anything removed is a breaking
 * change for a driver package — including ours, which is the point of making it explicit.
 *
 * It is the one home of the driver contracts, and it is complete: every type a signature here names is exported
 * here too, but for the brand symbols, which no driver names: a backend writes the store's brand as
 * `[STORAGE_BACKEND]`, and the errors carry their own. A registry driver that does not extend `ObjectStoreRegistry`
 * writes `IRegistryDriver`'s method signatures from the record types below, a read source of your own implements
 * `StorageChunkSource`, and a keystore implements `IKeystore`, each without importing `@cloudbitmaps/core`'s main
 * entry. `@cloudbitmaps/roaring` names these types in its own signatures (`CloudRoaringOptions['storage']`,
 * `EncryptionOptions['keystore']`) and does not re-export them: an application that has to name one imports it from
 * here.
 *
 * WHAT A DRIVER MUST DO. The port doc comments (`IStorageDriver`, `IRegistryDriver`) carry the full list, each with
 * the caller that depends on it. In short:
 *
 *  - Storage: `putImmutable` is write-once and throws `WriteConflictError` on a collision; a missing object makes
 *    `getRange`/`getTail` throw `NotFoundError`; an out-of-range read, and a `getTail` length that is not a safe
 *    integer, throw `ValidationError`; `getTail` returns the true total size, and the object's `version` where the
 *    driver has one; `delete` is idempotent; a driver that
 *    reports `conditionalDelete` deletes, given `ifVersion`, only the object that version names, in one step the
 *    backend applies, and throws `WriteConflictError` for another; `list` is strongly consistent, read-after-delete.
 *  - Registry: `create` and `compareAndSwap` are atomic conditional writes that throw `WriteConflictError` when
 *    they lose; a token is not reused (2^-128 per pair of incarnations of a name); every row carries `pointerId`, the
 *    token of its create or of the last compare-and-swap that named a resolved field (`renewsPointer`); `delete` is
 *    idempotent, and `delete(ref, expected)` lands only while the
 *    row still carries `expected`, else it throws `WriteConflictError`; `list` yields tombstones and every field.
 *    A registry may also report each write's token to `RegistryWriteOptions.onToken`, before it sends the write (a
 *    write sent again with a new token reports it; one that repeats the same body repeats the token already reported),
 *    unique to that write attempt, and say so with `reportsWriteTokens: true` (a getter or a field): a publish then
 *    takes a write as its own when the row's `pointerId`, which names the writer of the write that last set the
 *    pointer, is a token it was told. A registry that wraps or extends another and overrides `create` or
 *    `compareAndSwap` either passes `options` through to the write it forwards, or sets `reportsWriteTokens` to
 *    `false`. One that does neither reads every write of its own that landed after an error or a lost answer as not its
 *    own (`superseded`), and deletes nothing.
 *    A driver whose client may have sent a write more than once raises every conflict it cannot prove the write did not
 *    land before (another writer's write found on the read-back, a compare-and-swap that finds the row gone, a
 *    read-back that finds nothing) with `unsettledConflict`, so a load refused after it reports `unanswered: true`; a
 *    conflict that proves it (a write sent once, a check made before sending) is a plain `WriteConflictError`. A
 *    registry that wraps another rethrows the conflict it was given, unchanged: the check that reads the mark is
 *    internal. The registry conformance suite does not test this mark.
 *  - Either: never replay a conditional write without telling the replay apart (send it once, or recognise your
 *    own write on the read-back), and raise a transient fault as `TransientError`.
 *
 * PORT CHANGES are recorded in the root `CHANGELOG.md`, under **Added**, **Changed** or **Breaking** like any
 * other. A parameter added to a port method is optional, so an existing driver keeps compiling, and a parameter it does not
 * implement is ignored: `IRegistryDriver.delete`'s optional expected token, and
 * `IStorageDriver.delete`'s optional `ifVersion` with `StorageCaps.conditionalDelete` and `getTail`'s optional
 * `version`, are the current examples: a driver that ignores them deletes unconditionally. A driver that
 * wraps another forwards `ifVersion` and the `version` of a tail read, or reports `conditionalDelete: false`.
 */

// The ports a driver implements, and the brand that marks a pair of halves as a backend. `brandAsBackend` also
// checks that each half is a driver, so a plain `{ storage, registry }` object can be branded with it.
export type {
  GenKey,
  IRegistryDriver,
  IStorageDriver,
  LifecycleVerdict,
  SegmentRef,
  StorageBackend,
  StorageCaps,
  StorageDeleteOptions,
  TailRead,
} from './core/ports';
export { brandAsBackend, STORAGE_BACKEND } from './core/ports';

// The registry row and what a registry driver's methods take and return: the record, a new row, a patch, the write
// options, the capabilities, and the types a row's fields are made of. `GenerationMetadata` is a row summary's, and
// `@cloudbitmaps/roaring` exports it too, for a load's `metadata`.
export type {
  ClearRegistrySummary,
  GenerationMetadata,
  GovernanceMeta,
  KnownGeneration,
  LeaseEntry,
  NewRegistryRecord,
  RegCaps,
  RegistryPatch,
  RegistryRecord,
  RegistryStatus,
  RegistrySummary,
  RegistryWriteOptions,
  SealedRegistrySummary,
  Token,
} from './core/ports';

// The read-source port: a store takes a `StorageChunkSource` of your own as its `storage`, and these are the types its
// methods name.
export type {
  ChunkRead,
  ChunkRef,
  GenerationSummary,
  ReadChunksOptions,
  SegmentSize,
  StorageChunkSource,
} from './core/ports';

// The keystore port: what a store's `encryption.keystore` implements, the wrapped key a row stores, and the cipher a
// keystore hands back for a segment's key.
export type { Aead, AeadSealed, IKeystore, WrappedDek } from './core/crypto';

// The randomness `ObjectStoreRegistry` draws its tokens from, when a test injects it.
export type { Entropy } from './core/determinism';

// The metrics sink a store hands a backend that implements `StorageBackend.attachMetrics`, the event union it emits
// to, and the operation names an event carries.
export type { IMetricsSink, MetricEvent, MetricOpName } from './core/metrics';

// The typed errors a driver must throw, the class they extend, `errorKind`, which classifies one, and
// `unsettledConflict`, a registry's conflict that may follow its own write's landing.
//
// In an ordinary install `instanceof` holds: every package here leaves `@cloudbitmaps/core` external, so one
// copy of these classes is shared. Throw and catch them normally. `errorKind` matters where that stops
// being true — a bundler that inlines core into two outputs, two major versions side by side in one tree, a
// worker or vm realm — because each error is `Symbol.for`-branded and so is identified by brand rather than
// by prototype identity. Prefer it in library code that cannot see how it will be bundled.
export {
  CloudRoaringError,
  errorKind,
  IntegrityError,
  NotFoundError,
  TransientError,
  unsettledConflict,
  ValidationError,
  WriteConflictError,
} from './core/errors';
export type { ErrorKind } from './core/errors';

// A row's `pointerId`: the fields a read resolves through, whether a patch renews it, the patch that renews it alone,
// and the read of it that refuses a row without one. A registry that builds its own records applies the same rule:
// `pointerId` is the token of the create, or of the last compare-and-swap for which `renewsPointer(patch)` is true.
export { RESOLVED_FIELDS, pointerIdOf, renewPointer, renewsPointer } from './core/pointer-id';

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

// Where a generation's object lives in an object store, and how a listed key is read back to its generation number:
// one layout for every object-store driver, so a segment written through one reads identically through another.
export {
  parseGenerationFromKey,
  segmentObjectPrefix,
  storageObjectKey,
} from './drivers/_shared/object-keys';

// Option checks a backend or driver applies to its constructor's options, each refusing with `ValidationError`.
export { refuseUnknownOptions, requireBool, requirePositiveInt } from './drivers/_shared/options';

// A fault's classification: a connection Node reports as failed or cut off, and the hand-off of a transient fault as
// `TransientError`. A driver's reading of its own service's statuses and codes stays the driver's.
export { isTransportFault, toTransient } from './drivers/_shared/faults';

// One buffer from the chunks a sink or a body read collected.
export { concatBytes } from './drivers/_shared/bytes';
