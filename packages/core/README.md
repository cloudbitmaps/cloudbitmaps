# @cloudbitmaps/core

> **ESM-only, Node ≥ 22.12.** This package ships as ES modules; there is no CommonJS bundle.
> `require()` works on Node 22.12+ through `require(esm)`, but a runner with its own CommonJS loader
> (notably Jest in its default configuration) does not get that and needs `import` instead. On TypeScript,
> a CommonJS project needs `"module": "nodenext"` or `"node20"`. See the
> [repository README](https://github.com/cloudbitmaps/cloudbitmaps#install--entry-points) for the details.


The **codec-agnostic cloud engine** behind the [CloudBitmaps](https://github.com/cloudbitmaps/cloudbitmaps) family:
a bounded RAM cache over immutable `.crbm` objects in STORAGE, serverless chunk-skipping intersection, the segment
registry, the write-once load-and-publish write path, generation GC, encryption-at-rest + crypto-shred, subject
erasure by generation rewrite, segment lifecycle (disposal, and a per-segment retention policy with the sweep
that enforces it), and the **in-memory and local-filesystem drivers**. It contains **no cloud SDK at all**: the
cloud drivers are their own packages (`@cloudbitmaps/s3` · `/gcs` · `/azure-blob`), each hosting both the
generations and the registry, and each built against `@cloudbitmaps/core/driver-kit` — the declared contract a
driver package depends on, which a third-party driver can use too.

## You probably want a flavor, not this package

This package holds no bitmap codec — that lives in a *flavor* package which depends on this one and supplies it
through the `CodecInterface` seam, and it holds no cloud driver either — those are packages of their own.
Install a codec and a storage; `@cloudbitmaps/core` is a dependency of both and never named by you:

```bash
npm i @cloudbitmaps/roaring @cloudbitmaps/s3   # the roaring flavor (flagship), and the storage you have
```

> [!NOTE]
> **The storage packages land in 0.10.0 and are not on npm yet.** On the published `0.9.0` they are
> subpaths of the flavor — `npm i @cloudbitmaps/roaring`, then import from `@cloudbitmaps/roaring/s3`.

Depend on `@cloudbitmaps/core` directly only to **author a flavor or a driver**. It has **zero runtime
dependencies** of its own.

Full docs, guides, and the design corpus live in the
[repository](https://github.com/cloudbitmaps/cloudbitmaps). Licensed Apache-2.0.
