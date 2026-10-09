---
'@cloudbitmaps/core': minor
'@cloudbitmaps/roaring': minor
'@cloudbitmaps/tools': minor
---

Moves the cost model out of core and roaring into a new package, `@cloudbitmaps/tools` (`CloudRoaring.estimateCost` and `seg.costReport()` are removed), and `stat()` reports the generation's byte size, `size`, so a grounded report needs nothing internal.
