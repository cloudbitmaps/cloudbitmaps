# Before production

A first run on `MemoryStorage` needs none of this. A deployment that other people depend on does. This page is the
checklist: work down the table, and follow each link for the detail.

| Check | Why it matters | Where |
|---|---|---|
| `await store.preflight()` passes on a first run: every check is `ok`, or each `unchecked` one has been checked by hand | It finds a missing permission, a storage that overwrites and a lagging listing before the first load, and a lifecycle rule where the backend can read the rules. `ok` does not vouch for an `unchecked` check, and `lifecycle` is `unchecked` under the documented permissions | [Check the setup](#check-the-setup-with-storepreflight) |
| Permissions are granted for the actions the library issues | A missing action fails a load or, on S3, turns a missing pointer into a `403`. Checked by `store.preflight()`, except `s3:AbortMultipartUpload` | [Permissions](#permissions) |
| An abort rule for incomplete uploads is on the bucket | A killed process leaves multipart parts that are billed but invisible | [Bucket lifecycle](#bucket-lifecycle) |
| Nothing expires current objects or the `registry/` prefix | An expired pointer or generation makes a live segment unreadable. Checked by `store.preflight()` where the backend can read the rules and the identity may (otherwise its `lifecycle` check is `unchecked`: look yourself) | [Bucket lifecycle](#bucket-lifecycle) |
| Versioning and backups cover the data and the pointers | A restore must bring both back to the same point in time | [Versioning and backups](#versioning-and-backups) |
| With versioning on, noncurrent versions expire after your restore window | Each generation a load collects is otherwise billed for as long as the bucket keeps it, out of sight | [Bucket lifecycle](#bucket-lifecycle) |
| The bucket honors conditional writes and is strongly consistent, and the S3 SDK is 3.700.0 or later | Otherwise a write-once generation can be silently overwritten, and a check that a delete landed can be wrong. `store.preflight()` checks that a second write is refused and that a read and a listing see a write, not the registry's `If-Match` or a read after a delete | [Conditional writes and the S3 SDK](#conditional-writes-and-the-s3-sdk) |
| Your reads have a timeout | Without one a hung request hangs its call. `readTimeoutMs` on `S3Storage`, `GcsStorage` and `AzureBlobStorage` bounds each read, and is off by default. It is the only bound on a GCS 8.x or Azure Blob download's body, which no client setting reaches. The library times no write, delete or listing, and times the [lifecycle check](#check-the-lifecycle-rules-from-code)'s one read only when `readTimeoutMs` is set: at the default of `0` that read is untimed, and `store.preflight()` gives up on it after 30 seconds | [Reliability](#reliability-retries-backoff--timeouts) |
| Your job re-runs a write after a transient error | A write is sent again for you only where that is safe: a [throttled S3 or GCS object](correctness.md#object-write-resent), and the registry write of a `load`, an `*Into` verb, an erasure's rewrite or an erasure's write to the row when the row shows it did not land. Every other write that gets no answer is [settled by reading back](correctness.md#row-write-settled) its row or its object, and one that landed is reported as landed ([what each settles](correctness.md#settle-by-read-back)). A `TransientError` reaches you for a write the read-back shows did not land, when the read-back failed too, or on a registry that reports no write tokens, which reads nothing back: run the call again. | [Reliability](#reliability-retries-backoff--timeouts) |
| You know the request budget and the memory ceilings | A runaway call is refused, not billed | [Limits](#limits-the-per-op-budget-and-the-memory-ceilings) |
| The keystore is backed up, if you encrypt | Losing the key makes the data permanently unreadable | [Encryption](encryption.md#before-you-encrypt) |
| Metrics and audit sinks are wired to your stack | Both are off by default | [Observability](observability.md) |
| Loads and the retention sweep are scheduled | Nothing in the library runs on a timer | [Schedule the work](#schedule-the-work) |
| Loads run off the request path, on a Node runtime | A load uses a core and, unless its ids come sorted (`sorted: true`), holds a whole segment in memory | [Where to run it](#what-blocks-the-event-loop-and-where-to-run-it) |

## Check the setup with `store.preflight()`

Run it once on a first run or at deploy time, before the first load, under the identity the store will run with:

<!-- typecheck-skip: a fragment: the page leaves `CloudRoaring`, `S3Storage` to the reader -->
```ts
const store = new CloudRoaring({ storage: new S3Storage({ bucket: 'bitmaps', prefix: 'cr' }) });
const report = await store.preflight();
for (const c of report.checks) if (c.status !== 'ok') console.log(`${c.name}: ${c.status}: ${c.detail}`);
// Exit on both branches: after its 30 s give-up the lifecycle request may still be running, and would hold the process open.
process.exit(report.ok ? 0 : 1);
```

```
 registry ─► write ─► write-once ─► read ─► list ─► delete ─► lifecycle
   get the    new      same key      read    list   remove     the backend's
   probe row  object   again must    back    names  its own    checkLifecycle()
   (absent)   A        be refused    A       it     object     (30 s bound)
```

The answer is `{ ok, checks }`. `checks` always holds all seven, in the order above, each as `{ name, status, detail }`,
and `ok` is true when no check is a `problem`. `status` is `ok`, `problem` or `unchecked`; read an `unchecked` check
yourself, since `ok` does not vouch for it. `detail` is a sentence for a person: what was found and what to do, and for
a failed step the error's name and message.

| Check | What it does | It is a `problem` when |
|---|---|---|
| `registry` | One read of the probe's registry row, and a look at whether the registry can write | The read fails (no permission, a missing bucket); a row exists at the probe's address; the registry reads but cannot write in this runtime |
| `write` | Writes a small new object, the probe | The write fails |
| `write-once` | Writes the same key again | The second write succeeds, so the storage can overwrite a generation (an S3 SDK of 3.640.0 or older, which drops `If-None-Match`, shows up here); or it fails for a reason other than the key existing |
| `read` | Reads the object back | It is missing right after the write, or its bytes or size differ |
| `list` | Lists the probe's segment | The listing does not name the probe, so a listing lags a write |
| `delete` | Deletes the run's own object, with the version the read gave where the driver applies one | The delete fails: the detail names the object, which is left behind |
| `lifecycle` | Calls the backend's [`checkLifecycle()`](#check-the-lifecycle-rules-from-code) | A rule would delete or archive the store's objects. It is `unchecked`, and `ok` stays true, when the identity lacks the two optional permissions (`s3:GetLifecycleConfiguration` on S3, `storage.buckets.get` on GCS: [neither is in the documented grants](#permissions), so this is the commonest reason); always on Azure Blob; for a backend without the check, such as a third-party one or a `brandAsBackend` wrapper that does not forward it; and when the check does not answer within 30 seconds (the fixed bound, counted on the store's clock), with the advice to run it again |

**It never throws over a finding.** A step that fails, a transient fault included, is a `problem`, and for a transient
fault the detail says to run `preflight()` again. The exception is the lifecycle step, whose failures, its timeout
included, are `unchecked`. A step whose answer another needs makes that one `unchecked`: if the write fails,
`write-once`, `read`, `list` and `delete` are `unchecked`. Nothing a step meets escapes: an error or a verdict that
cannot be read, a clock that fails, an entropy source that throws (that is a `write` problem naming it: only `registry` and `lifecycle` still run, and
the other four are `unchecked`). The one throw is a store with no backend (a store built on a bare driver or a source of your own),
which has nothing to check: `UnsupportedError`. `preflight()` takes no options.

**The probe** is one object of about 30 bytes, at `cbm.due.preflight/segments/probe.<number>.crbm` under the store's
prefix, where `<number>` is 48 random bits. That namespace is inside the reserved `cbm.due.` prefix, which no
application ref can name, so the probe can never be one of your segments, and no registry row is written. No scan,
sweep, erasure, export or collection reads a probe object or row as a segment. A run's cleanup deletes only its own key,
by version where the driver applies one. The probe sits at `<prefix>cbm.due.preflight/`, outside the namespaces your application uses. The documented grant over everything under the prefix covers it, but a grant scoped per namespace, narrower than that, does not: it shows as a `write` problem for a store that loads fine, and as a `registry` problem too when the registry grant is scoped per namespace (the probe row's read at `<prefix>registry/cbm.due.preflight/probe.reg` is refused). A step's `detail` carries the error's name and message, cut to a length, as the driver raised it, so on `LocalFsStorage` an
`EACCES` names a host path under the store's root. A step that reads `no object was written` ran after a failed write,
which is not proof that none landed: a write that lost its response may have stored an object. After a failed write the
run deletes its key in case the write landed, except after a conflict, where the object under the key is another
run's and is left alone; so a later run's `list` names the object only when that delete failed or the write landed
after it. A probe that another run left (cut off, or still running) is named in the
`list` detail and not deleted, since it could be a run in progress (the one exception is a probe left at the same 48-bit
number, which another run's cleanup can remove); delete it by hand if no run is. On `LocalFsStorage`
the probe really is a file, and a run leaves two empty directories behind.

**What it costs.** About seven requests: the registry read, two writes, a tail read, a listing, a delete and the
lifecycle request (S3 and GCS; Azure Blob spends none on the lifecycle and one more on each of the second write and the
tail read, so eight). GCS adds one listing the first time a driver sees a missing row, which the probe's row always is on a first run, so a first run on GCS is eight, the eighth being a second listing (the check that the bucket exists). About $0.000016 a run on S3 (derived from the cost model's prices: three PUT-class and three GET-class requests; the seventh, the DELETE, is free).
`MemoryStorage` and `LocalFsStorage` make no network request.

**Timing.** The lifecycle step is the only one with a bound of its own, because the drivers' `readTimeoutMs` defaults to
none: after 30 seconds of the store's clock it stops waiting and the check is `unchecked`. The other steps are the store's
ordinary calls and keep their timing, so one that hangs hangs the call. `readTimeoutMs` bounds the registry read and the
tail read; the two writes, the listing and the delete are untimed by the library, so bounding them takes a timeout on
your client. The request the lifecycle step gave up on is not cancelled: at the default `readTimeoutMs` of `0` it runs on
untimed and can hold a process open, so a deploy script exits explicitly once it has read the result, as the example does,
on both branches.

### What preflight does not check

So check it another way: a read after a delete (the listing proves a write, not a delete); the registry's `If-Match` on
compare-and-swap; the multipart abort permission (`s3:AbortMultipartUpload`); versioning and backups; the keystore and
its backup, which a first load fails early and typed on; and an S3 SDK from 3.641.0 to 3.699.0. An SDK of 3.640.0 or
older drops `If-None-Match`, which shows as a `write-once` problem. One from 3.641.0 to 3.699.0 keeps `If-None-Match` but drops `If-Match` on
`PutObject`, which the registry's compare-and-swap needs; preflight cannot see that, because its registry check
only reads and only a registry write refuses such an SDK. An SDK from 3.641.0 to 3.697.0 also drops `If-Match` on `DeleteObject`,
which turns the conditional delete off without a word. So the 3.700.0 floor stays yours to check.
[Permissions](#permissions), [Conditional writes and the S3 SDK](#conditional-writes-and-the-s3-sdk) and [Versioning and
backups](#versioning-and-backups) cover the rest.

## Permissions

These lists are derived from the calls each storage package makes. Check them in staging under the identity you will
run with. A process that only reads can drop the write and delete actions.

**S3.** Five actions, on two resources:

| Resource | Actions |
|---|---|
| The bucket | `s3:ListBucket` |
| The objects under your `prefix` | `s3:GetObject` (also covers the metadata reads), `s3:PutObject` (also covers starting, uploading and completing a multipart upload), `s3:DeleteObject`, `s3:AbortMultipartUpload` |

In the policy, the bucket is the bucket's ARN, and the objects are that ARN followed by `/`, the `prefix` you pass to
`S3Storage`, and `/*`. `s3:ListBucket` matters even for readers: without it S3 answers a missing key with `403`
instead of `404`, and the library cannot list generations.

If the bucket encrypts with a KMS key, grant that key's use as well.

**GCS.** The library creates, reads, lists and deletes objects. `roles/storage.objectAdmin` on the bucket covers all
four; a custom role needs `storage.objects.create`, `storage.objects.get`, `storage.objects.list` and
`storage.objects.delete`. Credentials come from Application Default Credentials unless you pass a `client`.

**Azure Blob.** It writes blocks, commits block lists, reads blobs and their properties, lists and deletes. The
`Storage Blob Data Contributor` role on the container covers all of them. A connection string carries the account
key, which grants far more: prefer a `containerClient` built from a managed identity.

**Two optional permissions, for the identity that checks the lifecycle rules.** A load never needs them; `store.preflight()`'s
lifecycle step does use them. They are read-only reads of the bucket's configuration, and the identity that runs [`checkLifecycle()`](#check-the-lifecycle-rules-from-code),
normally the store's own, needs one more: on S3, `s3:GetLifecycleConfiguration` on the bucket; on GCS,
`storage.buckets.get` on the bucket, which `roles/storage.objectAdmin` does not include. Without it the check answers
`unchecked` and names the permission. Azure Blob has no such permission to grant: its lifecycle policy is read through Azure Resource Manager, not
by a blob client (see below).

**A bucket or container that does not exist** fails every call with a `ValidationError`, never reads as an empty store: a
misspelt or deleted bucket cannot answer `has` with `false` and `count` with `0`. On S3 a zero-length tail
(`getTail(key, 0)`) reads as a missing object, because S3 sends no error code on a HEAD; on GCS, see the two cases this
paragraph ends with. The error names the bucket or
container and says what to check (the name, and the region, endpoint, project or account the client is built for), and
carries the service's own error (`NoSuchBucket`, `ContainerNotFound`) as its `cause`. It is not a `NotFoundError`, which
a read answers by looking again, and a wiring fault does not heal. GCS answers a missing bucket and a missing object with the same `404`, so
the first time a GCS request answers `404` the driver lists one object in the bucket, which only a missing bucket can
answer with `404`, and remembers the bucket once it has seen it: one listing per driver for the life of the process.
A missing bucket then fails with `the GCS bucket does not exist: <bucket>; check ...`. An identity without
`storage.objects.list` is refused that listing, which says nothing about the bucket: for it, a `404` reads as a
missing object unless GCS's message says the bucket does not exist. A bucket deleted after the driver has seen it
reads as empty for the rest of the process, while every write to it fails.

## Bucket lifecycle

Two rules to add, and one to never add.

**Add: abort incomplete multipart uploads.** A large generation is written as a multipart upload. The library aborts
it on any error it survives to handle. It cannot abort one whose process no longer exists, so a killed container or
an out-of-memory exit leaves the parts behind. Those parts are billed and never appear in an object listing, so only
the bill will tell you. On S3, with a few days as the grace period:

```json
{
  "Rules": [
    {
      "ID": "abort-incomplete-multipart",
      "Status": "Enabled",
      "Filter": { "Prefix": "" },
      "AbortIncompleteMultipartUpload": { "DaysAfterInitiation": 3 }
    }
  ]
}
```

A sorted load (`sorted: true`) can fail after several parts have gone up, where an unsorted one refuses a bad id before
it uploads anything: its ids are read during the upload, so an error its source throws, or an id out of order, can come
late. The process survives that, so S3's upload is aborted and its parts are not billed past the abort, and a GCS
resumable session that never completes never becomes an object. Azure Blob has no call to discard staged blocks, so a
sorted load refused late on Azure leaves its blocks billed until Azure collects them, a week after the last one was
staged.

Applying a lifecycle configuration replaces the bucket's whole configuration, so merge this with any rules you have.
This rule is for S3. What a dead writer leaves on GCS and Azure Blob, and when each cloud removes it, is in [the backup checklist](disaster-recovery.md#backup-checklist).

**Add, if versioning is on: expire noncurrent versions.** With versioning on, every generation a load collects stays
in the bucket as a noncurrent version: billed, and absent from an ordinary listing. A rule that expires noncurrent
versions after a number of days removes them. A restore to a time `T` needs every object deleted since `T`, so those
days are also the oldest point you can restore to: set them at or above your restore window
([the backup checklist](disaster-recovery.md#backup-checklist)). On S3, as a second rule in the same configuration:

```json
{
  "ID": "expire-noncurrent-versions",
  "Status": "Enabled",
  "Filter": { "Prefix": "" },
  "NoncurrentVersionExpiration": { "NoncurrentDays": 30 }
}
```

**Add, if versioning is on: remove expired delete markers on the registry prefix.** Where the registry removes a row
(`conditionalDelete`), a delete in a versioned bucket leaves a delete marker, not an absence. Once the noncurrent
versions beneath it expire, the marker is all that is left of the name: one per name ever purged, which every listing
of the prefix steps over. A rule that removes expired delete markers is the last piece of the recipe, scoped to the
registry prefix (`<prefix>registry/` on a backend built with a `prefix`), as a third rule in the same configuration:

```json
{
  "ID": "expire-registry-delete-markers",
  "Status": "Enabled",
  "Filter": { "Prefix": "registry/" },
  "Expiration": { "ExpiredObjectDeleteMarker": true }
}
```

It cannot touch a live row: S3 removes a delete marker only when no version remains under it. A create over a delete
marker (`If-None-Match: *`) is one the registry makes whenever a purged name is loaded again, and the probe in
`tests/integration/real-cloud-conditional-delete.test.ts`, run against a versioned bucket, checks that S3 and GCS accept
it.

**Never: expire current objects.** No rule may delete current generations, and no rule may delete current versions
under the `registry/` prefix. A rule cannot tell a live row from a tombstone or from a due-index pointer, and an
expired live row is a pointer lost: every generation it named looks unreferenced. Where the registry removes a row
itself, it removes only the version it judged, by a conditional delete. A rule on noncurrent versions only is safe, and is the optional recipe in
[the disaster-recovery guide](disaster-recovery.md#optional-make-a-shred-durable-with-a-registry-expiry-rule).

### Check the lifecycle rules from code

A backend built by this library can read the bucket's lifecycle rules and say whether one would delete or archive what
the store keeps. `checkLifecycle` is optional on a `StorageBackend`, so on a value typed `StorageBackend` call it with
`?.`; on every backend this library ships (`S3Storage`, `GcsStorage`, `AzureBlobStorage`, `MemoryStorage` and
`LocalFsStorage`) it is always there:

<!-- typecheck-skip: a fragment: the page leaves `S3Storage` to the reader -->
```ts
const backend = new S3Storage({ bucket: 'bitmaps', prefix: 'cr' });
const verdict = await backend.checkLifecycle();
// { status: 'ok' | 'problem' | 'unchecked', detail: 'a sentence for a person' }
```

Application code needs no import for the result's type: it is inferred from the call, and `LifecycleVerdict` stays in
`@cloudbitmaps/core/driver-kit`, which application code does not import.

It never rejects, sends one request (plus the SDK's own retries), and keeps no state. Act on `status`; `detail` is for a
person and carries no credential. On S3 and GCS the request honours `readTimeoutMs`; a read that gets no answer in time is
`unchecked`, and the answer is to run the check again. On S3 the timeout cancels the request; on GCS the check stops
waiting but the request is not cancelled, and runs on until the server answers or closes it. A backend without the method (a third-party one, or a
`brandAsBackend` wrapper that does not forward it) offers no lifecycle check, and
[`store.preflight()`](#check-the-setup-with-storepreflight) reads that as `unchecked`.

| Status | Meaning |
|---|---|
| `ok` | No rule would delete or archive the store's current objects. `detail` may still carry advice, such as the abort rule below. |
| `problem` | A rule would. `detail` names it and says how to fix it: narrow it, or remove or retarget a rule that sits inside the store's prefix. |
| `unchecked` | The check could not be made: no permission, an error, or a backend whose rules are out of reach. `detail` says what to grant, or how to check by hand. |

What each backend does:

| Backend | What it reads | A `problem` is |
|---|---|---|
| S3 | `GetBucketLifecycleConfiguration` (one `GET`-class request), with `s3:GetLifecycleConfiguration` | An enabled rule (one with no `Status` counts as enabled) with no tag filter whose prefix and the store's are one a prefix of the other, and that expires current objects (`Days` or `Date`), moves them to `GLACIER` or `DEEP_ARCHIVE` (in any of its transitions, at `Days: 0` too), or moves them to a storage class the check does not know (it names the class). Rules that only expire noncurrent versions, remove expired delete markers or abort incomplete uploads are safe, and so are a disabled rule and a tag-filtered one (the store tags nothing). No configuration at all is `ok`. |
| GCS | The bucket's metadata (`lifecycle.rule`), with `storage.buckets.get` | A `Delete` rule, or one with an action the check does not know (it names the action) or none (`no action type`), that applies to live objects (not `isLive: false`, and not `numNewerVersions` of 1 or more, which a live object never meets, nor `daysSinceNoncurrentTime` or `noncurrentTimeBefore` at any value, which only a noncurrent version meets; a `numNewerVersions` of 0 matches every object) and whose `matchesPrefix` and `matchesSuffix`, if it has them, can match a name of the store's: a prefix and the store's are one a prefix of the other, and a suffix and `.crbm` or `.reg` are one a suffix of the other. `SetStorageClass` is safe, even to `ARCHIVE`, which stays readable. |
| Azure Blob | Nothing: always `unchecked`, with no request | Never. Lifecycle management policies belong to the storage account, on the management plane. `detail` gives the `az storage account management-policy show` command and what to look for: every enabled rule with a `baseBlob` `delete` or `tierToArchive` action must either have a `blobIndexMatch` filter or have a `prefixMatch` that overlaps nothing in `<container>/<prefix>` (a rule with no `prefixMatch` applies to every blob in the account, so it overlaps). |
| `MemoryStorage`, `LocalFsStorage` | Nothing | Never: always `ok`, there is no lifecycle. |

The store's prefix is the `prefix` you gave the backend. With none, the store may use any key in the bucket, so a rule on
any prefix counts, and the advice is to give the store a prefix or scope the rule away from its paths. **When a rule is
unclear the check says `problem`:** a condition it does not interpret (an S3 object size filter, a GCS storage class or
name pattern, an age) is judged as if it matched, so it can report a rule that would not act on the store's objects; it
does not hide one that would. The same goes for a value it does not know: an S3 rule with no `Status`, a transition to
a storage class it does not know, a GCS action it does not know. Fix such a rule by narrowing it, or confirm by hand that
it cannot match and leave it.

On GCS, any `403` on the bucket-metadata read gets the advice to grant `storage.buckets.get`, including a refusal that is
a billing or network-perimeter one, which that grant would not fix.

A `detail` is short whatever the bucket holds: it names at most 3 problem rules and then says "and N more", and cuts each
rule id, prefix and error name to 64 characters and an error message to 200.

**Advice is never a `problem`.** `detail` carries it whatever the status:

- On S3, when no rule over the store's generation keys (`<prefix>…/segments/`, not only `<prefix>registry/`) sets
  `AbortIncompleteMultipartUpload`, it says to add one. GCS and Azure Blob clean up an abandoned upload on their own,
  about a week on (see [the backup checklist](disaster-recovery.md#backup-checklist)), so they give no such advice.
  One rule on one namespace's keys counts, so the advice is left out for every namespace of the store: it does not say
  which namespace lacks a rule.
- On S3, a transition to `INTELLIGENT_TIERING` is safe by itself, but if the bucket turns on its archive access tiers
  (a separate configuration this check does not read), an object in one needs a restore before it can be read: leave
  them off for the store's prefix.
- On S3, a transition to `STANDARD_IA`, `ONEZONE_IA` or `GLACIER_IR` keeps objects readable, but each class has a minimum
  storage duration and a per-GB retrieval fee that the store's reads will pay.

## Versioning and backups

The data, the pointers and, if you encrypt, the keys are three separate stores, and a restore must bring them back
at the same point in time. [The disaster-recovery backup checklist](disaster-recovery.md#backup-checklist) says what
to turn on for each, and [`checkConsistency()`](disaster-recovery.md#checkconsistency--verify-before-you-serve-traffic)
verifies a restore before you serve traffic.

## Conditional writes and the S3 SDK

The library's guarantee that a generation is write-once rests on conditional writes: `If-None-Match: *` for a new
object and `If-Match` for the pointer.

- **The bucket must honor them.** AWS S3 does, and the test suite runs against MinIO. Another S3-compatible service
  that ignores the headers turns write-once into overwrite, so check yours before you depend on it. GCS and Azure
  Blob use their own equivalents (`ifGenerationMatch`; `If-None-Match` and `If-Match`).
- **The bucket must be strongly consistent.** A read or a listing made after a write or a delete returns must see it.
  A rollback takes a read of its target that succeeds as proof the object is there, and an erasure's check that no
  generation still holds the id, a drop's `generationsRemaining` and the retention sweep prove a delete by listing.
  AWS S3 is; check another S3-compatible service.
- **Use `@aws-sdk/client-s3` 3.700.0 or later if you pass your own `client`.** An SDK drops a conditional header it
  does not model, without an error. Measured against MinIO, 3.640.0 drops `If-None-Match` and silently overwrites an
  existing object, which loses a published generation; up to 3.699.0 the serializer drops `If-Match` on `PutObject`,
  so the registry's compare-and-swap goes out unconditionally. `@cloudbitmaps/s3` never resolves its own SDK below
  the floor. If your own code imports the SDK, to build that `client`, add it to your own `package.json` too: pnpm does not let your code import a dependency of a dependency.
- **The registry checks the SDK it is given for the headers it sends.** The floor above covers the compare-and-swap's
  `If-Match` on `PutObject` (3.700.0) and the conditional delete's on `DeleteObject` (3.698.0), and a `client` you pass,
  or an SDK your package manager pins, can still be older. Before its first request the registry serialises each of the
  three through a client built from yours, sending nothing and running none of your middleware. It refuses a write the SDK
  would send without its precondition (`ValidationError`, naming the header) and tombstones instead of deleting when a
  `DeleteObject` would go out without `If-Match`. If you see that error, upgrade `@aws-sdk/client-s3`.

## Reliability: retries, backoff & timeouts

**Reads retry by themselves.** Cloud storage throttles, returns 5xx and drops connections. Every read that answers a
query retries those transient faults with bounded exponential backoff and full jitter: `has`, `count`, `iterate`
and the combines (the `*Into` verbs' reads of their operands included), a pinned handle's reads, and `pin()` itself.
It is on by default.

<!-- typecheck: backend -->
```ts
import { CloudRoaring } from '@cloudbitmaps/roaring';

const store = new CloudRoaring({ storage: backend }); // reads already retry
```

Tune the policy, or turn it off. The policy is partial, so name only what you change; `onRetry` goes in the same group:

<!-- typecheck-skip: a fragment: the page leaves `CloudRoaring`, `backend`, `log` to the reader -->
```ts
const store = new CloudRoaring({
  storage: backend, // an S3Storage, GcsStorage, ...
  retry: {
    maxAttempts: 6,
    onRetry: ({ attempt, delayMs }) => log.warn({ attempt, delayMs }, 'retrying transient fault'),
  },
  // or `retry: false` when something else retries your reads (a GCS download is retried by the driver either way)
});
```

**On GCS the driver retries downloads, and the SDK does not.** In `@google-cloud/storage` 7.x and 8.x (checked on 7.22.0
and 8.1.0), a download the SDK retries after any status it retries (408, 429, 500, 502, 503 or 504) can crash the
process with `ERR_STREAM_UNABLE_TO_PIPE`, thrown outside any promise, even though the retried request succeeded. The
client `GcsStorage` builds sends each download once, and the driver runs it again itself, up to three more times with
backoff, after a connection fault (refused, reset, timed out, a DNS failure, a body cut off) or a 408, 429, 500, 502,
503 or 504, and after nothing else (not a missing credentials file or a TLS failure), so a download is retried whichever
call made it and whether or not the store's own `retry` is on. What still fails after those attempts is a
`TransientError`, which the store's read retry, above, can run again. The client's listings, deletes, resumable uploads
and the metadata read that settles a write keep its retry settings (under which the SDK sends a delete with no
precondition once); a single-request conditional write is sent without them. A client you pass as `client` keeps its own
retries for those requests: its downloads go through a twin of it, built from its own class with the same credentials
object, endpoint, project, user agent, timeout, checksum generator and interceptors and the SDK's retries off. The two
clients share one credentials object, so one token fetch serves both. The twin is built even for a client whose retries
are off, because the SDK turns a client's retries off while a delete or an upload with no precondition is in flight, so
that setting, read once, does not say how the client was built. A `Storage` client is always used through its twin,
which must have taken the settings that decide where and how a download goes: the same credentials object, URL and
endpoint, and retry settings of its own, which are then turned off over any its class set. The backend refuses, when it
is built, a client whose twin would not (a subclass that builds from options of its own), one whose class overrides
`bucket` (as a test double built on `Storage` does), and one whose `bucket` is replaced on the instance (as by a test
stub). Stub `Storage.prototype` (or `Bucket.prototype`, `File.prototype`) instead, which reaches the twin; a stub on the
client's instance does not. A test double that is not a `Storage` client is used as it is when it has
`retryOptions: { autoRetry: false }`, and refused without it; with the SDK's module mocked, pass the mock as `client`.
What is set on a client after the backend was built, other than an interceptor, is not carried to the twin.

**A GCS client's `timeout` does not bound a download** on `@google-cloud/storage` 8.x: the SDK hands it to an HTTP
client that has no such option. Measured against a local server that accepts a read and never answers, a read through
a client built with `timeout: 2000` was still pending after 12 s, and one through the default client after 75 s.
**`readTimeoutMs` on `GcsStorage` does bound it, and it is off unless you set it:**

<!-- typecheck -->
```ts
import { GcsStorage } from '@cloudbitmaps/gcs';

const backend = new GcsStorage({ bucket: 'my-bitmaps', readTimeoutMs: 2_000 });
```

It bounds each read the backend makes as a whole: a generation's tail (with the metadata read it falls back on for an
empty object), a range of it, and a registry row. One deadline covers every attempt the driver makes at the read and
the backoff between them, so `readTimeoutMs` bounds one driver read, its own retries included. The clock starts at the
call into the driver, so fetching or refreshing a credential counts, as does any wait for a socket (Node's agents set
no limit on sockets unless your process sets one), and it runs until the whole body has arrived, so a server that
sends its headers and then stalls is cut off too. It counts time the process spends busy too: Node runs a due timer
before it reads a socket, so a synchronous stretch longer than the timeout fails the reads in flight even when their
responses have arrived. When the deadline passes, the read throws `TransientError` naming the read and the timeout, no
further attempt starts, and the store's read retry, above, runs it again. With `readTimeoutMs: 2_000` and the default
retry policy, a read whose requests stall on every attempt fails after 4 × 2,000 ms of timeouts plus up to 350 ms of
backoff, about 8.35 s; measured against a local server that never answers, a `has()` failed after 8.1 to 8.2 s.
Uploads, deletes, listings and the conditional writes are not timed: an upload can rightly take longer than a read,
and a write cut off may still land. The one read of the [lifecycle check](#check-the-lifecycle-rules-from-code) on S3 and
GCS takes the same `readTimeoutMs`; with the default of `0` it is untimed, and one that gets no answer in time is
`unchecked`.

**What a timed-out read leaves open.** The SDK cannot cancel a request whose response has not begun, so when the
deadline passes before the server has answered, that request keeps its connection open until the server answers or
closes it, and until then it keeps a Node process from exiting. That is one request per driver read, and so up to four
per call through the store's read retry: measured against a local server that never answers, one `has()` left 4
requests open, 20 at once left 80, and a process whose read had timed out at 200 ms exited only when the server closed
its connection, 6 s later. A sustained outage at N reads a second therefore adds about 4N held connections each
second, until the server closes them. On `@google-cloud/storage` 8.x a read cut off after its response began closes
its own connection; on 7.x (checked on 7.22.0) it stays open as well, and without a timeout a body the server cuts off
part-way never settles. A 404 whose error body arrives after the deadline is reported as the timeout, a
`TransientError`, rather than as `NotFoundError`.

**The driver sends every download on Node's global agent**, timed or not, rather than on the SDK's own keep-alive
pool. When a download fails part-way, the SDK destroys the agent it went out on, and its own pool is shared by every
request in the process, so a download cut off mid-body, refused or timed out there resets every other request in
flight, uploads included: measured on 8.1.0 with no timeout, a body the server cut off part-way reset a 64-byte upload
and a registry write on a second backend. On the global agent all of them complete, and the SDK never destroys it.
What that costs: Node's global agent closes a connection that has been idle for 5 seconds, which the SDK's own pool
does not, so a read after a longer quiet spell opens a new connection, with its TCP and TLS handshake; and the downloads
share that agent with any other `http` or `https` request in your process, so a `maxSockets` set on it queues them,
and the queue counts toward the timeout. Raising `https.globalAgent.options.timeout` keeps idle connections longer
(measured on Node's `http` agent against a local server: two reads 6.5 s apart opened two connections by default and
one with `options.timeout` at 30 s).

**Nor does an Azure Blob client's timeout bound a body that stalls.** The SDK's per-try timer stops once the response
headers arrive, and `retryOptions.tryTimeoutInMs` is the timeout it asks the service to apply. Measured against a local
server that sends a registry pointer's headers and then nothing, a read through a client set with `tryTimeoutInMs: 500`
was still pending after 2.5 s.

**`readTimeoutMs` bounds an Azure Blob read, when you set it.** It is off by default. Set, each read request either
half of `AzureBlobStorage` sends, a range read, a tail read's properties and its ranged download, each on its own, and
a registry row's read, has that many ms to finish, the response body included, or it is aborted and throws
`TransientError`, which the store's read retry runs again. Measured against a local server that stalls before the
headers, after them or part-way through the body, a range read, a tail read and a registry read with
`readTimeoutMs: 300` each failed 300 to 321 ms after the call, and the server saw the connection close. The clock
starts at the call into the SDK, so time waiting for a socket and for a token credential's token counts; the HTTP agent
the SDK builds sets no limit on sockets (twenty reads at once opened twenty connections), so a client of the SDK's own
making does not queue a read for one. It counts time the process spends busy too: Node runs a due timer before it reads
a socket, so a synchronous stretch longer than the timeout fails the reads in flight even when their responses have
arrived. Writes, block commits, deletes and listings are not timed.

**The timer covers the client's own retries of a request, and the Azure SDK's are slow.** Its default policy retries a
500 or a 503 at once, then after 4 s, then after 12 s, so a `readTimeoutMs` under 4 s cuts it off after two tries,
and a throttled read throws the timeout rather than the 503. The store's read retry then runs the read again: against a
stub answering two 503s and then the data, a read with `readTimeoutMs: 2_000` timed out after 2.0 s, and `has()` through
the store returned after 4.0 s, as it did with the timeout off.

<!-- typecheck-skip: a fragment: the page leaves `AzureBlobStorage`, `containerClient` to the reader -->
```ts
const backend = new AzureBlobStorage({ containerClient, readTimeoutMs: 2_000 });
```

Only transient faults (they surface as `TransientError`) are retried. Errors that retrying cannot fix are never
retried: `ValidationError`, `IntegrityError`, `NotFoundError` and `WriteConflictError`.

**S3 reads can be timed.** `@cloudbitmaps/s3` takes `readTimeoutMs`, which is off (`0`) unless you set it. Set, it
gives each read the backend sends, every `GetObject` and `HeadObject` of a generation or a pointer, that many ms to
finish, the SDK's own retries of it and the response body included, so a connection that sends its headers and then
stops is cut off as well. A read that runs out of time throws `TransientError`, which the store's read retry, above,
runs again, and its request is aborted, which frees the connection. AWS's S3 guidance is to retry a GET of under
512 KB that has not answered in about 2 seconds. With `readTimeoutMs: 2_000` and the default retry policy, a read
whose request stalls on every attempt fails with `TransientError` after 4 × 2,000 ms of timeouts plus up to 350 ms of
backoff, about 8.35 s, rather than hanging. That bound is derived, not measured: four attempts, waits of up to 50, 100
and 200 ms between them, and one timed-out request per attempt; any request earlier in the same attempt that did
answer adds its own time.

<!-- typecheck -->
```ts
import { S3Storage } from '@cloudbitmaps/s3';

const backend = new S3Storage({ bucket: 'my-bitmaps', readTimeoutMs: 2_000 }); // 0, the default, sets no timeout
```

**The clock starts when the read is handed to the SDK**, not when it reaches the wire. It counts the time the read
waits for one of the client's sockets (128 by default on the client the store builds) and the time spent fetching credentials, and under
`retryMode: 'adaptive'` the SDK's rate-limiter wait. So a burst of concurrent reads larger than the socket pool can
time out with nothing slow on the wire: measured against a local stub that answers each request in 50 ms, 8,000
concurrent `has()` calls with `readTimeoutMs: 2_000` lost most of their reads to the timeout. It counts time the process spends
busy too: Node runs a due timer before it reads a socket, so a synchronous stretch longer than the timeout fails the
reads in flight even when their responses have arrived. Size `readTimeoutMs` above the
worst queueing your concurrency implies, which is about the concurrent reads divided by the sockets, times what one
read takes (8,000 ÷ 50 × 50 ms is 8 s on a client with 50 sockets; derived), or raise `maxSockets`. A registry listing keeps up to 48 row reads open at once, so on a client you pass, at the SDK's 50 sockets, your own concurrent reads may wait for a socket while a listing runs, and that wait counts toward `readTimeoutMs`; the client the store builds has 128. The client the store builds takes it
as an option; a client you pass is yours to set:

<!-- typecheck-skip: a fragment: the page leaves `S3Storage` to the reader -->
```ts
const backend = new S3Storage({ bucket: 'my-bitmaps', maxSockets: 256 });
```

The limit is the only thing that differs from the SDK's own client; free keep-alive sockets do not hold the process open,
and `backend.client.destroy()` closes them.

On a client of your own, set it on the request handler. A handler built this way replaces the SDK's own, so it also drops
the settings the SDK's defaults mode would have given it (the `connectionTimeout` that `AWS_DEFAULTS_MODE` sets, for
one): pass those yourself if you rely on them, or let `S3Storage` build the client and set `maxSockets` on it, which
changes the limit and nothing else.

<!-- typecheck-skip: imports `@smithy/node-http-handler`, which this repository does not install -->
```ts
import { S3Client } from '@aws-sdk/client-s3';
import { NodeHttpHandler } from '@smithy/node-http-handler';

const client = new S3Client({
  region: 'us-east-1',
  requestHandler: new NodeHttpHandler({ httpsAgent: { maxSockets: 256 } }),
});
```

A combine reads each operand as a stream of ranges and keeps up to `concurrency` range requests per operand in flight
(32 by default once its window has widened; it opens 4 wide): an `intersect` of two segments has up to 64 reads open,
and an `andNot` against excludes up to 32 for the include plus 32 for each exclude read in the same round; an exclude
of an `intersect` of two or more segments is read in batches whose requests never exceed the keys the window holds, so
up to 32 more for each exclude. Most reads need
far fewer: chunks that sit near each other are one range, so two segments whose shared chunks lie together are one
request each. The client the store builds allows 128
sockets, which covers one two-operand combine with room to spare; a client you pass keeps the SDK's default of 50, and
its reads past the 50th are not refused: they wait for a socket, and the wait counts against `readTimeoutMs`. Raise
`maxSockets` (on the store, or on your own client) to match your concurrent combines (256 covers four two-operand
combines), or pass a lower `concurrency` to the combine.

**The store tells you when a client you pass is below that.** When the store has a `metrics` sink and the
client's socket pool is smaller than twice the default window (64), the first read sends the sink one `advisory` event
and no more: `{ kind: 'advisory', code: 'socket-pool-below-window', driver: 's3', bucket, maxSockets, threshold: 64,
concurrency: 32 }`. Nothing is logged or printed, and the check sends no request of its own. It compares against the
default `concurrency` of 32, because a combine's `concurrency` is chosen per call and the store cannot see it: if you
always pass a lower one, the event is a false alarm for you and you can ignore it. It reads the pool through the SDK's
own request handler, so it sees the SDK's default handler and the agents you give it (`maxSockets` on its `httpAgent` or
`httpsAgent`, for the scheme your endpoint uses). It **cannot read** a request handler you wrote yourself, an HTTP/2
handler, the Fetch handler, or an agent that does not expose `maxSockets`, and for those it sends nothing and raises no
error, so no event does not mean the pool is large enough. A pool you raise after the first read is not seen. When your client has an `endpoint`, it reads the agent for that scheme. When it has none, or its endpoint comes from the environment (`AWS_ENDPOINT_URL`), which the client does not expose, the scheme is not known, so it reads every agent the handler has made and sends the event only if all of them are below 64: it never warns on a pool your reads do not use, and it can miss a small pool when the other agent is large. A backend given to several stores sends each store's sink its own event, once; a store built after the check has run gets it as soon as the check's result is known. The client
the store builds, at its 128 sockets, sends none unless you set `maxSockets` below 64.

`eraseSubject` has up to `concurrency × 8` requests open (64 by default, since it erases 8 segments at once, each
reading its segment through a stream of at most 4 ranges, each up to 1 MiB, and searching its other generations for a
holder 4 at a time, two requests each), and `iterate` reads up to 32 ranges ahead (a source that reads chunk by chunk,
and the storage-path `count`, up to 32 keys). Its 64 fit the client the store builds (128 sockets); on a client you
pass with the SDK's default of 50, the requests past 50 wait for a socket unless you raise `maxSockets`.

### Reading ranges: the bytes between chunks

A combine or `iterate` reads the chunks it needs from an object as ranges: chunks that sit within 256 KiB of each other
are read in one request, up to 1 MiB, and the bytes between them are read and never looked at. That is what turns a
request for every chunk into a request for a stretch of the object. It also means a read of chunks that are spread over
an object can cover most of it: the requests fall, and the bytes read rise toward the object's size. Inside the bucket's
region S3 Standard does not bill bytes read, so the extra bytes cost a few milliseconds of transfer and nothing else (S3
Express One Zone bills them). **Across
regions, and out to the internet, S3 bills the bytes**, and reading most of an object to get a few of its chunks can cost
more in transfer than the requests it saved: run readers in the bucket's region, or measure with
[the sizing guide's overlap tables](sizing.md#how-much-the-overlap-matters), which show the requests and the bytes read
for chunks that lie together and for chunks that are spread. There is no setting for the 256 KiB or the 1 MiB.

Raise `readTimeoutMs` too on a link too slow to deliver a read inside the timeout, since such a read fails on every attempt. The
timer is set on each request rather than on the client, so a `client` you pass gets it without being changed. On a
client built with `cacheMiddleware: true`, a timed read resolves its middleware each time, since the SDK reuses a
cached handler only for a request sent with no options.

**Set a timeout on your S3 client for the rest.** `readTimeoutMs`, above, times reads and nothing else: the library
times no write, because a write abandoned in flight can still land after it was given up on, and it times no delete
or listing, on any backend. On S3 a timeout on your client turns a hung write or listing into a transient fault,
which for a write is yours to re-run. Build the client with the timeout and pass it to the backend:

<!-- typecheck-skip: imports `@smithy/node-http-handler`, which this repository does not install -->
```ts
import { S3Client } from '@aws-sdk/client-s3';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import { CloudRoaring } from '@cloudbitmaps/roaring';
import { S3Storage } from '@cloudbitmaps/s3';

const client = new S3Client({
  region: 'us-east-1',
  requestHandler: new NodeHttpHandler({ connectionTimeout: 1_000, socketTimeout: 30_000 }),
});
const store = new CloudRoaring({ storage: new S3Storage({ bucket: 'my-bitmaps', client }) });
```

`socketTimeout` ends a request whose connection has carried nothing for that long, so an upload that is still sending is
left alone. `requestTimeout` on its own only logs a warning when it passes: checked on `@smithy/node-http-handler`
4.12.1 against a stub endpoint, it ends the request only with `throwOnRequestTimeout: true` beside it.
`@smithy/node-http-handler` comes with the AWS SDK; declare it in your own `package.json` as well, since your code
imports it. A `client` carries its own region and credentials, so passing `region` or `credentials` beside it is refused.

**Reads retry by themselves; a write is retried only where that is safe, and any other fault on it is yours to re-run.** What is retried for you:

| Calls | Retried for you? |
|---|---|
| Reads that answer a query: `has`, `count`, `iterate`, the combines (the `*Into` verbs' reads of their operands included), a pinned handle's reads, and `pin()`; and the search `subjectReport` and `eraseSubject` make under a destroyed segment, its listing included | Yes, with backoff; `retry` tunes it |
| Writes: `load`, the write half of the `*Into` verbs, and the lifecycle helpers (`eraseSubject`, `dropSegment`, `retireExpired`, `rollback` and the rest) | Settled, and sent again only where it is safe, never by `retry`. A [throttled write-once object](correctness.md#object-write-resent) on S3 and GCS is sent again. A registry write that gets no answer is settled by [reading the row](correctness.md#row-write-settled), and through the store the read-back waits between its reads (the store passes a sleeping clock; a direct call into core's internal entry with no clock does not wait). The publish of a `load`, an `*Into` verb or an erasure's rewrite, and an erasure's write to the row before it deletes, are sent again as a fresh compare-and-swap when the row shows they did not land (at most three, after a wait; [a load's writes](correctness.md#when-a-write-is-throttled-or-gets-no-answer)). Every other lifecycle write counts as landed when the row shows its write token: the crypto-shred of `destroySegment`, `eraseNamespace`, `dropSegment` and a sweep's retirement, a drop's tombstone, `setRetention`, `clearRetention`, and a `rollback`'s move and its move back. A delete that gets no answer is settled by reading back what it removed: a sweep's delete of a tombstone or a due-index pointer counts as done when the row is gone, and a storage delete (a load's collection, an erasure's, a drop's sweep) when its object is gone (an erasure's, when another object is under the number, as a refusal). Any other outcome reaches you as the `TransientError`: run the call again. It can still have landed when the read-back failed too, a delete can land after its check, and a registry that reports no write tokens cannot show a write by its token; [what a re-run then answers](correctness.md#settle-by-read-back) lists each case. The reads they make along the way are retried, with backoff: a load guard's read of the current generation, and an erasure's reads of the generation it rewrites, of the one it wrote, and of any other that may still hold the id |
| Registry reads and listings: `exists`, `segments`, `generations`, `getRetention`, and the registry scan that `subjectReport`, `exportSegments` and `checkConsistency` start from | No: call it again |

A write that lands and then loses its response looks, from the error alone, like a write that failed, and replaying it
would find itself already there and report a conflict. So [the S3 and GCS drivers send a conditional write
once](correctness.md#sdk-retry), and again only where an id it carries tells a replay apart (a throttled object), and [every write settles an unanswered registry write by reading the row](correctness.md#row-write-settled). Two GCS
writes keep the SDK's retry: a resumable upload (an object above `simpleUploadThresholdBytes`), which carries the same
id, and the registry's delete under `ifGenerationMatch`, which its precondition makes safe to send twice (a copy that meets
the first's landed delete reads as a lost race, and the retention sweep, which sends that delete, settles it by reading the row and finding it gone). Azure Blob's
client retry can replay any write, a registry row included: [the id tells a replay from another writer's
object](correctness.md#tagged-writes), and for a row that read-back is not definitive ([how retries stay
correct](correctness.md#how-retries-stay-correct)). A fault those do not settle reaches you as `TransientError`, and
the retry is yours.

Re-running a `load` is safe. It takes a fresh generation number and re-reads the pointer, so it publishes whether or
not the first attempt landed, under every guard setting. Three things to know:

- **Pass the ids again, fresh.** An iterator the first attempt used up yields nothing the second time, and an empty
  load can publish: with `allowEmpty: true`, or onto a segment that holds no data.
- **A late write reads as a lost race.** A request that timed out on your client can still land while the re-run is
  under way, and the re-run then reports `superseded`. On a `superseded` right after a transient fault, check before
  you re-derive, and run the load again if your ids are not current.
- **Every attempt that landed takes a `keep` slot.** The default `keep: 1` then collects the generation the segment
  held before the load. To keep that one as a rollback or pin target, pass a `keep` one above the number of attempts
  that landed: `keep: 2` after one. See [Generations and `keep`](loading.md#generations-and-keep).

To learn whether an attempt landed, check instead of replaying: compare `store.generations(ref)` with what it listed
before the call. A new current generation is a publish that landed. A new one above the current is an object that
landed unpublished. While another writer is active on the segment, the listing cannot say whose either one is.
`generations` is not retried either, so a fault there means asking again.

### A write that gets no answer

A lifecycle write that gets no answer [reads back its row](correctness.md#row-write-settled) or [its object](correctness.md#settle-by-read-back), and counts as landed when what it reads carries
its own mark: [a crypto-shred](correctness.md#settle-shred), [a drop's tombstone](correctness.md#settle-tombstone),
[a retention write](correctness.md#settle-retention) and [a rollback's move and its move
back](correctness.md#settle-rollback) by the write's token, [a sweep's purge](correctness.md#settle-sweep) by the row
being gone, and [a storage delete](correctness.md#settle-storage-delete) by the object being gone. Each read-back waits
between its reads through the store. [What each settles](correctness.md#a-write-that-gets-no-answer), and what a re-run
then answers, is in the guide to how it stays correct.

## Schedule the work

The library starts no timer, so it behaves the same in a Lambda and on a server. Two things need a schedule from you:

- **Loads.** Run each `store.load` from a scheduled job or a queue consumer, at the cadence your data needs. A shorter
  cadence is how you get fresher data. See [Loading in depth](loading.md).
- **The retention sweep.** If you record expiries with `setRetention`, call `store.retireExpired()` on a schedule.
  Nothing else removes expired segments. See [Retention](retention.md).

## Limits: the per-op budget and the memory ceilings

Two separate limits protect you. It helps to know which one you hit.

| | `budget` | the memory ceilings |
| --- | --- | --- |
| bounds | **cost**: chunk reads a single operation may fan out into, an upper bound on its backend requests (neighbouring chunks share one) | **memory**: what a process holds resident, whatever the segments' size |
| knobs | `budget: { maxRequests }`; `false` disables it | `cache.maxChunks` (decoded cached chunks, default 1024) · `cache.readerMax` / `cache.readerMaxBytes` (open `.crbm` readers, default 1024 / 64 MiB: their parsed indices, a fixed 3.75 KiB each for the objects around the index, and the chunk bytes of a small generation; and 8 × as many segments' resolutions within a sixteenth of the bytes) · the combines' `concurrency` window · the per-chunk decode cap · `maxBufferedBytes` for `materializeMany` (default 256 MiB; required with a feed). **`budget: false` lifts none of them.** |
| covers | `count` · `iterate` · the combines · `materializeMany` · `subjectReport` · `eraseSubject` | every read, on every backend |

### The request budget

On a shared or serverless backend, one runaway call can quietly run up a large bill: an `intersect` over two enormous
barely-overlapping segments, a wide `union`, or a fleet-wide `eraseSubject`. The library caps the number of backend
calls one operation may fan out to and throws `BudgetExceededError` instead of running away. The cap is on by default
at 1,000,000 units. Lower it on untrusted or multi-tenant surfaces. Raise it, or pass `budget: false`, for trusted
bulk jobs.

<!-- typecheck-skip: a fragment: the page leaves `backend`, `hugeIds`, `otherIds` to the reader -->
```ts
import { CloudRoaring, BudgetExceededError } from '@cloudbitmaps/roaring';

// set your own store-wide ceiling:
const store = new CloudRoaring({ storage: backend, budget: { maxRequests: 50_000 } });
await store.load({ segment: 'huge' }, hugeIds);
await store.load({ segment: 'other' }, otherIds);

try {
  for await (const id of store.segment('huge').intersect([store.segment('other')])) {
    /* ... */
  }
} catch (e) {
  if (e instanceof BudgetExceededError) {
    // the operation would have fanned out past the ceiling; it was refused before doing the work
    console.log(e.option, e.limit, e.spent); // 'budget.maxRequests', 50000, and the count it needed
  }
}
```

The operations that take options (the combines, `subjectReport`, `eraseSubject`) accept a per-call override. A
partial override inherits the store ceiling; it never resets it to the default:

<!-- typecheck-skip: a fragment: the page leaves `userId` to the reader -->
```ts
// tighten or lift the ceiling for one call:
await store.subjectReport(userId, { namespace: 'eu', budget: { maxRequests: 5_000 } });
for await (const _ of store.segment('huge').intersect([store.segment('other')], { budget: false })) {
  // a trusted batch job: no ceiling for this call
}
```

The error says which option to raise without parsing its message: `option` is the option that lifts the refusal
(`'budget.maxRequests'`, `'maxBufferedBytes'` for `materializeMany`'s memory, or `'maxScanSegments'` for a registry
scan), `limit` is the bound that was in force and `spent` is what the call had reached. What `spent` tells you depends
on the option:

- `'budget.maxRequests'`: the requests a plan needs. Raising the budget to it lets the call through, except for an
  enumeration stopped at its bound (`subjectReport`, `eraseSubject`'s scan), and a `subjectReport` refused while it searches a destroyed segment, which report `limit + 1`, a lower bound:
  raising the budget to it can be refused again, so raise it with room to spare.
- `'maxBufferedBytes'`: a **lower bound** on the memory the call needs, namely what it held plus what it asked for at the
  moment it was refused. Raising the limit to `spent` can be refused again further on, because the call had not finished
  growing. The one figure that lets an output through is the per-output refusal's, whose message says "raise
  maxBufferedBytes to at least N". For any other `maxBufferedBytes` refusal, raise the limit with room to spare, or split
  the outputs across calls, rather than loop on `spent`.
- `'maxScanSegments'`: `limit + 1`, a lower bound and not the size of the fleet: the scan stops at the first row past the
  bound (for the retention sweep's due-index scan, the first pointer, unread, which may be stale). Narrow it with `namespace`, or raise the limit.

`option` is a string and the other two are numbers: the error carries no id, key or segment name.

The ceiling is checked before the fan-out, against work whose size is already known, so it adds nothing to the
hot path. An `iterate` or a combine that lists its keys again after a move
([a running read plans its keys again](reading.md#a-running-read-plans-its-keys-again-after-a-move)) is checked again,
with the chunk reads it has already taken, and throws `BudgetExceededError` at that key when the segment grew past the
ceiling. `has` is a single call and is never budgeted. The units are the chunk reads the operation will actually
issue. For an `intersect` that is the surviving keys times the operands present at each, plus only those excludes
that hold the key, so a large suppression list is not charged for keys it cannot affect. An exclude read in batches
(an `intersect` of two or more segments) is still charged a unit for each such key, though a batch sends fewer requests than it has keys. Bytes need no separate
limit, because every chunk read is size-capped by the safe deserializer. `count` on a loaded segment reads no
payload: it answers from the row's summary, or from the index when the row has none it can use, so it approaches the ceiling only on a source that cannot serve cardinalities.

`subjectReport` charges one unit per registered segment too, and, for each destroyed segment in scope, one for each
object it opens under it beyond the one the row names (a segment's own listing and that open are in its unit). A drop
that deleted everything costs 1 listing; a cleartext destroy with 3 objects, 7 requests; 10 objects, 21, of which 10 are
budget units when the id is only in the oldest. A report that runs out throws `BudgetExceededError`, never a short
answer, with `spent` at `limit + 1`, a lower bound: raise the budget with room to spare.

`eraseSubject` charges one unit per registered segment, and one for each generation it opens beyond the one the
row names. Only the enumeration can refuse the whole call. A segment that runs the budget out during the scan is
listed in the ledger with `erased: false` and an `error:` note, before anything of it is deleted, and the scan carries
on. Re-run with a higher `budget` to finish those segments. The ledger of the erasures that did happen is never lost.

### The memory ceilings

`intersect`'s budget is a product (surviving keys times operands), while its memory is a window
(`concurrency × operands × the 1 MiB a range may be`, which is the chunk cap) that does not depend on segment size. A request budget cannot express a memory
bound, and `budget: false` ("I know my fan-out") must not silently also mean "unbounded RAM". A wide segment's parsed
index can reach about 1.3 MB (65,536 entries at 20 B), which is why the reader cache is bounded by bytes as well as by count. A reader also keeps the chunk bytes of a generation whose whole object arrived with its tail read, when they total at most `readerMaxBytes` / `readerMax` (64 KiB by default), and those count in the same bound, so a cache of readers that each kept a whole share holds fewer than `readerMax` of them. Each open reader counts a fixed 3.75 KiB for the objects it holds around its index besides, so readers that each kept a whole share weigh the share plus 3.75 KiB plus their index: `readerMax` readers of that kind fit in the ceiling only up to the fraction share / (share + 3.75 KiB + index), about 94% at the defaults (about 965 of 1,024), about 68% with `readerMaxBytes` at 8 MiB and about 51% at 4 MiB. A deployment that raises `readerMax` for many tiny segments is bounded by `readerMaxBytes` too: 64 MiB holds about 17,000 of them, and a `readerMaxBytes` below two readers' weight (about 7.7 KB for tiny ones) keeps one reader open at a time. Lower
`cache.readerMaxBytes` for a memory-tight deployment, such as a small Lambda function that reads across many wide segments. A running combine or `iterate` holds the reader of the generation it is reading (its parsed index, any chunk bytes it kept, and the key it unwrapped on an encrypted segment) until it moves on or ends, outside `readerMax` and `readerMaxBytes`: one reader per streamed operand, for as long as the read runs, so a process with many reads open at once holds that many readers more than the cache's bound. Both caches are keyed on the segment's generation and its row's `pointerId`, so a load's publish, a rollback or an erasure's rewrite makes each store reading the segment open its reader again at its next pointer refresh and fetch again the chunks it reads next, and a lease or a `setRetention` does not ([what a lease costs](reading.md#hold-a-generation-for-a-job-a-lease)). A store with a timed refresh also keeps each segment's resolution, the few hundred bytes of its row a read resolves through and never an unwrapped key; the wrapped keys are in it. It keeps them apart from its readers: up to 8 × `readerMax` of them within `readerMaxBytes` / 16, so 8,192 and 4 MiB by default ([what they hold](sizing.md#what-each-reader-holds)). A segment whose reader the cache let go is reopened from it with no registry read, when a read needs its index or a chunk the chunk cache does not hold, and on an encrypted segment the key is unwrapped again through the keystore.

**A load's memory is the generation, unless its ids are sorted.** A load of ids holds the generation it builds, one
bitmap per non-empty chunk, and a buffer of up to about 28 MB; a bitmap load holds the bitmap decoded and re-encoded.
A load with `sorted: true` holds one chunk's ids and bitmap and the writer's index, whatever the segment's size: up to
about 7 MiB at the 65,536 chunks a segment can have, about 8 MiB for an encrypted segment, while the footer is written
(derived from the writer's code; [the measured
figures](../benchmarks.md#what-a-sorted-load-holds-in-memory)). Any load adds what the backend buffers of
the object, derived from the drivers' code and not measured: up to about twice the part or block size on S3 and Azure
Blob at a flush (16 MiB at the 8 MiB default), up to about twice the simple-upload threshold on GCS when it switches to
a resumable upload, next to nothing on the local filesystem, and the whole object in `MemoryStorage`
([memory, and where a load runs](loading.md#memory-and-where-a-load-runs)). No budget bounds a load: size the process
for these.

**Neither limits how many ids a segment can hold.** A segment holds up to the full 32-bit id space, about 4.29
billion members. `maxScanSegments`, an option of `store.retireExpired` and `store.checkConsistency` (default 250,000), counts segments, not members: 500 audience segments count as 500, whatever their size.

## What blocks the event loop, and where to run it

Node is single-threaded, so CPU-heavy work stalls **every** other request on that instance. Most of this library
is network-bound and irrelevant here — a `has()` spends a negligible fraction of its time on bit math — but a
**load** and an **erasure rewrite** are genuinely CPU-heavy, because each one touches a whole generation.
Measured on an Apple M3 Pro on 2026-09-30, the median of 20 runs, each in a fresh process, **on the native codec of
0.23.0**:

| path | cost | longest single stall | where it belongs |
| --- | --- | --- | --- |
| a load, `store.load()` (1M ids spread across the id space, in-memory storage) | ~526 ms | **~24 ms** (47 ms at worst) | a batch job or worker; survivable off the request path |
| `eraseSubject` | decodes and re-encodes every chunk of the segment — same order of work as a load | yields on the same cadence | an admin job, never a request handler |
| `store.materializeMany` | decodes each operand chunk once per group and encodes every output, as an `*Into` does | not measured | a batch job or worker, as for a load |
| `has` / `count` / `intersect` / `union` / `andNot` | microseconds of CPU; dominated by network | — | anywhere |

The **stall** column is the number that decides whether co-resident work survives, and it is not the same as
cost. A load yields the event loop periodically, so its ~526 ms is spent in slices — the longest ~24 ms in the
median run and 47 ms in the worst — with the loop free in between: other requests interleave rather than
queueing behind the whole load. Without a clock to yield through, the two columns are the same number: the same
1M-id load holds the loop for **~519 ms straight** (median), long enough for a health check to time out and the
instance to be pulled from its load balancer.

**These are the native codec's figures, to be re-measured on the TypeScript codec.** The store runs the TypeScript codec
from 0.24.0, and its bulk load measured faster than the native one's in a warm process (see [the codec's costs and
gains](roaring-codec.md#what-it-costs-and-gains-against-native)), so ~526 ms is not what a load costs on it; no event-loop
run exists on it yet, and the stall column is likewise native's.

**Read these as a loaded machine's figures.** The machine was not idle: its one-minute load average was about 5
at the start and the end of the run, so the cost column in particular is likely higher than an idle machine would
give, and the worst stall is the figure a busy neighbour moves most. The two columns' proportions are the finding.
The harness, the per-run samples, the Node version and the load averages are in
[`bench/event-loop-results.json`](../../bench/event-loop-results.json), written by
[`bench/event-loop.cjs`](../../bench/event-loop.cjs); `pnpm bench:event-loop:check` fails in CI if this section's
figures are not the ones in that file.

Yielding is on by default for `@cloudbitmaps/roaring` users; there is nothing to configure. It needs a `Clock`,
which the store passes to its loads and its erasures.

**The rule:** anything that touches a whole generation belongs out of the request path. Yielding makes a load a
well-behaved neighbour, not a cheap one — it still burns a core for a fraction of a second, holds the whole
generation in memory unless its ids are sorted, and streams a multipart upload. Use a job runner, a queue consumer, or a short-lived task —
and keep `has`, `count` and `intersect` where the requests are.

## Deploying to AWS Lambda

Serverless chunk-skipping intersection is what CloudBitmaps is for, so Lambda is a first-class target, and it
needs nothing special. `@cloudbitmaps/roaring` has no native addon and no install script: the bitmap math is
TypeScript, so nothing is built per architecture, no toolchain is needed, and a `node_modules` installed on a laptop
and zipped up loads on Lambda the same as one installed anywhere else. Match only the **Node version**: every
CloudBitmaps package needs Node 22.12 or later, so the function runs on `nodejs22.x` or a later runtime. The library is the same JavaScript on `arm64`
(Graviton) and `x86_64`, with nothing per architecture; CI exercises `x86_64` only.

Package it however you already do: a zip of your bundle and `node_modules`, a container image
(`FROM public.ecr.aws/lambda/nodejs:22`, `npm ci`), or a Lambda layer holding `node_modules`, reused across
functions.

The repository's CI checks this path on every push: the `pnpm lambda-smoke` gate packs core and the flavor, unpacks
them into a `node_modules`, mounts it into the Amazon Linux 2023 Lambda runtime image (nothing is installed or built
inside it), checks that no native addon is present, and loads and round-trips the library under both ESM and CJS. It
runs on `x86_64`; the packages are the same JavaScript on `arm64`, which no job runs. `pnpm build-lambda-layer` from a
clone produces `dist-lambda/cloudbitmaps-lambda-layer.zip`, holding core and the roaring flavor and nothing compiled,
and loads the unzipped layer from `/opt/nodejs/node_modules` in the same image through `NODE_PATH`, which Lambda sets
for a layer and which resolves `require()` and not an ESM `import`. The layer script is in the repository, not a
published artifact: nothing on npm or on a GitHub release carries it, though a manually dispatched CI run can build one
and attach it to that run.

## How it stays correct

[A fault costs a read some latency and a write a re-run, never correctness](correctness.md#fault-costs-a-re-run):
generations are write-once, [a publish only moves the pointer forward](correctness.md#publish-is-forward-only), and
every byte is checksum-verified before use. [A cloud SDK's own retry gives the wrong answer for a conditional
write](correctness.md#sdk-retry), since a write that lands and loses its response meets itself when it is sent again. So
the S3 and GCS packages send a conditional write with the SDK's retry off for that request alone, except a GCS resumable
upload, which the SDK retries within its session, and the GCS registry's delete. [A write that can meet itself carries a
random id in its metadata](correctness.md#tagged-writes): every Azure Blob write, a GCS resumable upload, and [an S3 or
GCS object sent again after a throttle](correctness.md#object-write-resent). When such a write reports a conflict, the
backend reads the stored object back, and one that carries the write's own id is a success. For a generation's object
that answer is definitive, since nothing overwrites it. A registry row is overwritten by compare-and-swap, so a writer
that swaps in over a write that landed, before the read-back, makes that write report a conflict. The publish then reads
the row again, and finds its write only while the pointer still names its generation and the row's `pointerId` is its
own write's; overtaken by a newer load, it answers `published: false, reason: 'superseded'`, and its
`segment.load-refused` event carries `unanswered: true`, as does the refusal of a load that lost an ordinary race at the
registry on Azure Blob, which marks every conflict of a row write as one that may follow the write's own landing. A
registry delete under a precondition that goes through the SDK's retry, on GCS and Azure Blob, is safe to send twice
because of its precondition. Each package's conditional writes, and what a tagged write does on a conflict, are in [How
retries stay correct](correctness.md#how-retries-stay-correct).
