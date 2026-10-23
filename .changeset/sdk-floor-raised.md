---
'@cloudbitmaps/s3': minor
'@cloudbitmaps/gcs': minor
'@cloudbitmaps/azure-blob': minor
---

Each storage driver's SDK range now starts at the lowest version its own tests pass on: `@aws-sdk/client-s3` `>=3.974.0 <4`, `@google-cloud/storage` `^8.1.0` and `@azure/storage-blob` `^12.23.0`.
