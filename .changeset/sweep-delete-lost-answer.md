---
'@cloudbitmaps/core': patch
'@cloudbitmaps/roaring': patch
---

The retention sweep reports a purge, a row delete or a due-index pointer delete whose response was lost as the delete it was, instead of a refusal counted in `purgeFaults`.
