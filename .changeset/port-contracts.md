---
"@cloudbitmaps/core": minor
"@cloudbitmaps/roaring": minor
"@cloudbitmaps/gcs": minor
"@cloudbitmaps/s3": minor
"@cloudbitmaps/azure-blob": minor
---

`IRegistryDriver.delete` takes an optional expected token, `delete(ref, expected?)`: given, the delete lands only
while the row still carries it, and otherwise throws `WriteConflictError`. A driver that ignores it keeps the
unfenced delete. The retention sweep passes it where it deletes a row it has just read, so a segment re-created
after the decision is no longer tombstoned. The driver ports now state what callers rely on, and a storage-driver
conformance suite holds the memory, local-filesystem, S3, GCS and Azure Blob drivers to it. The user-facing
entries are in the root `CHANGELOG.md`, under `[Unreleased]`: `Added` and `Fixed`.
