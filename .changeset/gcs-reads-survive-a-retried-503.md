---
"@cloudbitmaps/gcs": patch
---

The client `GcsStorage` builds sends each download once, so a GCS read that gets a 503 or 429 is a `TransientError` the
store retries, not a process crash from the SDK's own retry. The user-facing entry is in the root `CHANGELOG.md`, under
`[Unreleased]`: `Fixed`.
