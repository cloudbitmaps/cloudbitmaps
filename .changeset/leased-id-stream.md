---
'@cloudbitmaps/roaring': patch
---

A stream read through a leased handle (`iterate`, `intersect`, `union`, `andNot`, `everyNth`, and `batches()`) answers `next()`, `return()` and `throw()` and is its own iterator, as the stream of an unleased handle is, instead of offering `for await` alone.
