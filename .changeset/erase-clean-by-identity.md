---
'@cloudbitmaps/core': patch
---

An erasure skips a generation it found clean only while the row, read after its last listing of the bucket, names that generation with the footer checksum of the object the erasure read, so a load of the id that takes such a number during the erasure is read, and the erasure answers `'superseded'` or throws `WriteConflictError` rather than `erased: true`. It costs one registry read more when that listing names a generation the erasure found clean.
