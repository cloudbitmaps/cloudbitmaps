---
'@cloudbitmaps/roaring': patch
---

`export-segments` refuses an existing `CR_EXPORT_OUT` that is a symlink (also written `link/` or `link/.`) or not a directory, instead of writing the dump through it. The mode and owner of `CR_EXPORT_OUT` are not checked; the namespace directories it writes into are checked as before.
