---
'@cloudbitmaps/core': minor
'@cloudbitmaps/roaring': minor
---

`errorKind(err)` replaces the 13 `isXError` predicates, which `@cloudbitmaps/roaring` and `@cloudbitmaps/core/driver-kit` no longer export: `errorKind(err) === 'ValidationError'`, or `errorKind(err) !== undefined` for any error of the library's, holds across copies of the package as the predicates did. `BudgetExceededError` carries `option`, `limit` and `spent`, and its constructor takes them as `(message, { option, limit, spent })`. `store.checkConsistency` takes `maxScanSegments`.
