---
"@cloudbitmaps/core": minor
"@cloudbitmaps/roaring": minor
---

A pinned handle could read chunks of a later generation than the one it pinned; a combine that held one segment
at two generations answered for one of them; a pin held across a purge and re-load read the new segment as its
own; a pin whose segment was dropped or destroyed went empty part-way through a read; pinned reads, and `pin()`
itself, were not retried; a store read its own materialisation's predecessor; a cold `has()` could fail with
`NotFoundError` when a publish and a `keep: 0` sweep landed as it began; and a generation whose footer named another
generation was read as that one. Four of these fixes make a call throw where it returned, which pre-`1.0` is a
minor bump. The user-facing entries are in the root `CHANGELOG.md`, under `[Unreleased]`: `Breaking` and `Fixed`.
