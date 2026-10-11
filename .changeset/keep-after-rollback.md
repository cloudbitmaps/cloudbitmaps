---
'@cloudbitmaps/core': minor
'@cloudbitmaps/roaring': minor
---

The first load after a rollback keeps the generation the rollback restored: a load keeps the generation it superseded first, then the newest of the rest by number, where a load over a row that records no window (after a rollback, or at a `keep` above 64) kept the newest `keep` by number and so deleted the restored generation. No load makes a request it did not make before.
