---
'@cloudbitmaps/core': patch
'@cloudbitmaps/roaring': patch
'@cloudbitmaps/s3': patch
'@cloudbitmaps/gcs': patch
'@cloudbitmaps/azure-blob': patch
---

Security hardening: error messages carry no id, the S3 and Azure drivers bound the response bodies they read, GCS errors carry no credential, a registry generation is a safe integer, and LocalFs refuses names too long for its file names and tells names apart by case on a case-insensitive filesystem.
