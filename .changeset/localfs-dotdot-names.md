---
'@cloudbitmaps/core': patch
'@cloudbitmaps/roaring': patch
'@cloudbitmaps/s3': patch
'@cloudbitmaps/azure-blob': patch
'@cloudbitmaps/gcs': patch
'@cloudbitmaps/tools': patch
---

LocalFs: a namespace or segment whose name begins with two dots (`..acme`) is now held to the case check like any other name, so `..acme` and `..Acme` can no longer share a directory on a case-insensitive filesystem.
