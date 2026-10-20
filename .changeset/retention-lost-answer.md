---
'@cloudbitmaps/core': patch
'@cloudbitmaps/roaring': patch
---

`setRetention` and `clearRetention` whose write lands and loses its response are settled by the write token, report what they did, and remove the old due-index pointer.
