# @cloudbitmaps/core

The **codec-agnostic cloud engine** behind the [CloudBitmaps](https://github.com/cloudbitmaps/cloudbitmaps) family:
tiered storage (HOT RAM → WARM key/value deltas → COLD immutable `.crbm` objects), serverless chunk-skipping
intersection, the segment registry, crash-safe 2-phase-commit compaction, encryption-at-rest + crypto-shred,
segment lifecycle (disposal, and a per-segment retention policy with the sweep that enforces it), and
**every storage driver** (S3 · GCS · Azure Blob · DynamoDB · PostgreSQL · Redis · MongoDB · Cassandra/ScyllaDB ·
MySQL/MariaDB, each on its own subpath with the backend SDK as an optional peer dependency).

## You probably want a flavor, not this package

This package holds no bitmap codec — that lives in a *flavor* package which depends on this one and supplies it
through the `CodecInterface` seam. Install the flavor; `@cloudbitmaps/core` arrives **transitively**:

```bash
npm i @cloudbitmaps/roaring        # the roaring flavor (flagship)
```

Depend on `@cloudbitmaps/core` directly only to **author a flavor or a driver**. It has **zero runtime
dependencies** of its own.

Full docs, guides, and the design corpus live in the
[repository](https://github.com/cloudbitmaps/cloudbitmaps). Licensed Apache-2.0.
