---
"@cloudbitmaps/gcs": minor
---

`GcsStorage` takes `readTimeoutMs`, off unless set: each attempt at a GCS download, and the metadata read a tail read
falls back on, is cut off once it has run that long, retried like a dropped connection, and thrown as `TransientError`
when every attempt times out. Every download now leaves the SDK's shared keep-alive agent, so one the driver cuts off
or refuses resets no other request, and the range read is capped at the bytes it asked for. The user-facing entries
are in the root `CHANGELOG.md`, under `[Unreleased]`: `Added` and `Fixed`.
