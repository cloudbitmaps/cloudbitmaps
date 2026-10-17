---
'@cloudbitmaps/core': patch
'@cloudbitmaps/gcs': patch
---

A load under a storage driver that runs its write again gets the whole object, an erasure's rewrite refuses a second run with `IntegrityError`, a load hands on a `WriteConflictError` its own source threw, and the GCS driver ends a resumable upload's request when it abandons the write.
