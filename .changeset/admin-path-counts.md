---
'@cloudbitmaps/core': patch
---

`checkConsistency` asks whether each segment's current object is there with a zero-length tail read in place of a listing, and lists a segment only when that read fails; with `summaries: true` and a clear summary the open decides. A guarded load and the summary check take the current size from the reader's `count()`.
