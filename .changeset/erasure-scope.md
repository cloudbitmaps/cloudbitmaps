---
'@cloudbitmaps/core': patch
'@cloudbitmaps/roaring': patch
---

`subjectReport` and `eraseSubject` refuse a `namespace` together with `allNamespaces: true`, in the types and at run time. An erasure that loses a race to another erasure of a different id on one segment reports `'superseded'`, not a storage error, and a ledger's `error:` note names the error's class.
