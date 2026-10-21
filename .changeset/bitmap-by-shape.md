---
'@cloudbitmaps/core': minor
'@cloudbitmaps/roaring': minor
'@cloudbitmaps/s3': minor
'@cloudbitmaps/azure-blob': minor
'@cloudbitmaps/gcs': minor
'@cloudbitmaps/tools': minor
---

A bitmap passed where ids go is recognised by its shape (an object with a `serialize` method), so a `RoaringBitmap32` from another copy of `roaring` loads as a bitmap, not as the ids it iterates; `sorted: true` with one now throws `ValidationError`.
