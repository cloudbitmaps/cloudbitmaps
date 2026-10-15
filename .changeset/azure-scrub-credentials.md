---
'@cloudbitmaps/azure-blob': patch
---

An Azure Blob error carries no credential. An SDK error that carries its transport, and every error in its `cause` chain (an `AggregateError`'s `errors` too), is now thrown as a copy of its plain data, without the request and the response it kept (`err.request`, `err.response.request`: the signed `Authorization` header, or a SAS URL with its `sig=`). The copy is a native error with the same prototype, message, stack, `code`, `statusCode` and `details`, so classification is unchanged, and the live error is never changed. In the copy's text an `Authorization` header line, a `SharedKey` or `Bearer` value, a `sig=` value (also percent-encoded, JSON-escaped or quoted) and the signature Azure quotes in a 403 body are redacted, as is the value under a credential key; a credential in any other form is not recognised, and a text too large for these patterns is replaced whole.
