---
'@cloudbitmaps/core': minor
---

The main entry of `@cloudbitmaps/core` imports no Node builtin and loads where none exists: the in-memory and local-filesystem backends and the in-process cipher and keystore, which need one, are exported by the internal `@cloudbitmaps/core/node`, and `@cloudbitmaps/roaring` still exports `MemoryStorage`, `LocalFsStorage` and `InProcessKeystore` as before.
