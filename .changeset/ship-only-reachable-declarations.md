---
'@cloudbitmaps/core': patch
'@cloudbitmaps/roaring': patch
'@cloudbitmaps/s3': patch
'@cloudbitmaps/gcs': patch
'@cloudbitmaps/azure-blob': patch
'@cloudbitmaps/tools': patch
---

The packages ship only the declaration files an `exports` entry reaches. Declarations for internal modules, which no entry made importable (the conformance suite, the fuzz harnesses and the portable decoder among them), are no longer in the tarballs; every public type is unchanged, and types resolve as before under node10, node16, nodenext and bundler resolution.
