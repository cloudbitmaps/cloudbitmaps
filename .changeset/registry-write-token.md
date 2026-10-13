---
'@cloudbitmaps/core': minor
'@cloudbitmaps/roaring': minor
'@cloudbitmaps/s3': minor
'@cloudbitmaps/gcs': minor
'@cloudbitmaps/azure-blob': minor
---

A registry can report the token of each write before it sends it (`RegistryWriteOptions.onToken`, with `IRegistryDriver.reportsWriteTokens`), and the in-memory, local-filesystem, S3, GCS and Azure Blob registries do. On a registry that reports tokens, a load, an erasure rewrite and every other publish whose registry write conflicts or gets no answer counts the write as its own only when the row's `pointerId` is the token of a write it sent, so a load whose write lost to another load's publish of the same ids reports `superseded`, audits a refusal and deletes nothing the row names, where it reported its own publish. On such a registry, a write of its own that landed and was then followed, before the call read the row again, by a write that renews the row's `pointerId` over it (an erasure's renewal, or a rollback that moved the pointer off the generation and back) reads as not its own: nothing is deleted, and a re-run publishes, or erases. A registry that wraps or extends another and overrides `create` or `compareAndSwap` either passes `options` through to the write it forwards, or sets `reportsWriteTokens` to `false`; one that does neither reads every write of its own that landed after an error or a lost answer as not its own (`superseded`), and deletes nothing. Each token a registry reports is unique to its write attempt. A registry of your own that does not report tokens keeps the check by the footer of the object.
