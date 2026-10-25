---
'@cloudbitmaps/core': minor
'@cloudbitmaps/roaring': minor
'@cloudbitmaps/s3': minor
'@cloudbitmaps/azure-blob': minor
'@cloudbitmaps/gcs': minor
'@cloudbitmaps/tools': minor
---

`@cloudbitmaps/roaring` gains a public `RoaringBitmap` class, importable from `@cloudbitmaps/roaring/bitmap` and the main entry, and `RoaringBitmap.deserialize` as the one door for portable bytes; `deserializePortable` and `ReadonlyBitmap` are removed (call `RoaringBitmap.deserialize`; the result is mutable).
