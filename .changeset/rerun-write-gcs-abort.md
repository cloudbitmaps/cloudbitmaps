---
'@cloudbitmaps/core': patch
'@cloudbitmaps/gcs': patch
---

A load of ids, of a bitmap or of a combine's chunks under a storage driver that runs its write again gets the whole object, an erasure's rewrite refuses a second run with `IntegrityError` that carries the first run's error as its `cause`, a load hands on a `WriteConflictError` its own source threw, and the GCS driver ends a resumable upload's request when it abandons the write.
