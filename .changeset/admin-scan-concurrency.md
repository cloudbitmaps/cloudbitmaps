---
'@cloudbitmaps/core': patch
'@cloudbitmaps/roaring': patch
'@cloudbitmaps/s3': patch
'@cloudbitmaps/gcs': patch
'@cloudbitmaps/azure-blob': patch
---

`eraseNamespace` shreds eight segments at a time, a registry listing reads 48 rows at a time instead of 16, and the erasure of one id looks through the other generations for a holder a few at a time. Results are unchanged; the `segment.erase` events of a namespace erase are no longer in the listing's order.
