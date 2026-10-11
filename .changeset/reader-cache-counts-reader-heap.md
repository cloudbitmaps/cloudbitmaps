---
'@cloudbitmaps/core': patch
'@cloudbitmaps/roaring': patch
'@cloudbitmaps/s3': patch
'@cloudbitmaps/azure-blob': patch
'@cloudbitmaps/tools': patch
---

The reader cache's byte ceiling (`cache.readerMaxBytes`) counts the fixed heap of each open reader, 3.75 KiB, besides its index, metadata and kept chunk bytes. Before, a tiny segment's reader was counted at about 20 bytes while it held about 3.7 KiB, so a deployment that raised `cache.readerMax` for many small segments was not held to the byte ceiling it set.
