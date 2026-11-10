---
'@cloudbitmaps/core': patch
'@cloudbitmaps/roaring': patch
'@cloudbitmaps/s3': patch
'@cloudbitmaps/azure-blob': patch
'@cloudbitmaps/gcs': patch
'@cloudbitmaps/tools': patch
---

`checkConsistency({ summaries: true })` reports a sealed summary, and a summary of another generation, on a row with no keys as `summary-mismatch`.
