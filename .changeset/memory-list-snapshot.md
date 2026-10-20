---
'@cloudbitmaps/core': patch
---

`MemoryStorage`'s listing snapshots the keys when it begins, so an object written during the listing is not yielded.
