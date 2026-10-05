---
'@cloudbitmaps/core': minor
'@cloudbitmaps/roaring': minor
---

Registry rows are schema 3: the row records the generations a load keeps, so `store.load()` collects by name at any `keep` up to 64 instead of listing the bucket. Every process that writes a store moves to this release together.
