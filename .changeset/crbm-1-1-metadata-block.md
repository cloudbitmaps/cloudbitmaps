---
"@cloudbitmaps/core": minor
"@cloudbitmaps/roaring": minor
---

The `.crbm` format gains minor 1.1: a generation written with metadata carries it in an extension block between its
last payload and its index, which a 0.11 reader skips, and a generation without metadata is still 1.0 byte for byte.
`CrbmReader` reads both and exposes the metadata as `metadata`, the reader cache weighs it (`retainedBytes`), and
`aadFor` takes a `'metadata'` scope. A cleartext object opened with a key is now refused. The user-facing entries are
in the root `CHANGELOG.md`, under `[Unreleased]`: `Added` and `Fixed`.
