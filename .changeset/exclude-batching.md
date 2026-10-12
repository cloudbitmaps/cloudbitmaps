---
'@cloudbitmaps/core': patch
---

An `exclude` of an `intersect` or `intersectInto` of two or more segments is read in batches of the surviving keys that ask for it together, as coalesced ranges that leave out the chunks the cache holds, so 1,000 surviving keys cost it about 65 range requests (about 35 read a chunk at a time) where each cost one; a key whose intersection is empty still never reads its exclude chunk.
