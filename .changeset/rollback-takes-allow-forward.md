---
"@cloudbitmaps/roaring": patch
---

`store.rollback`'s options type takes `allowForward`, as `rollbackSegment`'s does, so rolling forward through the
store compiles. The user-facing entry is in the root `CHANGELOG.md`, under `[Unreleased]`: `Fixed`.
