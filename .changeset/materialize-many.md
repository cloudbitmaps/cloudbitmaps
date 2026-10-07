---
'@cloudbitmaps/core': minor
'@cloudbitmaps/roaring': minor
---

`store.materializeMany(...)` writes many `*Into` outputs in a chunk-ordered pass over named stored operands, reading each operand once per group: expressions of `and`, `or` and `andNot`, each operand read once per group, stored operands pinned for the call, every pinned operand an output subtracts re-checked before the publishes (`StaleOperandError`), and a resident-bytes memory budget that regroups.
