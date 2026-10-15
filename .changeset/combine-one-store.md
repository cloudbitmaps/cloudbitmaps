---
'@cloudbitmaps/roaring': minor
---

A combine, an `*Into` verb and `materializeMany` take only segments made by the store the call runs on, and refuse a
segment of another store, of a second store object over the same backend, or of another installed copy of the package
with a `ValidationError` before any request. A handle of a store over different storage is no longer read as the
receiving store's segment of the same name, which answered from, or published, the wrong ids.
