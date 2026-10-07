---
'@cloudbitmaps/core': minor
'@cloudbitmaps/roaring': minor
---

`store.memory(input)` holds ids in memory as an operand of `store.materializeMany` (and of no other verb): it takes what `store.load` takes and checks it the same way (only a real `Uint32Array` skips the per-id check), the handle is read from memory with no request and never through the chunk cache, counts against `maxBufferedBytes` while a call runs, is refused when empty unless its name is in `mayBeEmpty`, gives the output byte for byte what the same operand stored would publish, and fails the outputs that read it with `StaleOperandError` (`reason: 'erased'`) once an erasure has started in its store after it was made. `release()` zeroes and drops its bytes.
