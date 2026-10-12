---
'@cloudbitmaps/core': patch
---

A refused load whose row another write changed deletes its own object only below that row's pointer, or as a cleartext object under key material. Above the pointer, or under a row with no pointer, another load can have taken the number again after an erasure deleted the object, writing the same bytes, and a delete there could remove the generation that load then publishes.
