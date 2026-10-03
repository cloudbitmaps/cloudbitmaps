---
"@cloudbitmaps/s3": patch
---

`@aws-sdk/client-s3` is required at 3.700.0 or later, the first version whose `PutObject` sends `If-Match`, which
the registry's compare-and-swap relies on; earlier versions drop the header without an error. The user-facing entry
is in the root `CHANGELOG.md`, under `[Unreleased]`: `Fixed`.
