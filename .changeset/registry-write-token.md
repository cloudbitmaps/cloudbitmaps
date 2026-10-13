---
'@cloudbitmaps/core': minor
'@cloudbitmaps/roaring': minor
'@cloudbitmaps/s3': minor
'@cloudbitmaps/gcs': minor
'@cloudbitmaps/azure-blob': minor
---

A registry can report the token of each write before it sends it (`RegistryWriteOptions.onToken`, with `IRegistryDriver.reportsWriteTokens`), and the in-memory, local-filesystem, S3, GCS and Azure Blob registries do. A load, an erasure rewrite and every other publish whose registry write conflicts or gets no answer counts the write as its own only when the row's `pointerId` is the token of a write it sent, so a load whose write lost to another load's publish of the same ids reports `superseded`, audits a refusal and deletes nothing the row names, where it reported its own publish. A registry of your own that does not report tokens keeps the check by the footer of the object.
