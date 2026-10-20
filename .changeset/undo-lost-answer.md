---
'@cloudbitmaps/core': minor
'@cloudbitmaps/roaring': minor
---

A rollback whose target went while the pointer was moving reports the pointer as put back when the move back landed and lost its answer, settled by the row's write token. The guides say what each lifecycle helper settles.
A rollback whose swap met a conflict and whose every read of the row failed throws `WriteConflictError` with the read's error as its cause, where it threw `TransientError`.
