---
"@cloudbitmaps/core": patch
"@cloudbitmaps/roaring": patch
---

A pinned handle could read chunks of a later generation than the one it pinned; a combine that held one segment
at two generations answered for one of them; a pin held across a purge and re-load read the new segment as its
own; pinned reads, and `pin()` itself, were not retried; a cold `has()` could fail with `NotFoundError` when a
publish and a `keep: 0` sweep landed as it began; and a generation whose footer named another generation was read
as that one. The user-facing entries are in the root `CHANGELOG.md`, under
`[Unreleased]`.
