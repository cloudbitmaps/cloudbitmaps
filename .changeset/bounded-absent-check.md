---
'@cloudbitmaps/core': patch
'@cloudbitmaps/roaring': patch
---

A combine (`intersect`, `union`, `andNot` and the `*Into` verbs) lists its operands, asks whether those that hold no chunk exist, and looks up their versions at most 16 operands at a time, and fails at once on the first of those reads to fail; `materializeMany` asks whether its operands exist the same way.
