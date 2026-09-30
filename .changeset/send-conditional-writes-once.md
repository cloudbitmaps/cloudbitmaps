---
"@cloudbitmaps/s3": minor
"@cloudbitmaps/gcs": minor
"@cloudbitmaps/azure-blob": minor
"@cloudbitmaps/roaring": minor
---

The S3 and GCS drivers send each conditional write once, with the SDK's retry off for that request alone, so a write
that lands and loses its response throws `TransientError` rather than reporting a conflict. GCS objects above
`simpleUploadThresholdBytes` and Azure Blob keep the SDK's retry. The Azure Blob README and the privacy note that
ships in `@cloudbitmaps/roaring` say what that means for their callers. The user-facing entries are in the root
`CHANGELOG.md`, under `[Unreleased]`: `Breaking` and `Fixed`.
