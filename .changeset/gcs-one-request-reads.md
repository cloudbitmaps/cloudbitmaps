---
"@cloudbitmaps/core": patch
"@cloudbitmaps/gcs": patch
---

GCS reads a registry pointer and a generation's tail in one request each, where it made two, so a GCS deployment's
sized reads cost what S3's do and `storage.requestsPerSizedRead: 2` is for Azure Blob alone. The user-facing entry is
in the root `CHANGELOG.md`, under `[Unreleased]`: `Changed`.
