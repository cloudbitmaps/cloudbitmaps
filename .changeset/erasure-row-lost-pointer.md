---
'@cloudbitmaps/core': patch
---

An erasure whose row loses its pointer after the call found one answers `'superseded'`, where it answered `'no-generation'` while an object that holds the id could still be in the bucket, and `eraseSubject` now notes it, so a re-run erases the id.
