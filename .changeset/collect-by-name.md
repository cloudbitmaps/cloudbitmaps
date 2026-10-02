---
"@cloudbitmaps/core": minor
"@cloudbitmaps/roaring": patch
---

`store.load()` deletes by name the one generation its publish pushed out of the window, with no listing, when it
numbered its generation with one existence check and keeps at most one generation; it lists on every sixteenth
generation, when the check met an object or its guard found the current object gone, and for a `keep` of 2 or more.
`LoadDeps.collectByListing` makes `loadSegment` list whatever `keep` is, and the `*Into` verbs set it. The cost model
prices a load at the requests it now makes. The user-facing entries are in the root `CHANGELOG.md`, under
`[Unreleased]`: `Added` and `Changed`.
