---
'@cloudbitmaps/core': patch
---

An `exclude` of an `intersect` or `intersectInto` of two or more segments is read in batches of the surviving keys it holds (half of `concurrency` keys a batch, joining reads already in flight), so 1,000 surviving keys cost the exclude itself 63 range requests where each cost one (the whole intersect 65 where it was 1,002); a key whose intersection is empty still never reads its exclude chunk.
