---
'@cloudbitmaps/core': patch
---

A cold `iterate()` or combine on a wide segment sends its first request sooner: the `.crbm` reader plans a stream's ranges as its window opens them rather than all at once, and the chunk-cache scan at open does less work per key, with the same requests, order and checks.
