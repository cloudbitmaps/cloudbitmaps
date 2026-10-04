---
'@cloudbitmaps/core': patch
'@cloudbitmaps/roaring': patch
'@cloudbitmaps/s3': patch
'@cloudbitmaps/gcs': patch
'@cloudbitmaps/azure-blob': patch
---

Concurrent cold reads of the same chunk share one storage request instead of each making their own, with or without a cache; a failed read rejects every caller waiting on it, and a different generation of the chunk is a separate request.
