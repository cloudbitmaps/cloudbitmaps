---
"@cloudbitmaps/gcs": minor
---

`GcsStorage` takes `readTimeoutMs`, off unless set: one deadline bounds each GCS read, every attempt the driver makes
and the backoff between them included; when it passes the read throws `TransientError` for the store's read retry, and
nothing more is sent. Every download now goes out on Node's global agent rather than the SDK's shared keep-alive pool,
so a download that fails part-way resets no other request, and the range read is capped at the bytes it asked for. The
user-facing entries are in the root `CHANGELOG.md`, under `[Unreleased]`: `Added` and `Fixed`.
