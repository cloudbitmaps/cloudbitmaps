---
"@cloudbitmaps/core": minor
"@cloudbitmaps/roaring": minor
---

`TimeoutError`, `AuditEventKind`, the flavor's `VERSION`, `MemoryStorageChunkSource`, `DEFAULT_PRICING`,
`SafeBitmap`, `roaringCodec`, `writeCrbmGeneration`, `publishGeneration`, `nextGeneration`,
`gcOrphanGenerations` and `GenerationDeps` are no longer exported, and `@cloudbitmaps/core/driver-kit` drops the
registry-key and AWS-error helpers. `encodeNameForPath`, `namespacePathPart` and `validateSegmentRef` are exported
from `@cloudbitmaps/core/driver-kit` only. A `keep` that is not a non-negative integer is refused with
`ValidationError`. Pre-`1.0`, a removed export is a minor bump. The user-facing entries are in the root
`CHANGELOG.md`, under `[Unreleased]`: `Breaking`.
