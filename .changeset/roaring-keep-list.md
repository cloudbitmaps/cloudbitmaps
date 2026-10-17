---
'@cloudbitmaps/core': minor
'@cloudbitmaps/roaring': minor
---

`@cloudbitmaps/roaring` exports the names an application uses and nothing else: the driver contracts move to `@cloudbitmaps/core/driver-kit`, their one home, which now exports every type its signatures and the store's ports name, and the `.crbm` reader, `CrbmStorageChunkSource`, the codec seam, `DEFAULT_RETRY_POLICY`, `MIN_EXPIRES_AT_MS` and the lease bounds leave the public surface.
