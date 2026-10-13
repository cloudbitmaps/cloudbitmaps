---
'@cloudbitmaps/core': patch
'@cloudbitmaps/roaring': patch
---

An erasure removes every generation it will delete from the row's ledger of known generations before it deletes anything, in one write that it makes only when the ledger names one, and its `keep: 0` collections spare every generation the row names when they read the row before a delete. An erasure of an id held only by an older generation, on a row whose ledger names it, now writes the row once and reads it once more (7 reads and 1 write at an object-store registry, where it was 5 and none; 6 and none when a usable ledger names nothing, 7 and none on a row with no usable ledger); a load that publishes during such an erasure keeps the generation it superseded, which the erasure used to delete.
