---
'@cloudbitmaps/core': minor
'@cloudbitmaps/roaring': minor
---

`@cloudbitmaps/roaring` adds `seg.pinAt({ generation, fingerprint })`, which reopens a generation an earlier pin recorded, and exports the `PinAt` type. `@cloudbitmaps/core`'s `CrbmStorageChunkSource` gains `pinGenerationAt`, which opens that generation and verifies its fingerprint.
