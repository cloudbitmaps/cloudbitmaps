---
"@cloudbitmaps/core": patch
---

A pinned handle could read chunks of a later generation than the one it pinned, when a live read of the same
segment on the same store fetched across a publish. The user-facing entry is in the root `CHANGELOG.md`, under
`[Unreleased]`.
