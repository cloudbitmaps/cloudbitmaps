---
'@cloudbitmaps/core': patch
'@cloudbitmaps/roaring': patch
---

A segment ref with a key it does not take, such as `{ segment: 'x', namspace: 'eu' }`, is refused with `ValidationError` naming the key and the keys a ref takes, in `load`, `exists`, `generations`, `rollback`, `dropSegment`, `setRetention`, `getRetention`, `clearRetention`, `invalidate` and `destroySegment`. It used to address the segment of that name in the default namespace.
