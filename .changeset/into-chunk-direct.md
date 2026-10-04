---
'@cloudbitmaps/core': patch
'@cloudbitmaps/roaring': patch
---

`intersectInto`, `unionInto` and `andNotInto` write the combine's chunks straight into the new generation instead of streaming its ids into a load.
