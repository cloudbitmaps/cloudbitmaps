---
"@cloudbitmaps/s3": minor
"@cloudbitmaps/gcs": minor
"@cloudbitmaps/azure-blob": minor
"@cloudbitmaps/roaring": minor
---

The S3 and GCS drivers send each conditional write once, with the SDK's retry off for that request alone, so a write
that lands and loses its response throws `TransientError` rather than reporting a conflict. Azure Blob and GCS objects above `simpleUploadThresholdBytes`
have no per-request switch, so each of their conditional writes tags its blob with a random id in metadata, and a
conflict reads the stored copy back: its own id is a success, any other a `WriteConflictError`. The READMEs and the
privacy note that ships in `@cloudbitmaps/roaring` say what that means for their callers. The user-facing entries are
in the root `CHANGELOG.md`, under `[Unreleased]`: `Breaking` and `Fixed`.
