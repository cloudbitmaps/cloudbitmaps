---
'@cloudbitmaps/core': patch
'@cloudbitmaps/roaring': patch
---

`MemoryStorage` and `LocalFsStorage` refuse an empty root, an unknown option key and a non-function `now` with `ValidationError`, and their `getTail` refuses a `NaN`, fractional or negative length. Every registry driver refuses a `keyId` that is not a non-empty string. `LocalFsStorage` throws `IntegrityError` on a short read and removes stale temp files on write, creates files `0600` and directories `0700`, and a buffer a writer reuses no longer corrupts a `MemoryStorage` object.
