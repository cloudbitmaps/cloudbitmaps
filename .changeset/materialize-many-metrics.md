---
'@cloudbitmaps/core': minor
'@cloudbitmaps/roaring': minor
---

`store.materializeMany` reports to the store's metrics sink: one `op` event per call (`name: 'materializeMany'`, a new `MetricOpName` member) and a `storage.get` event per range request it sends. A memory operand passed to a combine or an `*Into` call is refused with a `ValidationError` instead of failing with a `TypeError`, and `mayBeEmpty` with no feed names what is wrong with it.
