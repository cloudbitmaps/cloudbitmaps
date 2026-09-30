---
"@cloudbitmaps/core": minor
"@cloudbitmaps/roaring": minor
---

`eraseSubject` charges its per-op budget for the generations it opens beyond the one a segment's row names, and a
segment that runs the budget out is listed `erased: false` with an `error:` note before any of its generations is
deleted. A call that listed nothing for a segment can now list an error entry for it, which pre-`1.0` is a minor
bump. The user-facing entry is in the root `CHANGELOG.md`, under `[Unreleased]`: `Breaking`.
