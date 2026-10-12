---
'@cloudbitmaps/core': patch
---

Listing a segment's chunk keys range-checks them in one pass, and sorts and scans for a repeat only a list that is not already strictly ascending, as a `.crbm` index always is; a chunk read validates the segment's name once rather than once per key. The checks on the keys and the requests made are unchanged.
