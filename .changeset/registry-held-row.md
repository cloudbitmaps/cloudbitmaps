---
'@cloudbitmaps/core': minor
'@cloudbitmaps/roaring': minor
'@cloudbitmaps/s3': minor
'@cloudbitmaps/gcs': minor
'@cloudbitmaps/azure-blob': minor
---

`IRegistryDriver.create` and `compareAndSwap` take an optional last argument, `options?: RegistryWriteOptions`, whose `held` is the row the caller read and is writing against (`null`: it found none), and `RegistryWriteOptions` is exported from `@cloudbitmaps/core` and `@cloudbitmaps/roaring`. A registry that keeps the version of the object it read can send its conditional write at once instead of reading the row first; the store's own condition (`If-Match`, `ifGenerationMatch`, or create-only) is still the fence, so a `held` row that has changed since fails the write with `WriteConflictError` exactly as a lost race does. `ObjectStoreRegistry`, and so the S3, GCS and Azure Blob registries, does; the in-memory and local-filesystem registries accept the option and read no more for it. A driver that ignores it reads the row, as before. A load, an `*Into` and an erasure's rewrite pass the row their publish acts on, which makes a load one registry request fewer; a write that gets no answer is still settled by reading the row, and never by `held`. The request counts `estimateCost()` prices a load at fall by one pointer read, and the registry conformance suite gains the `held` cases.
