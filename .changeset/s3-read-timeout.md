---
"@cloudbitmaps/core": minor
"@cloudbitmaps/roaring": patch
"@cloudbitmaps/s3": minor
---

`S3Storage` takes `readTimeoutMs`, off (`0`) unless set: each `GetObject` and `HeadObject` its drivers send that has not
finished, body included, in that many ms is aborted and throws `TransientError`, which the store's read retry runs
again. Writes and listings are not timed. `loadSegment` and `eraseIdFromSegment` take an optional `readRetry` dep, and
the store passes its own, so a load's guard read and an erasure's reads are retried on one transient fault. New options,
so a minor bump. The user-facing entries are in the root `CHANGELOG.md`, under `[Unreleased]`: `Added` and `Fixed`.
