# Security Policy

This page is the security document of CloudBitmaps: how to report a vulnerability, what the library defends and against
whom, what it does not defend, how to deploy it safely, and how the published packages are built. Every guarantee
below names the test file that holds it, and each limit is stated beside its guarantee rather than left for a reader to
find.

- [Reporting a vulnerability](#reporting-a-vulnerability)
- [Supported versions](#supported-versions)
- [The threat model in summary](#the-threat-model-in-summary)
- [What the library guarantees, and the limit of each](#what-the-library-guarantees-and-the-limit-of-each)
- [What is not authenticated, by design](#what-is-not-authenticated-by-design)
- [Deployment advice](#deployment-advice)
- [Dependency audit](#dependency-audit)
- [Supply chain (build, publish & provenance)](#supply-chain-build-publish--provenance)
- [Out of scope](#out-of-scope)

## Reporting a vulnerability

Report a suspected vulnerability **privately**, through GitHub Security Advisories: on this repository's Security tab,
choose **Report a vulnerability**
([open a draft advisory](https://github.com/cloudbitmaps/cloudbitmaps/security/advisories/new)). Never open a public
issue, pull request or discussion for a security report, and do not post a proof of concept anywhere public before a fix
ships.

Include what lets us reproduce it:

- the package and version (`@cloudbitmaps/core`, the flavor, the driver), and the Node.js version;
- the storage service and whether the segment is encrypted;
- what an attacker needs to be able to do (pass bytes to the API, read the bucket, write the bucket, write the
  registry row, read a key) and what they gain;
- the smallest input, object or call sequence that shows it, and what you expected instead.

**What we commit to:**

| Step | Within |
| --- | --- |
| Acknowledge your report | 3 working days |
| A first assessment: whether we reproduce it, and how severe we judge it | 10 working days |
| A fix, or a mitigation you can apply, released | 90 days of the report |
| Disclosure | A date agreed with you, with a GitHub advisory and a CVE |

**Good-faith research is welcome.** If you test against your own buckets and keys, stay within what is needed to show
the issue, do not read or keep other people's data, and report privately. Do not run tests against storage or accounts that are not yours.

## Supported versions

CloudBitmaps is pre-1.0 and has no long-term-support branch. **Only the latest 0.x minor release receives security
fixes**, together with `main`; a fix lands on `main` and ships in the next release.

| Version | Security fixes |
| --- | --- |
| The `main` branch | yes |
| The latest 0.x minor release | yes |
| Any earlier 0.x minor release | no: upgrade to the latest minor |

The policy for releases after 1.0 is decided with the 1.0 compatibility policy and will be written here.

## The threat model in summary

**What is defended (the assets).**

| Asset | Why it matters |
| --- | --- |
| **Membership data**: which ids are in which segment | An id can be a user, a subscriber or a device, so it is personal data in the usual case ([PRIVACY](PRIVACY.md)). Disclosure, tampering and a wrong answer all have a person-shaped consequence |
| **Keys**: each segment's data key, and your key-encryption keys | Whoever holds a key-encryption key can read every segment it wraps; destroying every wrapping of a data key is the erasure |
| **The erasure and privacy promises** | A false promise of erasure is the worst failure this project can have: the receipt, the crypto-shred and the in-flight bound are written down and tested |
| **The answers**: `has`, `count`, iteration, `intersect` | A wrong answer is an integrity failure even when nothing leaks |
| **The published packages** | A tampered package runs inside every consumer's process with the consumer's cloud credentials |
| **The host process**: its memory, CPU and cloud bill | A hostile object that exhausts memory or turns into unbounded requests is a denial of service or of wallet |

**Who is considered (the actors).**

| Actor | What they can do |
| --- | --- |
| **A caller passing bytes** | Calls the API with bytes, ids, names and options: a malformed bitmap, an out-of-range id, a path-shaped name, a huge payload |
| **A bucket reader** | Reads the bucket (an over-broad grant, a leaked log, a backup) and cannot write it |
| **A storage writer** | Writes objects (`.crbm` generations) but not registry rows |
| **A storage and registry writer** | Writes both. On S3, GCS and Azure Blob the registry rows are `.reg` objects in the same bucket unless the permissions split them, so this is whoever holds write access to the bucket. They can also repoint a segment's pointer, change its summary and replace its wrapped data keys |
| **The key store** | Holds your key-encryption keys and unwraps data keys. It is the root of trust of encryption, so it is not an adversary here; a mistake in running it is |
| **A pull-request author** | Changes workflow files, scripts and tests that CI runs |
| **A compromised dependency** | Runs code at install or import time in a developer machine, in CI or in a consumer's install |
| **The release runner** | Code running in the publish job after approval, able to ask for the token that npm Trusted Publishing accepts |

**Where the trust boundaries are.**

```
  caller ──bytes, ids, names, options──▶ ┌──────────────────────────────────────────────┐
                                         │ B1  the API edge                              │
                                         │     names are percent-encoded, ids are        │
                                         │     checked, sizes and options are validated  │
                                         └───────────────────┬──────────────────────────┘
                                                             │
        ┌────────────────────────────────────────────────────▼─────────────────────────┐
        │ the library, in your process                                                   │
        │   cache ◀── reader ◀── B2  bytes back from storage are UNTRUSTED               │
        │   (bounded)            size cap → layout check → bounded decode → range check  │
        │                        CRC32C on cleartext, AES-256-GCM on encrypted           │
        └───────────────────┬────────────────────────────────────────────────────────────┘
                            │ driver ports: S3, GCS, Azure Blob, local files
  ═════ B3  the bucket boundary: a reader reads, a writer writes ═══════════════════════════
                            │
        ┌───────────────────▼──────────────┐   ┌──────────────────────────────────────┐
        │ objects  <ns>/segments/…crbm     │   │ registry rows  registry/<ns>/….reg   │
        │ immutable, generation-keyed      │   │ pointer, summary, generations,       │
        │                                  │   │ wrapped data keys, leases, status    │
        └──────────────────────────────────┘   └──────────────────────────────────────┘

  ═════ B4  the key boundary: key-encryption keys live in YOUR key store; the library asks it
             to wrap and unwrap and never keeps one ═══════════════════════════════════════

  ═════ B5  the supply-chain boundary: pull request ─▶ CI ─▶ release workflow (a required
             reviewer approves) ─▶ npm Trusted Publishing, with provenance ═════════════════
```

**Which guarantee holds against which actor.** A "holds" is a guarantee the library makes. A "no" is a limit, stated
plainly; each one is explained under [What is not authenticated, by design](#what-is-not-authenticated-by-design).

| Guarantee | Caller bytes | Bucket reader | Storage writer, cleartext segment | Storage writer, encrypted segment | Storage and registry writer |
| --- | --- | --- | --- | --- | --- |
| No crash, memory blow-up or code execution from bad bytes | holds | n/a | holds | holds | holds |
| Membership stays confidential | n/a | **no** on cleartext; holds on encrypted (object sizes and counts stay visible) | no: they can read what a reader reads | holds, needs a key | holds on encrypted |
| A wrong answer is detected (`has`, iteration, `intersect`) | holds | n/a | **no**: a forged object that passes the layout check answers as forged | holds | **no**: they can repoint a segment to an older, genuine generation, which authenticates, and they can clear the row's wrapped keys and plant a cleartext generation, which a store not built with `encryption: { required: true }` reads as a cleartext segment |
| **`count()` is right** | holds | n/a | no: the index is not compared with the payload | holds for the chunks and the index; the row's summary is sealed on an encrypted segment | no: they can make a count wrong, as they can repoint the generation |
| Data is gone after a crypto-shred | n/a | holds, if no copy of the data key or key-encryption key survives elsewhere | n/a | holds | holds against a load, which refuses a destroyed row; not against restoring an older copy of the row (a backup, a noncurrent version) that still holds the wrapped keys |
| An erasure receipt is honest | n/a | n/a | holds, except two generations it vouches for rest on a CRC32C identity | holds | no more than the CRC32C limit; a receipt is a return value and an audit event, not a bearer token |

Two further actors are covered where they act: the supply chain (pull-request author, dependency, release runner) under
[Supply chain](#supply-chain-build-publish--provenance), and the key-store operator under
[Deployment advice](#deployment-advice).

## What the library guarantees, and the limit of each

Each row is a guarantee the library makes, the limit of it, and the test file that fails when it breaks. A test file
named here exists, and a check in CI (`tests/docs/security-doc.test.ts`) fails if one is renamed or removed, or if a row
stops naming one.

| Guarantee | Limit | Held by |
| --- | --- | --- |
| **Every byte from storage is checked before any decoder sees it.** An object's footer, index and chunks are length-checked and verified (CRC32C, or the AES-GCM tag on an encrypted object); a chunk is at most 1 MiB (1 MiB plus 28 bytes of nonce and tag when encrypted), the index by default at most 8 MiB, the extension block at most 4 KiB, and an entry above its cap is refused when the object is opened, before any payload is read | A cap bounds memory and work; it does not make a forged object true. See the next row and [What is not authenticated](#what-is-not-authenticated-by-design) | `tests/core/crbm/fuzz.test.ts`, `tests/core/crbm/format-extension.test.ts`, `tests/core/crbm/index-lookup.test.ts` |
| **A payload's structure is checked, then it is decoded by the library's own bounds-checked decoder** (there is no trusting variant). Containers and values are in order, runs are disjoint and inside their container, every cardinality matches the bits. The decoder copies the bytes first and reads only the copy | A hostile or corrupted object fails closed with a typed `IntegrityError`; it cannot crash the process or build a bitmap whose `has`, `size` and iteration disagree | `tests/roaring/portable-layout.test.ts`, `tests/roaring/portable-decode.test.ts`, `tests/core/crbm/fuzz-corpus.test.ts` |
| **Every decoded value is range-checked.** A chunk payload holds 16-bit remainders; one outside `[0, 65535]` is rejected rather than masked into an id in another chunk's space. Chunk keys are integers, in range and unique, in one pass | None: the checks are shared by every read path, the erasure's search for a holder and its rewrite | `tests/core/chunk-checks.test.ts`, `tests/core/chunk-value-range.test.ts`, `tests/core/erase-holds-range.test.ts` |
| **Bytes a caller loads are untrusted the same way.** A load from `{ serialized }` portable bytes, or from a `{ bitmap }`, has its own size cap (537,403,396 bytes, more than any canonical 32-bit bitmap serializes to), the same structural check and decoder, refuses bytes after the bitmap's end, reads through the typed array's own accessors, and copies a `SharedArrayBuffer` first. The load also checks every container of the bitmap again, by the same rules, as it writes it, and refuses one that does not hold what its header says with `IntegrityError` before anything is published. Ids must satisfy `v >>> 0 === v`, so NaN, fractions, negatives and values of 2^32 or more are refused. Bytes that fail are a `ValidationError` and nothing is read or written | A caller must not modify the buffer while a load reads it: a plain buffer another thread, an unfinished `fs.read` or an asynchronous call is still writing is read once, as a private copy, so what is built is consistent, but which bytes the copy holds is whatever the buffer held at that instant. Hand in a buffer that nothing else writes, or a copy | `tests/core/input-checks.test.ts`, `tests/roaring/portable-decode.test.ts`, `tests/core/chunk-value-range.test.ts` |
| **Encryption at rest (opt-in) is AES-256-GCM** with a per-segment data key wrapped under your key-encryption keys. A fresh random 96-bit nonce is drawn for every seal; the 32-byte key length is enforced and the full tag is verified; every failure is one `IntegrityError` that carries no plaintext. The data key and nonces come from the platform's secure random source, never from the injected test generator | Random nonces under one data key stay safe below about 2^32 seals over a segment's life, and nothing counts them ([how many seals one key takes](docs/guide/correctness.md#seal-count)). Object sizes and counts stay visible, so an encrypted segment still reveals roughly how large it is | `tests/crypto-vectors.test.ts`, `tests/drivers/crypto.test.ts`, `tests/core/encryption-lifecycle.test.ts` |
| **The associated data binds a chunk to where it belongs.** Every chunk, the index, the metadata section and the row's summary is sealed with associated data naming the format version, namespace, segment, generation, scope and chunk key; a relocated or relabelled chunk fails to open. A wrapped data key is bound to its key-encryption key's id, so a wrapping cannot be relabelled to another key | The binding is to a generation number, not to one object instance; see [what is not authenticated](#what-is-not-authenticated-by-design) | `tests/drivers/crypto.test.ts`, `tests/core/crbm-storage-source-encryption.test.ts` |
| **A cleartext object under a keyed segment is refused**, and an encrypted object with no key is refused; a load never mints a key for a segment that already has generations and refuses to write cleartext onto a row that carries wrappings | A store wired with a keystore leaves an existing **cleartext** segment cleartext unless it is built with `encryption: { required: true }`; set it | `tests/core/encrypted-segment-cleartext-object.test.ts`, `tests/core/erase-cleartext-object-under-key.test.ts` |
| **Erasure and crypto-shredding are honest.** A crypto-shred is one compare-and-swap that clears the wrapped keys, the summary, the generation ledger and the leases of the row; a load refuses a destroyed row, so a racing load cannot resurrect it. `eraseSubject` reports `erased: true` only after a fresh listing of the bucket and a re-read of every generation except the two it can vouch for by a recorded footer checksum; an object sealed under a key the row does not hold counts as holding the id, never as clean; any other fault propagates instead of yielding a clean receipt | A receipt proves what that call saw in the bucket it listed. It does not reach backups, replicas or noncurrent object versions, and the two vouched generations rest on CRC32C identity on a cleartext segment. A reader in another process serves the id until its own cache window ends (the in-flight bound, stated in [PRIVACY](PRIVACY.md)) | `tests/core/erase-id.test.ts`, `tests/core/gc-destroyed-resurrection.test.ts`, `tests/core/shred-lost-answer.test.ts`, `tests/docs/erasure-in-flight-bound.test.ts` |
| **Errors never carry credentials, ids or bitmap contents.** The cloud drivers replace an SDK error that holds a transport, a request or a credential with a copy that drops them and redacts credential-named fields, header lines, signatures and session tokens; keystore, cipher and summary errors name key ids, generations and segment names only; no error message names a chunk key, a remainder, a stored value or an id (a check over the source holds each message to that); keys and plaintext are never logged | A name you choose (a bucket, a segment) appears in a message; do not put a secret in one. The source check reads the names interpolated into each message, so a message built another way is for review | `tests/drivers/credentials-not-in-s3-azure-errors.test.ts`, `tests/drivers/gcs/no-credential-in-error.test.ts`, `tests/drivers/s3/scrub-error.test.ts`, `tests/arch/error-messages-value-free.test.ts` |
| **Names cannot escape their place; local paths cannot escape their root.** Every segment and namespace name is percent-encoded (`/`, control characters, `%`, a leading `_`, `.` and `..`, and on the filesystem alphabet `:`, Windows device names and a trailing dot), so a name cannot invent a path or leave its component. The local driver validates before it joins, creates files owner-only with `O_EXCL` and `O_NOFOLLOW`, publishes by hard link (never overwrites) and names only the logical segment and generation in errors | The local driver assumes an operator-controlled root: a symlinked directory component of the root you configure is not defended against | `tests/core/name-codec.test.ts`, `tests/drivers/localfs/traversal-containment.test.ts`, `tests/drivers/localfs/paths.test.ts` |
| **Metadata and registry rows are parsed strictly.** A generation's metadata is strict UTF-8 and canonical JSON (string keys of at most 128 bytes, string or finite-number values, at most 1 KiB, no `__proto__`) and must be exactly its canonical text; a registry row with an undeclared field, a wrong type, a malformed token or pointer, or that names another segment is refused. No `eval`, `new Function` or dynamic import touches parsed data | A row you can write is a row you can falsify; see [What is not authenticated](#what-is-not-authenticated-by-design) | `tests/core/generation-metadata-read.test.ts`, `tests/core/crbm/format-extension.test.ts`, `tests/drivers/localfs/registry.test.ts` |
| **A segment's pointer and a generation are never overwritten in place, and a write is fenced.** Objects are immutable and generation-keyed; a publish moves the pointer by compare-and-swap, fenced on what its writer found, and a write that gets no answer is settled by reading the row ([a write that gets no answer](docs/guide/correctness.md#row-write-settled), [a rollback's swap](docs/guide/correctness.md#rollback-settles-its-swap)) | Compare-and-swap protects against concurrent writers, not against a writer who holds the registry permission | `tests/core/known-generations-publish.test.ts`, `tests/core/erase-fence-fuzz.property.test.ts`, `tests/core/first-load-race.property.test.ts` |

The shape of each guarantee is exercised by coverage-guided fuzzing (`pnpm fuzz:*`, nightly and weekly) and by the
DR drill's byte-corruption scenario (`pnpm dr-drill`, `tests/dr-drill.test.ts`).

## What is not authenticated, by design

A **cleartext** segment has no secret, so nothing in it can prove who wrote it. These limits follow from that, and each
is stated here once so you can decide with them in view.

| Limit | What it means | Who it affects |
| --- | --- | --- |
| **A cleartext object's identity is a CRC32C checksum, not a signature.** A CRC proves the bytes are the bytes that were written, which someone able to write your storage satisfies by construction | An object that passes the layout and range checks answers `has`, `count` and iteration as it was forged. The erasure receipt also skips re-reading two generations whose recorded footer checksum matches the object it opened or wrote, and on a cleartext segment a same-size substitute could present that checksum | A cleartext segment, and only someone who can **already write the bucket** |
| **An encrypted object's metadata block: its presence is not authenticated.** The block's content is sealed like the index; its minor version, trailer and section types are covered by CRCs, which take no key | Whoever can write the object can remove the block, and the generation then reads as one without metadata. It never changes a member id, and the row's sealed summary is the check | Callers who rely on a generation's metadata being present, against someone who can write the object |
| **An index's cardinality is not compared with its payload.** `count()` answers from the row's summary of the current generation, or from the index when the row has none it can use, without decoding a payload | An index that is internally consistent (key order and range, each cardinality in `1..65536`, payloads inside the payload region, footer totals, which are compared only on an unencrypted object) but wrong yields a wrong count. The summary is used only for the generation it names, on an active row, in the form the keys call for (a sealed summary only if it opens under its generation's associated data), and, when an object is opened anyway, the store holds the summary against it and stops using one that disagrees | A segment whose bucket has a writer you do not trust |
| **A registry writer can repoint to an older, genuine generation.** The pointer is a plain field of a row | A read returns stale data, not forged data; on an encrypted segment the older generation authenticates | Anyone who relies on the freshness of an answer against a registry writer |
| **The associated data names a generation number, not an object instance.** A number can be taken again once its object is deleted ([after a rollback, or a refused rewrite's discard](docs/guide/correctness.md#erasure-number-taken-again)) | An old object at that number authenticates under the same data key. The open is held to the row summary's fingerprint (the object's size and footer checksum, which includes a random write identity), so a replay needs a forged fingerprint | An encrypted segment whose bucket writer is also a registry writer |

**The advice that follows: encrypt a segment when not everyone who can write the bucket is trusted.** With encryption
wired, someone who can write objects but holds no key cannot make a read return a wrong member, cannot splice chunks
between generations or segments, and cannot downgrade by planting a cleartext object. They can still delete or withhold,
and, if they can also write the registry, repoint to an older genuine generation. Where encryption is off, treat write
access to the bucket as the ability to forge answers.

## Deployment advice

**Encrypt when bucket writers are not all trusted, and require it.** Build the store with a keystore and
`encryption: { required: true }`, so that a keyed store never reads or writes a cleartext segment and a cleartext object
under a keyed segment is refused (see the guarantees above). Keep key-encryption keys in a managed key store, hold a
recovery key offline in a separate place, and treat the key store as the root of trust: whoever can unwrap a data key
reads every segment it protects. Losing every key-encryption key that wraps a segment makes it unreadable, which is the
point of crypto-shred and the cost of a lost key.

**Least-privilege permissions, per driver.** Grant exactly the actions the library issues, and give a process that only
reads nothing that writes. The lists are derived from the calls each driver makes; the
[production checklist](docs/guide/production.md#permissions) has the sample policy and the optional lifecycle-check
permissions. `store.preflight()` checks them under the identity you run with, but it writes and deletes a small probe object, so it needs the loader's permissions and cannot pass for a read-only identity.

| Driver | The loader and eraser identity | A read-only identity |
| --- | --- | --- |
| **S3** | on the bucket, `s3:ListBucket`; on the objects under your prefix, `s3:GetObject`, `s3:PutObject`, `s3:DeleteObject` and `s3:AbortMultipartUpload` (a KMS-encrypted bucket also needs use of its key) | `s3:ListBucket` and `s3:GetObject` (without list, S3 answers a missing key with `403`); a KMS-encrypted bucket also needs the key's decrypt permission |
| **GCS** | `storage.objects.create`, `storage.objects.get`, `storage.objects.list` and `storage.objects.delete`, or `roles/storage.objectAdmin` on the bucket (a bucket with a customer-managed key also needs use of it) | `storage.objects.get` and `storage.objects.list`, and use of a customer-managed key where the bucket has one |
| **Azure Blob** | `Storage Blob Data Contributor` on the container (blocks, block lists, blobs and properties, listing, deletes); prefer a managed identity over a connection string, which carries the account key | `Storage Blob Data Reader` on the container |
| **Local files** | read, write and delete in one directory you own: the driver creates what it stores owner-only | read of that directory |

The registry rows (`registry/` under your prefix) and the objects (`<namespace>/segments/`) share a bucket. A
**registry write is the stronger permission**: it can repoint a pointer, so grant write to the registry prefix only to the
identity that loads and erases, and read-only to every reader. A permission split between the two prefixes narrows what a
leaked reader credential can do; it does not protect a segment from the loader's own identity. The local driver trusts its
root directory: keep it out of a location another user can plant a symlink into.

**Give the store a bucket of its own, and keep it that way.** Use a bucket (or a prefix) that only this store writes to,
so another job's write, an object lifecycle rule or a replication rule cannot touch it. Do not add a lifecycle rule that
expires current objects or the `registry/` prefix ([bucket lifecycle](docs/guide/production.md#bucket-lifecycle));
`store.preflight()` looks for one where it can read the rules.

**Versioning and backups keep copies that erasure cannot reach.** Erasing an id or crypto-shredding a segment acts on the
bucket and the row as they are now. A noncurrent object version, a cross-region replica, a backup, a locked object and a
point-in-time copy of the registry keep the older bytes until their own lifecycle removes them, and a restore can bring
an erased id back ([PRIVACY](PRIVACY.md), [disaster recovery](docs/guide/disaster-recovery.md)). Decide what you retain,
and plan the erasure of those copies, before you promise erasure to anyone.

**Key rotation, and what it does and does not re-encrypt.** To rotate, add a new key-encryption key and point
`activeKeyId` at it, and keep the old one for as long as any segment is wrapped under it. A rotation does **not**
re-encrypt any segment's data, and it does not re-wrap a segment that already exists: that segment keeps its data key and
the wrappings it was created with, so the old key still opens it. A new segment is wrapped under the active key, and the
recovery key when one is configured. To move an existing segment off an old key, load its ids into a new segment (a fresh data key), then
destroy the old one. Check a segment's wrappings by reading its row's `wrappedDeks`
([encryption](docs/guide/encryption.md#erase-a-segment-or-a-namespace-crypto-shred)).

**Bound your reads.** Set `readTimeoutMs` on `S3Storage`, `GcsStorage` and `AzureBlobStorage`: it is off by default, and
without it a request that hangs hangs its call (on a GCS 8.x or Azure Blob download it is the only bound on the body). The
library times no write, delete or listing, so bound those with a timeout on your own client
([reliability](docs/guide/production.md#reliability-retries-backoff--timeouts)).

**Limit what a caller can spend.** The memory ceiling, the intersection concurrency and the per-operation budgets are
yours to size ([production checklist](docs/guide/production.md)); a segment name a user chooses and an id a user supplies
are validated, but how many segments and how many ids you accept is a decision the library cannot make for you.

**Never log keys, ids or bitmap contents**, and never put a subject's id in a generation's metadata: erasure carries
metadata over unchanged and does not scan it.

## Dependency audit

CI runs a blocking dependency audit — [`node scripts/audit.cjs`](scripts/audit.cjs), a thin wrapper over
`pnpm audit --prod --json` — scoped to **production** dependencies at the **high** severity bar. A brand-new
advisory in a runtime dependency breaks the build. The **release workflow re-runs it** on the exact commit
being published rather than trusting CI's result, because this is the one gate whose verdict changes with no
commit at all: an advisory disclosed after `main` went green makes that unchanged tree newly vulnerable. (It is invoked as `node scripts/audit.cjs`, not bare
`pnpm audit`, which is pnpm's own built-in command.) Advisories that have been triaged as not-applicable are listed in
`package.json` → `pnpm.auditConfig.ignoreGhsas`, each with its rationale below, and are the **only** ones the
gate ignores.

### Forced transitive versions (`pnpm.overrides`)

Every advisory we have had sat in **development-only** transitive dependencies, so the blocking gate above —
scoped to production dependencies — correctly ignored them and CI was green. They still generated alerts, and
"correctly ignored" is not the same as "fine", so they are **fixed rather than accepted**: `package.json` →
`pnpm.overrides` forces each to a patched version, pinned inside its current major so an override never
smuggles in a breaking change.

| forced | reached us via | note |
| --- | --- | --- |
| `undici >=6.28.0 <7` | `roaring` (the test oracle, a dev dependency) -> `node-gyp` | |
| `brace-expansion >=5.0.12 <6` | `eslint` / `typescript-eslint`, through `minimatch` | |
| `nanoid >=3.3.18 <4` | the vitest toolchain | |
| `uuid ^11.1.1` | `@google-cloud/storage` | |
| `esbuild >=0.28.2 <0.29` | a direct devDependency, and `vitest` -> `vite` | |
| `source-map-js >=1.2.2 <2` | the vitest toolchain: `vite` -> `postcss` | |
| `shell-quote >=1.11.0 <2` | the changesets CLI: `@changesets/cli` -> `launch-editor` | |
| `launch-editor >=2.14.2 <3` | the changesets CLI: `@changesets/cli` -> `launch-editor` | |

An override is a **claim that the forced version still works**, which is only worth making if it is tested, and
only meaningful while something in the tree actually resolves to it. Every row above binds to at least one
package in `pnpm-lock.yaml` — `tests/docs/override-hygiene.test.ts` fails the build otherwise, because an
override matching nothing cannot be tested by any suite and quietly becomes a claim about a package that is not
here. Each was verified against the full `pnpm test:integration` suite (against the real backends in
containers — MinIO, fake-gcs-server and Azurite), which matters most for `uuid` under `@google-cloud/storage`:
it is the only one on a path the unit suite never exercises.

`uuid` is deliberately pinned to `^11.1.1` rather than left open: the advisory is fixed at 11.1.1, and an
unbounded range resolved to 14.x, which is three majors of blast radius for no security benefit.

**None of these overrides reach consumers.** A `pnpm.overrides` entry applies to *this workspace's* install
tree and is not part of any published manifest, so an installed `@cloudbitmaps/*` package resolves by the
ranges its own manifest declares. What a consumer actually gets is counted **per package** — none for
`@cloudbitmaps/core` and none for `@cloudbitmaps/tools`, none for the flavor, and one cloud SDK each for `/s3`, `/gcs` and `/azure-blob`
(the table in [CONTRIBUTING](CONTRIBUTING.md#dependency-policy) is the source). One of the packages above does
sit under a shipped SDK transitively — `uuid` under `@google-cloud/storage` — at whatever version that SDK
itself resolves, which is the surface to reason about here, not our pinned one. `undici` is **not** in that
category: it reaches this repo only through the test oracle's `roaring` dev dependency and its `node-gyp`, and never
through a package a consumer installs.

**A consumer's `npm audit` lists two moderate findings through `@cloudbitmaps/gcs`**: `uuid` below 11.1.1
([GHSA-w5hq-g745-h8pq](https://github.com/advisories/GHSA-w5hq-g745-h8pq)) and `gaxios`, which depends on it, by the
path `@cloudbitmaps/gcs` → `@google-cloud/storage` → `gaxios` → `uuid@9`. The advisory is a missing bounds check in
`uuid`'s `v3`, `v5` and `v6` when the caller passes a buffer to fill. `gaxios` calls `uuid.v4()` with no buffer
argument, to make a multipart boundary, so the flaw is not reachable here. The finding clears when the upstream SDK moves
to a `gaxios` that no longer depends on that `uuid`; a consumer that gates on `npm audit` can add
`"overrides": { "uuid": "^11.1.1" }` to its own manifest in the meantime. No other `@cloudbitmaps` package, and no
other SDK it installs, shows a finding.

### Triaged (accepted) advisories

**Currently empty.** No advisory is being ignored — every one the gate sees is either fixed or absent.

**The bar for adding an entry here:** a rationale that names the exact path the advisory would have to travel to
matter, plus a concrete condition under which the entry gets removed. An accepted advisory with no revisit
condition is an unmaintained one. If any accepted advisory ever becomes reachable from a runtime path, the entry
must be removed and the advisory addressed, not ignored.

## Supply chain (build, publish & provenance)

CloudBitmaps is published through a hardened pipeline so that a consumer can verify **exactly what source
produced the package they installed**. In short:

| Control | What it gives you |
| --- | --- |
| **npm Trusted Publishing, no token** | No long-lived npm credential exists to steal: the release workflow authenticates with a short-lived identity token bound to this repository, workflow and environment |
| **Provenance on every package** | A signed attestation links each tarball to the workflow, repository and commit that built it; verify with `npm audit signatures` or the "Provenance" panel on the package's npm page |
| **A required reviewer on the `release` environment** | The publish job pauses until the maintainer approves it, and nothing publishes before |
| **Every CI action pinned to a full commit SHA** | A moved or hijacked tag cannot inject code into the build |
| **Frozen installs** | `pnpm install --frozen-lockfile` in CI and release; build scripts of dependencies are limited to an allowlist |
| **The dependency audit and the leak scan** | A blocking production audit at high severity, re-run on the exact release commit; the packed tarballs are scanned for credentials, keys, emails, local paths and cloud account ids before publish |
| **CodeQL** | Static analysis on every pull request, every push to `main` and weekly |
| **Fuzzing** | Coverage-guided fuzz targets run nightly, with a longer weekly soak |
| **Least-privilege workflows** | Read-only repository access by default; the publish job cannot write to the repository |

**What a published package contains.** Each of the six packages ships only its `dist/` build, `README.md`, `LICENSE` and
`NOTICE` (the flavor also ships `PRIVACY.md`). Core has no runtime dependencies and no cloud SDK; each driver package has
one cloud SDK. A pull request cannot reach a secret: no workflow runs on `pull_request_target`, `workflow_run` or
`issue_comment`, untrusted text (a title, a branch name, an input) reaches a script only through an environment variable,
and the one secret CI holds is withheld from pull requests opened from forks.

The controls in full:

- **Static analysis.** The [CodeQL workflow](.github/workflows/codeql.yml) analyses the JavaScript and TypeScript
  source on every pull request, on every push to `main` and weekly, and reports findings as code-scanning alerts. It
  covers the packages, the scripts and bench harnesses that CI runs, and the site; it leaves out the test suite and
  the fuzz harnesses, which ship nowhere. Its action versions are pinned to commits like every other workflow's.
- **Build provenance (SLSA).** The [release workflow](.github/workflows/release.yml) publishes with `--provenance` and
  `NPM_CONFIG_PROVENANCE=true`, set at the call site rather than in the manifests. (A manifest's
  `publishConfig.provenance: true` would be strictly worse: it cannot be overridden by the CLI *or* the environment, so
  every non-CI publish — the bootstrap and the break-glass path both — would abort with
  `EUSAGE: … not supported for provider: null`. Opting in where provenance is actually achievable keeps the guarantee
  without the trap.) npm records a **signed, publicly-verifiable attestation** linking the tarball to the exact GitHub
  Actions workflow, repository, and commit that built it, minted via GitHub **OIDC** (the job runs on a GitHub-hosted
  runner with `id-token: write` and no other write scope). Verify an installed copy with **`npm audit signatures`**, or
  read the "Provenance" panel on the package's npm page. A tarball whose provenance doesn't trace to this repo's release
  workflow should be treated as untrusted. A *publicly-verifiable* attestation requires the source repository to be
  public and the package published under a real version — both true of every release, so every tarball **published by
  the release workflow** carries an attestation you can check yourself. **One deliberate exception, and it is visible on
  the registry.** Creating a package name needs a first publish, and npm's Trusted Publisher cannot be bound to a name
  that does not yet exist — so a new name is bootstrapped by hand, from a laptop, which has no workflow identity and
  therefore no provenance. Those are published under the `rc` dist-tag at a throwaway prerelease of the family version
  (for example `X.Y.Z-rc.0` for family version `X.Y.Z`). The registry can point `latest` at a name's first publish, so
  until the real release ships, a plain install of a new name may serve that prerelease. If you are checking signatures,
  expect exactly those prerelease versions, and the `0.0.0-stage` stub npm creates beside a first publish, to have none,
  and treat an unattested tarball at a **real** version as untrusted.
- **Publish only a re-verified tree.** The release workflow re-runs the gate that governs the artifact
  (`lint · lint:arch · format:check · typecheck · test · audit · build · api:surface:check · smoke`, plus a `leak-scan` of the
  packed tarball) against the exact commit being published before the tarball is created — a green `main` is
  necessary but not sufficient. CI's site and fuzz-lockfile checks are not repeated here; they guard what is
  served from `main`, not what is published. The workflow publishes only from a `vX.Y.Z` tag ref, and every package's
  version must match that tag, or the release fails. A manual dispatch with `dryRun: false` publishes only when
  dispatched on a tag, where it runs the same tag/version check and release-notes check; on a branch or any other ref
  it fails before any build or publish step. That rule stops a mistaken publish from the wrong ref; it is not an access
  control, because a dispatch on a branch runs that branch's own copy of the workflow file. What stops anyone else from
  publishing is the `release` environment's required reviewer and the npm Trusted Publisher binding to this repository
  and workflow. A manual run, from any ref, creates no GitHub Release.
- **Reproducible, frozen installs.** Both CI and the release build use `pnpm install --frozen-lockfile` (fails
  on a stale lockfile). Consumers get the same guarantee with **`npm ci`** against a committed lockfile. Three CI jobs
  install from the registry without a lockfile, each inside a container: the consumer install (the six packed tarballs
  and the cloud SDKs), and `lambda-smoke` and `rss-gate` (`roaring` at its locked version, with its own dependencies
  resolved fresh). The consumer install's container mounts nothing writable from the host and passes no environment
  in, and its job holds no secret and restores and saves no cache; the release workflow does not run it.
- **SHA-pinned GitHub Actions.** Every third-party `uses:`, in every workflow and in the composite actions under
  `.github/actions/`, is pinned to a **full commit SHA** (with a `# vX` comment for readability), so a hijacked or
  force-moved tag on a third-party Action cannot inject code into our build. A local action
  (`uses: ./.github/actions/…`) is read from the same commit as the workflow that uses it, so it has no tag to move.
  Bumps are deliberate (Dependabot's `github-actions` ecosystem, monthly + grouped, over the workflows and the
  composite actions).
- **The Actions cache is trusted like the code.** CI restores pnpm's store and the container images its jobs run
  from the Actions cache, and runs what it restores. Only runs on `main` write entries every run can restore; a pull
  request's runs write entries only its own later runs read. So after anything untrusted has run in a workflow on
  `main`, such as a compromised dependency or Action, delete every cache entry (`gh cache delete --all`) as well as
  reverting it: an entry it wrote would be restored by later runs. Three jobs run unpinned registry code, each inside a
  container: the consumer install, `lambda-smoke` and `rss-gate`. The consumer install shares no cache with any other job
  (it restores none and saves none), so nothing it ran can become an entry another job restores; the other two restore
  the pnpm cache and save the container-image cache, and a container escape from either is the risk this section accepts.
- **The published tarball is scanned, not just the source.** Before publishing, the release workflow packs each
  package, unpacks the `.tgz` and scans **what actually ships**
  ([`scripts/leak-scan-tarballs.cjs`](scripts/leak-scan-tarballs.cjs)) for credentials, private keys, real email
  addresses, absolute local machine paths, AWS account ids and ARNs. This is deliberately a different surface from scanning the repo:
  `dist/` is gitignored, so a source-tree or git-history scan cannot see the majority of the published bytes —
  and the sourcemaps carry every `src` comment verbatim in `sourcesContent`. It runs **before** the publish
  because an npm tarball is immutable outside the 72-hour unpublish window; there is no fixing a string that
  has already shipped.
- **Recoverable checks run before the irreversible one.** Every gate above that a run performs — the re-run test
  suite, the audit, the tag/version agreement, the release-notes check, the tarball scan — precedes `pnpm publish`,
  and [`tests/ci/release-workflow.test.ts`](tests/ci/release-workflow.test.ts) fails if the audit, the tag/version
  agreement, the release-notes check or the tarball scan is ever moved after it. A release is also never cancelled in flight (`cancel-in-progress: false`), so the six packages
  cannot be left half-published.
- **Least-privilege CI.** Workflows declare minimal `permissions:`: the workflow-level default is
  `contents: read`, and the release workflow adds `id-token: write` for provenance. **Exactly one job holds
  `contents: write`** — `github-release`, which creates the GitHub Release object and cannot publish. The job
  that *does* publish never holds it, which is the point of splitting them: the write scope lives on the job
  an attacker gains least from. Enforced, not merely stated —
  [`tests/ci/release-workflow.test.ts`](tests/ci/release-workflow.test.ts) resolves **effective** permissions
  (job-level, falling back to workflow-level) and fails if the publish job can ever write to the repo.

Releases run through the workflow, apart from the two hand-run paths named above — a new name's bootstrap
prerelease, and the [break-glass release](RELEASING.md#manual--break-glass-release) — neither of which carries
provenance. The workflow can also be dispatched by hand (`workflow_dispatch`): with `dryRun: true`, the default, it
runs as a **dry run**, which exercises the **full gate + tarball pack** without publishing — a dry run mints no
attestation, by design; with `dryRun: false` it publishes only when dispatched on a version tag, where it runs the same checks as a tag push
(see *Publish only a re-verified tree* above); on any other ref it fails before any build or publish step. Either way a
manual run creates no GitHub Release.

**One limit, stated as it is.** The publish job runs `pnpm install --frozen-lockfile` and the gate in the same job that
can ask for the publish token, so a malicious locked dependency whose build script is on the allowlist could run there;
the frozen lockfile, the allowlist and the reviewer's pause before anything runs are what stand against it. Any publish through the workflow needs the `release`
environment's reviewer, and the Trusted Publisher is bound to the workflow and environment. The two hand-run paths above
(a new name's bootstrap and the break-glass release) need no reviewer: only the maintainer can perform them, on the
npm account's own protections (its login and two-factor authentication).

## Out of scope

These are not vulnerabilities in CloudBitmaps. They are stated once here so a report does not turn on them.

- **Resource limits you set.** A memory ceiling, a concurrency or a budget you configure too high, a segment count or id
  count your application accepts, or a request timeout you leave off. These are configuration; [Deployment
  advice](#deployment-advice) says what to set.
- **Someone who can write your bucket forging a cleartext segment's objects.** On a cleartext segment nothing
  authenticates an object, by design ([What is not authenticated](#what-is-not-authenticated-by-design)); encrypt the
  segment.
- **Someone who holds your key-encryption key reading what it wraps**, or a key store that is mis-configured or
  compromised. The library never stores a key-encryption key.
- **Someone with write access to the registry repointing a segment** to an older genuine generation, or deleting or
  withholding objects. Permissions are what protect those.
- **Copies you keep.** Backups, versioned or replicated objects and registry copies that you retain are yours to erase
  ([Deployment advice](#deployment-advice)).
- **A caller who changes a buffer while a load reads it**, or who puts a secret in a segment name, a bucket name or a
  generation's metadata.
- **The local driver on a root another user can write to**, or whose path holds a symlink you did not intend.
- **A vulnerability in a cloud provider's service or SDK**, or in a test-only dependency that no published package
  installs. Report those upstream; the [dependency audit](#dependency-audit) covers what a published package installs.
- **Findings with no attacker capability**: a crash or wrong answer reachable only by a caller who already holds your
  credentials and the process itself.

If you are unsure whether something is in scope, report it privately; we would rather read it.
