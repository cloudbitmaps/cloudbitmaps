---
'@cloudbitmaps/core': minor
'@cloudbitmaps/roaring': minor
'@cloudbitmaps/s3': minor
'@cloudbitmaps/azure-blob': minor
'@cloudbitmaps/gcs': minor
'@cloudbitmaps/tools': minor
---

Config objects refuse an option they do not take, a value of the wrong type or no value at all, with a `ValidationError` naming the option: `InProcessKeystore` (a misspelt `recoveryKeyId`), `encryption.required` (exactly a boolean), `retireExpired` (`scan`, `lookbackBuckets`, `shards`, `null`), the `cache` sizes, `estimateCost` (a segment with no size), `AzureBlobStorage.connectionString`, `S3Storage.region` and the backends' `prefix`.
