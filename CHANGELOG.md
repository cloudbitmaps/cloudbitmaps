# Changelog

All notable, user-facing changes to CloudRoaring are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the project adopts
[Semantic Versioning](https://semver.org/) from **v0.1.0**.

> **Pre-release.** Everything accumulates under **[Unreleased]** until the `0.1.0` launch
> (Phase 9) cuts the first versioned section and begins SemVer. Until then
> this doubles as the running dev log; for granular per-phase detail see the
> roadmap and phase docs, and for *why* decisions were made the
> decision log.

## [Unreleased]

### Added

- **Release auth is now tokenless** (DECISIONS #64) — `release.yml` carries **no
  `NPM_TOKEN`**, publishes from the workflow's GitHub OIDC identity (npm Trusted Publishing), runs behind a
  protected `release` environment whose required reviewer is the approval gate, and sets
  `NPM_CONFIG_PROVENANCE=true`. Root [`RELEASING.md`](RELEASING.md) documents the pipeline, the one-time npm +
  GitHub setup, and the break-glass path.
  - **This resolves a trap rather than dodging it.** Setting a package to *"require 2FA and disallow tokens"* —
    which the standards ask for — **rejects an automation-token publish outright**, so token auth and that
    hardening are mutually exclusive. Trusted Publishing is not a token, so it passes. Choosing the token model
    would have meant silently dropping the hardening.
  - **Bootstrap:** a Trusted Publisher is a *per-package* setting and needs the package to exist, so the very
    first version is published manually with interactive 2FA — the order both sibling projects actually used,
    confirmed from their git history. One-time, not a standing token. Since a manual publish carries no
    provenance attestation, [`RELEASING.md`](RELEASING.md) documents two bootstraps: publish `0.1.0` manually
    (as the siblings did), or publish a throwaway `0.1.0-rc.0` to create the names and ship the real `0.1.0`
    through the gated workflow **with** provenance. **The prerelease route is the chosen one** — deliberately
    diverging from the siblings so the launch artifact isn't the single unattested tarball in a project whose
    supply-chain story is the point.
  - The decision was taken by **matching the sibling projects** (`onadiet`, `babystack` already publish this way)
    rather than inventing a third model; cloud-roaring was the outlier. The tag trigger and its two guards —
    tag↔version agreement, and refusing to "publish" a still-`private` package that `pnpm publish` would silently
    skip while exiting 0 — are kept as-is.
- **Internal-doc citations removed from shipped code comments** (Phase 9 Stage 3). Packing the tarballs revealed
  **362** internal-doc references inside the published `@cloudbitmaps/core` artifact (and 20 in `roaring`) —
  carried there by preserved JSDoc and by sourcemap `sourcesContent`, which copies every source comment verbatim.
  Two consequences: a user hovering a type in their editor saw links that would **404** (that directory is dropped
  from the public snapshot), and `leak-scan --snapshot` fatally failed the tarball. Every citation is now replaced
  by the fact it was pointing at — a comment should *say* the thing, not cite a file the reader cannot open. Also
  swept the `spec-04` / `spec-09` shorthand, which had the same problem in disguise. **Now 0 in both tarballs.**
- **Three real defects in `pnpm leak-scan`, found by actually scanning the npm tarballs** (Phase 9 Stage 3) — and
  `tests/scripts/leak-scan.test.ts`, the test file that should have existed from the start. Nothing in the gate
  guarded the script that decides whether a tree is safe to publish, which is why all three survived.
  - **False positive that would have failed the launch gate.** `const token = crypto.randomUUID();` was reported
    as a "hardcoded secret literal" — the callee is 17 characters of otherwise-legal literal characters. It fired
    on **five shipped driver bundles** (the random-UUID OCC tokens) and made `leak-scan --snapshot` fail the core
    tarball outright. Not cosmetic: a scanner that cries wolf gets bypassed with `--force`, and then it protects
    nothing. Call expressions are now rejected as values.
  - **False negative.** Any env-var name with a *suffix* slipped through, because the keyword had to sit
    immediately before the `=`/`:` — so `DJANGO_SECRET_KEY=…` and `MY_API_TOKEN_VALUE=…` were both unflagged, and
    the `SECRET_KEY` convention is near-universal. Verified against the pre-fix script rather than assumed.
    (`AWS_SECRET_ACCESS_KEY` was *never* in this gap — it has its own dedicated rule. Worth stating because it is
    the example one reaches for first, and it is wrong.) An all-numeric-value exclusion keeps the widening from
    tripping on `tokenExpiryNanos = 1730000000000000000`.
  - **Two rules disagreeing.** The URL rule carefully exempted `mysql://root:pw@host.docker.internal` — and then
    the *email* rule flagged `pw@host.docker.internal` anyway, so a compose DSN still failed. The loopback/compose
    host list is now defined once and shared, since keeping two copies is what caused it.
  - The scanner also skips its own test file by exact path (that file exists to hold secret-*shaped* fixtures, the
    same reasoning that keeps `.leak-needles` gitignored) — an exact-path allowlist, not a `tests/` glob, because a
    real credential under `tests/` is still a real credential.
- **Planned: `analyze` — decide before adopting** (Phase 9.5, DECISIONS #63). Not built; scoped on paper. Every cost tool we ship currently
  presupposes adoption — `costReport()` needs data already in CloudRoaring, `estimateCost()` needs half a dozen
  guessed parameters — so the thing that would *convince* a team to adopt requires them to have adopted. `analyze`
  streams a candidate's own ids through `bulkLoadCrbmGeneration` into a Memory/LocalFs driver (**no cloud account,
  no credentials, nothing created**) to *measure* cardinality, `.crbm` bytes and above all **chunk density** — the
  figure nobody can guess and the one that drives everything — then feeds those measured numbers to `estimateCost`
  in place of the guesses. It will refuse to invent what it can't know: traffic rates and arrival pattern stay
  caller-declared and labelled as such. Stage **9.5b** adds the *"do you even need the native addon?"* comparison
  (a plain per-chunk bitset is exactly `chunkCount × 8192` bytes against a measured roaring size — ratio ~1 ⇒ skip
  CRoaring and deploy to edge runtimes), gated on the `bitmap` flavor existing.
- **`CostReport.advisories` — the estimator now compares you to *us*, not only to Redis** (DECISIONS #62).
  `verdict` has always been Redis-relative, which left a blind spot: feed it the id-at-a-time write shape and it
  returns `'win-big'` — true, and thoroughly misleading, because you can beat the $346/mo baseline by 40× while
  paying ~150× more than *this same library* would charge for the same outcome. `advisories` is a second,
  self-relative channel that closes it.
  - Ships one code, **`'batchable-writes'`**, carrying `currentUSD` and `batchedFloorUSD`. Empty array is the
    normal case (never `undefined`, so consumers iterate unconditionally); dollar figures, `verdict` and
    `rationale` are untouched.
  - **The trigger is arithmetic, not a heuristic.** A 16-bit chunk key caps a segment at 65,536 warm rows, and a
    segment can't occupy more rows than it holds ids — so if modeled writes/month far exceed that bound, the same
    rows are provably being rewritten many times over.
  - **The bound is deliberately an *upper* bound.** Over-stating it only makes the advisory quieter; under-stating
    it makes it fire on already-optimal workloads, which trains people to ignore it — at which point the feature is
    worse than absent. Byte-derived cardinality is rejected for exactly this reason (it understates a dense 8 KiB
    bitmap container by ~16×). Two further gates keep it quiet: a ratio floor of 8 and a $1/mo savings floor.
  - **A hit is a prompt to check, not an accusation** — the message says so. If those ids genuinely arrive one at a
    time (real-time qualification) then `add()` *is* the right path; the estimator sees the shape, not the arrival
    pattern.
  - **Planning-time by design.** Detecting this at runtime would put a counter, map lookup and clock read on every
    `add()` — the hot path everyone pays for, taxed to catch a mistake a minority makes once. Rejected outright
    rather than deferred.
- **Corrected: `add()`-in-a-loop at scale costs more than we published.** "$7.50 for 10M ids" was a **floor**, not
  the figure. The measured $0.75/million holds for warm rows ≤1 KiB — what the calibration run exercised at ~500
  ids/segment — but DynamoDB bills writes per **1 KiB** and a chunk's delta grows as you fill it, so a full ~8 KiB
  roaring-bitmap row costs 2 RRU + 8 WRU = **$5.25/million**, i.e. ~$52 for the same 10M ids. **Denser data makes
  the loop worse**, which is precisely the case where bulk-load was the obvious call. Now published as a range in
  the README, benchmarks page, and guide.
- **`pnpm test` now validates doc *anchors*, not just paths** (`tests/docs/links.test.ts`). Resolving the path
  was never the whole invariant: `[x](docs/benchmarks.md#renamed-heading)` passed the existing check and still
  dumped the reader at the top of the page with no signal anything was wrong. Adding the check immediately found
  three real breaks — a stale table-of-contents entry in the threat model, and **six** links to a phase-doc
  heading that had since gained a `*(gate — ☑ SHIPPED)*` suffix (fixed with a stable `<a id>` so a future status
  edit can't break them again). The subtlety worth recording: GitHub maps **each** space to a hyphen, so
  `## Cost & performance` is `cost--performance` — collapsing whitespace runs instead would have declared most of
  this repo's own correct links broken, and the slugifier is unit-tested against that specific mistake.
- **Real-cloud calibration — MEASURED.** The library's cost claim is no longer a model. Run
  `2026-07-25-60291` against real S3 + DynamoDB in `us-east-1` (20 segments / 2,000 `add`s / 20 publishes /
  2,000 `count`s, concurrency 16) cost **$0.001911** across 6,355 billed requests, against an always-on
  Redis-HA line of **$346/mo**. Unit economics: **$0.75 per million** incremental writes, **$0.14 per million**
  `count()`s, **$5.88 per million** segment publishes. Published with the full method, the cost-safety evidence,
  and what it does *not* establish, in [`docs/benchmarks.md`](docs/benchmarks.md#real-cloud-calibration--aws).
  - **The run measured two things the estimator could only assume.** **Zero SDK retry billing** — `attempts`
    equalled `commands` for every command type (6,355 = 6,355), so no throttle/5xx storm quietly multiplied the
    bill; and a **2.65% OCC conflict rate** (53 retries over 2,053 write attempts = 1.027 attempts per write,
    against the engine's bound of 17). It also confirmed `cold.list = 0` — LIST bills at the PUT rate, 12.5× a
    GET, so a stray list-per-read is the classic cost blowup in this design, and the read path issues none.
  - **The pre-flight projection was 95× the actual, by design.** It assumes every write exhausts all 16 OCC
    retries, making the spend ceiling a true upper bound rather than a forecast — a run that fits under it cannot
    surprise you, and one that does not gets refused rather than trimmed. (It refused at $0.10.)
  - **Latency was measured but does *not* calibrate the in-region claim, and the docs now say so.** The client sat
    outside the region: a same-machine TCP probe put the network floor at **96.0 ms** to DynamoDB and 92.6 ms to
    S3, which decomposes the phases exactly — READ p50 95.47 ms ≈ **one** round trip, WRITE p50 197.72 ms ≈ **two**
    (`add()` is `GetItem` then conditional `UpdateItem` under OCC), and throughput tracks concurrency ÷ latency
    rather than any engine ceiling. Since the North Star warm-`has()` target is
    single-digit-to-~25 ms and the floor here is ~4× that whole budget, run 1 neither confirms nor contradicts it.
    An **in-region run** (Lambda/EC2 in `us-east-1`) is recorded as the named follow-up in
    96-PRODUCTION-READINESS, and no in-region figure is published until
    it happens.
  - **One honest floor:** AWS bills a failed conditional write at 1 WCU, but the 53
    `ConditionalCheckFailedException` responses carried no `ConsumedCapacity`, so the meter could not recover those
    units. True total ≈ $0.001944; the published figure understates by $0.000033. Disclosed on the page.
- **Real-cloud calibration harness** (`pnpm calibrate:aws`) — Phase 9 Stage 2, the tool behind the numbers above.
  Drives the real S3 + DynamoDB drivers against a real AWS account through the same three phases as `pnpm load`
  (WRITE / PUBLISH / READ), timing every op for p50/p99/p999 and metering every billable request. Method, safety
  properties, a per-run log, and an explicit list of what a run does **not** cover:
  the real-cloud method doc.
  - **Ops are metered at the AWS SDK layer, not through our own telemetry.** `IMetricsSink` emits only
    `cold.get`/`warm.read`/`warm.write`, so it cannot see S3 **PUTs** — the ingest path, billed at **12.5× a
    GET** — nor LIST, DELETE, or any registry operation. A cost figure derived from an op set missing the most
    expensive write would be an overclaim, so the harness counts commands on the client itself.
  - **DynamoDB cost comes from AWS's own numbers.** The meter injects `ReturnConsumedCapacity: 'TOTAL'` and reads
    the units back off each response, replacing our size→`ceil`→units estimate (which mis-rounds on a
    size-varied workload) with the capacity AWS reports consuming.
  - **Safety, because it spends money:** dry-run by default; a hard `CR_CALIBRATE_MAX_USD` ceiling checked
    against a projection computed the same way the result is; a required explicit region (no default — a silent
    us-east-1 fallback is how you bill the wrong account); typed confirmation; the account identity printed
    before anything is created; uniquely-named, cost-allocation-tagged resources; a refusal to touch any
    pre-existing bucket or table; and teardown from the `finally`, from a SIGINT/SIGTERM handler, or by
    `--cleanup <runId>` after an uncatchable kill. Every one of these was verified against LocalStack.
  - `CR_CALIBRATE_ENDPOINT` rehearses the whole harness against LocalStack for free, so a real-account run has no
    untested moving parts. Rehearsal also relaxes SDK checksum validation (LocalStack doesn't implement it
    fully); a **real** run leaves validation on, because end-to-end integrity is something a calibration run
    should be exercising.
- **`bench/lib/measure.cjs`** — the latency and cost maths are now shared by the LocalStack and AWS harnesses, so
  the *arithmetic* cannot drift between them. Their **dollar** figures are still not comparable, and the review
  quantified why: the LocalStack one **over-states S3 GET cost by ~90×**, because `IMetricsSink` counts *logical*
  chunk reads and the `.crbm` reader answers most of them from its cached index with no HTTP request at all
  (1901 events carrying 1016 total bytes in the committed result). Disclosed in the harness output, the method
  doc, and the test-strategy figure that quoted it.
- **`pnpm test` now guards the calibration script's refusal paths** (`tests/bench/calibrate-guards.test.ts`, 19
  cases on the pure-projection path — no AWS, no credentials, no cost).

- **Launch prep — the repo is now presentable to the public** (Phase 9, Stage 1 of the launch runbook):
  - **A public [roadmap](docs/ROADMAP.md)** — what's shipped, the **validated envelope** (what's proven, at what
    scale, and what isn't), the path to `1.0`, and an explicit *deliberately not planned* list. It is a curated,
    public-safe subset of the internal roadmap, and `CONTRIBUTING.md` now requires the two to move together.
  - **Community-health files** — a Contributor Covenant [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md), issue forms
    (bug / feature, routing security reports to the private policy and questions to Discussions), and a pull
    request template tailored to this project's gate rather than generic filler.
  - **README badges** — npm version, CI, license, and supported Node. The npm/Node badges read the registry and
    the CI badge needs a public repo, so all three resolve themselves at launch.
  - **`pnpm leak-scan`** — the pre-publish gate. Always fatal: credentials (including the unquoted `.env`/YAML
    shapes, which is how secrets actually leak), private keys, non-noreply email addresses, and absolute local
    machine paths. Fatal under `--snapshot`: stale old-owner URLs and dangling private-doc references, in both
    the path form and the bare `NN-DOC-NAME.md` form. Scans tracked files, an arbitrary directory (`--dir`, for
    an **unpacked npm tarball** — the artifact no git-based scan can see and the one that's immutable once
    published), or every blob reachable from **every ref** (`--history`; `git log -p` walks HEAD only and emits
    no diff for merge commits, so it would miss a secret added as a merge resolution or left on an unmerged
    branch — both of which `git push --mirror` carries).
  - **`pnpm verify-blob-hashes`** — content-verifies a repo migration by **git blob hash**, so the package
    split's renames don't produce false alarms; relocated matches are listed rather than silently counted,
    because duplicated content (the per-package `LICENSE`/`NOTICE`/`PRIVACY.md` copies) would otherwise mask a
    real deletion. Nothing gets archived until every file provably survives.
  - **Three new doc gates** — every relative link in the docs, `site/`, and `.github/` resolves; `site/` and the
    public roadmap link nothing at a private path (which the snapshot drops, so those links resolve locally
    and 404 only in public — the reason five of them survived the package split); no user-facing file tells a
    reader to install or import the retired unscoped `cloud-roaring` name; and the exported `VERSION` matches
    **both** package manifests, pinning the lockstep-release invariant that previously had no test.

### Changed

- **Both packages are versioned `0.1.0`**, still carrying `private: true` — the last accidental-publish guard,
  removed only by the release commit. `pnpm publish` *silently skips* a private package (no error, exit 0), which
  would have turned a real release attempt into a fully green run that published nothing — so the release
  workflow now **fails loudly** on a still-private package, and the runbook verifies both packages on the
  registry afterwards rather than trusting a clean log.
- **Both packages gained `prepack`**, so a publish can never ship a stale or absent `dist`.

- **Launch decisions locked** (DECISIONS #60): the public repo will be
  **`cloudbitmaps/cloudbitmaps`** — the family monorepo, not a flavor name — with language ports as suffixed
  siblings; and the repo goes **public before the first publish**, so `0.1.0` ships with npm build provenance
  (which requires a public source repo) instead of deferring the attestation.

### Fixed

- **The calibration script's spend ceiling could be silently deleted.** A non-numeric `CR_CALIBRATE_MAX_USD`
  (`1,00`, `$1.00`, `abc`) parses to `NaN`, and `total > NaN` is `false` — so the documented "real bound" wasn't
  one. Now rejected, and regression-tested.
- **Refusing a pre-existing DynamoDB table orphaned the S3 bucket it had just created**, and bailed via
  `process.exit`, which skips `finally` — so nothing was even printed about the leak. Both existence probes now
  run before either resource is created.
- **Three exit paths raced each other's teardown.** A SIGTERM'd run printed only one of two deletes because the
  top-level catch's `process.exit(1)` killed an in-flight `DeleteTable`. There is now one memoised teardown
  promise awaited by the `finally`, the signal handler, and the catch. Re-verified at two interrupt points: both
  deletes complete, zero leftovers.
- **A signal during table creation would have torn down nothing** — `createFresh` returned a fresh `created`
  object, so the caller's copy stayed all-false for up to the 120 s `waitUntilTableExists` window on real AWS.
- **The meter counted commands, not billed requests, and lost capacity on failures.** It sat above the SDK's
  retry loop, so a throttled run — the case calibration exists to catch — would have under-reported. Split into
  two middlewares: attempts are tallied inside the retry loop, capacity and byte sizes are read where the output
  is actually parsed, and a failed data-plane command's `ConsumedCapacity` is recovered off the error (an OCC
  `ConditionalCheckFailedException` consumes capacity like any other write).
- **Published op counts disagreed with the published cost.** `measuredOps` was assigned by reference, so
  teardown's own LIST/DELETE landed in it *after* cost was computed — anyone recomputing cost from the counts got
  a higher number. Snapshotted now.
- **`CR_CALIBRATE_WRITES=0` ran the full default workload**, because the shared `int()` helper maps 0 to the
  default. Sizes now mean what they say, and a malformed one is an error.
- **The projection was not a bound.** Measured writes came within *one request* of a ×2 projection, so the
  multipliers were raised and the ceiling is additionally re-checked against measured cost after every phase.
- **A silently understated DynamoDB cost can no longer be published as a measurement** — if fewer capacity units
  are reported than requests issued, the run warns and stamps `cost.capacityWarning` into the result.
- `--cleanup <runId>` was documented but only the env var was read; an empty `CR_CALIBRATE_RUN_ID` would have
  named resources `cloudbitmaps-calib-`.
- **A present-but-empty `CR_CALIBRATE_ENDPOINT` meant "real AWS".** `CR_CALIBRATE_ENDPOINT=$LOCALSTACK` with the
  variable unset turned the documented *free rehearsal* — whose command line already carries
  `CR_CALIBRATE_CONFIRM=spend-real-money` — into a billed run, and for `--cleanup` a deletion aimed at a real
  account. Now an error.
- **A second Ctrl-C leaked everything.** `process.once` meant an impatient repeat signal during teardown reached
  Node's default handler and killed the process mid-delete, leaking bucket, objects and table with no warning —
  immediately after printing "tearing down before exit". Teardown is 4+ round trips on real AWS, so "press it
  again" is the expected reaction. It now warns and prints the recovery command.
- **A failed existence probe read as "absent".** `HeadBucket` answers **403, not 404**, for a bucket you own but
  can't `ListBucket` — and in **us-east-1** `CreateBucket` on a bucket you already own returns **200 OK**. The run
  would have written into your bucket and teardown would then have emptied and deleted it. Only a genuine
  not-found now counts as absent.
- **The projection still wasn't a bound.** Each OCC retry round issues another `GetItem` + `UpdateItem`, so reads
  and writes track each other — but reads had the *smaller* multiplier, so the read slot always breached first
  (measured 237 against a projected 186, triggered by `CONCURRENCY > SEGMENTS`, i.e. exactly what you'd set to
  make a run cheaper). Both now derive from the engine's own OCC retry bound, and the ceiling is additionally
  enforced **during** the WRITE phase rather than only at phase boundaries.
- **The failure counter was inverted.** A 4xx (`ConditionalCheckFailedException` — the dominant OCC case)
  *resolves* at the `deserialize` step, because the SDK's own deserializer sits outside the middleware, so it was
  recorded as a clean success and `failedAttempts` published `{}` on runs full of conflicts. Meanwhile a
  transport failure, where nothing reached AWS and nothing was billed, was counted as a billed attempt.
  Classification is now off the HTTP status. A rehearsal that reported 0 failures now reports 131.
- **Teardown couldn't empty a versioned bucket or abort an in-flight multipart upload** — the parts are billed,
  and real `DeleteBucket` refuses while one is in progress, so the last-resort cleanup tool could dead-end. It now
  aborts uploads and deletes object versions plus delete-markers.
- **A crashed run discarded every measurement it had already paid for** (reproducible: OCC exhaustion at ~90% of
  the workload). Results are now written from the `finally`, flagged `partial`.
- **`--cleanup` reported non-existent resources as leftovers that "will keep costing money"** — crying wolf on the
  common case, which trains you to ignore the one signal that matters for spend.
- The identity check could print **"@aws-sdk/client-sts is not installed"** when the real cause was an expired
  token, resolved credentials *separately* from the clients doing the work, and only ever printed the account at
  someone rather than checking it. Both clients must now agree, and `CR_CALIBRATE_EXPECT_ACCOUNT` is enforced.
- Percentiles a sample can't support now print `—` instead of a number: with n < 1000, `p999` degenerates to
  `max`, so a 20-op phase was presenting p99/p999/max as three statistics drawn from one observation.
- Meter details: don't mutate the caller's input object; count the harness's own bucket-lifecycle requests
  (billed); sum array-shaped `ConsumedCapacity` from batch/transact commands; add `TransactGetItems`.

- **The three `pnpm fuzz:*` targets silently lost coverage guidance under any other directory name.** They
  filtered instrumentation with `--includes cloud-roaring/fuzz/build`, a path substring that matched only because
  the checkout directory happened to be called `cloud-roaring`. Renaming the repo — which the launch will do —
  loaded **1 module / 512 counters instead of 2 / 663**, dropping our own code from the fuzzer's feedback loop
  while the nightly job still exited 0. Now `--includes fuzz/build`, verified to instrument identically on all
  three targets.

- **`site/` still told readers to `npm i cloud-roaring` and to import from `'cloud-roaring'`** — 32 occurrences
  across all four pages, missed when the package split swept the source and the docs. That package is a
  non-functional `0.0.0` placeholder, so every copy-pasteable example on the most shareable surface we have
  produced an empty install and a `Cannot find module`. Now guarded by a test.
- **Five `site/` pages linked into the private docs tree** — a path the public snapshot drops, so they resolved
  locally and would have 404'd only once deployed. Also a `src/` path stale since the package split, and
  `docs/guide/`'s pointer to the conformance suite.
- **The shipped `packages/roaring/PRIVACY.md` linked `docs/guide/…` relatively** — but the tarball contains no
  `docs/` tree, so those links were dead for every npm reader. It also cited a private adversarial-research doc
  by name, inside an artifact that is immutable once published.
- **`site/`'s status block** still described the drivers as upcoming and Phase 8 as the `1.0` release.
- **`site/`'s framing of the design target** claimed a productized-replacement pedigree that the roadmap
  explicitly says isn't there yet (adoption feedback is listed as still owed). Softened to what's true: the
  design target was a real workload of that shape.
- **npm keywords** now include `mysql`/`mariadb` (a shipped driver that was missing) plus `cloud-roaring` and
  `cloudbitmaps` on the flavor, so the retired unscoped name and the family name both still find it.
- **Split into the `@cloudbitmaps` family: `@cloudbitmaps/core` + `@cloudbitmaps/roaring`**
  (DECISIONS #58). The repo is now a pnpm workspace of two publishable packages.
  **What you install changes name, not shape:** `npm i @cloudbitmaps/roaring` (plus only the backend SDK(s) you
  use); `@cloudbitmaps/core` arrives **transitively** and is never installed directly. Every import keeps its
  form — `import { CloudRoaring } from '@cloudbitmaps/roaring'`,
  `import { S3ColdDriver } from '@cloudbitmaps/roaring/s3'` — because the flavor re-exports core wholesale and
  mirrors each driver subpath.
  - **`@cloudbitmaps/core`** — the codec-agnostic engine: `SegmentEngine` + the `CodecInterface` seam, **all**
    storage drivers (each on its own subpath, SDKs as optional peers), the `.crbm` format, crash-safe compaction,
    encryption/crypto-shred, the registry, consistency check, budget, and eject. **Zero runtime dependencies.**
  - **`@cloudbitmaps/roaring`** — the flagship flavor: the roaring codec (`SafeBitmap`/`roaringCodec`), the
    `CloudRoaring` facade, the driver re-export barrels, and both CLIs (`compact-segments`, `export-segments`).
  - **Completing the codec seam:** core can no longer default the codec (the concrete codec lives in a package
    that *depends on* core — a default would invert that arrow). `EngineDeps.codec` is now **required**; the
    public entry points that need one (`bulkLoadCrbmGeneration`, `compactSegment`, `runCompactionCycle`,
    `runExport`) keep it optional and fail fast with a typed error, while the flavor re-exports **codec-bound**
    wrappers that shadow the star-export — so existing call signatures are unchanged.
  - **Additive API surface:** core's barrel now also exports the **flavor-author kit** (`SegmentEngine`,
    `EngineDeps`, `BoundedLru`, `safeMetrics`, `groundedReport`, `validateCompactionOptions`, `runExport`,
    `splitId`/`joinId`, `mapWithConcurrency`, the budget helpers, `validateSegmentRef`) and the **driver kit**
    (`NO_ROW`, `NoRow`, `Token`, `WarmRow`, `WarmReadOptions`, `chunkRefKey`, `segmentKey`) — what a flavor or
    driver author composes, which is core's audience. Documented in
    [the API reference](docs/guide/api-reference.md).
  - Both packages shipped **private at `0.0.0`** (since versioned `0.1.0`, still private — see above);
    publishing under the scope is the Phase-9 launch itself.
  - Guard-rails added/repaired with the split: a dep-cruiser rule that **core may never import a flavor**
    (one-way arrow), the api-reference sync guard extended to both barrels + the flavor driver barrels, and the
    determinism / SDK-free-core ESLint override, the bundle-purity dep-cruiser rules, and the mutation-testing
    targets all retargeted to the new paths (they had silently matched nothing after the move).

### Fixed

- **Conformance `D4` now rides out a `TransientError`, ending a recurring Cassandra CI flake.** The
  concurrent read-modify-write conformance test asserts the OCC contract — *no lost updates* — but its retry loop
  only absorbed `WriteConflictError` and rethrew everything else. A cold Cassandra node whose Paxos layer isn't
  warm answers a burst of `INSERT … IF NOT EXISTS` with *"Server timeout at consistency SERIAL (0 peer(s)
  acknowledged)"*, failing the lane for a reason unrelated to lost updates. Production never sees this because
  `CloudRoaring` wraps every warm driver in `RetryingWarmDriver` by default, so the contract test now reflects
  real usage: transients are retried with a short linear backoff, **bounded** (25) so a driver that only throws
  transients still fails loudly. Predicted by the Phase-7 warm-driver audit (finding F2) and deferred at the
  time; promoted after it reddened CI again. Verified against a freshly-recreated (cold) Cassandra container.

### Added

- **Bitmap-codec seam** (DECISIONS #58) — `core/` is now **codec-agnostic**: the
  `SegmentEngine`, compaction, and the `.crbm` read/write helpers construct and combine bitmaps only through a
  new `CodecInterface` factory + `CodecBitmap` value type (`src/core/codec.ts`), never a concrete implementation.
  Roaring is the flagship codec (`roaringCodec`, delegating to `SafeBitmap`); the `CloudRoaring` facade injects
  it, so nothing changes for callers. This is the pre-split step that lets `@cloudbitmaps/bitmap` /
  `@cloudbitmaps/soaring` plug in behind the same seam with zero engine or driver changes. New public exports:
  `CodecInterface`, `CodecBitmap`, `roaringCodec`. A codec-agnostic test drives the whole engine (add/has/remove/
  count/iterate/tier-merge/intersect) on a non-roaring `Set`-backed codec to prove no roaring assumption leaked.
  The hot path is unchanged — the codec is resolved once at store construction, never per-op. *(The physical
  `@cloudbitmaps/core` + `@cloudbitmaps/roaring` package split is the follow-up; the `.crbm` serialization-id
  generalizes to a per-codec id with the second codec's format work.)*

### Security

- **Supply-chain hardening (Phase 8; threat model S9).** Publishing now runs through a hardened, provenance-
  signed pipeline. A new gated [release workflow](.github/workflows/release.yml) publishes with
  `npm publish --provenance` (SLSA build provenance via GitHub OIDC; `publishConfig.provenance: true`), re-runs
  the **entire** gate against the exact commit before creating the tarball, enforces `vX.Y.Z`-tag ↔
  `package.json`-version agreement, and installs with `pnpm install --frozen-lockfile`. **Every GitHub Action
  is now pinned to a full commit SHA** (a moved tag can no longer inject code). Workflows declare least-privilege
  `permissions:` (only the release job gets `id-token: write`). Documented in
  [SECURITY.md](SECURITY.md#supply-chain-build-publish--provenance), incl. the optional from-source `roaring`
  build (already proven by the AL2023 Lambda CI job) for consumers who won't trust a prebuilt addon. The first
  real publish is the Phase 9 launch; until then the workflow runs in dry-run. The threat model
  is finalized — S9 marked implemented, and the stale per-op-budget (shipped Phase F) / audit-sink (5d) statuses reconciled.

- **Hard memory & OS ceilings (Phase 8).** Closes the readiness deferrals that were *hardening* (not launch):
  - **`pnpm rss-gate`** — the definitive hard-RSS-ceiling gate (96 residual #1).
    Runs a sustained write+read+compact workload under a hard cgroup `--memory` limit (swap off) and **fails if
    OOM-killed** — so peak RSS, *including the `roaring` addon's off-heap native memory*, is now gated, not just
    leak-watched. Wired as a CI job; runnable locally on any Linux-VM Docker (Colima/Docker Desktop).
  - **Native OS matrix** — a gated `native-os-matrix` CI job builds + loads the addon on ubuntu/windows/macOS ×
    node 20/22 (gated off on the private repo to save paid minutes; proven on `workflow_dispatch`, always-on at
    go-public — not yet run in CI).
  - **`pnpm build-lambda-layer`** — produces a ready-to-attach AWS Lambda **layer** (`roaring` compiled from
    source for Amazon Linux 2023; builder verified locally), uploaded as an artifact by a gated CI job.
  - Hardened the Cassandra integration lane's cold-boot warm-up to prime the **LOCAL_SERIAL read** path (not
    just the LWT write), fixing an intermittent `Server timeout … at LOCAL_SERIAL` flake in the concurrent-D4
    conformance test on cold CI nodes.

- **Continuous fuzzing (Phase 8).** Promoted the coverage-guided jazzer/libFuzzer campaign (T3) toward
  continuous: the fuzz workflow now runs a **nightly** (10 min/target) **and a weekly deep soak** (60 min/target)
  with an accretive cached corpus, exercising the untrusted-`.crbm` boundary well beyond a single nightly budget.
  The fully-continuous **OSS-Fuzz / ClusterFuzzLite** lane (targets are already Jazzer.js-compatible) is
  documented as the post-go-public follow-on (it needs a public repo). **Phase 8 is complete.**

### Tests

- **Per-driver engine end-to-end + wide-segment scale coverage for the Phase-7 drivers.** The six new drivers
  were conformance-verified but only S3 was exercised behind the real engine. Each driver now has an
  **engine-level end-to-end** test in its integration lane: the two cold drivers (GCS, Azure Blob) bulk-load →
  `count` / `iterate` / chunk-skipping `intersect` through a real `CloudRoaring` store; the four warm drivers
  (PostgreSQL, Redis, MongoDB, Cassandra/ScyllaDB) layer live `add`/`remove` deltas over an immutable cold base
  and prove the tier-merge (`(cold ∪ warm.adds) \ warm.removes`) + intersect. Each warm driver also gets a
  **wide-segment scale** test that writes 1.1K–2.1K chunks (past several of its own default `listChunks`
  pagination pages) and asserts the enumeration is complete + strictly ascending with no dropped/duplicated
  chunk at a page/batch seam. All green against the real docker-compose backends.

### Added

- **MySQL / MariaDB warm driver (`cloud-roaring/mysql`; Phase 7g).** `MysqlWarmDriver` — an `IWarmDriver` over
  MySQL / MariaDB via the official `mysql2` (its promise API; an **optional peer dependency**, so the core
  install stays SDK-free). A `mysql2` `Pool` is **injected**. Each chunk is one row in a single table
  (`PRIMARY KEY (key_prefix, namespace, segment, chunk_key)`) with an opaque random-UUID OCC **token** and the
  delta `payload` (LONGBLOB). OCC is real, cross-process, server-side plain SQL: create-if-absent = a plain
  `INSERT` (a pre-existing row raises `ER_DUP_ENTRY` ⇒ `WriteConflictError`); token-fenced update/delete =
  `UPDATE`/`DELETE … AND token = ?` with an `affectedRows !== 1` conflict check. The fresh-UUID-per-write makes
  `affectedRows` (which MySQL counts as *changed* rows) cleanly reflect the *match*, and the table's
  **`utf8mb4_bin` collation** makes the key columns compare **byte-exact and case-sensitive** (MySQL's default ci
  collation would alias `A`/`a` — a correctness hole the DDL closes). Column lengths keep the composite primary
  key within InnoDB's 3072-byte index limit under utf8mb4. Ships an idempotent `mysqlWarmTableDDL()` for
  deploy-time schema. Tokens are never reused across delete→recreate (ABA-safe; DECISIONS #57).
  Passes the same `warmConformance` suite as the in-memory / LocalFs / DynamoDB / Postgres / Redis / Mongo /
  Cassandra warm drivers (finding V8) against a real MySQL (new docker-compose service + integration lane, incl.
  the engine-e2e tier-merge + wide-segment scale checks), plus a case-sensitivity regression. `mysql2` is MySQL-
  first [babystack](https://github.com/sharvilk/babystack)'s wheelhouse, so it doubles as a real-engine local
  test harness. **Rounds out the Phase 7 warm-driver set as a fast-follow.**

- **Cassandra / ScyllaDB warm driver (`cloud-roaring/cassandra`; Phase 7).** `CassandraWarmDriver` — an
  `IWarmDriver` over Cassandra / ScyllaDB via the official `cassandra-driver` (an **optional peer dependency**;
  the core install stays SDK-free). A connected `Client` is injected. Each chunk is one row in a table
  partitioned by `(kp, ns, seg)` and clustered by `ck`, so all of a segment's chunks share one partition and
  `listChunks` is a single partition read already ordered by `ck` ascending (streamed with auto-paging). The
  opaque random-UUID OCC **token** lives in a `tok` column (`token` is a CQL reserved word); OCC is a **lightweight transaction** (LWT —
  Paxos-linearizable CAS): create-if-absent = `INSERT … IF NOT EXISTS`; token-fenced update/delete =
  `UPDATE`/`DELETE … IF tok = ?` — not-applied ⇒ `WriteConflictError`. The keyspace + table names are
  identifier-validated + quoted (the sole CQL-injection vector; every other value is a bound `?`). Ships an
  idempotent `cassandraWarmTableDDL()` for deploy-time schema. Tokens are never reused across delete→recreate
  (ABA-safe). Passes the same `warmConformance` suite as the in-memory / LocalFs / DynamoDB / Postgres / Redis /
  Mongo warm drivers (finding V8) against a real Cassandra (new docker-compose service + integration lane).
  **Completes the planned Phase 7 warm-driver set.**

- **MongoDB warm driver (`cloud-roaring/mongodb`; Phase 7).** `MongoWarmDriver` — an `IWarmDriver` over
  MongoDB / DocumentDB via the official `mongodb` driver (an **optional peer dependency**; the core install
  stays SDK-free). A `Db` is injected. Each chunk is one document keyed by a **deterministic composite `_id`**
  (`<prefix>|<ns>|<seg>|<chunkKey>`) with an opaque random-UUID OCC token + the delta payload (BSON binary).
  OCC is per-document + server-side: create-if-absent = `insertOne` (a duplicate `_id` ⇒ `WriteConflictError`);
  token-fenced update/delete = `updateOne`/`deleteOne` filtered on `{ _id, token }` (a 0 matched/deleted count ⇒
  `WriteConflictError`). Each op is single-document atomic (no transaction). `listChunks` streams a `find` cursor
  sorted numerically by `ck` (bounded memory). Ships `ensureMongoWarmIndexes()` for the `listChunks` index (the
  composite `_id` already makes create-if-absent unique — no extra index needed). Tokens are never reused across
  delete→recreate (ABA-safe). Passes the same `warmConformance` suite as the in-memory / LocalFs / DynamoDB /
  Postgres / Redis warm drivers (finding V8) against a real MongoDB (new docker-compose service + integration
  lane).

- **Redis warm driver (`cloud-roaring/redis`; Phase 7).** `RedisWarmDriver` — an `IWarmDriver` over Redis via
  the official `ioredis` (an **optional peer dependency**; the core install stays SDK-free). An `ioredis`
  client is injected. The "sub-millisecond writes, accept always-on" warm tier. Each chunk is a Redis **hash**
  (`t` = opaque random-UUID OCC token, `b` = delta payload); each segment keeps a **sorted-set index** of its
  live chunk keys (Redis has no range scan) that `listChunks` reads ascending. Optimistic concurrency is a
  **server-side atomic Lua compare-and-set** (Redis runs the script atomically — no `WATCH`/`MULTI`): create-
  if-absent fails if the hash exists; token-fenced update/delete fails unless the stored token matches — both
  ⇒ `WriteConflictError`. The hash + index share a Redis-Cluster **hash tag** so the multi-key script is
  slot-safe. Tokens are never reused across delete→recreate (ABA-safe). Passes the same `warmConformance`
  suite as the in-memory / LocalFs / DynamoDB / Postgres warm drivers (finding V8) against a real Redis (new
  docker-compose service + integration lane).

- **PostgreSQL warm driver (`cloud-roaring/postgres`; Phase 7).** `PostgresWarmDriver` — an `IWarmDriver`
  over PostgreSQL via the official `pg` (an **optional peer dependency**; the core install stays SDK-free). A
  `pg.Pool` is injected. "No DynamoDB — use the Postgres you already run." Each chunk is one row keyed by
  `(key_prefix, namespace, segment, chunk_key)` with an opaque OCC **token** (a random UUID minted per write)
  and the delta payload (`bytea`). Optimistic concurrency is real, cross-process, server-side: create-if-absent
  is `INSERT … ON CONFLICT DO NOTHING` (0 rows ⇒ `WriteConflictError`); token-fenced update/delete is
  `UPDATE`/`DELETE … WHERE … AND token = :expected` (0 rows ⇒ `WriteConflictError`). Tokens are **never reused**
  across delete→recreate (ABA-safe). `listChunks` is keyset-paginated (bounded memory on wide segments). Ships
  an idempotent `postgresWarmTableDDL()` to create the table at deploy time (the driver stays thin — no runtime
  DDL); the table name is identifier-validated + quoted (the one non-parameterizable value → the sole injection
  vector, closed). Passes the same `warmConformance` suite as the in-memory / LocalFs / DynamoDB warm drivers
  (finding V8) against a real Postgres (new docker-compose service + integration lane). **First non-AWS warm
  tier — "use the datastore you already run."**

- **Azure Blob cold driver (`cloud-roaring/azure`; Phase 7).** `AzureBlobColdDriver` — an `IColdDriver` over
  Azure Blob Storage via the official `@azure/storage-blob` (an **optional peer dependency**; the core install
  stays SDK-free). A container-scoped `ContainerClient` is injected. Generations are **write-once** immutable
  blobs — the conditional `ifNoneMatch: '*'` makes publish atomic (a second write is a `WriteConflictError`,
  never a silent overwrite), the Azure analogue of S3's `If-None-Match: *` and GCS's `ifGenerationMatch: 0`.
  Writes **stream in constant memory** (a small blob is a single conditional `upload`; a larger one is staged as
  blocks, each freed as it goes, committed with a conditional `commitBlockList` — **write-once enforced on both
  paths, empirically verified against Azurite**). Range + tail reads, idempotent delete, and generation listing
  round out the contract. Passes the same `coldChunkSourceConformance` suite as the in-memory / LocalFs / S3 /
  GCS cold drivers (finding V8) against the Azurite emulator (new docker-compose service + integration lane).
  **Completes the object-store story on all three major clouds: AWS (S3) + GCP (GCS) + Azure (Blob).**

- **GCS cold driver (`cloud-roaring/gcs`; Phase 7).** `GcsColdDriver` — an `IColdDriver` over Google Cloud
  Storage via the official `@google-cloud/storage` (an **optional peer dependency**; the core install stays
  SDK-free). The `Storage` client is injected. Generations are **write-once** immutable objects — a resumable
  upload with `ifGenerationMatch: 0` makes publish atomic (a second write is a `WriteConflictError`, never a
  silent overwrite), the GCS analogue of S3's `If-None-Match: *`. Writes **stream in constant memory**; range +
  tail reads, idempotent delete, and generation listing round out the contract. Passes the same
  `coldChunkSourceConformance` suite as the in-memory / LocalFs / S3 cold drivers (finding V8) against the
  `fake-gcs-server` emulator (new docker-compose service + integration lane). Runs on any major cloud's object
  store: **AWS (S3) + GCP (GCS)**, with Azure Blob next.

- **Byte-aware cold-reader cache bound + native-memory soak proof; production-readiness verdict → READY within a validated envelope (DECISIONS #55).**
  A fresh 6-lens adversarial re-audit of production readiness (verified against the *current code*) found the
  fixes solid — docs-vs-code honesty **resolved**, correctness clean — with two gaps in the *memory-bound proof*,
  now closed: (1) the cold-reader cache is bounded by aggregate parsed-index **bytes** (new `coldReaderCacheMaxBytes`,
  default 64 MiB), not just open-segment **count**, so a working set of unusually *wide* segments can't pin
  gigabytes of indices while the count looks in-bounds (finishes audit gap #1); (2) the soak endurance harness now
  watches the roaring addon's **off-heap native memory** (`getRoaringUsedMemory()`) for creep alongside JS heap —
  a flat heap alone was not evidence the native footprint is bounded. Scope stated honestly: these prove *no leak*
  on the read path, not a hard RSS ceiling (the cgroup `--memory` gate stays deferred to the public launch). Also:
  the reference `compact-segments` daemon can emit per-attempt `MetricEvent`s on stdout via `CR_COMPACT_METRICS=1`.
  The 96-PRODUCTION-READINESS verdict is upgraded from the original
  analytical NOT READY to **READY within a validated envelope** (read-mostly / ≤~100K segments / tens-of-millions
  ids-per-segment / single-tenant / single-region; billions-ids, real-AWS cost calibration, and multi-tenant
  isolation are the named Phase-8 deferrals). Hot path (`add`/`has`/`remove`/`count`/`intersect`) unchanged.
- **Chaos drills against LocalStack (test-strategy T8; DECISIONS #54) — completes the T1–T8 testing frontier.**
  `pnpm chaos` (`bench/chaos-localstack.cjs`; offline, needs LocalStack + `docker`, not a CI gate) injects real
  faults at the AWS SDK drivers: a **throttle storm** (`ThrottlingException` at ~30% of DynamoDB calls, SDK
  retries off) — the store's retry layer rode out 818 injected throttles with **no lost update** — and a
  **backend outage** (`docker pause` for 2.5 s) — ridden through, every write lands, consistency preserved.
  Daemon-kill-mid-2PC stays with the in-process crash-at-every-step sweep; disk-full is deferred (not injectable
  on ephemeral LocalStack). No product code change.
- **Load + tail-latency harness against LocalStack (test-strategy T7; DECISIONS #53).**
  `pnpm load` (`bench/load-localstack.cjs`; offline, not a CI gate) drives the **real** S3 + DynamoDB drivers
  against LocalStack (a new on-demand `docker-compose.localstack.yml`) in three timed phases (add → DynamoDB OCC,
  bulk-load → S3 PUT, count → tier-merge), reporting throughput **and p50/p99/p999** tail latency, plus a $
  projection computed from a metrics sink's **measured** op-counts at published AWS prices (vs the always-on
  Redis baseline). Explicitly LocalStack-on-a-laptop numbers, not an AWS SLA. **This workload surfaced the CJS
  cross-bundle identity bug** (see Fixed / ).
- **Security hardening (test-strategy T6; DECISIONS #51).** Three additions atop
  the existing crypto/trust-boundary coverage: **external AES-256-GCM known-answer vectors**
  (`tests/crypto-vectors.test.ts` — McGrew–Viega / NIST test cases) pin the AEAD to published answers, not just
  self-referential round-trips; an **end-to-end KEK-rotation test** (`tests/key-rotation.test.ts`) proves old
  segments read under a retained old KEK (and compact without re-wrapping) while new segments adopt the new
  active KEK; and a **blocking CI dependency audit** (`pnpm audit` → `scripts/audit.cjs`, prod deps at high)
  guards the supply chain. Adds a **`SECURITY.md`** (private reporting policy, trust boundary, and the three
  triaged build-time `tar` advisories reached only via `roaring`'s install-time `node-pre-gyp` chain — never on
  the runtime path). No product code change.
- **Executable DR drill (test-strategy T5; DECISIONS #50).** `pnpm dr-drill`
  (`tests/dr-drill.test.ts`) turns the [disaster-recovery runbook](docs/guide/disaster-recovery.md) into a
  gated, **on-disk** `backup → corrupt → restore → verify` exercise against the real `LocalFs` cold + registry
  tiers. It injects a **torn restore** (registry recovered ahead of cold) and a **lost `.crbm`** — both detected
  as `missing-cold-generation` and cleared by rolling `currentGen` back / restoring the object — and **byte
  corruption** inside a present `.crbm`, which `checkConsistency` deliberately **cannot** see (it is
  presence-only) but which fails closed on read with `IntegrityError` (per-chunk CRC). Documents and verifies
  why the runbook's post-restore read spot-check exists. No product code change — the DR primitives already
  shipped in Phase F.
- **Stress harness (test-strategy T4; DECISIONS #49).** An offline `pnpm stress`
  (`bench/stress.cjs`; machine-dependent, **not** a CI gate) pushes three subsystems past their comfort zone,
  each against a deterministic oracle: **S1** a budgeted compaction-backlog drain (1,000 dirty segments drain in
  16 monotonic cycles, ≤ 64 compacted/cycle — the compaction *count* is budget-bounded; discovery stays
  O(fleet)); **S2** hot-row OCC contention (4,800 concurrent ops on one chunk → the effective set equals a
  per-writer oracle exactly, no lost update); **S3** a 50 M-id single segment where `count === 50 M` (no loss),
  counted in tens of ms, footprint tracking the roaring container structure (RSS ~370 MiB; JS heap stays ~5.4 MiB
  only because roaring is off-heap). **S2 surfaced a real data-loss bug** (the OCC-backoff premature-exit fixed
  in ) — see Fixed. Results persist to
  `bench/stress-results.json` with `STRESS_INJECT=1`.
- **Mutation testing of the core with Stryker (test-strategy T2; DECISIONS #47).**
  A [Stryker](https://stryker-mutator.io) pass (`pnpm mutation`) injects mutants into the highest-risk core logic
  — compaction 2PC/OCC, tombstone merge, bounded concurrency, bit routing (~1,115 LOC) — to quantify how well the
  suite catches bugs. **83.4% mutation score on covered code** (79.1% incl. uncovered; 449 killed / 90 survived /
  29 no-cov / 2 timeout of 570). It found **real gaps**, now hardened: a one-sided boundary in `decodeDelta` (the
  suite tested only _over-cap rejection_, never that a _maximal in-spec_ delta is _accepted_ — an off-by-N in the
  cap arithmetic would reject legitimate Warm rows; **chunk.ts 68% → 85%**), plus two reachable compaction
  branches (bootstrap-clean; encrypted-segment-without-keystore → `KeyUnavailableError`, never a silent decode).
  Residual survivors (concentrated in `compaction.ts`) are error-message strings (unasserted by design),
  observability/metrics-timing mutants, and defensive/edge branches. Offline + on-demand (not a CI gate; re-run
  pre-freeze). Dev-only (`@stryker-mutator/*` devDeps).
- **Coverage-guided fuzzing of the untrusted-`.crbm` boundary (test-strategy T3; DECISIONS #46).**
  Beyond the seeded property fuzz already in the suite, a [jazzer.js](https://github.com/CodeIntelligenceTesting/jazzer.js)
  (libFuzzer) campaign (`pnpm fuzz:*`, nightly) evolves adversarial inputs toward unreached branches over three
  targets — the **native** CRoaring portable deserializer (ungated), the hand-written index parser `parseIndex`
  **directly** (past the CRC wall a mutational fuzzer can't cross), and `CrbmReader.open`'s validation front.
  All assert the boundary contract: arbitrary bytes yield a typed `CloudRoaringError` or a self-consistent
  success, never a `RangeError`/native crash/hang.
  - Recorded run (Apple M3 Pro, 120 s/target): **~11.3 M adversarial executions, 0 crashes** — 4.19 M against
    the deserializer (~34.6k/s, black-box: native C++ isn't instrumentable), 3.72 M against `parseIndex`
    (~30.7k/s, coverage-guided: 34 edges / 189 features), 3.37 M against the reader front (~27.8k/s,
    coverage-guided: 102 edges / 163 features).
  - **Offline + nightly, not a CI gate** (corpus cached so coverage accretes). A found crash becomes a committed
    reproducer under `tests/core/crbm/fuzz-corpus/`, replayed by a new test on **every** PR — so the campaign
    stays offline while every fixed bug is guarded. Harness + policy in [`fuzz/README.md`](fuzz/README.md).
  - Dev-only (`@jazzer.js/core` devDep; nothing enters the published bundle).
- **Soak / endurance harness — no heap creep under sustained load (test-strategy T1; DECISIONS #45).**
  A new offline endurance harness (`pnpm soak`) runs sustained mixed load — continuous writes + reads across the
  population + compaction (with orphan-generation GC) — and samples **post-GC retained heap over time**, asserting
  the last-third median hasn't grown past the first-third median beyond a **relative** band. Complements G4's
  memory _snapshot_ with the _steady state over time_:
  - **No creep** — 90 s / 400 segments / 712 real compactions leaves post-GC heap flat (~7.3 → 7.4 MiB; +0.1 vs a
    2.1 MiB band) → PASS (measured; Apple M3 Pro).
  - **Isolated reader-child footprint** (closes G4's follow-up) — a fresh reader-only child reading the whole fleet
    holds a **6.8 MiB post-GC heap** (the read-path bound); its ~65 MiB RSS is the fixed Node + roaring-addon floor.
  Requires `--expose-gc` (the script sets it) and **fails fast without it**, since a no-op GC would hide a leak.
  Measured + machine-dependent, so — like the other benches — **not** a CI gate; a multi-day run is the same
  harness at a larger `SOAK_SECONDS` (nightly). Results in
  the test-strategy doc + `bench/soak-results.json`.
- **At-scale benchmark — measured readiness at 1K→10K→100K segments (Phase G4; DECISIONS #44).**
  A new offline load benchmark (`pnpm bench:scale`) that converts the production-readiness audit's code-read
  conclusions into **measured** evidence at fleet scale, building up to 100K real `.crbm` segments on local disk:
  - **Bounded memory (the headline).** Reading across the _entire_ fleet under the default reader-cache cap holds
    retained live heap **flat at ~7 MiB from 1K to 100K segments** (measured; Apple M3 Pro) — memory is a function
    of the working set (the cap), not the fleet, exactly as the design claims (closes the measurement half of gap #1).
  - **Discovery cost characterized** — `findCompactable` timing across fleet sizes shows the honest `O(total)`
    registry-enumeration floor (gap #3); sharding (which splits the Warm drain, not the enumeration) is discussed
    in prose, not measured here.
  - **Chunk-skipping intersection holds at scale** — two large multi-chunk segments intersect by fetching only
    the shared chunks, skipping the rest by key alignment.
  Measured (wall-clock + RSS) and machine-dependent, so — like the cost bench — **not** a CI gate; the
  deterministic claims stay gated in `tests/bench/anchors.test.ts`. Results land in a new "At scale" section of
  [docs/benchmarks.md](docs/benchmarks.md).
- **Simulator hardening — compaction under concurrency (Phase G3; DECISIONS #43).**
  The deterministic simulator now runs the **real** engine + `.crbm`/registry path with a compaction actor racing
  each batch's live reads/writes through one seeded scheduler, closing audit gap #12's "simulator half": the 2PC,
  intersection-under-compaction, torn-read, and crash-recovery are proven by a **searched interleaving** rather than
  hand-examples. New oracle coverage — effective-set equivalence under a racing compaction (fenced-purge / no-lost-write),
  chunk-skipping `intersect` equals the oracle intersection on a just-rewritten segment, and no torn read of a
  write-free segment being compacted (generation-pinning). New faults — a **process crash injected at any durable
  2PC step** (staged generation + lease-acquire/`currentGen`-swap/lease-release), and **transient faults on cold
  reads** ridden out by the retry decorator. Determinism holds: a disabled fault draws no randomness, so every
  prior seed replays byte-for-byte. Test-only (nothing enters the published bundle).
- **Zero-cost pre-freeze test/release gates (Phase G2; DECISIONS #42).**
  Two release gates that run for **$0** on the self-hosted runner, before the 1.0 format freeze:
  - **Bounded-memory gate (structural).** A deterministic at-scale test proves the cold-reader cache is bounded
    by its cap, not the fleet size (gap #1): reading a fleet far larger than the cap twice re-opens every
    segment (2N opens) because each is evicted before the loop returns — an unbounded cache (the pre-Phase-C
    regression) would keep them resident (N opens) and fail. (A hard cgroup-OOM gate is deferred to the
    public-launch Linux runners — Docker Desktop for Mac doesn't reliably enforce `--memory`.)
  - **AWS Lambda / Amazon Linux 2023 deployability smoke.** Builds the native `roaring` dep for the AL2023
    Lambda runtime and loads the packaged library under both ESM and CJS in a container (`pnpm lambda-smoke`
    + a CI job). Surfaces a real deploy note: `roaring` ships no linux-arm64 prebuilt for the current Lambda
    node runtimes, so it must be **built for the target** (container build / SAM `--use-container` / a layer) —
    see [Deploying to AWS Lambda](docs/guide/getting-started.md#deploying-to-aws-lambda). A prebuilt Lambda
    layer for a drop-in experience, and a native windows/ubuntu OS matrix, are deferred to the public launch.
- **Schema-version stamps on the Warm-delta & registry formats (Phase G1 — pre-1.0 format-freeze prerequisite; DECISIONS #41).**
  A pre-1.0 format-freeze prerequisite: every persisted format now carries a version discriminator, so a
  future, incompatible writer's bytes **fail closed** on an old reader instead of being silently misparsed
  (the Cold `.crbm` format already had this).
  - **Warm delta** gains a 1-byte version prefix (`[u8 version][u32 addsLen][adds][removes]`); an unrecognized
    version is rejected with `UnsupportedError`.
  - **Registry rows** gain a `schemaVersion` field (LocalFs/S3 envelope + DynamoDB body): a **newer** version
    is rejected (`UnsupportedError`), an **absent** one is tolerated as legacy v1 so durable pre-freeze rows
    stay readable across the upgrade. The stamp is wire-only — it never appears on the in-memory record; the
    in-RAM `Memory*` drivers carry no stamp.
  - Error-type split mirrors the `.crbm` reader: unknown *version* → `UnsupportedError`, structural
    *corruption* → `IntegrityError`. **Scope:** the *logical* formats are stamped; the per-driver *physical*
    framings (e.g. LocalFs warm's `[counter][deleted]` prefix) wrap the versioned payload and are intentionally
    not separately stamped. **+1 byte/Warm-row, ~18 bytes/registry-row; O(1), off the hot path.**
  - **Upgrade note:** pre-stamp *Warm* rows fail closed on read (never a silent wrong answer) — because Warm is
    a transient tier, drain/compact or wipe+re-seed it on an in-place upgrade; durable *registry* rows are
    tolerated as v1 and need no action.
  - Incidental hardening: `parseRegistryEnvelope` now rejects `null`/primitive JSON with a typed
    `IntegrityError` instead of an uncaught `TypeError` (invariant 5).
- **Tenancy, denial-of-wallet budget & DR consistency (Phase F — audit gaps #8/#11; DECISIONS #40).**
  Three pre-1.0 hardening items, scoped lean (the fuller tenancy/crypto/format work is deferred to Phase 7/8 — see below):
  - **Per-op request budget (#8) — the denial-of-wallet ceiling the specs asserted but never built.** A new
    `BudgetExceededError` + a store-level `budget` option (default `{ maxRequests: 1_000_000 }` — on, but
    generous), with a per-op override and `budget: false` to disable. `count` / `iterate` / `intersect` /
    `subjectReport` / `eraseSubject` now **refuse before fan-out** when the work would exceed the ceiling.
    The check is **O(1)** against the already-known fan-out size, so the hot path (`add`/`has`/`remove`) is
    untouched. Byte volume is **transitively bounded** by requests × the per-request safe-deserialize size
    cap, so no per-chunk byte accounting is added (a deliberate refinement of the spec's "requests *and* bytes"; T3 / Decision #3 updated to match).
  - **Minimal tenancy guard.** `subjectReport` / `eraseSubject` operate over the **global u32 id space**
    shared across namespaces, so a namespace-less call is a fleet-wide sweep. They now require an explicit
    `namespace` **or** an `{ allNamespaces: true }` acknowledgement — a fleet-wide erase/report can no longer
    be the accidental default. (Full namespace-scoped handles + per-namespace KEK are deferred to Phase 7/8.)
  - **Torn-restore detection (#11).** `store.checkConsistency()` (and the standalone `runConsistencyCheck`)
    verify every registered segment's `currentGen` `.crbm` is actually present in cold storage — catching a
    **registry recovered ahead of the object store** (its `currentGen` points at a generation that was never
    restored), which would otherwise surface as a failed read much later. Paired with a coordinated-restore
    runbook ([docs/guide/disaster-recovery.md](docs/guide/disaster-recovery.md)). The self-healing
    footer-DEK format change is documented as a deferred evolution (the footer is full; it also changes the crypto-shred model — "Reserved / future").

  New `BudgetExceededError`, `DEFAULT_BUDGET`, `runConsistencyCheck`, and the `Budget` / `BudgetOption` /
  `ConsistencyReport` / `ConsistencyIssue` types are exported.

### Documentation

- **Production-readiness re-audit — operator docs + envelope re-scope.** A second 6-lens adversarial readiness
  re-audit against the merged 10-driver code found the correctness verdict unchanged (no in-envelope
  silent-wrong-answer hole in the 8 Phase-7 drivers) but surfaced **operator-facing footguns** the
  DynamoDB/S3-era docs never covered. Closed here (companion to the code fixes in
  ):
  - **getting-started** now documents production wiring for all 7 new backends + a "choosing a registry"
    callout: the **Redis eviction footgun** (`maxmemory-policy noeviction` + AOF, or warm chunks silently drop →
    wrong answers), the **registry-pairing rule** (the new drivers are tier-only → a compaction-enabled
    deployment needs an S3/DynamoDB registry), and per-driver required settings (MySQL `utf8mb4_bin` +
    `ROW_FORMAT=DYNAMIC`, Cassandra RF + must-wrap-in-`RetryingWarmDriver`, Mongo simple collation +
    `ensureMongoWarmIndexes`).
  - **disaster-recovery** gains a **per-backend backup/PITR table** (warm: DynamoDB PITR · PG WAL · MySQL binlog
    · Mongo oplog/snapshot · Cassandra snapshot · Redis AOF+RDB; cold: S3/GCS/Azure versioning) — warm sets your
    RPO, and Redis-warm is the only live copy; the `checkConsistency` **Case-A honesty note** (detects the torn/dangling-pointer case, not the #35 silent lost-update); and a **no manual
    publish during active compaction** caveat.
  - **96-PRODUCTION-READINESS** §2.2 re-scopes the validated envelope to **DynamoDB + S3 (fully documented)**,
    with the other 8 drivers labeled **conformance-passing + correctness-clean**; roadmap updated.
  - **README + SECURITY**: Alpine/musl install note (`roaring` has no musl prebuilt → needs a build toolchain).

- **Post-Phase-8 accuracy sweep.** Reconciled all docs against the merged Phase 7–8 state. Launch facts
  corrected everywhere: public launch is **Phase 9 at `0.1.0`** (not "Phase 8"/`1.0.0`); the **`.crbm` format
  freeze gates `1.0`, not the `0.1.0` launch**; the package publishes scoped as **`@cloudbitmaps/roaring`**
  (umbrella family, DECISIONS #56) and the split is the Phase-9 pre-release gate;
  trademark search/registration is a Phase-9 task, not "deferred". Added a *partially-superseded* banner to the
  11-RELEASE runbook and fixed its decisions table, publish command, and
  checklist. Marked the **hard cgroup-RSS ceiling gate** as **shipped** (`pnpm rss-gate`, Phase 8) across the
  testing/readiness docs (previously listed as deferred), and the **Lambda layer** as shipped
  (`pnpm build-lambda-layer`). Added **MySQL/MariaDB** to warm-driver enumerations; corrected barrel count to
  **ten**; updated fuzz-PR references (`#92` → `#93`); refreshed roadmap/phase status markers to Phases 1–8
  complete. Clarified that the conformance suite stays **internal** (no public `./testing` export — the Phase-7-publish note in DECISIONS #9 was deferred).
- **Phase 7 driver-doc sweep.** Synced the docs to the shipped driver set now that all six Phase-7 drivers have
  merged. Corrected the `IWarmDriver` OCC-token table in 05-DRIVER-SDK — the
  **PostgreSQL** row wrongly described the token as a `version`/`xmin`/counter; all four warm drivers (Postgres,
  Redis, Mongo, Cassandra) use a **per-write random UUID + hard delete**, now recorded as a first-class
  contract-valid realization alongside the monotonic counter (new DECISIONS #57; reconciled the "recommended implementation" prose and the locked-decision row). Added a **Cassandra/ScyllaDB
  operational note** (LWT + `LOCAL_SERIAL` reads + single-partition-per-segment hot-partition guidance).
  Refreshed the stale status/"works today"/driver-list prose in the [README](README.md), the
  [getting-started guide](docs/guide/getting-started.md), and 98-USAGE; fixed the
  "three barrel files" → nine count and completed the driver-option-types index in
  [the API reference](docs/guide/api-reference.md); corrected the `tsup.config.ts` entry comment
  ("AWS SDK" → the per-driver backend SDKs). Marked **Phase 7 complete** in the roadmap and phase doc.

### Fixed

- **Pre-launch hardening from the production-readiness re-audit** (6-lens adversarial pass against the merged
  Phase 7–8 code). Four sharp code/test fixes; no in-envelope correctness defect was found, these close latent
  edges before the `0.1.0` publish:
  - **MongoDB warm driver now pins a binary collation** (`{ locale: 'simple' }`) on every `get`/`update`/
    `delete`/`list` op + the index. Under a case-**insensitive** collection default collation, an unpinned query
    could match the wrong document (case-differing segments/namespaces are distinct stores) → cross-segment
    read/leak. This is the Mongo analogue of the MySQL `utf8mb4_bin` requirement; a case-sensitivity integration
    test (mirroring MySQL's) now guards it. *(insert uniqueness is still governed by the `_id` index collation —
    the operator guide states the warm collection must use the simple default collation.)*
  - **`InProcessKeystore.openDek` now tries every held wrapping**, not just the first. A DEK is wrapped under
    both the active and (optional) offline **recovery** KEK precisely so a corrupt/tampered active-KEK wrapping
    can be recovered from the other — but the loop returned on the first held keyId and let a failed unwrap
    throw, defeating that insurance. It now falls through to the next held wrapping and only surfaces the
    integrity failure when **all** held wrappings fail (a missing-KEK case still raises `KeyUnavailableError`).
  - **Chunk-skipping intersection is now tested at the boundaries** — the crown-jewel path at the maximum
    chunk-key span (id `0xFFFFFFFF`, chunk `65535`) and a common chunk whose effective set is fully tombstoned
    in one operand (must yield `null` and be skipped, not a phantom id). Membership was already proven at the
    ceiling; intersect was only sampled below chunk key 4.
  - **GCS resumable (large-object) upload path is now exercised end-to-end against fake-gcs-server** (previously
    only the ≤8 MiB simple path was emulator-grounded). Write-once *enforcement* on the resumable finalize stays
    covered by the driver mock (sends `ifGenerationMatch:0`, maps a 412 → `WriteConflictError`) + real GCS,
    because fake-gcs-server does not honor the precondition on resumable finalize — documented in the test.

- **Cross-bundle identity broke the DynamoDB driver + all retry/resilience in the published CJS package (found by the T7 LocalStack load harness; DECISIONS #52).**
  The package ships separate bundles (the core entry + the `./s3` / `./dynamodb` subpaths); the CJS output
  inlines its own copy of `core/*` into each, so values compared by **identity across that boundary** broke for
  `require()` consumers. Two symptoms, both invisible to the test suite (one source module graph): (1) the
  `NO_ROW` create sentinel was a plain `Symbol('no-row')` → distinct per bundle → `expected === NO_ROW` always
  false → **every warm-row create failed** (empty-`:expected` `ValidationException`); (2) the typed **error
  classes** were duplicated per bundle → the engine/retry/compaction `instanceof WriteConflictError` /
  `isTransient` checks against **driver-thrown** errors returned false → **OCC retry, transient-fault retry, and
  compaction race-handling were silently disabled** (the Phase-4b resilience layer was a no-op in CJS). Fixes:
  `NO_ROW` is now a global-registry `Symbol.for`; errors carry `Symbol.for` **brands** and are classified by new
  exported predicates — **`isCloudRoaringError` · `isWriteConflictError` · `isTransientError` ·
  `isNotFoundError` · `isIntegrityError` · `isValidationError`** (prefer these over `instanceof` when catching
  errors from a cloud driver) — replacing every cross-boundary `instanceof` in `core/`. Guarded by unit tests +
  a built-bundle cross-check in `scripts/smoke.cjs`. Verified end-to-end against LocalStack.
- **OCC-backoff premature process exit — silently dropped contended writes (found while developing the T4 hot-row stress; DECISIONS #48).**
  The default clock's `sleep` **unref'd** its backoff timer. Because that `sleep` only ever backs a
  caller-awaited, bounded retry (the engine's OCC read-modify-write and the driver `withRetry` loop), the
  timer was the sole thing holding a short-lived process open during a retry. Under contention on a hot chunk,
  a losing writer would back off, and if that backoff timer was the process's only remaining handle, Node
  treated the event loop as empty and **exited `0` mid-retry** — the awaited `add()`/`remove()` neither applied
  nor threw. This struck exactly the serverless target (Lambda/CLI/short-lived scripts) the library is built
  for. Fix: the default clock now uses a **ref'd** timer; a pending backoff keeps the loop alive until the
  awaited, bounded retry resolves. Guarded by a regression test (`tests/backoff-liveness.test.ts`); the
  bare-process end-to-end contention scenario that first exposed it lands with the T4 stress PR. No hot-path or
  steady-state cost (retries are bounded).
- **Read-path cost & admin latency (Phase E — audit gaps #9/#10; DECISIONS #39).**
  Four cost/latency gaps from the readiness audit, kept lean (two heavier sub-items deferred — see below):
  - **Opt-in eventually-consistent warm reads (#9).** Every warm `has()`/`count()`/`iterate()`/`intersect()`
    previously forced a **strongly-consistent** DynamoDB read (2× RCU) with no in-process absorption. A new store
    option `warmReadConsistency: 'strong' | 'eventual'` (default `'strong'`, unchanged) makes the **read paths**
    eventually-consistent — **~½ the read cost** — while the OCC read-modify-write path stays strong regardless
    (correctness). No effect on the always-strong in-memory / LocalFs drivers. Trades read-after-write for cost.
  - **Compaction is now in the cost estimator (#10).** `estimateCost` / `segment.costReport` add a `compaction`
    term (whole-generation re-read + PUT + Warm purge) to `byOp` / `byTier`. Default `compactionsPerMonth: 0`
    leaves existing estimates unchanged, but the report now **discloses** the omission instead of silently
    under-reporting the background job that usually dominates operational cost. (First consumer of
    `pricing.cold.putPerMillion`, now validated.)
  - **Bounded admin fan-out.** `subjectReport` / `eraseSubject` scanned segments **serially**; they now fan out
    at a bounded `concurrency` (default 8) — per-segment fault isolation preserved. The **S3 registry `list()`**
    did one GET per key serially (an N+1); it now reads each page's rows at bounded parallelism.
  - **Bounded flusher.** `addMany` / `removeMany` gain an opt-in `writeConcurrency` (default **1** ⇒ unchanged
    serial) to fan distinct-chunk writes out for throughput on wide batches.

  New reusable `mapWithConcurrency` primitive (`core/concurrency.ts`) underpins the fan-out. **Deferred
  (documented):** an in-process short-TTL warm-chunk cache (#9) and compaction's coalesced constant-memory merge
  GET (#10) — each needs its own focused change; see DECISIONS #39.
- **Scaled the compaction daemon for the fleet + made it observable (Phase D — audit gaps #2/#3; DECISIONS #38).**
  The crash-safe daemon was correct but a single unsharded worker, invisible to monitoring, and could wedge on one
  bad segment. Phase D closes those fleet-scale gaps (kept lean — see the deferred list):
  - **Observability + a dead-man's-switch (#2).** Every compaction attempt now emits a `compaction` metric to your
    `IMetricsSink` (committed / clean no-op / error, dirty-chunk count, rows purged, ms), and every commit stamps
    `lastCompactedAt` on the segment's registry record. Alarm on "nothing compacted in the last hour" to catch a
    wedged or absent daemon — previously a compaction failure was logged-and-swallowed with no signal at all.
  - **Poison-segment quarantine (#2).** A segment whose compaction kept throwing (e.g. one corrupt warm row) used
    to be retried every cycle **forever** — freezing that segment's compaction and burning money. It's now
    quarantined after `quarantineThreshold` consecutive failures (default 5), skipped until a cooldown elapses
    (default 5 min), then retried once; a success clears the streak. One poison segment can no longer wedge a worker.
  - **Shardable, budgeted, urgency-ordered discovery (#3).** Run N workers over disjoint shards (`shard`/`totalShards`;
    CLI `CR_COMPACT_SHARD` / `CR_COMPACT_TOTAL_SHARDS`) partitioned by a stable hash — disjoint and covering the whole
    fleet, no coordination. `maxSegments` (CLI `CR_COMPACT_MAX_SEGMENTS`) caps work per cycle, compacting the
    most-backed-up segments first (dirty-chunk count, oldest-compacted tiebreak) and deferring the rest so a burst
    can't starve the tail. A change-guarded CAS skips the registry write when nothing moved. `runCompactionCycle`
    now returns `{ candidates, compacted, deferred, results }`.

  Two **optional** registry fields (`lastCompactedAt`, `consecutiveFailures`) carry the daemon state — both optional
  for backward-compatibility with existing rows. **Deferred (documented):** an O(dirty) enumeration seam
  (`Select:COUNT` / GSI / projection) + resumable cursor, lease heartbeat/renewal, and lease-aware publishing (the
  Phase B #5 residual) — see DECISIONS #38.
- **Bounded the cold-reader cache — no more unbounded index growth (Phase C — audit gap #1; DECISIONS #37).**
  `CrbmColdChunkSource` held opened `.crbm` readers (each carrying a fully-parsed index) in an **unbounded** map,
  so a long-running server that read across many segments grew its footprint with *every distinct segment ever
  read* (tens of GB / OOM at 100K+ segments). The reader cache is now a `BoundedLru` capped by a new
  `coldReaderCacheMax` option (default **1024** segments): past the ceiling the least-recently-used segment's
  reader is evicted, and re-reading it later re-opens it in one cheap tail GET (generations are immutable). The
  gap-#4 currentGen TTL is unchanged (orthogonal). Steady-state memory is now bounded by the working set, capped
  at the ceiling.
- **Correctness holes closed (Phase B — audit gaps #4/#5/#6; DECISIONS #34–#36).**
  Three silent-wrong-answer bugs outside the well-tested crash paths:
  - **Stale reads after compaction (#4).** A long-lived reader (a Topology-B app server) pinned a segment's
    generation for its lifetime, so after a separate daemon compacted it served the prior generation
    indefinitely — a folded add read `false`, and an **erased id resurrected to `true`**. The cold source now
    re-resolves `currentGen` on a short TTL (`coldGenTtlMs`, default 2000 ms; lazy — checked on read, no timer)
    and the HOT cache is **generation-keyed**, so a reader converges to the new generation within the TTL. Reads
    are now **bounded eventually-consistent** — up to `coldGenTtlMs` of staleness after a compaction, then they
    converge; the hot path stays I/O-free within the window. Needs a `registry` (else the source pins as before,
    which suits single-process/local use).
  - **Compaction RECONCILE vs a concurrent publish (#5).** A `publishGeneration` / `bulkLoadCrbmGeneration`
    that advanced `currentGen` mid-compaction could have its generation deleted by RECONCILE — a silent
    whole-generation lost update. Compaction now re-reads `currentGen` under its lease and **aborts**
    (`reason: 'superseded'`) if it moved, so RECONCILE never deletes a just-published generation.
  - **`.crbm` format-field validation (#6).** `CrbmReader.open` now validates `element_width` /
    `roaring_serialization_id` / `container_codec` and throws `UnsupportedError` on a mismatch, so a future
    64-bit or re-codec'd generation can never be silently fed to the 32-bit deserializer. A 64-bit generation
    is a **major**-version bump (old readers auto-reject).
- **ESM import under Node** — the shipped package now imports cleanly in a native Node ESM project
  (`import { CloudRoaring } from 'cloud-roaring'`). The `roaring` native addon is CommonJS, and a _named_
  ESM import of it crashed Node's ESM loader (`SyntaxError: Named export 'DeserializationFormat' not found`);
  the core now takes those runtime values off `roaring`'s default export (Node maps a CJS module's
  `module.exports` to the ESM `default`). A `scripts/smoke.cjs` package smoke test — wired into CI and
  runnable via `pnpm smoke` — loads every published entry (`index`, `s3`, `dynamodb`) under **both** ESM and
  CJS and exercises the roaring-backed path, so this can't regress (DECISIONS #24).

### Added

- **Export / eject your data — `store.exportSegments()` + the `export-segments` CLI**: dump every registered segment's
  current effective set to a portable file, using only public read APIs, so your data is readable **without
  CloudRoaring** (the exit path / a building block for a data-portability response). `format: 'roaring'` (default) writes one
  portable RoaringBitmap32 per segment (loadable by any roaring library in any language); `'ndjson'` writes
  newline-delimited ids (zero-dependency, streamed). Writes through an injected `ExportSink` (the store never
  imports `node:fs`); the `export-segments` CLI supplies a filesystem sink (atomic `.part`→rename) and writes a
  self-describing `manifest.json` last (its presence = the run **finished**; a crash leaves none → re-run into a
  fresh dir). Reuses the store's own registry (needs one, else `UnsupportedError`); folds in warm deltas; decrypts
  transparently if a keystore is wired (export is **cleartext**); skips crypto-shredded segments. **Fault
  isolation**: a segment that can't be read (corrupt cold object, or an encrypted segment with no keystore) is
  recorded in the manifest's `failed[]` and the export continues — one bad segment never blocks the rest (the CLI
  exits non-zero when any failed). **Warm-only escape hatch**: all-warm segments not yet in the registry can be
  named via the `candidates` option (CLI: `CR_EXPORT_SEGMENTS`), mirroring the compaction daemon's discovery
  (DECISIONS #31).

- **Store lifecycle methods reuse the store's own drivers** — `store.compact(ref, { owner })` (new), plus
  `store.eraseSubject(id, { owner })` and `store.subjectReport(id)` now build their compaction/erasure deps from
  the store's own cold/warm/registry, so you no longer re-pass a `registry` or a hand-assembled `CompactionDeps`.
  `compact`/`eraseSubject` require the store built with a raw cold driver + a `registry`; `subjectReport` needs
  only a `registry` (it just enumerates + `has()`) — all throw `UnsupportedError` when the store lacks what they
  need. The `compactSegment` / `destroySegment` / `bulkLoadCrbmGeneration` free functions remain for
  out-of-process daemons/CLIs. This also removes a footgun: the erasure ledger can no longer report a false purge
  from mismatched deps — the drivers are provably the store's own. `eraseSubject` isolates per-segment faults
  (records `physicallyPurged:false`, `note:'error: …'` and continues, so one segment can't discard the whole
  ledger) and validates `owner` before writing any tombstone (DECISIONS #30).

- **Simpler wiring — one config shape (`cold` / `warm` / `registry` / `keystore`)**: the `CloudRoaring`
  constructor now accepts a **raw `IColdDriver`** as `cold` (`S3ColdDriver`, `LocalFsColdDriver`,
  `MemoryColdDriver`, …) and assembles the `.crbm` cold source for you, with `registry` / `keystore` /
  `requireEncryption` lifted to the same config object — so each driver is named **once** instead of being
  threaded through a hand-built `new CrbmColdChunkSource(cold, { registry, keystore })` wrapper. Passing an
  already-built `ColdChunkSource` still works unchanged (for a source-only backend like `MemoryColdChunkSource`,
  or a source you configured with advanced reader options like `tailBytes`/size caps), so no capability is lost.
  Fail-fast guards reject `registry`/`keystore`/`requireEncryption` paired with a pre-built source (configure
  them on the source), a keystore without a registry, and a `cold` that is nullish, ambiguous, or neither a
  driver nor a source. Wiring-time only — the hot path is untouched (DECISIONS #29).

- **`S3RegistryDriver` — run the registry on S3, no DynamoDB** (`cloud-roaring/s3`): an `IRegistryDriver`
  backed by one tiny object per segment in the same bucket as your Cold data, using **S3 conditional writes**
  (`If-None-Match` for create, `If-Match` ETag for the atomic compare-and-swap; GA Nov 2024) instead of a
  server-side counter — so a **read-mostly deployment runs on S3 alone**. Same OCC + ABA-safe token (monotonic
  counter, tombstone-on-delete) as the other registries; passes the shared `registryConformance` suite in the
  unit lane (faithful fake S3) and against **MinIO** in the integration lane. Requires a backend that honors
  `If-Match`, `s3:ListBucket`, and no lifecycle-expiry on the `registry/` prefix (see the driver docs +
  getting-started §7). Also hardened both S3 drivers to treat a **`409 ConditionalRequestConflict`** (S3's
  other concurrent-conditional-write outcome, not just `412`) as a `WriteConflictError`
  (DECISIONS #28).

- **Phase 6c — legal hold (documented)**: the legal-hold posture is enforced via **S3 Object Lock** (a locked
  Cold object can't be deleted before its retention date — stronger than an in-library flag) plus excluding
  held segments from compaction/erasure; documented in `PRIVACY.md`. A native `legalHold` flag was
  deliberately not built (it would be advisory where Object Lock is enforced at rest, and wasn't cheap). This
  completes the lean **Phase 6 → milestone M4**.

- **Phase 6b — subject access & erasure (`subjectReport` / `eraseSubject`)**: two admin helpers on the store
  for GDPR Art. 15 / 17. `subjectReport(id, registry)` returns which **registered** segments an id is a member
  of; `eraseSubject(id, compaction, { owner })` writes a logical `remove` **and force-compacts** each affected
  segment on the spot — so the bit is physically gone from Cold on return, even for idle/archival segments
  organic compaction would never touch (the P13 fix) — and returns an **erasure ledger** (per-segment proof of
  deletion; return-value only, route it to your audit sink). Both scan registered segments (`O(registered
  segments)`, admin-only) — **no `id→segments` reverse index**, so nothing taxes the hot path. If a daemon
  holds a live lease, that segment's purge is deferred honestly (`physicallyPurged:false`); logical removal
  always holds. Per-subject crypto-shred is infeasible, so this is the single-subject route; whole-segment/
  tenant erasure remains `destroySegment`/`eraseNamespace`. See getting-started §13 + `PRIVACY.md`.

- **Phase 6a — `PRIVACY.md` (privacy & shared responsibility)**: a user-facing statement of the trust
  boundary (CloudRoaring is an embedded library, sends nothing to the authors, so *you* are the
  controller/processor and we are not a sub-processor), the honest erasure model (logical `remove` →
  scheduled-compaction physical purge → `destroySegment` crypto-shred, incl. the backups/WORM trap), the
  residency transfer surface, retention guidance, a shared-responsibility matrix, and a DPIA skeleton + Art. 30
  record template. Documents residency/classification/retention as integrator responsibilities rather than
  building policy-engine machinery (see Phase 6 plan).

- **Phase 5d — audit sink (security/compliance events)**: an optional, off-by-default `IAuditSink` — separate
  from the metrics sink — records the compliance-relevant state changes: `segment.publish` (a generation
  became current), `segment.compact` (a generation was committed), `segment.erase` (a genuine crypto-shred),
  and `namespace.erase` (with an honest `segmentsShredded` count). It's the natural feed for an append-only
  audit log / SIEM and a truthful GDPR Art. 30 erasure receipt — `segment.erase` fires only for a real key
  shred, never for a cleartext tombstone (bytes stay readable) or an idempotent re-run, and `segment.compact`
  fires at the durable commit so a purge fault can't drop it. Pass `audit` to `bulkLoadCrbmGeneration` /
  `compactSegment` / `runCompactionCycle` / `destroySegment` / `eraseNamespace`; the sink is exception-safe
  (a throwing sink never breaks the op) and vendor-neutral. Also hardens the compaction boundary
  (`owner`/`leaseMs` validated fail-fast). **KEK rotation is not emitted** — it's operator-side keystore
  reconfiguration with no library hook (see the [dashboards guide](docs/guide/dashboards.md) and DECISIONS #27). Completes **Phase 5 (M4)**.

- **Phase 5c — cheap `count()`**: `count()` now sums per-chunk cardinality straight from the `.crbm` index
  for warm-delta-free chunks — **zero payload reads or deserializes** — and merges only the chunks with
  pending Warm deltas. A fully-compacted (Topology-A steady-state) segment counts for free; this is now a
  build-breaking CI anchor (`count()` → 0 payload reads). Adds an optional `cardinalities()` to
  `ColdChunkSource` (the in-memory source omits it and falls back to fetch-and-merge — same answer, just not
  free); `has` / `iterate` / intersection are unchanged (DECISIONS #25).

- **Phase 5c — benchmark-as-test + published crossover chart**: the verified economics are now
  **build-breaking CI assertions** ([`tests/bench/anchors.test.ts`](tests/bench/anchors.test.ts)) so a
  cost/perf regression or overclaim can't ship — chunk-skipping byte-savings (a 5%-overlap intersection
  fetches ≤ 10% of a full download, measured through the metrics sink), at-rest ≤ 10% of a Redis-HA node,
  the write crossover ≥ the published rate, and the estimator within **±20%** of the engine's measured
  backend cost (**K3**). Adds an offline, **zero-dependency** `pnpm bench` generator that draws the
  CloudRoaring-vs-flat-Redis crossover chart straight from the shipped `estimateCost()` (so it can't drift),
  published to `bench/crossover.svg`, `bench/results.json`, [`docs/benchmarks.md`](docs/benchmarks.md), and
  the [site](site/benchmarks.html). Wall-clock latency stays offline (too noisy to gate on shared CI
  runners). The `count()` → 0-payload-reads anchor + the enabling cheap-count optimization land next
  (DECISIONS #23).

- **Phase 5b — cost estimator**: a first-class cost API. **Planning:** pure
  `CloudRoaring.estimateCost({ segments, workload, topology, pricing? })` — size a workload with no instance
  or data. **Grounded:** `segment.costReport({ workload?, pricing?, topology? })` — storage cost from the
  segment's **real** `.crbm` size (exact, no payload reads), request cost from the supplied workload. Rates are
  a pluggable `PricingProfile` (default `aws-us-east-1-ondemand`, from the fact-checked research; set
  `wruPerMillion: 0` to model a flat/provisioned Warm tier). Every `CostReport` carries a `verdict`
  (`win-big` | `win` | `lose-zone` — never hides where flat Redis wins), the `redisCrossover` rates (matching
  the verified ~26 writes/s + ~329 reads/s), and `assumptions` (the grounded flag + the model's
  simplifications). Malformed inputs — workload rates, segment sizes, and pricing rates — are rejected
  fail-fast with `ValidationError` (a report is never silently `NaN`). Adds an optional `sizeOf()` to
  `ColdChunkSource` for grounded size from the index. New
  exports: `estimateCost`, `DEFAULT_PRICING`, `AWS_US_EAST_1_ONDEMAND`, and the `PricingProfile` /
  `CostReport` / `Workload` / `SegmentSizing` / `EstimateInput` / `Topology` / `SegmentSize` types. Deferred:
  whole-store aggregation + live-metrics-derived request cost (DECISIONS #22).

- **Phase 5a — observability metrics sink**: an optional, injected `IMetricsSink` that receives typed
  `MetricEvent`s — cold GET (+ bytes + latency), warm read/write (+ bytes), cache hit/miss, OCC + transient
  retries, intersection fetched-vs-skipped chunks, and per-op latency. **Off by default** (a no-op sink;
  emission is skipped entirely when unused — a `metricsOn` fast-path, near-zero overhead); enable it with
  `new CloudRoaring({ warm, cold, metrics })`. The library emits **vendor-neutral
  events**, so you map the handful you care about to OpenTelemetry / Datadog / a log line in ~12 lines (a
  copy-paste OTel adapter is in the getting-started guide) — **no telemetry dependency is added to the
  library**. A buggy sink can never break a read/write (its exceptions are swallowed). Ships
  `CountingMetricsSink` (tallies events into a `MetricsSnapshot` — handy for tests and the upcoming grounded
  `costReport()`), `NOOP_METRICS`, and `safeMetrics`. New exports: `IMetricsSink`, `MetricEvent`,
  `MetricOpName`, `MetricsSnapshot`, `CountingMetricsSink`, `NOOP_METRICS`
  (DECISIONS #21).

- **Phase 4f — streaming / constant-memory compaction**: compaction now merges **and writes as a stream**, so
  the daemon streams the **cold** merge in constant memory — flat on the cold side (the dirty warm delta set is still buffered; a deferred fix) (the "runs in a 128 MB Lambda" property,
  now true for the write path too). `mergeChunksStream` yields one merged chunk at a time and
  `writeCrbmGenerationStream` feeds each to a streaming cold sink, freeing it. The **S3 cold driver uploads via
  multipart** (buffering ≤ one ~8 MiB part, flushed as the codec writes); a small object that fits one part is a
  single conditional `PutObject`, a larger one finishes with a conditional `CompleteMultipartUpload` — **both
  keep S3-enforced write-once** (a second writer → `WriteConflictError`, never a silent overwrite). In-flight
  uploads are aborted on error and SHA-256 is hashed incrementally; the S3 default object ceiling rises to the
  5 TiB multipart max (`partBytes` tunable). LocalFs already streamed to a temp file; the in-memory cold driver
  stays buffered (RAM by definition). Encryption composes unchanged. (DECISIONS #20).

- **Phase 4e — encryption-at-rest + crypto-shred**: opt-in **AES-256-GCM** encryption of the Cold `.crbm`
  objects (payloads **and** index, so a leaked object reveals neither ids nor cardinality), with **crypto-shred**
  erasure. Envelope model: a per-segment **DEK** is wrapped under one or more operator **KEKs** and stored in the
  registry; reads unwrap it, `destroySegment` / `eraseNamespace` delete it (the at-rest bytes are then
  permanently unrecoverable — GDPR erasure that works even on immutable/backed-up storage). Each ciphertext is
  AAD-bound to its `(namespace, segment, generation, chunkKey)` so it can't be relocated. **Key management is
  dependency-free by default**: an `InProcessKeystore` (BYOK — you supply 32-byte KEK(s)) using `node:crypto`;
  the `IKeystore`/`Aead` seams keep `core/` crypto-free and let KMS/Vault adapters drop in later. KEK rotation
  needs no data re-encryption (keyId-aware), and a DEK can be wrapped under an offline **recovery KEK** so losing
  the active KEK isn't fatal. Encryption is **store-level opt-in** (pass a keystore) with an optional
  `requireEncryption` guard; lose every KEK and a segment's at-rest data is gone by design (rebuild it from
  source). Threads through `bulkLoadCrbmGeneration`, `CrbmColdChunkSource`, and the compaction daemon (which
  reuses a segment's DEK across generations). New exports: `InProcessKeystore`, `NodeAead`, `destroySegment`,
  `eraseNamespace`, `aadFor`, `KeyUnavailableError`, and the `Aead`/`IKeystore`/`WrappedDek` types
  (DECISIONS #19).

- **Phase 4d — crash-safe compaction daemon**: consolidates accumulated Warm deltas into a fresh immutable
  Cold generation via a **2-phase commit** — `compactSegment()` (pin → merge `(cold ∪ adds) \ removes` → stage
  → verify chunk-keyset + cardinality → atomic `currentGen` swap → **version-fenced** Warm purge → orphan GC),
  merged chunk-by-chunk with working memory bounded by one segment's size. A write that lands mid-compaction is
  never lost (its newer OCC token fails the purge fence), and a crash at **any** step recovers cleanly (proven
  by a crash-at-every-step test sweep). A per-segment **lease** (registry `status` + owner/expiry, stealable on
  expiry) avoids duplicate work across multiple workers — though correctness never depends on it (concurrent
  compactions are safe); the lease is released even on an abnormal abort so a faulted segment isn't stuck
  `compacting`, and a per-segment fault is isolated so one bad segment can't abort the whole cycle. Concurrent
  **bootstrap** is no-data-loss: only the worker that actually writes generation 0 purges its Warm rows; an
  adopter leaves them for the next compaction. Readers self-heal if GC sweeps the exact generation they pinned
  mid-read (re-resolve to the current generation rather than fail — **no torn read**). Discovery
  (`findCompactable` / `runCompactionCycle`) scans the registry and drains Warm per segment (O(total warm)/cycle); the write path stays uncoupled from the registry. Ships the **`compact-segments` CLI** (`once` for Lambda/cron, `loop` for
  K8s/ECS) over the local-filesystem backend; cloud users call `runCompactionCycle` from their own handler.
  Also adds an in-memory `MemoryColdDriver`. (Crypto-shred-driven erase is Phase 4e.)

- **Phase 4c — segment registry**: an `IRegistryDriver` — the authoritative per-segment record holding the
  current generation (`currentGen`), discovery index, status, and a reserved wrapped-DEK slot — in three
  backends (`MemoryRegistryDriver`, `LocalFsRegistryDriver`, and `DynamoDbRegistryDriver` at the
  `cloud-roaring/dynamodb` subpath, co-located with warm rows in the single table). Reads can now resolve the
  current generation through the registry instead of a per-read **list-scan** of every generation: pass a
  `registry` to `CrbmColdChunkSource` (`new CrbmColdChunkSource(cold, { registry })`) — **optional**, with the
  list-scan kept as the fallback when absent. `bulkLoadCrbmGeneration(..., { registry })` publishes the new
  generation, and `publishGeneration(registry, key)` is the standalone, forward-only publish primitive. OCC,
  ABA-safety, and discovery all pass a shared `registryConformance` suite (vs in-memory, LocalFs, and
  DynamoDB-Local). Also: a `RetryingRegistryDriver` decorator, and a shared driver key-grammar helper
  (`_default` sentinel) extracted now that it has five consumers.

- **Phase 4b — resilience & fault-tolerance**: CloudRoaring now **rides through transient cloud faults**
  (throttling, 5xx, dropped connections, request timeouts) instead of surfacing them. A shared retry layer
  retries such faults with **bounded exponential backoff + full jitter** (default: 4 attempts; 50ms→100→200,
  capped at 2s),
  **on by default** for every warm/cold call — tune with the `retry` option or disable with `retry: false`.
  OCC conflict retries now back off too. **No data is ever lost or double-applied**: retries are idempotent
  (the OCC token detects a phantom-success; cold writes stay write-once), and the deterministic simulator now
  injects transient faults and proves effective-set equivalence holds under them. New public surface:
  `TransientError`/`TimeoutError`, `withRetry`, `RetryPolicy`, `DEFAULT_RETRY_POLICY`, and the
  `RetryingWarmDriver`/`RetryingColdChunkSource`/`RetryingColdDriver` decorators (driver authors can wrap
  their own). **Configure a request timeout on your injected S3/DynamoDB client** — timeouts are retried as
  transient (see the [getting-started guide](docs/guide/getting-started.md) §reliability).

- **Phase 4a — DynamoDB warm driver**:
  `DynamoDbWarmDriver` for the live warm tier, at the **`cloud-roaring/dynamodb`** subpath with
  `@aws-sdk/client-dynamodb` as an **optional peer dependency** (core's only runtime dep stays `roaring`).
  Real cross-process optimistic concurrency via DynamoDB conditional writes (a monotonic, ABA-safe counter);
  single-table layout; an optional `keyPrefix` lets several logical stores share one table. Inject your own
  `DynamoDBClient` (`new DynamoDbWarmDriver({ client, tableName })`). Passes the same warm-driver conformance
  suite as the in-memory and local-filesystem tiers.

- **Phase 3c — S3 cold driver**: `S3ColdDriver`
  for S3-compatible object storage (AWS S3 / MinIO), exposed at the **`cloud-roaring/s3`** subpath. Built on
  `@aws-sdk/client-s3` as an **optional peer dependency** — the core package's only runtime dependency stays
  `roaring`; you install the AWS SDK only if you use S3. Inject your own `S3Client`
  (`new S3ColdDriver({ client, bucket, prefix? })`); write-once via conditional `If-None-Match:*`. Passes the
  same cold-driver conformance suite as the in-memory and local-filesystem tiers.

- **Phase 3b — bulk-load**:
  `bulkLoadCrbmGeneration(driver, key, ids)` builds an immutable `.crbm` Cold generation from an arbitrary
  **unsorted** id stream (sync or async iterable) — the batch "seed/sweep" entry point. Folds ids into
  per-chunk Roaring bitmaps as they stream (input consumed lazily; deduped on insert), then writes chunks
  ascending. Returns `{ size, sha256, chunkCount, cardinality }`.

- **Phase 3a — chunk-skipping intersection engine**:
  `segment.intersect([...others])` and `intersectInto(dest, [...others])` — the crown jewel. Computes
  `A ∩ B ∩ …` by aligning the segments' chunk-key maps and fetching **only** the Cold chunks present in every
  operand (non-overlapping keys are never downloaded), streaming result ids ascending under a bounded
  in-flight window so it runs over huge segments in a small/serverless process. Tier-merging (warm adds +
  tombstones honored) and commutative.

- **Phase 2e — deterministic simulator**:
  a seeded scheduler (gating at driver-call boundaries) + fault-injecting fake drivers + a `Set`-oracle
  effective-set equivalence check, running the real engine under reproducible, replayable concurrency.
  Failures print a seed that reproduces the exact interleaving; a regression-seed corpus + seeded
  Warm-bytes fuzz round it out. Internal test infrastructure (not part of the published bundle).
  **Completes Phase 2 (M1, local end-to-end).**
- **Phase 2d — driver conformance suite**: shared
  `warmConformance` / `coldChunkSourceConformance` factories that every driver must pass, run against the
  in-memory **and** LocalFs drivers.
- **Phase 2c — Warm tier**: a persistent
  `LocalFsWarmDriver` with filesystem optimistic concurrency (monotonic counter token, ABA-safe tombstones,
  per-row lossless CAS chain). Engine writes survive a restart.
- **Phase 2b — Cold tier**: `IColdDriver` +
  `LocalFsColdDriver` (write-once via atomic `link`, symlink-hardened) + `CrbmColdChunkSource` bridging
  `.crbm` generations to the engine (generation-pinned). The engine now reads a persistent Cold tier.
- **Phase 2a — `.crbm` archive codec**: a streaming
  writer + speculative-tail-read reader for the on-disk Cold format — delta+varint footer index, per-chunk
  + index + footer CRC32C, version/flag gating, and a frozen golden-file corpus.
- **Phase 1 — in-memory core engine**: id routing,
  `SafeBitmap` (safe-deserialize + size cap over the `roaring` engine), the tombstone-aware chunk model +
  effective-set merge, a bounded LRU+TTL HOT cache, and the seven segment operations
  (`add`/`addMany`/`remove`/`removeMany`/`has`/`count`/`iterate`) over an OCC read-modify-write loop, with
  in-memory drivers and property tests against a `Set` oracle.
- **Phase 0 — Foundations**: repo scaffold
  (TypeScript strict, ESLint/Prettier, Vitest, CI, Husky, docker-compose), the 7 design specs, and the
  reserved npm name.
- **Public API exports:** `CloudRoaring`, `Segment`, the in-memory + LocalFs drivers, `CrbmColdChunkSource`,
  `writeCrbmGeneration`, `SafeBitmap`, the `.crbm` codec + blob seam, and the typed error classes.

<!-- At v1.0 (Phase 8) the above becomes the first versioned section, e.g. "## [1.0.0] - YYYY-MM-DD". -->
