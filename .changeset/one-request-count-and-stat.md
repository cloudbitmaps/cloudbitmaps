---
"@cloudbitmaps/core": minor
"@cloudbitmaps/roaring": minor
---

A cold `count()` is one pointer read: the registry row records the current generation's id count, so a count opens no
object, cleartext or encrypted, and whatever the index's width. `seg.stat()` returns the generation's number, id count
and metadata from the same resolution, and the current entry of `store.generations()` carries them. The row's summary
is held against the object whenever a read opens it anyway, and a disagreement stops the store using it.
`checkConsistency({ summaries: true })` reports `summary-mismatch`. A cold `count()` over a torn restore answers the
row's number where it threw. The user-facing entries are in the root `CHANGELOG.md`, under `[Unreleased]`: `Added` and
`Changed`.
