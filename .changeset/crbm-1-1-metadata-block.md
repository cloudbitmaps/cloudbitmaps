---
"@cloudbitmaps/core": minor
---

The `.crbm` format gains minor 1.1: a generation written with metadata carries it in an extension block between its
last payload and its index, which a 0.11 reader skips, and a generation without metadata is still 1.0 byte for byte.
`CrbmReader` reads both and exposes the metadata as `metadata`; `aadFor` takes a `'metadata'` scope. The user-facing
entry is in the root `CHANGELOG.md`, under `[Unreleased]`, `Added`.
