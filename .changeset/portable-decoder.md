---
'@cloudbitmaps/core': minor
'@cloudbitmaps/roaring': minor
---

`@cloudbitmaps/roaring` exports `deserializePortable(bytes)`, which decodes portable Roaring bytes through the check a `{ serialized }` load makes first. `@cloudbitmaps/core` exports `decodeSerialized(bytes, codec, what?)`, the one check both go through.
