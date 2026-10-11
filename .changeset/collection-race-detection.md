---
'@cloudbitmaps/core': minor
'@cloudbitmaps/roaring': minor
'@cloudbitmaps/tools': minor
---

A rollback that lands between a delete loop's read of the row and its delete, onto the generation being deleted, is reported: a load, an erasure or a collection that finds the pointer on a generation it deleted, with no object under it, reads the row again at once and after waits of up to 1.75 s on the store's clock, and throws `NotFoundError` naming the generation, after its audit event, only when every read still names it. A refused load can now throw this error rather than answer with its refusal, and a load whose publish landed can throw it too: check `store.generations(ref)` before acting, since a rollback that found its target gone puts the pointer back itself. Each such loop reads the row once more after its last delete, one registry request, so a steady load makes one GET more, and `estimateCost` prices it. A refused load deletes its own object once another write has changed the row, when its footer proves the object its own and the row does not name it, so no rollback can publish what no load published.
