# CloudBitmaps guide

User-facing documentation — how to actually use CloudBitmaps. Kept accurate to what's **shipped**, and
grown one capability per phase (so it never describes vapor).

- [**Getting started**](getting-started.md) — install status, the in-memory quick start, the persistent
  local-filesystem setup, loading a generation, and the operation reference.
- [**API reference**](api-reference.md) — the complete callable surface, every export with its shape, kept in
  sync with the barrels by CI.
- [**Dashboards**](dashboards.md) — wiring the metrics + audit sinks into your observability stack.
- [**Disaster recovery**](disaster-recovery.md) — what to back up, the coordinated-restore procedure, RPO/RTO,
  and the `checkConsistency()` torn-restore check.

Shipped capabilities — **intersection** (the crown jewel), the **cloud drivers** (S3/GCS/Azure cold,
S3/DynamoDB registry), and loading, encryption, retention, cost, and observability — are
covered in [getting started](getting-started.md). Writing your own driver builds on the internal conformance
suite (`packages/roaring/src/testing/conformance.ts`); it is not yet exported as a public package subpath. For
what's shipped, what's proven to what degree, and what's next, read the [roadmap](../ROADMAP.md); for the
measured cost and memory figures and their method, [benchmarks](../benchmarks.md).
