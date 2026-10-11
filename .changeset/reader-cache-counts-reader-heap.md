---
'@cloudbitmaps/core': patch
'@cloudbitmaps/roaring': patch
---

The reader cache's byte ceiling (`cache.readerMaxBytes`) counts the fixed heap of each open reader, 3.75 KiB, besides its index, metadata and kept chunk bytes, so a deployment that raised `cache.readerMax` for many small segments is held to the byte ceiling it set. An encrypted segment's key is kept in memory of its own, not as a view on a slab of Node's shared buffer pool (8 KiB on Node 22, 64 KiB on recent Node 24), so an open encrypted reader no longer pins a whole slab that no weight counted.
