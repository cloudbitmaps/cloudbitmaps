---
'@cloudbitmaps/core': patch
'@cloudbitmaps/roaring': patch
---

A live read no longer mixes the ids of two objects stored under one generation number, which a rollback, an erasure above the pointer and a reload inside `cache.genTtlMs` could make it do, an erased id among them: each generation a store reads is named by the object it opened as well.
