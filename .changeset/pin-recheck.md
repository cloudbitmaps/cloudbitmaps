---
'@cloudbitmaps/core': patch
'@cloudbitmaps/roaring': patch
'@cloudbitmaps/s3': patch
'@cloudbitmaps/azure-blob': patch
'@cloudbitmaps/gcs': patch
'@cloudbitmaps/tools': patch
---

A pinned handle re-reads its segment's registry row at most every `cache.genTtlMs` and fails once the segment is destroyed or its generation erased.
