---
'@cloudbitmaps/core': minor
'@cloudbitmaps/roaring': minor
---

Every `segment.*` audit event carries the row's `incarnation`; an erasure that rewrites nothing emits `segment.collect`; the export manifest lists the destroyed segments it skipped in `skipped[]`.
