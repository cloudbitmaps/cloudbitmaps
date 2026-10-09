---
'@cloudbitmaps/core': minor
'@cloudbitmaps/roaring': minor
'@cloudbitmaps/s3': minor
'@cloudbitmaps/gcs': minor
'@cloudbitmaps/azure-blob': minor
---

A storage driver can delete an object only while it is the one that was read: `StorageCaps.conditionalDelete`, `IStorageDriver.delete(key, { ifVersion })` and `getTail`'s `version`. The memory, S3, GCS and Azure Blob drivers implement it, each backend's `conditionalDelete` option covering its storage half too, and an erasure's delete of a holder above the pointer is conditioned on the object it searched, so it no longer removes a generation a load put under that number since.
