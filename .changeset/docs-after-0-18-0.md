---
'@cloudbitmaps/core': patch
'@cloudbitmaps/roaring': patch
---

Documentation corrections: the package READMEs' banner, `materializeMany` and `store.memory` in the `roaring` README, the `materializeMany` metrics and audit facts, and `StaleOperandError`'s doc comment for held operands. `store.materializeMany` accepts an empty `mayBeEmpty` on a call with no feed and no held operand.
