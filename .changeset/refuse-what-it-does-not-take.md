---
"@cloudbitmaps/core": minor
"@cloudbitmaps/roaring": minor
"@cloudbitmaps/gcs": minor
"@cloudbitmaps/s3": minor
"@cloudbitmaps/azure-blob": minor
---

`new CloudRoaring(options)`, `new S3Storage(options)`, `new GcsStorage(options)` and `new AzureBlobStorage(options)`
refuse every option key they do not take, by name, and the store refuses a group that is not an object. A
registry row with a status other than `active` or `destroyed`, a field its record or envelope does not declare, or
no `schemaVersion` is refused on read, and the registry drivers refuse to write either of the other two statuses.
`LocalFsStorage` does not look for a `cold/` directory. The error brands are
`Symbol.for('cloudbitmaps.error')` and `Symbol.for('cloudbitmaps.error.transient')`.
