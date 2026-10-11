---
'@cloudbitmaps/core': patch
'@cloudbitmaps/roaring': patch
---

A combine (`intersect`, `union`, `andNot` and the `*Into` verbs) asks the registry whether its operands with no chunks exist at most 16 at a time, as `materializeMany` already did, where it asked about all of them at once.
