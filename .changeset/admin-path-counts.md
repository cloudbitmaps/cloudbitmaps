---
'@cloudbitmaps/core': patch
---

`checkConsistency` asks whether each segment's current object is there with a zero-length tail read in place of a listing, and with `summaries: true` and a clear summary lets the open decide; a guarded load and the summary check take the current size from the reader's `count()`.
