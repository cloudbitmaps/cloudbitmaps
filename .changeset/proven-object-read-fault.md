---
'@cloudbitmaps/core': patch
'@cloudbitmaps/roaring': patch
'@cloudbitmaps/s3': patch
'@cloudbitmaps/gcs': patch
'@cloudbitmaps/azure-blob': patch
---

A refused erasure whose read of its own object faults retries it and throws the fault when it still fails, instead of keeping the object and answering `superseded`.
