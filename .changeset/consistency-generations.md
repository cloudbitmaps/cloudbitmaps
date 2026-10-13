---
'@cloudbitmaps/core': minor
'@cloudbitmaps/roaring': minor
---

`checkConsistency({ generations: true })` holds every generation a row's ledger of known generations names, and the bucket has, to the footer checksum the ledger records. A generation whose object is not the one recorded is reported as `known-generation-mismatch`, with its `generation`; one missing from the bucket is not reported. A row with a pointer whose ledger cannot be used is counted in `generationsUnchecked`. Each known generation present costs one 104-byte footer read, with no key, under the store's read retry: 2 per segment at `keep: 1`. `runConsistencyCheck` takes the same option, and an optional `readRetry` in its deps. Off by default; the default check makes the requests it made.
