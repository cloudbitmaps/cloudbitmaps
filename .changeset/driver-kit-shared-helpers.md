---
'@cloudbitmaps/core': minor
'@cloudbitmaps/s3': patch
'@cloudbitmaps/gcs': patch
'@cloudbitmaps/azure-blob': patch
---

`@cloudbitmaps/core/driver-kit` exports the helpers the cloud drivers share: `storageObjectKey`, `segmentObjectPrefix` and `parseGenerationFromKey` for the storage object layout, `refuseUnknownOptions`, `requirePositiveInt` and `requireBool` for option checks, `isTransportFault` and `toTransient` for fault classification, and `concatBytes`. The S3, GCS and Azure Blob drivers use them. A `getTail` length is one rule on every storage driver: a safe integer, with zero or less an empty tail; `NaN`, a fraction, an infinity and a whole number past the safe range (2^53 or more, or -2^53 or less) throw `ValidationError`. A malformed size or switch given to a cloud backend is always a `ValidationError`, and each cloud driver words a transient fault one way. A reader keeps chunk bytes of its own when a driver answers a tail read with a Node `Buffer`.
