---
"@cloudbitmaps/core": minor
"@cloudbitmaps/roaring": minor
"@cloudbitmaps/gcs": minor
---

`new CloudRoaring(options)` and `new GcsStorage(options)` refuse every option key they do not take, by name. A
registry row with a status other than `active` or `destroyed`, a field the record does not declare, or no
`schemaVersion` is refused on read. `LocalFsStorage` does not look for a `cold/` directory. The error brands are
`Symbol.for('cloudbitmaps.error')` and `Symbol.for('cloudbitmaps.error.transient')`.
