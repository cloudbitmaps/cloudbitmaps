---
'@cloudbitmaps/core': patch
'@cloudbitmaps/roaring': patch
'@cloudbitmaps/s3': patch
'@cloudbitmaps/gcs': patch
'@cloudbitmaps/azure-blob': patch
---

The object-store drivers trim the slashes at the ends of `prefix` in linear time; a long run of slashes inside a prefix took time quadratic in its length on every key built.
