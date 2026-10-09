---
'@cloudbitmaps/core': patch
'@cloudbitmaps/roaring': patch
---

A load that found no registry row is refused as `superseded` when a row appears before its publish, guarded or not; an unguarded one could move the pointer over that row, and onto an object a subject erasure had deleted, after which every read of the segment failed with `NotFoundError`.
