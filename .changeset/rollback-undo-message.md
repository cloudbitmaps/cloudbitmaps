---
"@cloudbitmaps/core": patch
---

The `NotFoundError` a rollback throws when its undo fails says the pointer may still name the collected generation,
where it said the pointer could not be put back: a swap that applied and lost its response throws too. The
user-facing entry is in the root `CHANGELOG.md`, under `[Unreleased]`: `Fixed`.
