---
'@cloudbitmaps/core': minor
'@cloudbitmaps/roaring': minor
'@cloudbitmaps/s3': minor
'@cloudbitmaps/azure-blob': minor
'@cloudbitmaps/gcs': minor
'@cloudbitmaps/tools': minor
---

An object planted at a huge generation number no longer blocks a load or an erasure. A load that lists the bucket to number its generation ignores a listed number more than 1,024 above the highest number its row names (the pointer, any `knownGens` entry, any lease), steps past any contiguous run it meets, and never deletes, overwrites or takes such a number. `LoadResult` gains `strays`, `{ count, generations }` (the lowest 64, ascending), so the operator can look at what it ignored and delete it. Before, one object at the largest accepted number made every later load and erasure rewrite fail with "no generation number left", and a smaller one dragged every later number up to it.
