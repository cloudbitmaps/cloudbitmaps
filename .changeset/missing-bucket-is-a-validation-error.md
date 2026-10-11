---
'@cloudbitmaps/s3': minor
'@cloudbitmaps/gcs': minor
'@cloudbitmaps/azure-blob': minor
---

A bucket or container that does not exist is a `ValidationError` on the S3, GCS and Azure Blob drivers, naming it and keeping the service's error as its `cause`. An Azure Blob generation read whose body closes early is a `TransientError`.
