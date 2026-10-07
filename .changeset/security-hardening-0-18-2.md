---
'@cloudbitmaps/core': patch
'@cloudbitmaps/roaring': patch
'@cloudbitmaps/s3': patch
'@cloudbitmaps/gcs': patch
'@cloudbitmaps/azure-blob': patch
---

Security hardening: error messages carry no id, the S3 and Azure drivers bound the response bodies they read, GCS and S3 errors carry no credential or live transport, a registry generation is a safe integer, LocalFs refuses names too long for its file names and tells names apart by case on a case-insensitive filesystem, the Azure and GCS storage drivers use the shared prefix check, `InProcessKeystore` checks key ids against the keys given, and `export-segments` refuses a symlinked or foreign namespace directory in its output.
