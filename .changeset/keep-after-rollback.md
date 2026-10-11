---
'@cloudbitmaps/core': minor
'@cloudbitmaps/roaring': minor
---

The first load after a rollback keeps the generation the rollback restored: a load keeps the generation it superseded first, then the newest of the rest by number, where a load over a row that records no window (after a rollback, or at a `keep` above 64) kept the newest `keep` by number and so deleted the restored generation. From the next load the window is the newest `keep` by number again, so with a `keep` of 2 or more the restored generation goes before the newest generations the rollback moved away from. A load deletes as many generations, and makes the same requests, as before, except that a live lease on the generation a load supersedes after a rollback now holds a place in its window instead of being spared beside it, so that load can delete one more generation and the next load one fewer.
