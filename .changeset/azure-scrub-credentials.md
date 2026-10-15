---
'@cloudbitmaps/azure-blob': patch
---

An Azure Blob error carries no credential. The driver now throws a copy of the SDK's error without the request and the response it kept (`err.request`, `err.response.request`: the signed `Authorization` header, or a SAS URL with its `sig=`), with the class, message, `code`, `statusCode` and `details` it had, and redacts an `Authorization` or `sig=` value left in its message, stack or details. The same goes for each error in its `cause` chain.
