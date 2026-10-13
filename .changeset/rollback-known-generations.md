---
'@cloudbitmaps/core': minor
'@cloudbitmaps/roaring': minor
---

`rollback` moves only onto a generation the segment's row knows it published (its `knownGens`), and only when the object's footer checksum is the one recorded; `allowUnknown` replaces `allowForward` and is the one override, audited with `unknown: true` on `segment.rollback`. A target the row does not know is refused with `ValidationError` before any request to storage, and another object under a known number with `IntegrityError`, with or without a key; a generation a rollback left above the pointer, or one a live lease holds, is known and needs no flag, and no key on an encrypted segment. A row with no usable `knownGens`, and a target older than a full list reaches, are judged as before, with no flag and audited `unknown: true`. After the swap a rollback reads the target's footer once in place of listing the bucket: 4 requests for a known target, 1 for a refused one. `store.generations` marks each generation `known`. A storage driver must answer a read of a deleted object with `NotFoundError` as soon as its delete returns; the conformance suite checks it.
