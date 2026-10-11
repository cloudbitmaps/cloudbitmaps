---
'@cloudbitmaps/core': minor
'@cloudbitmaps/roaring': minor
---

A `rollback` above the pointer of an encrypted segment throws `KeyUnavailableError` when it has no key to open its target (no keystore, or one that holds none of the key's KEKs or one that does not unwrap it), and `TransientError` when the key service did not answer in time (a timeout as its `cause`), instead of moving the pointer onto an object it cannot tell from one sealed under another key. A keystore failure other than those and a timeout (as `AbortSignal.timeout()` and the AWS SDK report one) is thrown instead of being taken for no key. A rollback to the generation already current checks that its object is there, and a swap of the pointer that gets no answer is settled by reading the row, taken as landed only from the row the swap leaves.
