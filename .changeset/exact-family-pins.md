---
'@cloudbitmaps/core': minor
'@cloudbitmaps/roaring': minor
'@cloudbitmaps/s3': minor
'@cloudbitmaps/gcs': minor
'@cloudbitmaps/azure-blob': minor
'@cloudbitmaps/tools': minor
---

The six packages depend on each other at an exact version, so install the same version of every `@cloudbitmaps/*` package. Every package exports its `package.json`, and a bare `429` from an S3-compatible service is a throttle.
