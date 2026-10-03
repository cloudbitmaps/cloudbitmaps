---
"@cloudbitmaps/core": minor
"@cloudbitmaps/roaring": minor
---

A `.crbm` generation can carry metadata in an extension block between its last payload and its index, which its footer
flags with a new bit; the format stays 1.0, and a reader before 0.12 refuses an object that carries one. A generation
without metadata is written byte for byte as before.
`CrbmReader` reads both and exposes the metadata as `metadata`, the reader cache counts it against its byte bound,
and `aadFor` takes a `'metadata'` scope. A cleartext object opened with a key is now refused, and a rollback refuses a
target whose encryption disagrees with the row. The user-facing entries are in the root `CHANGELOG.md`, under
`[Unreleased]`: `Breaking`, `Added` and `Fixed`.
