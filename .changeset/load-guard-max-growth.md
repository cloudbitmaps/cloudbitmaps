---
'@cloudbitmaps/core': minor
'@cloudbitmaps/roaring': minor
---

`guard.maxGrowth` refuses a load, an `*Into` or a `materializeMany` output that grows its segment past a multiple of what it holds, with `reason: 'max-growth'`.
