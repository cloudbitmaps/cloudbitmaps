---
"@cloudbitmaps/core": patch
"@cloudbitmaps/roaring": patch
---

The local-filesystem registry serializes a row's compare-and-swap across the whole process, not per instance, so two
backends on one root in one process can no longer both advance a row from one token. The user-facing entry is in the
root `CHANGELOG.md`, under `[Unreleased]`: `Fixed`.
