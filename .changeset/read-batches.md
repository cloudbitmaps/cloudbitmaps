---
'@cloudbitmaps/core': minor
'@cloudbitmaps/roaring': minor
'@cloudbitmaps/s3': minor
'@cloudbitmaps/gcs': minor
'@cloudbitmaps/azure-blob': minor
---

`iterate`, `intersect`, `union` and `andNot` return an `IdStream`: still an `AsyncIterable<number>`, now with `.batches()`, which yields each chunk's ids as one ascending `Uint32Array` (the same ids and order as the per-id stream, no empty arrays), several times faster than one `await` per id on a large scan. `CodecBitmap` gains an optional `toUint32Array()`.
