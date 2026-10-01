---
"@cloudbitmaps/core": minor
"@cloudbitmaps/roaring": minor
---

`eraseNamespace` holds its listing of the namespace to `maxScanSegments` (default 250,000, the ceiling every other
fleet scan keeps) and takes that option, so a call over a larger namespace now throws `BudgetExceededError` where it
erased it. It lists before it destroys, so the refusal erases nothing. Pre-`1.0`, a call that throws where it returned
is a minor bump. The user-facing entry is in the root `CHANGELOG.md`, under `[Unreleased]`: `Breaking`.
