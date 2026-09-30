---
"@cloudbitmaps/core": minor
"@cloudbitmaps/roaring": minor
---

`bulkLoadCrbmGeneration` and `BulkLoadResult` are no longer exported; load with `store.load()` or `loadSegment()`.
Pre-`1.0`, a removed export is a minor bump. The user-facing entries are in the root `CHANGELOG.md`, under
`[Unreleased]`: `Breaking` and `Fixed`.
