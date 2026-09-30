---
"@cloudbitmaps/core": minor
"@cloudbitmaps/roaring": minor
"@cloudbitmaps/gcs": minor
"@cloudbitmaps/s3": minor
"@cloudbitmaps/azure-blob": minor
---

The size settings are options of the backend classes: `S3Storage` takes `partBytes` and `maxObjectBytes`,
`GcsStorage` takes `simpleUploadThresholdBytes` and `maxObjectBytes`, and `AzureBlobStorage` takes `blockBytes` and
`maxObjectBytes`, each with the name, default and validation it had on the separate storage half. The separate
storage and registry halves (`S3StorageDriver`, `S3RegistryDriver`, `GcsStorageDriver`, `GcsRegistryDriver`,
`AzureBlobStorageDriver`, `AzureBlobRegistryDriver`, `MemoryStorageDriver`, `MemoryRegistryDriver`,
`LocalFsStorageDriver`, `LocalFsRegistryDriver`), their options types and `createBackend` are no longer exported.
Build a backend from a backend class; to pair halves of your own, use `brandAsBackend({ storage, registry })` from
`@cloudbitmaps/core/driver-kit`, which now checks that each half is a driver. Pre-`1.0`, a removed export is a minor
bump. The user-facing entries are in the root `CHANGELOG.md`, under `[Unreleased]`: `Breaking`.
