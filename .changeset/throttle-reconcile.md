---
"@cloudbitmaps/core": minor
"@cloudbitmaps/s3": minor
"@cloudbitmaps/gcs": minor
"@cloudbitmaps/azure-blob": patch
"@cloudbitmaps/roaring": patch
---

A write-once object that S3 answers `503 SlowDown`, or GCS `429` or `503`, is sent again (up to three more times, with
backoff) and carries a random write id in its metadata, so a first send that landed is told from another writer's
object; the drivers still send every registry row once. A publish whose registry write ends without an answer reads the
row: its own landed write (proved by the object's footer, for a load, an erasure rewrite and a bulk load alike) is
`published: true`, a row that moved on is a lost race, and a row still as the write found it gets a fresh
compare-and-swap from the version just read, at most three times with backoff on the injected clock; still unanswered, it
throws the registry's `TransientError` and deletes nothing. A refusal after an unanswered write sets `unanswered: true` on
its audit event. Azure Blob's behaviour is unchanged (a doc comment moves). The user-facing entries are in the root
`CHANGELOG.md`, under `[Unreleased]`: `Changed` and `Fixed`.
