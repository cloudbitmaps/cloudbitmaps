---
'@cloudbitmaps/roaring': minor
---

An exclusion past its `expiresAt` now throws `ValidationError` in `andNot` and in `exclude` on `intersect` and `union`, before any request is made; it used to be skipped and exclude nothing. Expired operands read as before.
