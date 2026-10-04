---
'@cloudbitmaps/core': minor
'@cloudbitmaps/roaring': minor
---

A read of a small generation, whose chunks all arrived with its tail, makes no further request for them: when a reader's tail read returns the whole object and its chunk region is at most the reader cache's share per reader (`cache.readerMaxBytes` over `cache.readerMax`, 64 KiB by default), the reader keeps a copy of it and serves `getChunk` and `getChunks` from memory, checked as a range-read chunk is and returned as a copy. Small generations' chunk bytes now stay with their reader, up to the reader cache's byte bound, alongside any decoded copies in the chunk cache; they count in the reader's `retainedBytes`, so the bounds hold. Only a store with a timed pointer refresh keeps them. A `storage.get` metric is reported only for a request a source sent, and a point read through a source with `getChunks` is a one-key stream.
