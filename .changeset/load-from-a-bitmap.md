---
"@cloudbitmaps/core": minor
"@cloudbitmaps/roaring": minor
---

`store.load` and `loadSegment` take a bitmap as well as ids: `{ bitmap }` (anything with `serialize('portable')`) or
`{ serialized }` portable Roaring bytes, checked before anything is written and written from the bitmap's own chunks
through the new optional `CodecBitmap.encodeChunks` seam. A byte array passed as ids is refused with `ValidationError`,
a breaking change that rides in the minor before 1.0. The roaring codec's `optimize()` is canonical. The user-facing
entries are in the root `CHANGELOG.md`, under `[Unreleased]`: `Breaking`, `Added` and `Changed`.
