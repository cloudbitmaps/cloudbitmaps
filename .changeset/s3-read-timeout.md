---
"@cloudbitmaps/s3": minor
---

`S3Storage` takes `readTimeoutMs`, 2,000 ms by default: each `GetObject` and `HeadObject` its drivers send that has not
finished, body included, in that time is aborted and throws `TransientError`, which the store's read retry runs again.
Writes and listings are not timed. A new option that changes default behaviour, so a minor bump. The user-facing entry
is in the root `CHANGELOG.md`, under `[Unreleased]`: `Added`.
