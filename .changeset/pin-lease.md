---
'@cloudbitmaps/core': minor
'@cloudbitmaps/roaring': minor
---

`pin({ leaseUntil })` keeps a pinned generation out of a load's collection until the lease ends, at most 14 days, recorded in the registry row's new `leases` field. A read of the handle after the lease throws `LeaseExpiredError` at every site, including as an operand or an exclude, and never reads empty. A lease keeps superseded generations, and erasure, shred, drop and retention ignore it.
