---
"@cloudbitmaps/core": patch
"@cloudbitmaps/roaring": patch
---

A subject erasure reports `erased: true` only when no generation of the segment holds the id: it deletes every
holder above the pointer after a rollback, reports a rollback that lands mid-erasure instead of attesting over it,
and a refused concurrent rewrite deletes its own object when it would outlive the winner. No API change. The
user-facing entry is in the root `CHANGELOG.md`, under `[Unreleased]`: `Fixed`.
