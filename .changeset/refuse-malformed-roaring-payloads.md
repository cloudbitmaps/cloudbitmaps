---
"@cloudbitmaps/roaring": minor
---

`SafeBitmap.safeDeserialize` checks the structure of the portable bytes before the native addon sees them, and
refuses with `IntegrityError` what the native deserializer accepts and roaring's invariants forbid: containers or
values out of order or listed twice, runs that overlap, touch or run past their container, a run container with no
runs, and cardinalities that disagree with the bits. The user-facing entries are in the root `CHANGELOG.md`, under
`[Unreleased]`: `Breaking` and `Fixed`.
