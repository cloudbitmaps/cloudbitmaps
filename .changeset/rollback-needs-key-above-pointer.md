---
'@cloudbitmaps/core': minor
'@cloudbitmaps/roaring': minor
---

A `rollback` above the pointer of an encrypted segment throws `KeyUnavailableError` when no key is at hand to open its target, instead of moving the pointer onto an object it cannot tell from one sealed under another key, and a keystore failure other than a missing or unopenable key, a `TransientError` or a timeout is thrown instead of being taken for no key. A rollback to the generation already current checks that its object is there, and a swap of the pointer that gets no answer is settled by reading the row.
