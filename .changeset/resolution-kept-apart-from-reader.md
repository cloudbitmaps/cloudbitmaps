---
'@cloudbitmaps/core': minor
'@cloudbitmaps/roaring': minor
'@cloudbitmaps/tools': minor
---

A store with a timed refresh keeps each segment's resolution apart from its reader, for `cache.genTtlMs` from the registry read that made it and bounded by the reader cache's settings: an eviction no longer reads the row again or moves a read on, and opens the object only for a chunk a read needs.
