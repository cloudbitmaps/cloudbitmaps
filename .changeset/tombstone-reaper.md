---
'@cloudbitmaps/core': minor
'@cloudbitmaps/roaring': minor
'@cloudbitmaps/s3': minor
'@cloudbitmaps/gcs': minor
'@cloudbitmaps/azure-blob': minor
---

`store.reapRegistryTombstones({ namespace?, dryRun?, confirmNoLegacyWriters?, limit? })` removes the `deleted: true` rows a release before 0.12.0 left in an object-store registry, which no other call removes and every full listing still reads. It touches only a deleted row with no incarnation id, never a live row, a `destroyed` row or a row a 0.12 or later release wrote, so it does not clean a bucket completely: the tombstones `dropSegment` leaves stay. A real run needs `confirmNoLegacyWriters: true`; each delete is conditioned on the version read, so a `create` that lands over the envelope first wins; a registry whose `conditionalDelete` is off throws `CapabilityError` before any request. `reapRegistryTombstones(registry, options)` is the free function, `IRegistryDriver` gains the optional `reapLegacyTombstones` member that the object-store registries implement, and `ObjectRegistryStore` an optional `resolveCapabilities`.
