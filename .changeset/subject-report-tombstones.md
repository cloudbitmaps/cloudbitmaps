---
'@cloudbitmaps/roaring': minor
---

`subjectReport` lists a destroyed segment whose leftover objects still hold the id, in a new required `tombstones` field (`[]` when none), found by the search `eraseSubject` makes under a tombstone. A cleartext `destroySegment` and a `dropSegment` whose sweep missed an object leave the id readable in the bucket; a crypto-shredded segment is listed only when an object left under it in the clear holds the id. `segments` is unchanged. Each destroyed segment in scope costs a listing and a read of each object searched, charged to the budget as `eraseSubject` charges.
