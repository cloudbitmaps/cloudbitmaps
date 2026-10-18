---
'@cloudbitmaps/core': minor
'@cloudbitmaps/roaring': minor
'@cloudbitmaps/s3': minor
'@cloudbitmaps/gcs': minor
'@cloudbitmaps/azure-blob': minor
---

`store.preflight()` checks a new store's storage and registry before its first load: it reads the registry, writes, rewrites, reads, lists and deletes one probe object and asks the backend for its lifecycle verdict, and resolves to `{ ok, checks }` with seven checks that are each `ok`, `problem` or `unchecked`. A finding never throws, it takes no options, and a backend without `checkLifecycle()` is read as `unchecked`.
