---
'@cloudbitmaps/core': patch
'@cloudbitmaps/roaring': patch
'@cloudbitmaps/tools': patch
---

A rollback that lands between a delete loop's read of the row and its delete, onto the generation being deleted, is reported: a load, an erasure or a collection that finds the pointer on a generation it deleted throws `NotFoundError` naming it, after its audit event, instead of answering as if nothing happened. Each such loop reads the row once more after its last delete, one registry request, so a steady load makes one GET more, and `estimateCost` prices it. A refused load deletes its own object once another write has changed the row, when its footer proves the object its own and the row does not name it, so no rollback can publish what no load published.
