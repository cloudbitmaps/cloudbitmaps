---
'@cloudbitmaps/roaring': minor
---

`deserializePortable(bytes)` returns `ReadonlyBitmap`, a type of this library's own, in place of `roaring`'s `RoaringBitmap32`. It has `size`, `has(id)`, ascending iteration and `serialize('portable')`, and a load takes it as `{ bitmap }`. For the rest of a Roaring library's API, decode its portable bytes with that library.
