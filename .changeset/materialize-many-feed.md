---
'@cloudbitmaps/core': minor
'@cloudbitmaps/roaring': minor
---

`store.materializeMany({ feed: { names, records, counts }, mayBeEmpty, maxBufferedBytes })` takes operands that arrive as records in chunk-key order beside stored ones: every record is checked before the pass sees it, a bad feed refuses every fed output and publishes none, a declared name that never appears is refused unless it is in `mayBeEmpty`, the call runs as one group under a required budget enforced as the feed is read, and an erasure in the store (`eraseSubject` now moves an in-process counter) refuses a fed call with `StaleOperandError` (`reason: 'erased'`).
