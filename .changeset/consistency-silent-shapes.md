---
'@cloudbitmaps/core': patch
'@cloudbitmaps/roaring': patch
'@cloudbitmaps/s3': patch
'@cloudbitmaps/azure-blob': patch
'@cloudbitmaps/gcs': patch
'@cloudbitmaps/tools': patch
---

`checkConsistency({ summaries: true })` reports every summary no read uses on a row with no keys (a sealed one, one of another generation, one whose `tailBytes` no object of that size can have) as `summary-mismatch`. A shipped registry refuses each of these shapes when it writes the row, so no row the library wrote is reported by this change; a row edited by hand can still hold a sealed summary or one of another generation, since a read checks only the summary's own shape, and such a row is now reported.
