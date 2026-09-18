# Migrating to 0.10.0

`0.10.0` is a breaking release with **six** changes. Four of them fail loudly — an unresolved import, a
refused constructor, or a module that will not load. The fifth changes a default, so it is the one that needs
you to look at your call sites rather than wait for an error. The sixth is a list of removed exports, and it
fails loudly too. Work down the list; most upgrades are the first two and take a few minutes.

1. [The cloud drivers are their own packages](#1-the-cloud-drivers-are-their-own-packages)
2. [ESM only, Node ≥ 22.12](#2-esm-only-node--2212)
3. [A storage backend must be built, not assembled](#3-a-storage-backend-must-be-built-not-assembled)
4. [The flat options became six groups](#4-the-flat-options-became-six-groups)
5. [The `*Into` verbs can now refuse](#5-the-into-verbs-can-now-refuse)
6. [Core exports only what it supports](#6-core-exports-only-what-it-supports)

Also worth knowing, because it changes what your `catch` blocks can rely on:
[`instanceof` now holds across packages](#instanceof-now-holds-across-packages).

---

## 1. The cloud drivers are their own packages

You now install **two packages**: the codec you want and the storage you have.

```diff
- npm i @cloudbitmaps/roaring
- npm i @aws-sdk/client-s3          # the optional peer you had to remember
+ npm i @cloudbitmaps/roaring @cloudbitmaps/s3
```

The SDK is a **real dependency** of the storage package, so installing it is the whole step. Nothing is an
optional peer any more, which removes the "install the peer" error path and the pnpm strict-resolution hazard
that came with it.

### Every import that moved

| 0.9.x | 0.10.0 |
|---|---|
| `from '@cloudbitmaps/roaring/s3'` | `from '@cloudbitmaps/s3'` |
| `from '@cloudbitmaps/roaring/gcs'` | `from '@cloudbitmaps/gcs'` |
| `from '@cloudbitmaps/roaring/azure'` | `from '@cloudbitmaps/azure-blob'` |
| `from '@cloudbitmaps/core/s3'` | `from '@cloudbitmaps/s3'` |
| `from '@cloudbitmaps/core/gcs'` | `from '@cloudbitmaps/gcs'` |
| `from '@cloudbitmaps/core/azure'` | `from '@cloudbitmaps/azure-blob'` |

> [!IMPORTANT]
> **The Azure package is `@cloudbitmaps/azure-blob`, not `@cloudbitmaps/azure`.** The other two renames are
> mechanical — drop the prefix, keep the last segment — and Azure is the one that is not. The old subpath was
> named for the *cloud*; the package is named for the *service*, because "azure" is ambiguous across Blob,
> Table, Files and Data Lake. `@cloudbitmaps/azure` does not exist and never will.

The classes, their constructors and their options are unchanged, so the move is the import line and the
install:

```diff
- import { CloudRoaring, S3Storage } from '@cloudbitmaps/roaring/s3';
+ import { CloudRoaring } from '@cloudbitmaps/roaring';
+ import { S3Storage } from '@cloudbitmaps/s3';

  const store = new CloudRoaring({ storage: new S3Storage({ bucket: 'bitmaps', region: 'us-east-1' }) });
```

### If you pin the cloud SDK yourself

This is the one part of the move that is not just an import. The SDK used to be an optional peer, so *your*
pin decided the version. It is now a real dependency of the storage package with a declared range, and your
pin has to satisfy it:

| package | required range |
|---|---|
| `@cloudbitmaps/s3` | `@aws-sdk/client-s3` `>=3.645.0 <4` |
| `@cloudbitmaps/gcs` | `@google-cloud/storage` `^7 \|\| ^8` |
| `@cloudbitmaps/azure-blob` | `@azure/storage-blob` `^12` |

**The S3 floor is a correctness floor, not a preference.** Below it the SDK does not model the conditional
write this library's write-once guarantee is built on: measured against MinIO, **3.640.0 silently overwrites**
an existing object instead of refusing — losing a published generation with no error — while 3.641.0 rejects
correctly. If you had `@aws-sdk/client-s3` pinned below `3.645.0`, raise it. A stale pin surfaces as an
install-time resolution error, not as a silent downgrade.

### If you construct the SDK client yourself

The drivers take an injected client, and the guide's examples show that. If you do it, **declare the SDK in
your own `package.json` too** — importing a package you did not declare is not guaranteed to resolve, and
pnpm refuses it by default:

```jsonc
// your package.json
"dependencies": {
  "@cloudbitmaps/roaring": "^0.10.0",
  "@cloudbitmaps/s3": "^0.10.0",
  "@aws-sdk/client-s3": "^3.645.0"   // only if YOU import S3Client yourself
}
```

### If you wrote your own driver

The internals a driver builds against are now a declared, versioned subpath:
**[`@cloudbitmaps/core/driver-kit`](docs/guide/api-reference.md#cloudbitmapscoredriver-kit)** — 36 symbols,
every one of them used by a driver that ships here. Import from it rather than reaching into core's internals.
It is not quite self-sufficient: `Token`, `RegCaps`, `RegistryRecord`, `NewRegistryRecord` and `RegistryPatch`
still come from core's main entry, and the API reference says so where it lists them.

---

## 2. ESM only, Node ≥ 22.12

The packages ship as ES modules. There is no CommonJS bundle.

- **`import` works everywhere.**
- **`require()` works on Node ≥ 22.12**, through Node's `require(esm)`. That is why the floor is 22.12 and not
  22: 22.11 throws `ERR_REQUIRE_ESM`.
- **A runner with its own CommonJS loader does not get `require(esm)`.** Jest in its default configuration
  fails with *"Must use import to load ES Module"*; Yarn PnP throws `ERR_REQUIRE_ESM` and does not stop doing
  so on Node 24. Use `import`, or configure the runner for ESM.
- **TypeScript:** a CommonJS project on `"module": "node16"` or `"node18"` gets **TS1479** when it statically
  imports an ESM package. Move to `"nodenext"` or `"node20"`. `"bundler"` is unaffected.

If you are on Node 20, or on a Node 22 older than 22.12, upgrade Node before upgrading this library.

---

## 3. A storage backend must be built, not assembled

```diff
- new CloudRoaring({ storage: driver, registry })
+ new CloudRoaring({ storage: new S3Storage({ bucket, prefix }) })
```

One class states the location once, so the mismatch that used to answer "empty" — generations at one prefix,
the pointer at another — is no longer expressible. A plain object literal is refused.

If you genuinely want the halves apart (an instrumented driver, or a registry in a database you already run),
say so explicitly with `createBackend({ storage, registry })`. It cannot verify that the two halves agree, so
calling it is you taking that on — which is the difference between a decision and the accident it replaces.

This one **throws with a message naming the fix**, so you will find it the first time you run.

---

## 4. The flat options became six groups

`cache` · `encryption` · `retry` · `metrics` · `budget` · `seams`:

| before | after |
|---|---|
| `cacheMaxChunks` · `cacheTtlMs` · `storageGenTtlMs` · `storageReaderCacheMax` · `storageReaderCacheMaxBytes` | `cache.maxChunks` · `cache.ttlMs` · `cache.genTtlMs` · `cache.readerMax` · `cache.readerMaxBytes` |
| `keystore` · `requireEncryption` | `encryption.keystore` · `encryption.required` |
| `onRetry` | `retry.onRetry` |
| `clock` · `rng` | `seams.clock` · `seams.rng` |

`retry` also takes a **partial** policy now, so `retry: { maxAttempts: 6 }` keeps every other field's default
instead of requiring all five.

This one throws too.

---

## 5. The `*Into` verbs can now refuse

`intersectInto` / `unionInto` / `andNotInto` used to write and publish in one step. An empty combine
therefore replaced the destination with an empty generation and reported success — indistinguishable from a
correct run, and reachable without passing any option.

They now refuse instead, the same way `load()` always has:

```ts
const res = await audience.intersectInto(dest, [eligible]);
if (!res.published) {
  // res.reason === 'empty', res.cardinalityBefore === what dest still holds
}
```

**What to check in your code:** anywhere you call an `*Into` verb and assume it wrote. If emptying the
destination is genuinely the point, pass `allowEmpty: true`.

That restores the old *publishing* behaviour, with one difference that is not worth hiding: the publish is
now fenced on the destination's registry row, so a segment purged and re-created under the same name while
your call was in flight throws `WriteConflictError` instead of publishing into the new incarnation. That is a
narrow race and the new outcome is the correct one.

**Generation collection is unchanged.** Unlike `load()`, a materialisation still collects nothing, so a
`rollback` target survives it. Pass `keep` if you want it to collect on the way through.

`MaterializeResult` gains `published`, `reason`, `cardinalityBefore` and `collected`. Reading the existing
fields is unaffected; a deep equality check on the whole object is not. `cardinalityBefore` is `null` when no
bound needed the read — with `allowEmpty: true` and no `guard.minRetained`, nothing reads it.

A lost race still throws `WriteConflictError` — unchanged.

## 6. Core exports only what it supports

`@cloudbitmaps/core`'s main entry went from **110 exports to 82**. It had accumulated the internals of
whatever landed next to it, and a reader could not tell supported API from plumbing that happened to be
reachable. Every name below still exists and still works inside the library — it is no longer importable.

**Most people are unaffected** — but check, because it is not only direct core imports.
`@cloudbitmaps/roaring` re-exports core wholesale, so a name removed from core disappears from the flavor
too. If you import any of the names below **from `@cloudbitmaps/roaring`**, that import is affected just as
much as one from `@cloudbitmaps/core`.

Twelve names were public in `0.9.x`:

| gone | what to do instead |
|---|---|
| `isTransient` | **use `isTransientError`** — see below, this is the only one worth a thought |
| `NOOP_AUDIT` | omit the `audit` option; that is what "no audit sink" already means |
| `drainRegistry` · `validateMaxScanSegments` | compose the two exported halves: `collectWithinBudget(excludingReservedRows(registry.list(ns)), budget, op)`. **`listSegments()` is not a drop-in** — it streams, so the bound is yours, and it yields `SegmentInfo`, which carries no `retention`. `excludingReservedRows` is the part you must not skip |
| `DEFAULT_MAX_SCAN_SEGMENTS` · `DEFAULT_RETIRE_LIMIT` · `DEFAULT_TOMBSTONE_GRACE_MS` | the values are in the [API reference](docs/guide/api-reference.md); pass your own to `maxScanSegments` / `limit` / `tombstoneGraceMs` rather than reading ours |
| `CrbmWriter` · `CrbmWriterOptions` | none. Building a `.crbm` is the library's job; `CrbmReader` is still exported for tooling that inspects one |
| `chunkRefKey` | none. `segmentKey` is still exported |
| `joinId` | none. `splitId` is still exported, because it range-checks an id on the way |
| `BufferSink` | implement `BlobSink` — it is one method, `write(bytes)` |

### The one that needs a decision: `isTransient`

It was `return isTransientError(err)` — the same check, with a plain `boolean` where its twin has a type
predicate. Swap the name:

```diff
- import { isTransient } from '@cloudbitmaps/core';
- if (isTransient(err)) retry();
+ import { isTransientError } from '@cloudbitmaps/roaring';
+ if (isTransientError(err)) retry();   // also narrows `err` to TransientError
```

If you passed `RetryDeps.isRetryable` or `RetryingOptions.isRetryable`, nothing changes — the default is now
`isTransientError`, which is the same predicate it always called.

> [!NOTE]
> Each driver package defines its own internal `isTransient` for *SDK* errors (an S3 `SlowDown`, a 503) —
> a different job from core's, which classifies errors this library already threw. **None of them exports it**,
> so there is no import of that name from `@cloudbitmaps/s3`, `/gcs` or `/azure-blob` to migrate.

**Why now rather than later.** `0.10.0` already breaks your import paths, so this costs one more entry in this
guide instead of a second breaking release. And re-exporting a name is additive, never breaking — so the bias
is to cut now and restore deliberately, with docs and tests, if a real use case turns up.

## `instanceof` now holds across packages

Not a breaking change — a guarantee that got *stronger* — but worth knowing if you wrote code around the old
behaviour.

Every package is now published with `@cloudbitmaps/core` left **external** rather than bundled in, so your
tree has **one** copy of the error classes. `core.ValidationError` and the class an `@cloudbitmaps/s3` driver
throws are the same object, and `instanceof` matches. Previously each package carried its own copy and it did
not.

If you worked around that with the `Symbol.for`-branded predicates (`isValidationError`, `isWriteConflictError`,
…), **keep them.** They still work, and they are still the right tool where one copy is not guaranteed and this
library cannot control it:

- a bundler that inlines `@cloudbitmaps/core` into two separate outputs;
- two major versions of core resolved side by side in one tree, which npm and pnpm will both do;
- an error crossing a `worker_threads` worker, a `vm` realm, or an iframe.

---

## Still stuck?

The full entries, with rationale, are in [`CHANGELOG.md`](CHANGELOG.md) under `[Unreleased]`. If something here
is wrong or missing, [open an issue](https://github.com/cloudbitmaps/cloudbitmaps/issues) — a migration you had
to work out yourself is a bug in this page.
