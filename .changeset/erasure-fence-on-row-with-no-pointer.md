---
'@cloudbitmaps/core': minor
'@cloudbitmaps/roaring': minor
---

An erasure deletes a first load's object on a segment with no generation yet, after renewing the row's `pointerId` so the load that wrote it is refused at its publish, and reports `erased: true`; an object sealed under a key no row holds is deleted whatever the id, so on an encrypted store an erasure of any id refuses an encrypted first load in flight onto a segment made ahead of its data. The fence before deleting a generation above the pointer is the same renewal, and a renewal that gets no answer is settled by reading the row.
