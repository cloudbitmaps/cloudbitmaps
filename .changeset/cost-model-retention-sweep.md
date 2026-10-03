---
"@cloudbitmaps/core": minor
---

The cost model prices the retention sweep: `Workload` gains `retirementsPerMonth`, `purgesPerMonth` and
`conditionalDelete`, and `CostReport.monthlyUSD.byOp` gains the required `retention`. The user-facing entry is in the
root `CHANGELOG.md`, under `[Unreleased]`: `Breaking` and `Added`.
