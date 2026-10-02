---
"@cloudbitmaps/s3": minor
---

`S3Storage` takes `readTimeoutMs`, off (`0`) unless set: each `GetObject` and `HeadObject` its drivers send that has not
finished, body included, in that many ms is aborted and throws `TransientError`, which the store's read retry runs
again. Writes and listings are not timed. A new option, so a minor bump. The user-facing entry is in the root
`CHANGELOG.md`, under `[Unreleased]`: `Added`.
