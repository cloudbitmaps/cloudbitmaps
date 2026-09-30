---
"@cloudbitmaps/core": patch
"@cloudbitmaps/roaring": patch
---

`subjectReport` sees a load or an erasure made by another process at once instead of after `cache.genTtlMs`; a
throwing `retry.onRetry` hook no longer stops the retry or replaces the read's error; and an erasure whose sweep
of the other generations finds an object gone reports `'superseded'` when the pointer moved. The user-facing entries
are in the root `CHANGELOG.md`, under `[Unreleased]`: `Fixed`.
