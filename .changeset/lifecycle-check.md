---
'@cloudbitmaps/core': minor
'@cloudbitmaps/roaring': minor
'@cloudbitmaps/s3': minor
'@cloudbitmaps/gcs': minor
'@cloudbitmaps/azure-blob': minor
---

A storage backend can check the bucket's lifecycle rules: the optional `StorageBackend.checkLifecycle()`, exported from `@cloudbitmaps/core/driver-kit` with `LifecycleVerdict`. `S3Storage` and `GcsStorage` read the rules with one request and report one that would delete or archive what the store keeps, `AzureBlobStorage` is always `unchecked` and says how to read its policy by hand, and `MemoryStorage` and `LocalFsStorage` are `ok`. It never rejects, and a refused read is `unchecked`, naming the permission.
