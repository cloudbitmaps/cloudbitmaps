---
'@cloudbitmaps/core': minor
'@cloudbitmaps/roaring': minor
---

`CrbmReader` gains a `tailBytes` getter: the bytes of the object after its chunk payloads, that is its extension block when it has metadata, its index and its footer. A tail read of that many bytes reaches all of them. It is known at open with no further request, and nothing else about a read or a write changes.
