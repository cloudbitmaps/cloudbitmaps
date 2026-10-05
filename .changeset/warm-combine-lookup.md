---
'@cloudbitmaps/core': patch
'@cloudbitmaps/roaring': patch
---

A combine or an `iterate` over chunks the cache already holds opens no stream and looks each chunk up once.
