---
'@cloudbitmaps/core': minor
'@cloudbitmaps/roaring': minor
---

Registry rows are schema 4: every row carries `pointerId`, the token of the last write that named a field a read resolves through (the pointer, the status, the keys or the summary), at any value, and its summary records the fingerprint of the object it describes. A reader's caches key on the generation with `pointerId`, so a lease or a retention write keeps them warm; where the row records that fingerprint, every live open holds the object to it; `stat()` answers from the row. Rows stamped 1 to 3 are refused, and a store moves by loading its segments into a new prefix.
