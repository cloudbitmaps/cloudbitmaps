---
'@cloudbitmaps/core': minor
'@cloudbitmaps/roaring': minor
'@cloudbitmaps/s3': minor
'@cloudbitmaps/gcs': minor
'@cloudbitmaps/azure-blob': minor
---

A storage driver can delete an object only while it is the one that was read: `StorageCaps.conditionalDelete`, `IStorageDriver.delete(key, { ifVersion })` and `getTail`'s `version`. The memory, S3, GCS and Azure Blob drivers implement it, each backend's `conditionalDelete` option covering its storage half too, and an erasure's delete of a holder above the pointer, and a refused load's delete of the object its footer proved its own, are conditioned on the object that was read, so on a storage driver that reports `conditionalDelete` neither removes a generation a load put under that number since.
