---
'@cloudbitmaps/core': minor
'@cloudbitmaps/roaring': minor
'@cloudbitmaps/s3': minor
'@cloudbitmaps/gcs': minor
'@cloudbitmaps/azure-blob': minor
---

`StorageChunkSource` gains an optional `getChunks(ref, keys, options?)`, which reads several chunks of one segment from one generation in as few range requests as their layout allows and answers them with the version they were read from; `CrbmStorageChunkSource` implements it, and `ChunksRead` and `ReadChunksOptions` are exported from `@cloudbitmaps/core`. The library's own reads do not call it yet.
