---
'@cloudbitmaps/core': patch
'@cloudbitmaps/roaring': patch
---

`runExport` records a segment destroyed between the registry listing and its export in `manifest.skipped` with `reason: 'destroyed'`, not as an empty file. The eject command refuses a namespace named `manifest.json` per segment with a `ValidationError` in `failed`, so its manifest is still written. `retireExpired` removes the due-index pointer of a tombstone it did not write.
