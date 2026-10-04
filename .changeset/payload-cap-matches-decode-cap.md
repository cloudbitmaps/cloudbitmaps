---
'@cloudbitmaps/core': patch
'@cloudbitmaps/roaring': patch
'@cloudbitmaps/s3': patch
'@cloudbitmaps/gcs': patch
'@cloudbitmaps/azure-blob': patch
---

A chunk too large to decode is refused when the object is opened, as an `IntegrityError`, before any payload is read; the reader's payload cap is the 1 MiB decode cap plus the encryption framing, where it was 16 MiB.
