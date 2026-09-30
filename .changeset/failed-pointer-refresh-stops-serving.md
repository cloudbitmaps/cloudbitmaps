---
"@cloudbitmaps/core": minor
"@cloudbitmaps/roaring": minor
---

A pointer refresh that fails with anything but a `TransientError` now throws to the read that met it, where it
kept serving the old reader, and its snapshot is dropped. A transient failure still keeps serving, and the retry
comes after 500 ms rather than after a whole `cache.genTtlMs`. A read that returned can now throw, which
pre-`1.0` is a minor bump. The user-facing entries are in the root `CHANGELOG.md`, under `[Unreleased]`: `Breaking`
and `Fixed`.
