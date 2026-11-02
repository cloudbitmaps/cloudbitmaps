---
'@cloudbitmaps/azure-blob': patch
---

A connection string the Azure SDK refuses no longer puts a part of itself in the error: the message says only that the string is not a valid Azure Storage connection string, and never includes the SDK's reason.
