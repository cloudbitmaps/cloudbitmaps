---
'@cloudbitmaps/core': patch
---

`ExportWriter.write` receives each NDJSON chunk as a plain `Uint8Array`, and a drop's sweep and the erasure's listings count a generation a storage listing yields twice once.
