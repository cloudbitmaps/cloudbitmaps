---
"@cloudbitmaps/core": minor
"@cloudbitmaps/roaring": minor
---

An id-range read: `iterate({ after, through })`, and the same options on every combine, yield only the ids in
`(after, through]` and fetch only the chunks the range overlaps. Two changes in the same work make a call throw
where it returned, which pre-`1.0` is a minor bump: `seg.union([expired])` and `seg.andNot([expired])` check `seg`
as every combine does, and take the call's `concurrency` and `budget`; and a custom `StorageChunkSource` that
lists one chunk key twice is refused. The user-facing entries are in the root `CHANGELOG.md`, under
`[Unreleased]`: `Added` and `Breaking`.
