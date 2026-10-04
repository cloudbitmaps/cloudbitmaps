---
'@cloudbitmaps/core': patch
'@cloudbitmaps/roaring': patch
'@cloudbitmaps/s3': patch
'@cloudbitmaps/gcs': patch
'@cloudbitmaps/azure-blob': patch
---

Erasing an id reads its segment through the coalesced chunk stream, in a few range requests rather than one request per chunk.

The stream reads at most 4 ranges ahead, so an erasure holds at most 4 MiB of a segment.
