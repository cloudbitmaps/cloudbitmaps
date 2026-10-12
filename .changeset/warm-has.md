---
'@cloudbitmaps/core': patch
'@cloudbitmaps/roaring': patch
---

A warm `has()` and `count()` skip the clock read on a cache hit and, with no metrics sink, the timing frame.
