---
'@cloudbitmaps/core': patch
---

A registry delete on a store that does not apply a conditional delete writes a tombstone that keeps only the name, the pointer's number, the status, the timestamps and the advanced token, no longer the deleted row's wrapped keys, sealed summary, generation ledger, leases or governance policies.
