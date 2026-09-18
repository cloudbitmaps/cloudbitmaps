# CloudBitmaps guide

User-facing documentation — how to actually use CloudBitmaps. Kept accurate to what's **shipped**, and
grown one capability per phase (so it never describes vapor).

- [**Getting started**](getting-started.md) — install status, the in-memory quick start, the persistent
  local-filesystem setup, loading a generation, and the operation reference.
- [**API reference**](api-reference.md) — the complete callable surface, every export with its shape, kept in
  sync by CI with each package's own `exports` map. It also documents
  [`@cloudbitmaps/core/driver-kit`](api-reference.md#cloudbitmapscoredriver-kit), the declared contract for
  writing a storage driver package.
- [**Migrating from 0.9.x**](../../MIGRATING.md) — the cloud drivers became their own packages
  (`@cloudbitmaps/s3` · `/gcs` · `/azure-blob`), the packages are ESM-only on Node ≥ 22.12, and two
  constructors changed.
- [**Dashboards**](dashboards.md) — wiring the metrics + audit sinks into your observability stack.
- [**Disaster recovery**](disaster-recovery.md) — what to back up, the coordinated-restore procedure, RPO/RTO,
  and the `checkConsistency()` torn-restore check.

Shipped capabilities — **intersection** (the crown jewel), the **storage packages**
(`@cloudbitmaps/s3` · `/gcs` · `/azure-blob`, each hosting both the generations and the registry in one
bucket), and loading, encryption, retention, cost, and observability — are covered in
[getting started](getting-started.md). Writing your own storage package builds against
[`@cloudbitmaps/core/driver-kit`](api-reference.md#cloudbitmapscoredriver-kit), the declared contract; the
conformance suite the in-repo drivers are held to (`packages/roaring/src/testing/conformance.ts`) is **not**
exported as a public subpath, so a third-party driver cannot yet run it. For what's shipped, what's proven to
what degree, and what's next, read the [roadmap](../ROADMAP.md); for the measured cost and memory figures and
their method, [benchmarks](../benchmarks.md).
