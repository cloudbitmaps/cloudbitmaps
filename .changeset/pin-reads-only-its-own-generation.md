---
"@cloudbitmaps/core": patch
---

A pinned handle could read chunks of a later generation than the one it pinned, when a live read of the same
segment on the same store fetched across a publish; and a cold read could fail with `NotFoundError` when a publish
and a `keep: 0` sweep landed as it began. The user-facing entries are in the root `CHANGELOG.md`, under
`[Unreleased]`.
