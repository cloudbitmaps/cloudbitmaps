---
'@cloudbitmaps/core': minor
'@cloudbitmaps/roaring': minor
---

`store.materializeMany` reports to the store's metrics sink: one `op` event per call (`name: 'materializeMany'`, a new `MetricOpName` member) and a `storage.get` event per range request it sends. An element of an operand list that is not a segment is refused with a `ValidationError` instead of failing with a `TypeError`, and `mayBeEmpty` with no feed names what is wrong with it.
