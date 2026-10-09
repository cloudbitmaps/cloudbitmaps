---
'@cloudbitmaps/roaring': patch
---

`store.segment(name, options)` refuses `expiresAt` with the same `ValidationError` as any other key but `namespace`.
