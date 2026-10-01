---
"@cloudbitmaps/core": minor
"@cloudbitmaps/roaring": minor
---

An expired exclusion excludes nothing in every combine: `intersect` and `union` with an `exclude` no longer subtract
the ids of an expired handle, as `andNot` already did not. Pre-`1.0`, a call that returns different ids is a minor
bump. The user-facing entry is in the root `CHANGELOG.md`, under `[Unreleased]`: `Breaking`.
