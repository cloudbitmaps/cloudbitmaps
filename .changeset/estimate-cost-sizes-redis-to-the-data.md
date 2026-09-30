---
"@cloudbitmaps/core": minor
---

**BREAKING:** `estimateCost()` compares with the Redis that would hold the data, sized from a catalogue of
ElastiCache node types, instead of one $346 cluster; to keep the old comparison, pass
`pricing: { ...AWS_US_EAST_1_ONDEMAND, redis: ONE_REDIS_HA_CLUSTER }`. The user-facing entry, with everything that
changes, is in the root `CHANGELOG.md`, under `[Unreleased]`: `Breaking`.
