---
"@cloudbitmaps/core": minor
"@cloudbitmaps/azure-blob": minor
---

Azure Blob reads a registry pointer in one request, where it made two, and the cost model prices a pointer read
(`storage.requestsPerPointerRead`, new, 1 by default) apart from a tail read (`storage.requestsPerSizedRead`, which now
prices tail reads only; 2 on Azure Blob). The user-facing entries are in the root `CHANGELOG.md`, under `[Unreleased]`:
`Added` and `Changed`.
