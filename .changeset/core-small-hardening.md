---
'@cloudbitmaps/core': patch
'@cloudbitmaps/roaring': patch
---

A reader keeps a copy of the chunk bytes it holds from a tail read even when a third-party driver returns a Node `Buffer`, and a pinned operand of core's batch combine must name its whole pin (generation, version and fingerprint), so the re-check of a subtracted operand cannot be skipped by leaving one out.
