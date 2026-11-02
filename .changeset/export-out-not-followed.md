---
'@cloudbitmaps/roaring': patch
---

`export-segments` refuses an existing output directory that is a symlink, not a directory, owned by another user or open to group or others, instead of writing the dump through it.
