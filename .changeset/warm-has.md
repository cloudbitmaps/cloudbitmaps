---
'@cloudbitmaps/core': patch
'@cloudbitmaps/roaring': patch
---

A warm `has()` and `count()` skip the clock read on a hit in a cache built without a TTL and, with no metrics sink, the timing frame.
