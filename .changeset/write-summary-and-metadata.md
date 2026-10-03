---
"@cloudbitmaps/core": minor
"@cloudbitmaps/roaring": minor
---

`load` and the `*Into` verbs take `metadata`, a small record written into the generation's object and, with its id
count, into the registry row's summary by the write that moves the pointer. A rollback writes its target's own, an
erasure's rewrite carries it over, a shred and a drop clear it. A guarded load sizes the current generation from the
row's summary and reads no tail of it, and looks for the current object with one zero-byte read before it deletes by
name. The user-facing entries are in the root `CHANGELOG.md`, under `[Unreleased]`: `Added` and `Changed`.
