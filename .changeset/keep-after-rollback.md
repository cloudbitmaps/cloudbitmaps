---
'@cloudbitmaps/core': minor
'@cloudbitmaps/roaring': minor
---

After a rollback, a load keeps the most recently current generations, from the first load on: the row's ledger records the order generations were made current and survives a rollback, so a load keeps the `keep` most recently current generations below the one it publishes, the generation it superseded (after a rollback, the one the rollback restored) first. A load over a row that recorded no window kept the newest `keep` by number and so deleted the restored generation; now the restored generation stays for as many loads as `keep` says, ahead of the generations the rollback moved away from, so at `keep: 2` the loads after a rollback to 1 from 3 leave 1, 3 and 4, then 1, 4 and 5, then 4, 5 and 6. A live lease on the generation a load supersedes after a rollback holds a place in its window instead of being spared beside it.
