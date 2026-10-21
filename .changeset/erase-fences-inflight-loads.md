---
'@cloudbitmaps/core': patch
'@cloudbitmaps/roaring': patch
'@cloudbitmaps/s3': patch
'@cloudbitmaps/gcs': patch
'@cloudbitmaps/azure-blob': patch
---

Every load that read the row before an erasure that found the id began is refused, by the erasure's write to the row or by another write that already changed its token.
