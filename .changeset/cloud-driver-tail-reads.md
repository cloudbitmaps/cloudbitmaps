---
'@cloudbitmaps/s3': patch
'@cloudbitmaps/azure-blob': patch
---

An Azure tail read is conditional on the blob's ETag, so a blob replaced mid-read is read again once and then raises `TransientError`, never one blob's size with another's bytes. S3 `getTail` refuses a length that is not a whole number with `ValidationError`, and the S3 driver treats `EHOSTUNREACH` and `ENETUNREACH` as transient.
