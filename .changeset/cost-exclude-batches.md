---
'@cloudbitmaps/tools': patch
---

The cost model's `chunksPerIntersect` documents how to count the requests of an `exclude` that an intersect of two or more segments reads in batches of its surviving keys (63 for 1,000 survivors where it was 1,000), and that a source with no `getChunks` still reads it per key.
