# CloudBitmaps guide

User-facing documentation — how to actually use CloudBitmaps. Kept accurate to what's **shipped**, and
grown one capability per phase (so it never describes vapor).

- [**Getting started**](getting-started.md) — install status, the in-memory quick start, the persistent
  local-filesystem setup, seeding a Cold generation, and the operation reference.
- [**Dashboards**](dashboards.md) — wiring the metrics + audit sinks into your observability stack.
- [**Disaster recovery**](disaster-recovery.md) — what to back up, the coordinated-restore procedure, RPO/RTO,
  and the `checkConsistency()` torn-restore check.

Shipped capabilities — **intersection** (the crown jewel), the **cloud drivers** (S3/DynamoDB + GCS/Azure cold
and PostgreSQL/Redis/MongoDB/Cassandra/MySQL warm), and encryption, compaction, cost, and observability — are
covered in [getting started](getting-started.md). Writing your own driver builds on the internal conformance
suite (`packages/roaring/src/testing/conformance.ts`); it is not yet exported as a public package subpath. For the end-to-end
usage walkthrough, for what's shipped, what's proven, and
what's next, the [roadmap](../ROADMAP.md).
