---
"@cloudbitmaps/core": minor
"@cloudbitmaps/roaring": minor
---

A namespace starting with `cbm.due.`, where the library keeps its due index, is refused with `ValidationError` in
every segment ref and every `namespace` option, where a segment there was silently skipped by erasures, consistency
checks, exports, `segments()` and the unscoped sweep. The library's own writes to it, which go through the drivers, are
unchanged, and `validateSegmentRef` on `@cloudbitmaps/core/driver-kit` checks the name rules only. Pre-`1.0`, a call that
throws where it returned is a minor bump. The user-facing entry is in the root `CHANGELOG.md`, under
`[Unreleased]`: `Breaking`.
