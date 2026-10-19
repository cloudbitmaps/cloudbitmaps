---
'@cloudbitmaps/core': minor
'@cloudbitmaps/azure-blob': minor
---

A registry driver can mark a conflict that may follow its own write's landing with `unsettledConflict`, from `@cloudbitmaps/core/driver-kit`, and a load refused after one reports `unanswered: true`. The Azure Blob registry marks every conflict of a row write.
