---
'@cloudbitmaps/core': patch
'@cloudbitmaps/roaring': patch
---

A running `iterate` or combine that meets a move of one of its segments (a chunk served from another generation than it listed its keys under, an invalidation in its store, or, for a combine with an `exclude` or a union, a look at its operands every `concurrency` keys) lists the chunk keys of the generation current then and reads on from the key it reached, so a chunk a load added is read, a segment that grew is read to its new end, and an opt-out list that gained an id in a new chunk is subtracted from there on. A pinned read, `everyNth`, a `count` that reads chunks and `materializeMany` with `pin: false` keep the keys they listed. A read that lists its keys again is charged to the per-op budget again, with what it has already taken.
