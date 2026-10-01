---
"@cloudbitmaps/core": patch
"@cloudbitmaps/roaring": patch
---

`iterate` and the storage path of `count` fetch up to 8 chunks at a time instead of one, so a cold full read of a large segment takes a fraction of the time with the same number of requests. The ids still arrive in ascending order, and a read that stops early fetches only a few chunks past where it stopped.
