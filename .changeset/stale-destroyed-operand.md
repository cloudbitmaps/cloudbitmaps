---
'@cloudbitmaps/core': patch
'@cloudbitmaps/roaring': patch
---

`materializeMany` refuses the outputs that subtract an operand destroyed (crypto-shredded, destroyed in the clear or dropped) after the call read it, and core's re-check before a publish fails closed on a numbered row that carries no fingerprint.
