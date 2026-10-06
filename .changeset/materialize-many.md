---
'@cloudbitmaps/core': minor
'@cloudbitmaps/roaring': minor
---

`store.materializeMany(...)` writes many `*Into` outputs from one chunk-ordered pass over named stored operands: expressions of `and`, `or` and `andNot`, each operand read once per group, stored operands pinned for the call, a pinned exclude re-checked before the publishes (`StaleOperandError`), and a resident-bytes memory budget that regroups.
