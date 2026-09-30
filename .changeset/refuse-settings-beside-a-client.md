---
"@cloudbitmaps/core": minor
"@cloudbitmaps/roaring": minor
"@cloudbitmaps/gcs": minor
"@cloudbitmaps/s3": minor
"@cloudbitmaps/azure-blob": minor
---

`new S3Storage(options)` refuses `region`, `endpoint`, `pathStyle` and `credentials`, and `new GcsStorage(options)`
refuses `projectId` and `apiEndpoint`, when a `client` is given beside them, with a `ValidationError` naming each one.
They were ignored before. Configure them on the client, or drop `client`. The user-facing entry is in the root
`CHANGELOG.md`, under `[Unreleased]`: `Breaking`.
