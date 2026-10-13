---
'@cloudbitmaps/core': minor
'@cloudbitmaps/roaring': minor
'@cloudbitmaps/s3': minor
'@cloudbitmaps/gcs': minor
'@cloudbitmaps/azure-blob': minor
---

A registry can report the token of each write before it sends it (`RegistryWriteOptions.onToken`, with `IRegistryDriver.reportsWriteTokens`), and the in-memory, local-filesystem, S3, GCS and Azure Blob registries do. A load, an erasure rewrite and every other publish whose registry write conflicts or gets no answer counts the write as its own only when the row's `pointerId` is the token of a write it sent, so a load whose write lost to another load's publish of the same ids reports `superseded`, audits a refusal and deletes nothing the row names, where it reported its own publish. A write of its own that landed and was then followed, before the call read the row again, by a write that renews the row's `pointerId` without moving the pointer (an erasure's renewal, a rollback onto the generation) reads as not its own: nothing is deleted, and a re-run publishes. A registry that overrides `create` or `compareAndSwap` declares `reportsWriteTokens` beside them and passes `options` through, and each token it reports is unique to its write attempt. A registry of your own that does not report tokens keeps the check by the footer of the object.
