---
'@cloudbitmaps/core': minor
'@cloudbitmaps/roaring': minor
'@cloudbitmaps/s3': minor
'@cloudbitmaps/gcs': minor
'@cloudbitmaps/azure-blob': minor
---

`StorageChunkSource` gains an optional `getChunks(ref, keys, options?)`, which streams several chunks of one segment, read from one generation in as few range requests as their layout allows, each with the version it was read from; `CrbmStorageChunkSource` implements it, and `ChunkRead` and `ReadChunksOptions` are exported from `@cloudbitmaps/core`. The stream holds at most `concurrency` ranges at a time whatever the key list. The library's own reads do not call it yet.
