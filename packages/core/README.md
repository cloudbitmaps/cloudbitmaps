# @cloudbitmaps/core

**Most people do not install this package.** It is the engine underneath [CloudBitmaps](https://github.com/cloudbitmaps/cloudbitmaps), and it arrives on its own
when you install the two packages you want. Install those instead:

```bash
pnpm add @cloudbitmaps/roaring @cloudbitmaps/s3   # the store, and the storage you have (or /gcs, or /azure-blob)
```

On npm 12 and pnpm 10 and later, allow `roaring`'s one install script first, or the install exits 0 and the package throws at `import`. Put this in your `package.json`: `{ "allowScripts": { "roaring": true }, "pnpm": { "onlyBuiltDependencies": ["roaring"] } }`. npm 11 runs the script but warns until you allow it the same way; pnpm 9 needs nothing extra. [Details](https://github.com/cloudbitmaps/cloudbitmaps/blob/main/docs/guide/getting-started.md#cannot-find-module-buildreleaseroaringnode-after-a-successful-install).

Depend on `@cloudbitmaps/core` directly only to write a flavor or a driver.

> **ESM-only, Node ≥ 22.12.** Use `import`; for `require()`, Jest and TypeScript, see
> [CommonJS, Jest and TypeScript](https://github.com/cloudbitmaps/cloudbitmaps/blob/main/docs/guide/getting-started.md#commonjs-jest-and-typescript).

> Pre-1.0: the API and the on-disk format can still change. On npm these docs match the version they ship in; on GitHub they describe `main`, and the changelog says what each release changed.

## What it is

The codec-agnostic cloud engine: a bounded in-memory cache over immutable `.crbm` objects, chunk-skipping
intersection, the segment registry, the write-once load-and-publish path, generation collection, encryption at rest
and crypto-shred, erasure by rewrite, retention, and the in-memory and local-filesystem backends. It has **zero runtime
dependencies and no cloud SDK**. The cloud backends are their own packages, built against
`@cloudbitmaps/core/driver-kit`, the declared contract a driver depends on. A third-party driver can use it too.

Its main entry is the flavor-author kit: the read engine, the standalone forms of the store's methods (`loadSegment`,
`dropSegment`, `retireExpired` and the rest), and the retry and budget internals. `@cloudbitmaps/roaring` re-exports,
by name, what an application uses.

## How the storage path is laid out

The `.crbm` storage path lives in `src/core/`, one module per concern. Arrows read "imports":

```
                bulk-load.ts                       write path: ids in, a generation written and published
              /      |       \
             v       v        v
   publish.ts  crbm-write.ts  crbm-open.ts  <----  crbm-storage-source.ts     read path
```

`publish.ts`, `crbm-write.ts` and `crbm-open.ts` import none of the others. Outside this group, `load.ts` imports
`bulk-load.ts`, `publish.ts` and `crbm-open.ts`; `erase-id.ts` imports `publish.ts`, `crbm-write.ts` and
`crbm-open.ts`; `rollback.ts` and `consistency.ts` import `crbm-open.ts`. `combine-many.ts`, `pinned-storage-source.ts`
(types only) and the package entry import `crbm-storage-source.ts`.

| File | Holds |
|---|---|
| `crbm-write.ts` | writing one immutable generation from in-memory bitmaps, from a stream or from already-encoded chunks |
| `publish.ts` | the forward-only pointer advance every write ends with, the lease patch, the refusal to point a keyed row at a cleartext generation, and the settling of a registry write that got no answer |
| `bulk-load.ts` | the loader `load()` is built on, with its read-ahead: ids, a decoded bitmap or a combine's chunks in, made into chunks (ids bucketed, a bitmap split by its codec where the codec can, a combine's chunks checked), one generation written, and published when a registry is wired and the caller does not defer it; `load()` defers it and publishes through `publish.ts` after its guard |
| `known-generations.ts` | the row's ledger, `knownGens`: what a usable one is, the window a load collects by name, the cap, and the ledger a publish and a rollback write |
| `ledger-seed.ts` | the first window of a ledger over a row that has none, read from the bucket |
| `crbm-open.ts` | opening a stored generation without the cache: the blob reader over a driver object, the checked and noting opens, the identity checks that tie an open to the object it read, generation verification, and the rollback target open |
| `crbm-storage-source.ts` | the read path: `CrbmStorageChunkSource`, its resolution cache and the pin machinery |

No write-path module imports `crbm-storage-source.ts`, and it imports only `crbm-open.ts` of the other four.

## The row's ledger of generations

A registry row carries `knownGens`: the generations the segment knows and has not decided to delete, each with the
CRC32C its object's footer stores, the current one last. They are the ones it made current, in that order, and, when a
publish over a row with no usable ledger seeds one, the ones a count by `keep` keeps in the bucket, which can include an
object no load published (an orphan or a stray): an entry says the library knows the generation and its checksum, not
that a load published it. Its entries below the
pointer are the window a load keeps and the generations a live lease holds, so a load deletes what its publish pushed out
of the window by name and lists the bucket only when it cannot rely on the row.

```
  row (schema 5)                              bucket
  currentGen: 7                               segment.3.crbm  segment.5.crbm  segment.6.crbm  segment.7.crbm
  knownGens: [ {5,crcA}, {6,crcB}, {7,crcC} ]       |               |               |              |
              \_____ window ____/  \ current        deleted by     in the window   in the window   current
                                                   name when a
                                                   load pushed it out
```

- **A publish writes it** in the compare-and-swap that moves the pointer. Over a row whose ledger is usable, the window
  is drawn from the order the generations were made current: the `keep` most recently current of the entries numbered
  below the new generation (at most 127), beside them every entry a live lease holds, whatever `keep` says, then the
  entries a rollback left numbered above the new generation (carried while the ledger holds fewer than 128, never
  collected, and taking no place in `keep`), then the new generation. The generation the publish superseded is the
  ledger's last entry, so it comes first, and after a rollback the restored generation ranks ahead of the ones the
  rollback moved away from, from every load on. Over a row with no usable ledger (a hand repair, a restore, a pointer
  moved down by hand, one a run of publishes with a `keep` above 64 carried past 64 names that no lease holds) the load
  lists the bucket and writes the window a count by `keep` keeps there: the
  generation the row named as current first, then the newest by number, each with a footer read (read eight at a time
  under the store's read retry, the superseded generation's too; a clear summary that describes it with another
  checksum leaves it out), and beside them the listed generations a live lease holds, oldest first by number with the
  leased ones before the window and the superseded one last, then the new generation. A generation gone from the
  bucket, or whose footer fails its checks, is left out. The publish then collects by that count.
- **An incarnation's first publish writes the new generation alone** (no row, or a row with no pointer): nothing below
  it was made current by it, so a seed could only name objects no load of it published.
- **A collection reads it.** A load with a `keep` of at most 64 deletes by name the entries its publish left out. A pass
  that keeps by a count (a `keep` above 64, or the first load over a row with no usable ledger) keeps the ledger's own
  most recently current names first, then the newest others by number, `keep` in all, and spares every name the row
  knows when it reads the row again before a delete.
- **A rollback carries it**, moving its target to the end with the checksum of the footer it read, and writes none over
  a row that had none: a rollback never starts a ledger.
- **An erasure's rewrite leaves itself alone in it**, since it deletes every older generation; a shred removes it.
- **Caps**: a writer writes at most 192 entries and keeps an entry nothing protects only while the ledger holds fewer
  than 128; the registry accepts 192 written and 384 read, so no publish or rollback is refused for the ledger's size.
- **Errors**: a malformed ledger is `ValidationError` on a write and `IntegrityError` on a read; a ledger that disagrees
  with its row is read and not used; a row stamped 4 or lower is `UnsupportedError`.
- Nothing yet reads the ledger to refuse a rollback: that check comes after this one.

## Documentation

- [API reference](https://github.com/cloudbitmaps/cloudbitmaps/blob/main/docs/guide/api-reference.md), including the
  [driver kit](https://github.com/cloudbitmaps/cloudbitmaps/blob/main/docs/guide/api-reference.md#driver-kit--what-you-need-to-implement-a-driver)
- [Getting started](https://github.com/cloudbitmaps/cloudbitmaps/blob/main/docs/guide/getting-started.md)
- [Changelog](https://github.com/cloudbitmaps/cloudbitmaps/blob/main/CHANGELOG.md)

## License

Apache-2.0
