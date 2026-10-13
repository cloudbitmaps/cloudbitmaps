---
'@cloudbitmaps/core': minor
'@cloudbitmaps/roaring': minor
---

`checkConsistency({ generations: true })` holds every generation a row's ledger of known generations names, and the bucket has, to the footer checksum the ledger records. A generation whose object is not the one recorded is reported as `known-generation-mismatch`, with its `generation`; one missing from the bucket is not reported. It holds each object's footer to the recorded checksum, so it finds another object, or bytes that are not a `.crbm`, under a known number; it does not find damage inside an object whose footer is intact (a read reports that as `IntegrityError`), nor a metadata change that keeps the footer's bytes. A row with a pointer whose ledger cannot be used is counted in `generationsUnchecked`. Each generation the ledger names costs one 104-byte footer read, with no key: 2 per segment at `keep: 1`. `runConsistencyCheck` takes the same option. Off by default; the default check makes the requests it made.
