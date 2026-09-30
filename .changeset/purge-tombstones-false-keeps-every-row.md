---
"@cloudbitmaps/core": patch
"@cloudbitmaps/roaring": patch
---

`retireExpired` with `purgeTombstones: false` keeps the row of a retired segment that held nothing, stamped, where it
deleted it in the same pass whatever the option said. The default is unchanged. The user-facing entry is in the root
`CHANGELOG.md`, under `[Unreleased]`: `Fixed`.
