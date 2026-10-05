---
'@cloudbitmaps/core': minor
'@cloudbitmaps/roaring': minor
'@cloudbitmaps/s3': minor
'@cloudbitmaps/gcs': minor
'@cloudbitmaps/azure-blob': minor
---

`store.reapRegistryTombstones({ namespace?, dryRun?, confirmNoLegacyWriters?, limit? })` removes the `deleted: true` rows with no incarnation id from an object-store registry, which a release before 0.12.0 left (or a 0.12.0 or later release left by deleting a row born before 0.12.0), which no other call removes, and which every full listing still reads. It never touches a live row, a `destroyed` row that is not `deleted`, or a row with an incarnation id, so it does not clean a bucket completely: the tombstones `dropSegment` leaves stay, and so does one written while `conditionalDelete` was off. A real run needs `confirmNoLegacyWriters: true`; each delete is conditioned on the version read, so a `create` that lands over the envelope first wins (on an endpoint that ignores `If-Match`, a `conditionalDelete: true` you set makes it unfenced); a registry whose `conditionalDelete` is off throws `CapabilityError` before any request. A run is not resumable. `reapRegistryTombstones(registry, options)` is the free function, `IRegistryDriver` gains the optional `reapLegacyTombstones` member that the object-store registries implement, and `ObjectRegistryStore` an optional `resolveCapabilities`.
