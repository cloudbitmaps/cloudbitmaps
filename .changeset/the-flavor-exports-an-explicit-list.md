---
"@cloudbitmaps/core": minor
"@cloudbitmaps/roaring": minor
---

`@cloudbitmaps/roaring` exports an explicit list of names in place of everything `@cloudbitmaps/core` exports. The
engine (`SegmentEngine`, `EngineDeps`, `EngineCombineOptions`, `BoundedLru`), the metrics, budget and retry
internals, the standalone forms of the store's methods (`loadSegment`, `dropSegment`, `retireExpired`,
`estimateCost` and the rest), and `eraseIdFromSegment` leave the flavor and stay on `@cloudbitmaps/core`. The
flavor's own `loadSegment` and `runExport` are deleted. A `Segment` has no public constructor: get one from
`store.segment()` or `seg.pin()`. Pre-`1.0`, a removed export is a minor bump. The user-facing entries are in the
root `CHANGELOG.md`, under `[Unreleased]`: `Breaking`.
