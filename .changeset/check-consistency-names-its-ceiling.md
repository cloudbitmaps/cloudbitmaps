---
"@cloudbitmaps/core": patch
---

The `BudgetExceededError` a consistency check throws past its ceiling names `runConsistencyCheck` as the call that
raises `maxScanSegments`, since `store.checkConsistency` takes none. The user-facing entry is in the root
`CHANGELOG.md`, under `[Unreleased]`: `Fixed`.
