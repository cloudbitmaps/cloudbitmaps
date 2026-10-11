---
'@cloudbitmaps/roaring': minor
---

A stream returned by `iterate`, `intersect`, `union`, `andNot` and `everyNth`, and the stream of `batches()`, answers `next()`, `return()` and `throw()` and is its own iterator, whether the handle holds a lease or not: a read through a leased handle used to offer `for await` alone, and a read refused when it is called (a lease that has ended, a bad option) was the same kind of object. A refused read now rejects at its first `next()`, and a later `next()` is done. The types declare it: `IdStream` extends the new `IdIterator`, and `everyNth` returns `IdIterator`.
