---
'@cloudbitmaps/core': patch
'@cloudbitmaps/roaring': patch
---

`runExport` records a segment destroyed between the registry listing and its export in `manifest.skipped` with `reason: 'destroyed'`, not as an empty file. The eject command refuses a namespace named `manifest.json` in any letter case: each of its segments is recorded in `failed` with a `ValidationError` message, so its manifest is still written, and a `manifest.json` directory already in the output directory is refused with a `ValidationError` that says to remove it. Where the registry removes rows, `retireExpired` removes the due-index pointer of a tombstone it did not write.
