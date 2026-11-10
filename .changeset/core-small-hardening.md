---
'@cloudbitmaps/core': patch
'@cloudbitmaps/roaring': patch
---

A pinned operand of core's batch combine must name its whole pin (generation, with a string version and fingerprint for a numbered generation), so the re-check of a subtracted operand cannot be skipped by leaving one out or setting it to null.
