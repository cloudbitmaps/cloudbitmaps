---
"@cloudbitmaps/core": minor
---

**BREAKING:** `estimateCost()` compares with the Redis that would hold the data, sized from a catalogue of
ElastiCache node types, instead of one $346 cluster; pass `redis: ONE_REDIS_HA_CLUSTER` to keep the old comparison.
The user-facing entry, with everything that changes, is in the root `CHANGELOG.md`, under `[Unreleased]`.
