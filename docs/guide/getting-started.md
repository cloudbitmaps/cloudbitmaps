# Getting started

> **These docs describe `main`.** The library is pre-1.0 and the API can still change. [The changelog](../../CHANGELOG.md#unreleased)
> lists what `main` has that the latest release does not, and the docs for each release are at its tag, on the
> [releases page](https://github.com/cloudbitmaps/cloudbitmaps/releases).

This is the 10-minute path: install, load a set into memory, keep it on disk, load real data, read it, and move
to a cloud bucket. Each step ends with a link to the page that goes deeper.

New to the words? [The words these docs use](#the-words-these-docs-use) is at the bottom of this page.

## Install

In a new folder, run `pnpm init` (or `npm init -y`), then:

```bash
pnpm add @cloudbitmaps/roaring              # the store; includes in-memory and local-disk backends
pnpm add @cloudbitmaps/s3                   # only when you move to S3 (or /gcs, or /azure-blob)
```

On npm 12 and pnpm 10 and later, allow `roaring`'s one install script first, or the install exits 0 and the package
throws at `import`. Put this in your `package.json`:

```json
{ "allowScripts": { "roaring": true }, "pnpm": { "onlyBuiltDependencies": ["roaring"] } }
```

npm 11 runs the script but warns until you allow it the same way; pnpm 9 needs nothing extra. `@cloudbitmaps/roaring` is the package you import from. `@cloudbitmaps/core` is the
engine underneath; it arrives on its own and you never install or import it.

The packages are **ES modules only and need Node 22.12 or later.** Use `import`. `require()` works too, on the same
Node versions: [CommonJS, Jest and TypeScript](#commonjs-jest-and-typescript) has the details.

If `import` fails with `Cannot find module './build/Release/roaring.node'`, see
[Troubleshooting](#cannot-find-module-buildreleaseroaringnode-after-a-successful-install).

## Your first segment, in memory

Save this as `first-run.mjs` (the `.mjs` extension lets it use top-level `await`) and run `node first-run.mjs`:

```js
import { CloudRoaring, MemoryStorage } from '@cloudbitmaps/roaring';

const store = new CloudRoaring({ storage: new MemoryStorage() });

// A load replaces a segment's contents with the ids you give it.
await store.load({ segment: 'shoppers' }, [5, 99_999, 1_234_567_890]);
await store.load({ segment: 'active' }, [5, 7, 1_234_567_890]);

const shoppers = store.segment('shoppers');
console.log(await shoppers.has(99_999)); // true
console.log(await shoppers.count()); // 3

const both = [];
for await (const id of shoppers.intersect([store.segment('active')])) both.push(id);
console.log(both); // [ 5, 1234567890 ]
```

The output is:

```
true
3
[ 5, 1234567890 ]
```

What happened:

- `MemoryStorage` is a **backend**: the object that decides where the data lives. This one lives in the process and
  is gone when it exits.
- `store.load(ref, ids)` wrote one immutable **generation** holding the whole set, then moved the segment's
  **pointer** to it. `{ segment: 'shoppers' }` is the **ref**: the name of the segment.
- Building a store does no I/O, so it is free to do in every job.
- `has`, `count` and `intersect` are reads. Ids are integers from 0 up to but not including 2³².

There is no `add` or `remove`. A segment changes only by loading a new generation, which replaces the old one. A
segment that was never loaded reads as empty (`has` is `false`, `count` is `0`), so there is nothing to create first.

## Keep it on disk

Swap the backend and the data survives a restart:

```js
import { CloudRoaring, LocalFsStorage } from '@cloudbitmaps/roaring';

const store = new CloudRoaring({ storage: new LocalFsStorage('./.cloudbitmaps') });
await store.load({ segment: 'active-this-week' }, [1, 2, 3]);
// A new process that opens the same folder reads the same set.
```

`LocalFsStorage` is for one process on one folder: two processes on the same folder do not protect each other from
writing at once. Use it for a laptop, a test or a single CI job. For anything shared, use a bucket.

Names keep their case, but a case-insensitive filesystem (the macOS and Windows default) would open one file for
`TenantA` and `tenanta`. `LocalFsStorage` compares the name it finds on disk exactly, so there a name in another case
reads as absent, and a load that would write beside an existing case variant fails with a `ValidationError` that says
so. The on-disk layout does not change, and a case-sensitive filesystem pays nothing for the check. A name is also
refused, before anything is written, when a file name derived from it (the segment, its generation and the temp file's
suffix, or the namespace directory) would pass the 255 bytes filesystems allow: about 207 characters of segment name.

## Load real data

A load is one call. Give it any iterable of ids, in any order, with duplicates allowed. It can be an array, a
generator, or a stream from your warehouse:

```js
import { CloudRoaring, MemoryStorage } from '@cloudbitmaps/roaring';

const store = new CloudRoaring({ storage: new MemoryStorage() });

// Your function: yields the user ids your warehouse query returns.
async function* idsFromWarehouse() {
  for (const id of [11, 12, 13]) yield id;
}

const result = await store.load({ segment: 'audience:active' }, idsFromWarehouse(), {
  guard: { minRetained: 0.5 }, // refuse a load that would drop more than half the segment
});

if (!result.published) {
  console.warn(`load refused: ${result.reason} (${result.cardinalityBefore} -> ${result.cardinality})`);
}
```

Three things to know:

- **Branch on `published`.** A load replaces the segment, so an upstream query that returns too little is a shrink
  nobody asked for. A refusal is reported in the result, not thrown, so a result you ignore is a load that did
  nothing. The `guard` says what counts as too little; an empty result over a non-empty segment is always
  refused unless you pass `allowEmpty: true`. The reasons are listed in
  [Loading in depth](loading.md#when-a-load-is-refused).
- **A load is a batch job, not a request handler.** It holds the whole set in memory and uses a core for a moment.
  Run it from a scheduled job, a queue consumer or a short-lived container, and keep the request path for reads.
- **There is no `create`.** `store.exists({ segment })` answers "has this segment been loaded?" with one registry
  read, and `store.segments()` lists what the registry holds. Do not keep your own list of names.

Rolling back, how many old generations to keep and the other things a load does are in
[Loading in depth](loading.md).

## Read it

Add this to the end of `first-run.mjs`:

```js
// Continues first-run.mjs: store and shoppers are from there. Load the suppression list first:
await store.load({ namespace: 'suppression', segment: 'global-opt-out' }, [7]);

const active = store.segment('active');
const optedOut = store.segment('global-opt-out', { namespace: 'suppression' });

await shoppers.has(5); // true or false: fetches one chunk
await shoppers.count(); // the exact size, from the registry row; fetches no data

for await (const id of shoppers.iterate()) {
  // every id, ascending
}

// ids in both segments; fetches only the chunks both could contain
for await (const id of shoppers.intersect([active])) {
  // ...
}

// ids in either, and ids in this one but not the other
for await (const id of shoppers.union([active])) {
  // ...
}
for await (const id of shoppers.andNot([optedOut])) {
  // ...
}

// the intersection minus a suppression list, in one pass
for await (const id of shoppers.intersect([active], { exclude: [optedOut] })) {
  // ...
}

// write the result as a new generation of another segment
const saved = await shoppers.intersectInto(store.segment('campaign-targets'), [active]);
console.log(saved.cardinality); // how many ids the new generation holds
```

Every segment a combine reads has to exist: the one you call it on, every operand and every `exclude`. A combine
throws `ValidationError` for a name that does not, so a mistyped suppression list cannot silently suppress nobody;
pass `allowAbsentOperands: true` when one may legitimately not exist yet. A direct read is different: `has`, `count`
and `iterate` of a segment that was never loaded answer empty. Every option, and the exact meaning of each verb,
is in the [segment verbs table](api-reference.md#the-segment-verbs-the-90-of-daily-use). How soon a reader sees a
new load, and how to read one fixed point in time, are in [Reading in depth](reading.md).

`intersect` streams ids and holds only a small window of data in memory, so it runs over very large segments in a
small or serverless process. Suppress with `exclude` instead of chaining: chaining writes an intermediate segment
and reads the suppression list in full.

### Coming from Redis bitmaps?

**This is a durable, cloud-native home for *set-shaped* data** — audiences, suppression lists, membership,
eligibility — where the sets are large, mostly read, have to survive a restart, and are **computed in batches**
upstream. It does that without an always-on cluster or a VPC for your functions.

**It is not a drop-in replacement, and the difference is the write model.** Redis mutates one bit in place per
call; here a segment changes only by getting a **new generation** — you compute the set, load it, and read it.
There is no per-id write at all, so a `SETBIT` loop has nothing to port to. If your set is defined by a query,
run the query and load the result. If it is defined by events arriving one at a time, accumulate them in the
system that receives them (Redis does that well) and load the set on a cadence.

The *read* side carries over one-for-one:

| Redis | Here | Difference |
|---|---|---|
| `GETBIT key id` | `has(id)` | none in meaning — an id is a bit offset, both `u32` |
| `BITCOUNT key` | `count()` | exact, and served from the registry row's summary (else the index) without fetching payloads |
| `BITOP AND dst a b` | `a.intersect([b])` / `a.intersectInto(dst, [b])` | streams, and skips chunks that cannot contribute; `dst` becomes a new generation |
| `BITOP OR dst a b` | `a.union([b])` / `unionInto` | none in meaning |
| `BITOP DIFF dst a b` (Redis 8.2+) | `a.andNot([b])` / `andNotInto` | none in meaning; reads `b` only where it overlaps `a` |
| `BITOP ANDOR dst x y1 y2` (Redis 8.2+) | `store.materializeMany` with `expr: { and: ['x', { or: ['y1', 'y2'] }] }` | one pass, no temp segment; one call can write many such outputs ([many outputs from one pass](loading.md#many-outputs-from-one-pass-materializemany)) |
| `BITOP XOR` | `store.materializeMany` with `expr: { andNot: [{ or: ['a', 'b'] }, { and: ['a', 'b'] }] }` | one pass: `(a ∪ b) \ (a ∩ b)`, written to a segment |
| `BITOP NOT` · `BITOP ONE` | — | no equivalent |
| `SETBIT key id 1` / `SETBIT key id 0` | — | **no per-id write.** Build the set upstream and `store.load()` it; remove one id everywhere with `eraseSubject` (a rewrite, for compliance — not a hot-path verb) |
| `EXPIRE key seconds` | `store.setRetention(ref, { expiresAt })` + `store.retireExpired()` | per **segment**, never per id (a bitmap stores ids, not timestamps), and the sweep is **yours to schedule** — this library starts no timer, so it behaves the same in a Lambda and a server. [retention](retention.md#retention-ttl-and-pruning--what-exists-and-what-doesnt) |

You are not giving up the bitmap: each 65,536-id chunk is stored in whichever of Roaring's three encodings is
smallest for that chunk. Past **4,096 ids** in a chunk (6.25% of it), a flat bit array beats a sorted list of ids.
That is a bit per id, as your Redis bitmap holds it. If the ids form runs, a run encoding is smaller still: a
contiguous range costs a few bytes a chunk. So the bit array is chosen per chunk instead of assumed for all of them,
and below that threshold you stop paying for the empty span.

It is the same bitmap but not the same bytes. Redis numbers a byte's bits from the most significant, and Roaring
numbers them from the least significant, in 64-bit words.

**What does not carry over: the raw bytes.** A `.crbm` object is not a flat bit array. Anything that reads
your Redis bitmap's underlying string will not read ours: a job that `GET`s the key and indexes into it, a
byte-for-byte backup, another service that already parses that layout. `BITFIELD`, `BITPOS`, and the byte-range
forms of `BITCOUNT` have no equivalent either: this is a set of ids, not an addressable bit buffer. `BITOP NOT` in
particular has nothing to complement against, because there is no bounded universe here, only the `u32` id space. Import from Redis's raw bit layout (the migration direction off Redis), and export to it, are not built; whether
they get built depends on someone saying they need them. [`exportSegments`](export.md) writes portable Roaring and ndjson, not that layout. Everything reached through bitmap *operations*
transfers today; everything reached through the bytes does not.

## Move to S3, GCS or Azure

Install the storage package for your cloud and swap the backend. Nothing else in your code changes:

```js
import { CloudRoaring } from '@cloudbitmaps/roaring';
import { S3Storage } from '@cloudbitmaps/s3';

const store = new CloudRoaring({
  storage: new S3Storage({ bucket: 'my-bitmaps', prefix: 'cloudbitmaps', region: 'us-east-1' }),
});
```

```js
import { GcsStorage } from '@cloudbitmaps/gcs';
const storage = new GcsStorage({ bucket: 'my-bitmaps', prefix: 'cloudbitmaps' });
```

```js
import { AzureBlobStorage } from '@cloudbitmaps/azure-blob';
const storage = new AzureBlobStorage({
  connectionString: process.env.AZURE_STORAGE_CONNECTION_STRING,
  container: 'bitmaps',
  prefix: 'cloudbitmaps',
});
```

One bucket (or container) and one prefix is the whole deployment: the generations, the pointers and the wrapped
keys of encrypted segments all live there. There is no second service to run.

- **The credentials need five S3 actions**, `s3:ListBucket` among them: [Permissions](production.md#permissions) lists them, and which resource each one goes on.
- **S3 needs a service that honors conditional writes** (`If-None-Match: *` and `If-Match`): AWS S3, and MinIO,
  which the test suite runs against. Another S3-compatible service must honor both headers, or a write-once
  generation can be overwritten without an error. Check yours.
- **If you pass your own `client`, use `@aws-sdk/client-s3` 3.700.0 or later.** Older versions drop a conditional
  header they do not model, without an error: they overwrite an existing object, which loses a published generation,
  or send the registry's compare-and-swap unconditionally. If your own code imports the SDK, to build that `client`, add it to your own `package.json` too: pnpm does not let your code import a dependency of a dependency. `S3Storage` builds its own client from the usual credential chain when you do not pass one.
- **GCS and Azure Blob** pass the same conformance suites as S3 and sit outside the validated envelope, which covers
  S3 storage only. They are the right choice if you are on that cloud, but you are an early user. The
  [roadmap](../ROADMAP.md#the-validated-envelope--whats-proven-and-what-isnt) states the exact claim.
- The options every backend takes, and the option tables per cloud, are in the
  [API reference](api-reference.md#build-a-store--new-cloudroaringoptions).

## Before production

Moving from a first run to a deployment that other people depend on takes a short checklist: permissions, a bucket
lifecycle rule, client timeouts, a load schedule, backups. [Before production](production.md) is that checklist,
one row per item, each linking to the detail.

## When something goes wrong

- **An error from the library.** Every error says whether to fix your call, retry, or look at the data. The
  [errors table](api-reference.md#errors-typed--you-catch-these) lists each one with what to do.
- **A load returned `published: false`.** Read `result.reason`:
  [when a load is refused](loading.md#when-a-load-is-refused).
- **The install or the first `import` fails**, or Node prints a deprecation warning: see
  [Troubleshooting](#troubleshooting) below.
- **Timeouts and retries.** <a id="6-reliability-retries-backoff--timeouts"></a>Reads retry by themselves, and a write is
  retried only where that is safe, so a fault it does not settle is yours to re-run: [Reliability](production.md#reliability-retries-backoff--timeouts).
- **Expiring data.** <a id="135-retention-ttl-and-pruning--what-exists-and-what-doesnt"></a>There is no per-id
  expiry: [Retention](retention.md#retention-ttl-and-pruning--what-exists-and-what-doesnt).

## Troubleshooting

### `Cannot find module './build/Release/roaring.node'` after a successful install

The install **exits 0** and the package is then unusable at runtime. Two ways to get here — and on **pnpm 10
the plain install is one of them**, with no flag of your own:

```
$ npm i @cloudbitmaps/roaring             # npm 12+: warns that roaring's install script was blocked, exits 0
$ pnpm add @cloudbitmaps/roaring          # pnpm 10+: warns "Ignored build scripts: roaring", exits 0
$ npm i --ignore-scripts @cloudbitmaps/roaring    # any client, when you opt out of scripts
$ node -e "require('@cloudbitmaps/roaring')"
Error: Cannot find module './build/Release/roaring.node'
```

**npm 12 and pnpm 10 do not run a dependency's install script unless you allow it** — a deliberate supply-chain
default, not a bug — so on them the *documented* install command needs a second step. npm 11 runs it and warns
that `allowScripts` does not cover it yet; pnpm 9 runs it; every client skips it under `--ignore-scripts`.

**Why.** The native dependency `roaring` publishes an npm tarball containing **no** compiled binary; it ships an
`install` script that downloads the right prebuilt binary for your platform from GitHub Releases. Skip install
scripts and that download never happens, so there is nothing for the addon loader to find. The client reports
success because the *install* did succeed — only the post-install step was skipped.

**Fixes, in order of preference:**

1. **Allow the install script for that one package** — narrow the exception rather than re-enabling scripts
   globally. Put it in your own `package.json` so CI and teammates inherit it; the first key is npm's, the second
   pnpm's:

   ```json
   { "allowScripts": { "roaring": true }, "pnpm": { "onlyBuiltDependencies": ["roaring"] } }
   ```

   `npm install-scripts approve roaring` (npm 12) and `pnpm approve-builds` do the same interactively; npm's
   records the approval pinned to the installed `roaring` version.
2. **Then re-run the skipped step** — `npm rebuild roaring` or `pnpm rebuild roaring`. The allowance above has
   to be in place **first**: without it, both exit 0 and leave the package just as broken, because rebuilding
   still runs an install script the client still will not run. npm 12 at least warns that it blocked one; pnpm's
   `pnpm rebuild roaring` is a **silent no-op**. An approval made with `npm install-scripts approve roaring` runs
   nothing by itself, so the rebuild is what fetches the binary.
3. **Build from source** — `npm_config_build_from_source=true npm i` with a C/C++ toolchain present. Also the
   route on **Alpine/musl**, where no prebuilt binary is published at all.

**Check it at install time, not at 3am.** Because no client's exit code tells you about this, add a startup or CI
assertion that the addon actually loads — `node -e "require('@cloudbitmaps/roaring')"` — so a broken install
fails your pipeline instead of your first request.

### `DEP0169 DeprecationWarning: url.parse() behavior is not standardized`

A normal install does not print this: Node 22 prints it only under `--pending-deprecation`, and Node 24 only when the code calling `url.parse()` is not under a `node_modules` path, as in a bundle. Where it does appear, it is on stderr, the first time the package is loaded:

```
(node:1234) [DEP0169] DeprecationWarning: `url.parse()` behavior is not standardized and prone to errors
  at node_modules/@mapbox/node-pre-gyp/lib/util/versioning.js:338
  at node_modules/roaring/index.js:32
```

**Nothing is wrong, and it is not CloudBitmaps code.** The chain is `@cloudbitmaps/roaring` → `roaring` (the
CRoaring binding, the only native code involved) → `@mapbox/node-pre-gyp`, which locates the prebuilt binary for
your platform. Finding it also computes the URL the binary *would* be downloaded from, using Node's legacy
`url.resolve()`; that URL is then discarded, because the binary is already installed. So the warning is emitted
for a computation whose result is never used.

Specifics, so you can decide whether to care:

- **Emitted once per process**, on **stderr**, and the process exits normally.
- **Building from source does not avoid it.** `roaring` calls node-pre-gyp's lookup first and only falls back to
  a locally-built binary if that throws `MODULE_NOT_FOUND`, so the lookup — and the warning — happens either way.
- **It is not a stale dependency.** `@mapbox/node-pre-gyp` is at its latest published version; there is no
  upgrade that removes this. The real fix is upstream in `roaring`, migrating to a resolver that reads the
  filesystem without constructing URLs. Nothing in CloudBitmaps calls `url.parse()`.
- **Security:** the inputs are `roaring`'s own `package.json` fields, not runtime or user-controlled data, and no
  network request happens at load. The vulnerability class that motivated this deprecation — trusting a host
  parsed out of untrusted input — does not apply here.

**The one case where it actually matters.** Where the warning is printed and you run Node with **`--throw-deprecation`**, warnings become
thrown errors and **your process will exit non-zero**. The import itself still succeeds — deprecation warnings
are emitted asynchronously, so the throw lands after the module has loaded — but the process dies. If you use
that flag, either drop it for the process that loads CloudBitmaps or allow this one deprecation.

**What not to do:** `--no-deprecation` silences *every* deprecation warning in your application, including ones
about your own code. Suppressing a whole diagnostic channel to hide one known-benign line is a bad trade.

### CommonJS, Jest and TypeScript

- `require('@cloudbitmaps/roaring')` works on Node 22.12 and later through Node's `require(esm)`, which is why the
  floor is 22.12 and not 22 (22.11 throws `ERR_REQUIRE_ESM`). On 22.12 exactly you also see an
  `ExperimentalWarning`; it is gone by Node 24. Bundlers are unaffected: esbuild, webpack, rollup and Vite were
  verified, emitting CommonJS as well as ESM.
- A loader that is not Node's own does not get `require(esm)`. **Jest** in its default configuration fails with
  `Must use import to load ES Module`: use Jest's ESM support (`--experimental-vm-modules`) or `import` the
  package. **Yarn PnP** throws `ERR_REQUIRE_ESM` on any Node version: `import` the package, or use
  `nodeLinker: node-modules`.
- A `.ts` file in a CommonJS package needs `"module": "nodenext"` or `"node20"`. `node16` and `node18` report
  `TS1479` on the import. A project on `moduleResolution: bundler` is unaffected.
- On Alpine (musl) there is no prebuilt `roaring` binary, so the install compiles it: add a toolchain first
  (`apk add --no-cache build-base python3`) or use a glibc image such as `node:22-slim`.

## The words these docs use

| Word | What it means |
|---|---|
| **segment** | A named set of integer ids. You load it, then read it. |
| **generation** | One immutable file that holds a whole segment at one point in time. A load writes a new one; nothing is ever edited in place. |
| **pointer** | The small record that names a segment's current generation. Moving it is what makes a load visible. |
| **registry** | The place the pointers live: one small row per segment, in the same bucket as the data. |
| **backend** | What you pass as `storage`: `MemoryStorage`, `LocalFsStorage`, `S3Storage`, `GcsStorage` or `AzureBlobStorage`. It decides where generations and pointers live. |
| **namespace** | An optional group name for segments, such as a tenant. `{ namespace: 'eu', segment: 'active' }` is a different segment from `{ segment: 'active' }`. |
| **ref** | The object that names a segment: `{ segment: 'active' }` or `{ namespace, segment }`. |
| **chunk** | A block of up to 65,536 consecutive ids inside a generation. Reads fetch only the chunks they need. |
| **cardinality** | How many ids a set holds. |
| **guard** | The `guard` option of a load, such as `{ minRetained: 0.5 }`, or `{ maxGrowth: 1.5 }` for the other direction: it refuses a result smaller or larger than you allow instead of publishing it. Without one, a load still refuses an empty result over a non-empty segment. |
| **keep** | How many old generations a load leaves behind for readers still using them. The default, `1`, is right for almost everyone. |
| **operand** | A segment you combine with another: in `a.intersect([b])`, `b` is an operand. |
| **exclude** | A segment whose ids are removed from the result of a combine, in the same pass. |
| **combine** | `intersect`, `union` or `andNot`: a read that combines a segment with others. Each has an `*Into` twin that writes the result as a new generation of another segment, and `store.materializeMany` writes many such results, each an expression over named operands, in one pass. |
| **collect** | Delete old generations that a newer one has superseded. A load does it as its last step and leaves `keep` of them. |
| **`cache.genTtlMs`** | How long a reader may keep serving the generation it has before it checks for a newer one: 2 s by default. See [how soon a reader sees a new load](reading.md#how-soon-a-reader-sees-a-new-load). |
| **sweep** | `store.retireExpired()`, which you schedule: it retires the segments whose recorded expiry has passed. |
| **dry run** | `dryRun: true` on `materializeMany`, `dropSegment` or `retireExpired`: the call reads what it would read and reports what it would do, and writes nothing. |
| **pin** | `segment.pin()` returns a handle that keeps reading the generation that was current when you pinned it. |
| **tombstone** | The row a dropped or crypto-shredded segment leaves behind, marking it as gone. |
| **token** | An opaque value the registry row carries. Every write to the row changes it, so a write can tell whether the row moved since it read it. |
| **`pointerId`** | The token of the last write that changed what a reader resolves from the row: its generation, its status, its keys or its summary. A reader keys what it caches on the generation with it, so a lease or a retention write leaves its caches warm. |
| **fence** | A write that names the generation and token it expects to replace, and is refused if either moved. Loads do this for you. |

## Where next

- [Before production](production.md): the checklist.
- [Loading in depth](loading.md) and [Reading in depth](reading.md).
- [The guide index](README.md): retention, encryption, erasure, observability, export and disaster recovery.
- [API reference](api-reference.md): every export, kept in sync with the code by CI.
- [Roadmap](../ROADMAP.md): what is shipped, the **validated envelope** (what is proven and what is not), and the
  path to `1.0`.
