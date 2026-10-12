---
'@cloudbitmaps/core': patch
---

Listing a segment's chunk keys makes one pass over the list instead of a copy, a sort and a scan when the keys are already ascending, and a chunk read validates the segment's name once rather than once per key. The checks on the keys and the requests made are unchanged.
