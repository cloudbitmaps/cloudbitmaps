---
'@cloudbitmaps/core': minor
'@cloudbitmaps/roaring': minor
---

Registry rows are schema 5: `knownGens`, a ledger of the generations a row made current with each object's footer checksum, replaces `keptGens`, and a summary records `tailBytes`. A row stamped 4 or lower is refused with `UnsupportedError`; a store moves by loading its segments into a new prefix. `KnownGeneration` is exported, `RegistryRecord.keptGens` and `NewRegistryRecord.keptGens` are removed, and `RegistryPatch` names `knownGens` in place of `keptGens`.
