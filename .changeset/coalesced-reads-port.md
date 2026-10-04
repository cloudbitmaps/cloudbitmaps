---
'@cloudbitmaps/core': minor
'@cloudbitmaps/roaring': minor
'@cloudbitmaps/s3': minor
'@cloudbitmaps/gcs': minor
'@cloudbitmaps/azure-blob': minor
---

`StorageChunkSource` gains an optional `getChunks(ref, keys, options?)`, which streams several chunks of one segment, read from one generation in as few range requests as their layout allows, each with the version it was read from, and reports every range request it sends, those a stopping consumer leaves in flight included, through an optional `onRequest`; `CrbmStorageChunkSource` implements it, and `ChunkRead` and `ReadChunksOptions` are exported from `@cloudbitmaps/core`. The stream holds at most `concurrency` ranges at a time whatever the key list; a consumer that stops early leaves requests in flight that finish and are not retried, a stream that fails raises at once, and a stream that heals first waits for the requests the failed one left in flight. Combines and `iterate` read each operand's chunks through it: chunks that sit near each other are one range request, so a cold intersect that took a request for every shared chunk takes a few requests, and `concurrency` counts range requests held ahead per operand.
