---
'@cloudbitmaps/core': minor
'@cloudbitmaps/roaring': minor
'@cloudbitmaps/s3': minor
'@cloudbitmaps/azure-blob': minor
'@cloudbitmaps/gcs': minor
'@cloudbitmaps/tools': minor
---

An erasure that deleted a generation and then did not finish now emits `segment.collect` for exactly the generations it deleted, whether it ended `superseded`, refused, or threw (the event comes first, and a throw is still thrown). Before, such a call emitted nothing, so a deletion of a subject's data could leave no record. The event has no `fromGeneration` and its shape is unchanged; a finished call still emits its one event, and a call that deleted nothing still emits none. The ledger's `erased`, not the event, says whether the erasure finished.
