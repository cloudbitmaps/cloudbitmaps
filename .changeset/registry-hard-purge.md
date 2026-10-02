---
"@cloudbitmaps/core": minor
"@cloudbitmaps/roaring": minor
"@cloudbitmaps/s3": minor
"@cloudbitmaps/gcs": minor
"@cloudbitmaps/azure-blob": minor
---

A registry whose backend applies a precondition on a delete removes a deleted row for good, and the retention sweep's
purge of a tombstone with it, so a full sweep reads what is live and inside its grace. `RegCaps.conditionalDelete`
says which a registry does, and `S3Storage`, `GcsStorage` and `AzureBlobStorage` take a `conditionalDelete` option,
on by default for AWS S3, GCS on its public endpoint and Azure Blob. Each retirement files a due-index pointer for its
tombstone, so an index scan purges too. The registry needs delete permission on its prefix. The user-facing entries
are in the root `CHANGELOG.md`, under `[Unreleased]`: `Breaking`, `Added` and `Changed`.
