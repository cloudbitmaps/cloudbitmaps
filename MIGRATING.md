# Migrating to 0.10.0

`0.10.0` is a breaking release with **eight** changes. Most fail loudly — an unresolved import, a refused
constructor, or a module that will not load. **Two do not**, and those are the ones that need you to look at
your call sites rather than wait for an error: change 6 (the `*Into` verbs now replace where they appended)
and change 8 (metric names, result fields and on-disk paths moved).

**Start with change 1.** It is the only one that can require a design decision rather than an edit, and it
affects every `0.9.x` deployment, because the option it removes was required.

> [!WARNING]
> **If your registry is DynamoDB, there is work to do BEFORE you upgrade** — on `0.9.x`, which is the only
> line where both registry drivers exist. `0.10.0` cannot read a DynamoDB row at all, so this is not
> something you can come back to. See [Before you upgrade](#before-you-upgrade-a-dynamodb-registry).

1. [The live (warm) tier is gone](#1-the-live-warm-tier-is-gone)
2. [The cloud drivers are their own packages](#2-the-cloud-drivers-are-their-own-packages)
3. [ESM only, Node ≥ 22.12](#3-esm-only-node--2212)
4. [A storage backend must be built, not assembled](#4-a-storage-backend-must-be-built-not-assembled)
5. [The flat options became four groups](#5-the-flat-options-became-four-groups)
6. [The `*Into` verbs replace their destination, and can now refuse](#6-the-into-verbs-replace-their-destination-and-can-now-refuse)
7. [Core exports only what it supports](#7-core-exports-only-what-it-supports)
8. [Metric names, result fields and on-disk paths moved](#8-metric-names-result-fields-and-on-disk-paths-moved)

Also worth knowing, because it changes what your `catch` blocks can rely on:
[`instanceof` now holds across packages](#instanceof-now-holds-across-packages).

---

## Before you upgrade: a DynamoDB registry

**Skip this unless your segment pointers live in DynamoDB.** If they do, this is the one piece of work that
cannot be done after the upgrade.

`0.9.x` is the only line in which the DynamoDB driver and an object-store registry both exist, so it is the
only place the library itself can read the old rows and write the new ones. `0.10.0` has no DynamoDB driver
at all. The `.crbm` objects are untouched either way — it is only the pointer rows that move.

**On `0.9.x`, with writers quiesced**, stand up an `S3RegistryDriver` against the bucket you already use for
generations, and copy every segment's row across **with every field it holds**, not just the pointer:

| field | why dropping it hurts |
|---|---|
| `currentGen` | the generation pointer — without it the segment reads empty |
| `wrappedDeks`, `keyId` | **an encrypted segment whose wrapped keys you drop is unrecoverable.** They exist nowhere else; losing them is a crypto-shred you performed on yourself |
| `status` | a `destroyed` tombstone that comes back `active` un-fences a name that was erased on request |
| `retention`, `residency` | drop these and the retention sweep silently stops expiring anything |

Writers must be quiesced because pointer identity is per-registry: a publish landing in the old row during
the copy is lost. Verify with `checkConsistency()` before you upgrade.

**GCS and Azure users have no in-library bridge**, because those registry drivers arrive in this same release,
after DynamoDB is gone. Copy the rows out yourself while still on `0.9.x` — the old table's key layout was
`PK = ns#<namespace>|seg#<segment>`, `SK = reg#` — or move onto S3 first and change buckets afterwards.

---

## 1. The live (warm) tier is gone

**This affects every `0.9.x` deployment**, because `warm` was a *required* option — you cannot have a `0.9.x`
store without one:

```ts
// before — 0.9.x, where `cold` and `warm` were both required
new CloudRoaring({ cold: coldDriver, warm: warmDriver, registry });
```

`0.10.0` has one storage tier. The mutable warm store, the per-call `add`/`remove` verbs over it, the
compaction daemon and the partition leases that kept it healthy are all removed, along with their options
(`warmReadConsistency`, `maxWarmScanBytes`, `writeConcurrency`, `occBackoff`) and their metric events.

**What to do depends on why you had it**, and only you can answer that:

| you used the warm tier for | in `0.10.0` |
|---|---|
| **batch updates** — a job recomputes a set and writes it | this is the loaded store. `store.load(ref, ids)` builds one immutable generation and publishes it. No change in shape, and it is what the library is now built around |
| **per-call `add` / `remove` on the read path** | there is no replacement, and there will not be one on the object store. Micro-batch into a load, or keep those writes in RAM — Redis does that well. Hot-path *reads* are what this library is for |
| **freshness inside a few seconds** | load more often. A load is one PUT plus a pointer swap, so the floor is your job cadence, not the library |

If you need the old behaviour while you decide, `0.9.x` stays on npm and the tier is archived at the git tag
`archive/live-warm-tier`. It will not receive fixes.

---

## 2. The cloud drivers are their own packages

You now install **two packages**: the codec you want and the storage you have.

```diff
- pnpm add @cloudbitmaps/roaring
- pnpm add @aws-sdk/client-s3          # the optional peer you had to remember
+ pnpm add @cloudbitmaps/roaring @cloudbitmaps/s3
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

**The classes were renamed too.** In `0.9.x` a driver was a *tier* — `S3ColdDriver`, `GcsColdDriver`,
`AzureBlobColdDriver` — and the object-store tier was called "cold". There is only one storage tier now, so
the name says what it is:

| `0.9.x` | `0.10.0` |
|---|---|
| `S3ColdDriver` / `S3ColdDriverOptions` | `S3StorageDriver` / `S3StorageDriverOptions` |
| `GcsColdDriver` / `GcsColdDriverOptions` | `GcsStorageDriver` / `GcsStorageDriverOptions` |
| `AzureBlobColdDriver` / `AzureBlobColdDriverOptions` | `AzureBlobStorageDriver` / `AzureBlobStorageDriverOptions` |
| — | `S3Storage` / `GcsStorage` / `AzureBlobStorage` — **new**: one object holding both halves |

So the move is three things, not one — the install, the import line, and the name:

```diff
- import { CloudRoaring } from '@cloudbitmaps/roaring';
- import { S3ColdDriver, S3RegistryDriver } from '@cloudbitmaps/roaring/s3';
+ import { CloudRoaring } from '@cloudbitmaps/roaring';
+ import { S3Storage } from '@cloudbitmaps/s3';

  const store = new CloudRoaring({ storage: new S3Storage({ bucket: 'bitmaps', region: 'us-east-1' }) });
```

### The rest of the `Cold` → `Storage` renames

The same rename runs through core and the flavor, and it is mechanical: **every `Cold` in a name became
`Storage`.** All ten:

| `0.9.x` | `0.10.0` |
|---|---|
| `IColdDriver` | `IStorageDriver` |
| `ColdChunkSource` · `ColdCaps` | `StorageChunkSource` · `StorageCaps` |
| `MemoryColdDriver` · `LocalFsColdDriver` | `MemoryStorageDriver` · `LocalFsStorageDriver` |
| `MemoryColdChunkSource` | `MemoryStorageChunkSource` |
| `CrbmColdChunkSource` · `CrbmColdChunkSourceOptions` | `CrbmStorageChunkSource` · `CrbmStorageChunkSourceOptions` |
| `RetryingColdDriver` · `RetryingColdChunkSource` | `RetryingStorageDriver` · `RetryingStorageChunkSource` |

`MemoryColdDriver` and `LocalFsColdDriver` are the two the `0.9.x` quickstart started with, so most projects
hit these before they hit anything above.

### The subpaths that are gone entirely

`0.9.0` published nine subpaths. Three moved to packages (above). The other six went with the write tier and
have **no replacement**: `/dynamodb` · `/postgres` · `/redis` · `/mongodb` · `/cassandra` · `/mysql`.

`/dynamodb` is the one worth calling out separately, because it was not only a warm driver — it carried
`DynamoDbRegistryDriver`, and a DynamoDB registry was the shape the `0.9.x` README led with. Every object
store now hosts its own registry, so a deployment that kept its pointer in DynamoDB moves the pointer into
the bucket it already has. If you need the pointer off the object store, implement `IRegistryDriver` against
a database you already run.

> [!NOTE]
> Among the object stores, `0.9.x` shipped a registry driver for **S3 only** (`S3RegistryDriver`) — there
> was also a DynamoDB registry, since removed. The GCS and Azure subpaths exported
> a cold driver and nothing else. `0.10.0` ships a registry for all three, which is what makes a
> single-bucket deployment possible on GCP and Azure as well.

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

## 3. ESM only, Node ≥ 22.12

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

## 4. A storage backend must be built, not assembled

```diff
- new CloudRoaring({ cold: coldDriver, warm: warmDriver, registry })
+ new CloudRoaring({ storage: new S3Storage({ bucket, prefix }) })
```

One class states the location once, so the mismatch that used to answer "empty" — generations at one prefix,
the pointer at another — is no longer expressible. A plain object literal is refused.

If you genuinely want the halves apart (an instrumented driver, or a registry in a database you already run),
say so explicitly with `createBackend({ storage, registry })`. It cannot verify that the two halves agree, so
calling it is you taking that on — which is the difference between a decision and the accident it replaces.

This one **throws with a message naming the fix**, so you will find it the first time you run.

---

## 5. The flat options became four groups

`cache` · `encryption` · `retry` · `seams`. **`metrics` and `budget` are unchanged** — both were already
single flat options in `0.9.x` and still take the same value, so leave them alone:

| before | after |
|---|---|
| `cacheMaxChunks` · `cacheTtlMs` · `coldGenTtlMs` · `coldReaderCacheMax` · `coldReaderCacheMaxBytes` | `cache.maxChunks` · `cache.ttlMs` · `cache.genTtlMs` · `cache.readerMax` · `cache.readerMaxBytes` |
| `keystore` · `requireEncryption` | `encryption.keystore` · `encryption.required` |
| `onRetry` | `retry.onRetry` |
| `clock` · `rng` | `seams.clock` · `seams.rng` |
| `occBackoff` · `warmReadConsistency` · `writeConcurrency` · `maxWarmScanBytes` | **gone** — see change 1 |

`retry` also takes a **partial** policy now, so `retry: { maxAttempts: 6 }` keeps every other field's default
instead of requiring all five.

This one throws too.

---

## 6. The `*Into` verbs replace their destination, and can now refuse

**Two changes, and the first one is silent.** Read this section even if your combines never come out empty.

### They replace where they used to append

In `0.9.x`, `intersectInto` / `unionInto` / `andNotInto` **added to** the destination. The engine drained the
result in batches through `addMany(dest, …)`, and the doc comment said so: *"into `dest` (added, not
replaced)"*. They returned `Promise<void>`.

In `0.10.0` they write a **new generation of `dest`** and publish it, so the destination holds the result of
*this* call and nothing else.

```ts
// 0.9.x — accumulate three audiences into one segment
await a.unionInto(all, []);
await b.unionInto(all, []);   // `all` now holds a ∪ b
await c.unionInto(all, []);   // `all` now holds a ∪ b ∪ c

// 0.10.0 — the same three calls leave `all` holding ONLY c
```

**Nothing throws.** There is no type error to catch it: the return type changed from `Promise<void>` to
`Promise<MaterializeResult>`, which is additive at every call site that ignored the result. A pipeline built
on the accumulate shape keeps running and quietly keeps only its last write.

**What to do instead.** Pass every operand to one call — `a.unionInto(all, [b, c])` — which is also the
cheaper shape, since it reads each operand once and publishes once. If the inputs arrive over time rather
than together, accumulate them upstream and `load()` the finished set; a segment changes by publishing a
whole new generation, which is the write model the rest of this release is built on.

This is the change the lede means by "one changes a default". It is the only one in this guide that a
`0.9.x` deployment can upgrade into without seeing an error.

### And they refuse an empty result

An empty combine used to add nothing, leaving the destination exactly as it was. Under the new publishing
model it would instead publish an empty generation over a destination that had data — so it refuses, the
same way `load()` always has:

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

## 7. Core exports only what it supports

`@cloudbitmaps/core`'s main entry went from **89 value exports in `0.9.0` to 82**. (The `[Unreleased]` changelog quotes 110 → 82; 110 was the count at an unreleased mid-cycle commit, not at any release.) It had accumulated the internals of
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
| `drainRegistry` · `validateMaxScanSegments` | compose the exported halves — see the recipe below. **`listSegments()` is not a drop-in**: it streams, so the bound is yours, and it yields `SegmentInfo`, which carries no `retention` |
| `DEFAULT_MAX_SCAN_SEGMENTS` · `DEFAULT_RETIRE_LIMIT` · `DEFAULT_TOMBSTONE_GRACE_MS` | the values are in the [API reference](docs/guide/api-reference.md); pass your own to `maxScanSegments` / `limit` / `tombstoneGraceMs` rather than reading ours |
| `CrbmWriter` · `CrbmWriterOptions` | none. Building a `.crbm` is the library's job; `CrbmReader` is still exported for tooling that inspects one |
| `chunkRefKey` | none. `segmentKey` is still exported |
| `joinId` | none. `splitId` is still exported, because it range-checks an id on the way |
| `BufferSink` | implement `BlobSink` — it is one method, `write(bytes)` |

### Replacing `drainRegistry`

```ts
import { collectWithinBudget, excludingReservedRows, resolveBudget, DEFAULT_BUDGET }
  from '@cloudbitmaps/roaring';

// Skip the reserved bookkeeping rows ONLY on an unscoped pass — a caller who names a namespace is asking
// for that namespace, including a reserved one. This is what `drainRegistry` did, and what `listSegments`
// still does.
const rows = namespace === undefined
  ? excludingReservedRows(registry.list())
  : registry.list(namespace);

// `resolveBudget` VALIDATES, which the raw object literal does not: a `maxRequests` of NaN would otherwise
// drain unbounded instead of throwing, and the ceiling is the whole property you are replacing.
const budget = resolveBudget({ maxRequests: 250_000 }, DEFAULT_BUDGET);

const drained = await collectWithinBudget(rows, budget, 'my-admin-pass');
```

Both halves matter. Forgetting `excludingReservedRows` makes a fleet-wide pass report the due index's own
pointer rows as segments; forgetting the budget removes the ceiling that was the entire point of the call you
are replacing.

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

## 8. Metric names, result fields and on-disk paths moved

The `cold` → `storage` rename is mostly a type-level change, and your compiler will find it. These are the
places it reaches past the type system — **strings and paths nothing type-checks**, so each one fails by
going quiet rather than by erroring.

### Observability strings

| `0.9.x` | `0.10.0` | what stays broken if you miss it |
|---|---|---|
| metric event `kind: 'cold.get'` | `'storage.get'` | a dashboard panel filtered on the old kind plots a flat zero |
| `CountingMetricsSink.snapshot().cold` | `.storage` | a counter read off the snapshot is `undefined`, which most charts render as 0 |
| `pricing.cold` (on a `PricingProfile`) | `pricing.storage` | a custom profile silently prices storage at zero |
| `CostReport`'s `coldBytes` | `storageBytes` | the bytes term drops out of your own cost arithmetic |
| `checkConsistency()` issue `'missing-cold-generation'` | `'missing-storage-generation'` | **an alert rule keyed to the old string matches nothing, which reads exactly like "no torn restores found"** |

The last one is worth a moment: a rule that stops matching looks identical to a rule that has nothing to
report. Grep your alert definitions, dashboard queries and runbook automation for `cold` before you upgrade,
not after.

### Local filesystem and CLI paths

| `0.9.x` | `0.10.0` | what to do |
|---|---|---|
| `new LocalFsStorage(root)` read `<root>/cold` | `<root>/storage` | rename the directory before switching. The `0.9.x` guide led with `./.cloudbitmaps/cold` |
| `export-segments` read `<CR_EXPORT_ROOT>/cold` | `<CR_EXPORT_ROOT>/storage` | same rename; the CLI refuses loudly if it finds nothing |

Both of these fail loudly — the constructor and the CLI each refuse a directory that is not there. The next
one does not.

### Segment names a filesystem cannot hold

The name grammar widened, and `LocalFsStorage` now escapes names that a filesystem would mangle: the Windows
device names (`con`, `nul`, `com1`–`com9`, `lpt1`–`lpt9`, in any case, with or without an extension) and any
name ending in `.` or a space.

If a `0.9.x` local store holds a segment with such a name, its bytes are still on disk under the old
spelling, and `0.10.0` looks for the escaped one. **The failure mode is silence, not an error:** `get()`
returns null, `list()` omits it, and every sweep skips it. Rename the directory to the escaped form, or
re-load the segment under a name outside that set. Object-store backends are unaffected — this is a
filesystem constraint, not a format one.

---

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
