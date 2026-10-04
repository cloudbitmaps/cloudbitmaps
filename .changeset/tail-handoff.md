---
'@cloudbitmaps/core': patch
'@cloudbitmaps/roaring': patch
---

A read of a small generation, whose chunks all arrived with its tail, makes no further request for them: when a reader's tail read returns the whole object and its chunk region is at most the reader cache's share per reader (`cache.readerMaxBytes` over `cache.readerMax`, 64 KiB by default), the reader keeps a copy of it and serves `getChunk` and `getChunks` from memory, checked as a range-read chunk is and returned as a copy. The kept bytes count in the reader's `retainedBytes`, so the reader cache's bounds hold.
