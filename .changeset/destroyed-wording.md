---
'@cloudbitmaps/core': patch
'@cloudbitmaps/roaring': patch
---

An error about a destroyed segment says the segment is destroyed and that no generation resolves through a destroyed row, not that it was crypto-shredded: a drop, a retirement and a cleartext `destroySegment` leave a destroyed row too, and a cleartext destroy leaves its objects readable. `generations()` lists no generation as `current` on a destroyed segment.
