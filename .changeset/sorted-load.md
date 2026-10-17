---
'@cloudbitmaps/core': minor
'@cloudbitmaps/roaring': minor
---

`store.load(ref, ids, { sorted: true })` writes ids that already ascend one chunk at a time while the object uploads, so a load holds about one chunk and the writer's index whatever the segment's size, and writes the same object an unsorted load of the same ids writes. An id lower than the one before is a `ValidationError` naming its position, and an error the ids raise reaches the caller as the very object raised.
