---
'@cloudbitmaps/core': minor
'@cloudbitmaps/roaring': minor
'@cloudbitmaps/s3': minor
'@cloudbitmaps/gcs': minor
'@cloudbitmaps/azure-blob': minor
---

A combine's default `concurrency` is 32, its window opens 8 keys wide and widens as keys are taken, `iterate` and `count` read ahead up to 32 chunks, and an exclude is read in the same round trip as the include where the include side cannot be emptied.
