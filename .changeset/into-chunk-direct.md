---
'@cloudbitmaps/core': minor
'@cloudbitmaps/roaring': minor
---

`intersectInto`, `unionInto` and `andNotInto` write the combine's chunks straight into the new generation. `@cloudbitmaps/core` exports `loadSegmentChunks`, `loadSegment` for a result already held as chunks, and `CodecInterface` gains an optional `owns?`.
