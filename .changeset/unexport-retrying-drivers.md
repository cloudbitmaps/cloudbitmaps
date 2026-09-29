---
"@cloudbitmaps/core": minor
"@cloudbitmaps/roaring": minor
---

`RetryingStorageDriver` and `RetryingRegistryDriver` are no longer exported; the store's read retry is unchanged, and
a write is retried by re-running the call. Pre-`1.0`, a removed export is a minor bump. The user-facing entry is in
the root `CHANGELOG.md`, under `[Unreleased]`: `Breaking`.
