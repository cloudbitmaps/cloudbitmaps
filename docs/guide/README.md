# CloudBitmaps guide

> **These docs describe `main`.** The library is pre-1.0 and the API can still change. [The changelog](../../CHANGELOG.md#unreleased)
> lists what `main` has that the latest release does not, and the docs for each release are at its tag, on the
> [releases page](https://github.com/cloudbitmaps/cloudbitmaps/releases).

How to use CloudBitmaps. Anything planned says so where it appears, and the [roadmap](../ROADMAP.md#planned--exploring)
lists all of it. New here? Read the [README](../../README.md), then [Getting started](getting-started.md).

## Start

- [**README**](../../README.md): what it is, when to use it, and a first run.
- [**Getting started**](getting-started.md): the 10-minute path from install to a bucket, with a glossary.

## Run it

- [**Before production**](production.md): the checklist, with permissions, lifecycle rules, timeouts and limits.
- [**Loading in depth**](loading.md): why a load is refused, generations and `keep`, rollback, the `*Into` verbs.
- [**Reading in depth**](reading.md): the combines, what a read costs, freshness, pins and paging.
- [**Retention**](retention.md): expiring segments, the sweep you schedule, and why there is no per-id TTL.
- [**Encryption at rest**](encryption.md): turning it on, key management, and crypto-shred.
- [**Subject access and erasure**](erasure.md): GDPR Art. 15 and 17.
- [**Observability**](observability.md): the metrics and audit sinks, and [dashboards](dashboards.md) that use them.
- [**Export your data**](export.md): getting every segment out in a portable format.
- [**Disaster recovery**](disaster-recovery.md): what to back up, the restore procedure, RPO and RTO, and the
  `checkConsistency()` check.

## When something fails

- [**Errors and what to do**](api-reference.md#errors-typed--you-catch-these): every error, what it means, and whether to retry.
- [**A load was refused**](loading.md#when-a-load-is-refused): each `reason` and what to do.
- [**Install or import fails**](getting-started.md#troubleshooting): the native addon, and the deprecation warning.

## Decide

- [**What it saves, and where it doesn't**](why-cloudbitmaps.md): CloudBitmaps against an always-on Redis, with charts.
- [**What it costs at your size**](sizing.md): a small, a medium and a large deployment priced term by term, and
  [how to estimate your own](cost.md).
- [**Benchmarks**](../benchmarks.md): the measured cost and memory figures, and their method.

## Reference

- [**API reference**](api-reference.md): every export with its shape, kept in sync by CI with each package's own
  `exports` map. Its [errors table](api-reference.md#errors-typed--you-catch-these) says what to do about each error.
- Writing a storage driver? The [driver kit](api-reference.md#cloudbitmapscoredriver-kit) is the declared contract. The
  conformance suite the in-repo drivers are held to (`packages/roaring/src/testing/conformance.ts`) is not exported as a
  public subpath, so a third-party driver cannot yet run it.
- [**Roadmap**](../ROADMAP.md): what is shipped, what is proven to what degree, and what is next.
