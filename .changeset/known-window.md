---
'@cloudbitmaps/core': minor
'@cloudbitmaps/roaring': minor
---

A generation a live lease holds stays in a row's ledger beside its window, so it stays a rollback target while its lease lives, and the first publish after the lease ends drops it and deletes it by name. A load that keeps by a count (a `keep` above 64, or the first load over a row with no usable ledger) keeps the ledger's own most recently current names first, then the newest others by number, `keep` in all, and spares every name the row knows when it reads the row again before a delete.
