---
'@cloudbitmaps/roaring': patch
---

`store.segment(name, options)` takes a plain object, and refuses `expiresAt`, or any own key but `namespace`, with `ValidationError`.
