---
"@cloudbitmaps/core": patch
"@cloudbitmaps/roaring": patch
"@cloudbitmaps/s3": patch
"@cloudbitmaps/gcs": patch
"@cloudbitmaps/azure-blob": patch
---

A GCS read that is refused or let go while its body is still arriving no longer prints Node's `MaxListenersExceededWarning`
("11 error listeners added to [PassThrough]") on stderr. It was never a leak: the SDK and its HTTP layer each run a
pipeline over the one response body, which holds eleven or twelve listeners while the body is in flight, one past Node's
default of ten, and each attempt has a body of its own, so nothing grew. The limit is raised on that one body. The
user-facing entry is in the root `CHANGELOG.md`, under `[Unreleased]`: `Fixed`.
