---
'@cloudbitmaps/core': minor
'@cloudbitmaps/roaring': minor
'@cloudbitmaps/s3': minor
---

A store with a metrics sink sends one `advisory` event when an S3 client's socket pool is smaller than twice the default `concurrency`. `MetricEvent` gains the `advisory` variant, `StorageBackend` an optional `attachMetrics`, and `driver-kit` re-exports `IMetricsSink` and `MetricEvent`.
