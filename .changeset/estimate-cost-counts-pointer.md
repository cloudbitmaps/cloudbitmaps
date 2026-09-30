---
"@cloudbitmaps/core": minor
"@cloudbitmaps/roaring": minor
---

`estimateCost()` counts the pointer, the index and the pointer refresh, and `segment.costReport()` prices the
refresh at the store's own `cache.genTtlMs`. `CostReport.monthlyUSD.byOp` gains the required `pointerRefresh`, and
an `operandsPerIntersect` below 1 is refused. The user-facing entries are in the root `CHANGELOG.md`, under
`[Unreleased]`: `Breaking` and `Fixed`.
