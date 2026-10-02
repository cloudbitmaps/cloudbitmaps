---
"@cloudbitmaps/azure-blob": minor
---

`AzureBlobStorage` and the Azure Blob drivers take `readTimeoutMs`, off unless set: each read request, its body
included, is cut off after that long and throws `TransientError` for the store's read retry. The user-facing entry is
in the root `CHANGELOG.md`, under `[Unreleased]`: `Added` and `Fixed`.
