---
"@cloudbitmaps/core": minor
"@cloudbitmaps/roaring": patch
---

`store.load()` reads the segment's registry row once before its publish, and numbers its generation with one
existence check instead of a listing, falling back to the listing when the check finds the number taken; the cost
model prices a load at the requests it now makes. The storage conformance suite checks a zero-byte tail read of a
missing object. The user-facing entry is in the root `CHANGELOG.md`, under `[Unreleased]`: `Changed`.
