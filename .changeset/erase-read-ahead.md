---
'@cloudbitmaps/core': patch
'@cloudbitmaps/roaring': patch
'@cloudbitmaps/s3': patch
'@cloudbitmaps/gcs': patch
'@cloudbitmaps/azure-blob': patch
---

Erasing an id reads the generation's chunks ahead through a window of 32 instead of one at a time, so a large segment's erasure takes about a thirty-second of the round trips in sequence; the requests, their order and the refusals are unchanged.
