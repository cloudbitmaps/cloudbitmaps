# Changelog

All notable, user-facing changes to CloudBitmaps are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).
Changes land under **[Unreleased]** and are cut into a version on release. For what is shipped and how far it is
proven see [`docs/ROADMAP.md`](docs/ROADMAP.md); for *why* a change is shaped the way it is, the entries below say
so, and so do the module headers in the code.

> **Pre-1.0 means the format and API can still move.** Breaking changes are possible in a minor bump until
> `1.0`, at which point the `.crbm` format freezes and normal SemVer guarantees apply.

## [Unreleased]

### Added

- **`AzureBlobStorage` can time each read: `readTimeoutMs`, off unless set.** With it set, every read request the
  Azure Blob storage and registry drivers send, a range read, a tail read's properties and its ranged download, each
  on its own, and a registry row's read, has `readTimeoutMs` to finish, the response body included, or it is aborted
  and throws `TransientError` ("Azure Blob download timed out after 2000 ms"), which the store's read retry runs
  again. No client setting bounds an Azure read whose body stalls: the SDK's per-try timer stops at the response
  headers. The timer starts at the call into the SDK, so waiting for a socket or a credential's token counts; the
  HTTP agent the SDK builds sets no socket limit. Writes, block commits, deletes and listings are not timed. `0`, the
  default, turns it off, and a value that is not an integer from 0 to 2,147,483,647 is refused with
  `ValidationError`. The drivers take it too (`AzureBlobStorageDriver`, `AzureBlobRegistryDriver`). The SDK's default
  retry waits 4 s before its second retry of a 500 or 503, so a timeout below that cuts it off, and the read throws the
  timeout instead of the 503 for the store's retry to run again. Tests run a real `@azure/storage-blob` client against
  a stub that stalls before the headers, after them and mid-body, and a child process checks that a read leaves no
  timer behind.

- **`S3Storage` can time each read: `readTimeoutMs`, off unless you set it.** The default is `0`, no timeout, until
  in-region measurements justify one. Set, it bounds every `GetObject` and `HeadObject` the S3 storage and registry
  drivers send, from the moment the read is handed to the SDK until its body is read: a read still running after that
  many ms is aborted, which releases its connection, and throws `TransientError` ("S3 GetObject timed out after
  N ms"), which the store's read retry runs again. The AWS SDK sets no timeout by default, so an untimed read on a
  connection that stops answering waits as long as the connection stays open. The clock counts the time a read waits
  for one of the client's sockets (50 by default) and the time spent fetching credentials, and under
  `retryMode: 'adaptive'` the SDK's rate-limiter wait, so a burst of concurrent reads larger than the socket pool can
  time out with nothing slow on the wire: against a local stub answering each request in 50 ms, 8,000 concurrent
  `has()` calls with `readTimeoutMs: 2_000` lost most of their reads. Size it above the worst queueing your concurrency
  implies, or raise `maxSockets`. AWS's S3 guidance is to retry a GET of under 512 KB after about 2 seconds; with
  `readTimeoutMs: 2_000` and the store's default retry, a read whose request stalls on every attempt fails after about
  8.35 s (4 × 2,000 ms plus up to 350 ms of backoff, derived rather than measured). Writes, multipart uploads, deletes
  and listings are never timed, and a `client` you pass gets the timeout without being changed. A value that is not
  an integer from 0 to 2,147,483,647 is refused with `ValidationError` (a longer Node timer fires after 1 ms).

- **`PricingProfile.storage.requestsPerPointerRead` prices a pointer read apart from a tail read.** It is the requests
  one pointer read costs, 1 by default, and the cost model charges it for each operand of an intersection, for the
  five pointer reads a load makes and for each pointer refresh. `requestsPerSizedRead` keeps its name and its default
  of 1, and now prices tail reads only: each operand's index read and the one a load makes. A pointer read is one
  request on S3, GCS and Azure Blob alike, so every shipped backend leaves `requestsPerPointerRead` at 1; S3 and GCS
  leave `requestsPerSizedRead` at 1 too, and an Azure Blob profile sets `requestsPerSizedRead: 2`, for its two-request
  tail read. An Azure profile that already sets `requestsPerSizedRead: 2` is priced one request lower for each pointer
  read, which is what an Azure pointer read now costs. A value that is not a finite number of at least 0 is refused
  with `ValidationError`, as `requestsPerSizedRead` is.

### Changed

- **A steady `store.load()` sends 11 requests to S3 where it sent 14: it reads the segment's row once, and checks its
  next generation number instead of listing for it.** A load read its registry row four times before its publish. On
  a cleartext segment it now reads it once, and the guard, the generation number, the write's refusal of a
  `destroyed` segment, and the publish's first attempt all decide from that read; the publish is fenced on that row
  as before, on its token, on the pointer a guarded load judged, or on its absence, so a row that changes in between
  makes the publish lose rather than land on the stale read. A load that found no row, or found an encrypted one,
  reads it again after its ids and before its write, so a first load still sees a row another writer created
  meanwhile, and an encrypted segment's key is unwrapped only from a row read after the ids. The number is
  `currentGen + 1` when one existence check finds no object holding it (a zero-byte tail read: `HeadObject` on S3,
  the object's metadata on GCS, the blob's properties on Azure Blob, one request on each); when the check meets an
  object, such as a crashed load's or the generations a rollback left above the pointer, or cannot answer (silently:
  nothing records it), the load lists the segment and numbers above everything in it, as every load did before. A
  load can therefore take a number below an object above the pointer, never one an object holds.

  Counts, measured on S3 (MinIO) and counted at the driver ports; those for GCS and Azure Blob are derived from their
  drivers. A steady single-part load on S3 is now 3 PUT-class requests (the object, the row, the collection pass's
  listing), 7 GET-class (five row reads, the guard's tail read, the check) and a delete, where it was 4, 9 and a
  delete; a segment's first load is 3 and 6, where it was 4 and 7, and its second the same. GCS makes the same
  counts; Azure Blob one GET-class request more, for its two-request tail read. An encrypted segment's load reads its
  row once more. `costReport()` and `estimateCost()` price a load at those counts, the check at one request on every
  backend whatever `requestsPerPointerRead` and `requestsPerSizedRead` say: $17.80 per million steady single-part
  loads at the default prices, where it was $23.60, and $17.40 for a segment's first load, where it was $22.80.

  What else moves with it:
  - **A drop or a shred that lands while a load is consuming its ids.** A load that read a present cleartext row
    before a `dropSegment` (or a retention sweep's drop) now writes its object, is refused at the publish
    (`published: false`, `reason: 'superseded'`) and deletes that object itself, since every generation of a
    `destroyed` segment is garbage; it threw `ValidationError` before writing. Only a load whose process stops
    between its write and its refusal leaves the object behind, for a re-run of the drop. An encrypted segment, or
    a load that found no row, is refused with `ValidationError` before it writes, as before. An `*Into` whose
    destination is dropped while it runs now throws `WriteConflictError` ("Re-read the destination and re-run"),
    where it threw `ValidationError`; a re-run gets the `ValidationError`.
  - **A cleartext write is never published onto an encrypted row.** A load with no keystore that wrote cleartext
    while another writer created the segment encrypted is refused at its publish with `KeyUnavailableError` and
    told to re-run with the keystore; before, a narrow window let such a publish land. A keystore load that mints a
    key while another writer publishes first is refused with `ValidationError`, whose message now says to re-run
    the write, which then uses the segment's key.
  - **A number whose object was deleted can be taken again.** It always could be (a refused load's, or a number an
    erasure freed with nothing above it); now a load also numbers under an object that survives above the pointer,
    after an erasure of the generations above a rolled-back pointer or a collection pass that stopped part-way. A
    live reader that still holds the old object's index used to fail such a read with `IntegrityError`; on an
    `IntegrityError` or a range `ValidationError` it now reads the object's footer, as a pin does, and when the
    object is another one, or gone, it re-reads the segment and answers from the new object. Caches key on the
    number and the row's token, and pins on the object's fingerprint, as before.
  - **Disaster recovery.** After a registry restore, re-running the load takes the number after the restored
    pointer while no object holds it, so the first re-runs can number below the generations published after the
    restore point and leave them above the pointer until a load's check meets one; the guide says to load until
    the pointer is above them. Because a re-run load takes again the numbers collection freed, step 9's restart or
    invalidation of every store is what clears a store that read the segment before the disaster.
  - **The calibration harness** expects each load's new shape, and its projection of a load's GET-class requests is
    now `4 + 2 × retryBound`: the default workload's bound is 364 PUT-class and 106,583 GET-class requests,
    $0.044453, and its expected bill 142 PUT-class and 92,907 GET-class, $0.037873.
  - **The storage conformance suite** now holds a driver's zero-byte tail read of a missing object to
    `NotFoundError`, as the port documents for every tail read.
- **Azure Blob reads a registry pointer in one request, where it made two.** A pointer read was the blob's
  properties and then a download pinned to the ETag they named; it is now one GET of the whole blob, taking the ETag
  (the version fence) and the length from the response that carries the bytes, so the pair describes one version and a
  concurrent overwrite is seen as the older row or the newer one, never split between two requests. The response is
  untrusted: one that is not a `200`, that has no ETag or an empty one, that has no length, or whose length is over the
  1 MiB row cap is refused with `IntegrityError` before a byte of its body is read, and the body is counted as it
  arrives and refused at the first byte past its length. A refused response is let go: the SDK throws on a response
  with no ETag or no length and leaves its socket open, and the driver aborts the request, which closes it. The read
  asks the SDK not to re-request the rest of a body cut off part-way, so the bytes come from one response or the read
  fails, with a `TransientError` the store's read retry repeats. An answer from a host other than the container's own,
  which is where a client set with `retryOptions.secondaryHost` sends a retried read, is refused as transient too, so
  the registry never takes a geo-replica's older row for the current one. A `404` is still absence. Writes, listings and the tombstoning delete are unchanged, and a tail read stays two
  requests, since Azure Blob takes no suffix range. Price an Azure deployment with `storage.requestsPerSizedRead: 2`
  and `requestsPerPointerRead` at its default of 1.

### Fixed

- **An Azure Blob range or tail read whose connection drops part-way through the body is a `TransientError`.** The
  SDK fails such a body with an `AbortError`, which reached the caller as it was, so the store's read retry did not run
  it again and a `has()`, `count()` or erasure failed on one dropped connection. The registry already read the same
  fault as transient. Tests drop the connection mid-body on a range read and a tail read, with the timeout off and on,
  and through the store.
- **An Azure Blob range or tail read lets go of a response the SDK refuses.** The SDK refuses a download with no ETag
  or no length by throwing a `RangeError`, and leaves the body unread with its socket open. The read now aborts its
  request when it fails, which closes the socket, with or without a timeout.
- **A calibration run survives a transient fault in a timed sample.** The workload's client makes one attempt per
  request and every timed store runs with its own retry off, so a single transient fault anywhere in a run's requests
  (up to ~94,600 GET-class and 364 PUT-class at the default workload) failed the whole run, and a partial run is not
  evidence. One in-region run failed on a single transient connection fault after about 86,300 requests; at that rate
  a run of this size would finish about a third of the time. A timed sample that meets a transient fault (a cold
  intersect, a cold point read, an `andNot` call or the warm stage's priming pass) is now discarded whole and run again
  from the start, from a state the failed attempt left nothing cached in: on a fresh store, except a first `count()`,
  which runs again on its store once the store has forgotten the segment, and a `has()` on an open segment, which runs
  again on the same store. At most three samples a run and two a stage are discarded; one more, or a fault in a load,
  fails the run as before. A transient fault is the library's `TransientError` or anything the installed SDK's own
  retry would retry. The harness waits for the failed sample's requests still in flight, counts them against it, and
  records each discard beside its stage: the sample, the error's name, the transport code beneath it, the SDK's
  attempt count, how long the attempt ran and the requests it made. Those requests are billed and stay in the stage's,
  and each stage's expected count is held to what its kept samples made. The projection allows three discarded samples
  at the costliest sample's bound, so the default workload's projected upper bound is 364 PUT-class and 106,583
  GET-class requests, $0.044453, under the $0.05 ceiling the README's example sets (`CR_CALIBRATE_MAX_USD` has no
  default, and `--run` refuses without one). `bench/lib/calibration-figures.cjs` treats a run with discards within the
  harness's bounds as evidence and requires its report to state how many it discarded. Wherever the harness records an
  error it now keeps the name, the code and the message: the SDK's HTTP handler renames `ECONNRESET`, `EPIPE` and
  `ETIMEDOUT` alike to `TimeoutError`, so the name alone could not say which it was. `CR_CALIBRATE_FAULT_GETS` makes a
  rehearsal fail the GetObject requests it lists, once each, as a reset socket or (`:denied`) as a 403 that is not
  transient, and is refused in every other mode. A test in the integration lane runs the harness itself through such a
  rehearsal against MinIO, so the integration job now builds the packages first. This is repository work on the
  calibration harness, outside the packages.
- **An S3 registry row refused for its size no longer holds its connection open.** A row whose response declares
  more than the 1 MiB cap is refused with `IntegrityError` before a byte of its body is read, and the body was left
  unread, so each refusal kept its socket until the server gave up on it. The driver now destroys the body on every
  way out of the read that leaves it unread, which closes the connection, with or without `readTimeoutMs`. A test
  refuses three such rows against a stub endpoint and checks that no connection is left open.
- **An S3 registry read whose body is cut off part-way is a `TransientError`.** It reached the caller as the
  SDK's raw connection error, which the store's read retry does not repeat; the storage driver already mapped the
  same fault.
- **One transient read fault no longer fails a whole load or erasure.** A load's guard read of the current
  generation, and an erasure's reads (the generation it rewrites and each of its chunks, the read-back that verifies
  the generation it wrote, and any other generation that may still hold the id) went to the raw driver once, so a
  single throttle or reset there failed the call. They now run under the store's read retry (`retry`, on by default),
  with its policy and `onRetry`; `loadSegment` and `eraseIdFromSegment` take it as an optional `readRetry` dep, and
  without one each read is made once. The writes are still sent once. This holds on every backend, with or without a
  read timeout. Tests fault each of those reads once, transiently and otherwise.
- **The production guide's S3 client-timeout sample set a timeout that only logs.** It built the client with
  `NodeHttpHandler({ requestTimeout: 3_000 })`, and on `@smithy/node-http-handler` 4.12.1 `requestTimeout` on its own
  logs a warning when it passes and leaves the request running; it ends the request only beside
  `throwOnRequestTimeout: true`. The sample sets `socketTimeout`, which ends a request whose connection has carried
  nothing for that long and leaves an upload that is still sending alone.

## [0.11.2] — 2026-10-01

**Upgrade if you read from GCS.** In 0.10.0 to 0.11.1, a GCS read that the SDK retried after a 408, 429 or 5xx could
end the process with `ERR_STREAM_UNABLE_TO_PIPE`, whatever the caller wrapped around it. This release sends every
GCS download once and retries it in the driver instead. It also makes a GCS pointer read and tail read one request
each, holds a reader's parsed index in typed arrays whose memory is counted exactly, and has `iterate` fetch up to 8
chunks at a time. No public API changes. The CloudShell entry is repository work on the calibration harness,
outside the packages.

### Changed

- **GCS reads a registry pointer and a generation's tail in one request each, where it made two.** A pointer read was
  a metadata request and then a download pinned to the generation it named; a tail read was a metadata request for the
  size and then a ranged download. The pointer read is now one GET, taking the version fence from `x-goog-generation`
  and capping the length before it buffers; the tail read is one suffix-range GET (`Range: bytes=-N`), taking the
  object's size from `Content-Range`, and an object shorter than the range comes back whole. Both refuse a header that
  is missing, malformed or at odds with the bytes received: a pointer read answers `IntegrityError` and a tail read
  `ValidationError`, where before the driver trusted whatever the second request returned. An empty object's tail is
  the exception to one request: GCS refuses a suffix of nothing with a `416`, and the metadata then confirms the object
  is empty, so it takes two. A pointer read can no longer lose its generation to a concurrent write between its two
  requests. The bytes returned and the registry's behaviour are unchanged. GCS now costs what S3 does per sized read, so `storage.requestsPerSizedRead: 2` in a pricing profile is
  for Azure Blob alone; leave it at its default of 1 for GCS.
- **`iterate` and the storage path of `count` fetch eight chunks at a time instead of one.** A cold full read of a
  segment waited for each chunk's GET before it asked for the next, so a 2,000-chunk read was 2,000 round trips in a
  row. `iterate` (with or without a range) now keeps up to 8 chunk fetches open ahead of the one it is yielding, and
  still yields every id in ascending order. The window opens 1, 2, 4, 8 wide, so a read the caller stops after a few
  ids has fetched a handful of chunks past where it stopped (none, if it stops in the first chunk), and an error in a
  later chunk surfaces only when the read reaches that chunk. `count` takes the storage path only for a custom chunk
  source that cannot serve cardinalities from an index; the shipped backends serve them, so their `count` reads no
  payload and is unchanged. The request total, the per-op budget and the memory ceiling (at most 8 decoded chunks held
  ahead) are unchanged, and there is no new option. A read still resolves one generation before it fetches, but a
  segment that re-resolves mid-read (a TTL boundary, an eviction, a sweep, an invalidation such as the store's own
  `eraseSubject`) now leaves up to 8 chunks already requested from the earlier generation, where a one-at-a-time read
  left only the chunk it was on; `intersect` has always read ahead this way. A fetch started ahead is not cancelled
  when the caller stops.
  Measured against an in-memory source with 10 ms of added latency per chunk read, 500 chunks, load average about 6.5:
  `iterate` 5.93 s to 0.77 s, `count` 5.92 s to 0.75 s; per-id cost on a warm segment is unchanged (about 180 ns an
  id before and after).

### Fixed

- **The CloudShell calibration script no longer stops in silence while it installs Node.** CloudShell ships Node 20, so
  the script installs Node 22 with nvm. nvm is not written for `set -eu`: sourcing `nvm.sh` returns 3 while no default
  Node is installed, and the script's `set -e` ended it there after printing "installing Node 22 with nvm", every time.
  It now runs nvm with those options off, restores them, and checks the result itself, stopping with a message if Node
  22 is still missing, and with another if nvm itself cannot be downloaded. A test runs the script's own bootstrap under its own shell options against an `nvm.sh` that returns 3.
- **A reader's memory bound counted less than its parsed index held.** `cache.readerMaxBytes` weighs each open
  reader by a fixed size per index entry, 160 B, and a measurement of the heap found 186–200 B retained per entry,
  so a cache could hold more index than its budget said. The reader now keeps its parsed index as typed arrays
  (key, cardinality, length, CRC and offset at their own widths) and reports their byte length: 20 B per entry,
  exact, and a test measures the retained memory against it. A 2,000-entry index also parses in about 45 µs where it
  took about 185 µs (Node 24, Apple M3 Pro, both versions bundled and timed under plain Node; inside a test runner
  the gap is nearer 1.7×). A chunk lookup is a binary search over
  the sorted keys. Nothing a caller sees changes except that the same budget now holds about eight times as many
  index entries; the sizing guide's reader table is regenerated at 20 B.
- **A GCS read the SDK retried could crash the process.** With `@google-cloud/storage` 7.x and 8.x (checked on 7.22.0 and
  8.1.0), when a download got any status the SDK retries (408, 429, 500, 502, 503 or 504) and the SDK's own retry then succeeded, the
  SDK threw `ERR_STREAM_UNABLE_TO_PIPE` ("Cannot pipe to a closed or destroyed stream") outside any promise and Node
  exited with code 1, whatever the caller wrapped around the call. It hit every read through `GcsStorage` on the client
  it built itself (tail, range and registry reads), in 0.10.0 and later. `GcsStorage` now builds a second client with
  the SDK's request retries off and sends every download through it, and the driver retries a download itself, up to
  three more times with backoff, after a connection fault (refused, reset, timed out, a DNS failure, a body cut off) or a 408, 429, 500, 502, 503 or 504: what the SDK retried, and not a missing credentials file or a TLS
  failure, which would fail the same way again. A store built with `retry: false` still gets it. What still fails is a `TransientError`. The client's other
  requests (uploads, listings, metadata reads) keep the default retries. A `client` you pass is used as given: build it
  with `retryOptions: { autoRetry: false }`, which also turns off the SDK's retries of listings, metadata reads and
  resumable uploads on that client.

## [0.11.1] — 2026-10-01

The package READMEs on npm say how to install on npm 12. npm 12 runs a dependency's install script only where the
project allows it, and `roaring`'s is the one that fetches its native binary, so a plain `npm i` installed a package
whose first `import` throws. The code in every package is unchanged from 0.11.0: only each package's README and its
version moved. Of the entries below, the install docs are the packages' change; the rest is repository work on the
calibration harness, outside the packages.

### Added

- **The calibration figures refuse a run for what it reports as wrong itself.** A run that timed `store.load()` is
  refused as evidence when teardown left anything behind, when it missed an expected count, when a stage's requests
  are not the ones the stage table expected, or when the shell ran in another region than the bucket's. Its latency is
  labelled in-region only when the round-trip floor is under the line and the shell's region is proven to be the
  bucket's, since a floor under 30 ms keeps another continent out but not a neighbouring region.
- **The calibration harness runs the stages an in-region run needs.** `pnpm calibrate:aws` now runs seven stages and
  records each one's own requests by class and by kind of read: loads through `store.load()`, cold intersects over
  the calibration layout, the same overlap with its shared chunks spread uniformly over each segment (a pure layout
  from a fixed seed, `bench/lib/calibrate-spread.cjs`), a sweep over how many chunks the operands share
  (`CR_CALIBRATE_SWEEP`, default 1,000 and 2,000), warm intersects, `count()` and `has()` as a first read, `has()` on a
  segment already open, both again warm, and `andNot` of one segment against ten. A warm read that makes a request fails its stage. One table names the stages and bounds
  each (`bench/lib/calibrate-stages.cjs`): the pre-flight projection prints every stage's bound, the finished run is
  held to each, and a test fails when the harness runs a stage the table does not name. Each load records its own
  requests, and `bench/lib/calibration-figures.cjs` prices a `store.load()` run from them and from each stage's own
  counts, refusing a file whose stages do not add up to what was billed.
- **The calibration harness measures how deep each cold read ran, and what it ran on.** Each cold intersect and each
  `andNot` call records the requests in flight at their peak, the mean in flight, and how many it waited for one after
  another, beside the engine's model of that, so a latency can be read against the number of round trips behind it.
  Every run also records the AWS SDK and HTTP handler versions and the handler's socket cap.

### Fixed

- **The install docs said npm needs nothing extra; npm 12 blocks `roaring`'s install script.** On npm 12 a plain
  `npm i @cloudbitmaps/roaring` exits 0 with the native binary missing, and the first `import` throws
  `Cannot find module './build/Release/roaring.node'`, as pnpm 10 does. The README, the getting-started guide and
  every package README now give one `package.json` block for both clients,
  `{ "allowScripts": { "roaring": true }, "pnpm": { "onlyBuiltDependencies": ["roaring"] } }`, and say that npm 11
  runs the script but warns until it is allowed the same way. The troubleshooting entry covers npm 12's
  `npm install-scripts approve roaring`, which records the approval but runs nothing, so `npm rebuild roaring`
  follows it.
- **The calibration harness runs from the CloudShell script's scratch directory.** It read the version it measured from
  `packages/roaring/package.json`, which a scratch directory that installed the published packages does not have, so
  `bash bench/calibrate-cloudshell.sh` stopped with `ENOENT` before it did anything. It now reads the installed
  package's version there and the checkout's own from a checkout, and a test runs the harness, in projection mode,
  from a directory holding only the files the script copies.
- **The CloudShell script installs a working `roaring` on npm 12, and refuses a run it cannot label.** npm 12 runs a
  dependency's install script only where the project allows it, and `roaring`'s is the one that fetches its native
  binary, so the scratch install exited 0 and the first import threw. The script now allows it, and stops before
  creating anything if the addon still does not load. It also refuses a shell that does not say which region it runs in,
  a requested region other than the shell's own, and a rehearse flag other than `1`, and it measures the release this
  clone's expectations were written for unless `CR_CALIBRATE_PACKAGE_VERSION` names another.

### Changed

- **Calibration results files carry every fractional number to nine decimals.** That is below a nanosecond for a time
  in milliseconds and a billionth of a dollar for a cost. A ratio's binary tail otherwise runs to 17 digits, and one of
  exactly 12 is a run the leak scan refuses, so a file could not be committed by chance.
- **The default calibration workload is 20 single-part and 5 multipart loads, and every segment is loaded once.** A
  segment's first load is what the projection bounds, so the harness refuses to load a name twice.

## [0.11.0] — 2026-10-01

Reading by id range, and a store that refuses what it would otherwise get wrong. `iterate`, `intersect`, `union`,
`andNot` and the `*Into` verbs read an id range `(after, through]` and fetch only the chunks it overlaps, so a large
segment pages by keyset. The public surface is trimmed to what callers use, a backend class is the one way to build
storage, and the store and the three cloud backends refuse every option key they do not take. Untrusted bytes get the
full structural check, a conditional write is sent once or settled by reading it back, and a subject erasure reaches
every generation that holds the id. Read the Breaking list before upgrading.

### Breaking

The first changes what two combines return, with no error. The next two narrow what an application sees: `@cloudbitmaps/roaring` exports a list of names in place of all of
core's, and a `Segment` can no longer be constructed. The four after them remove exports: the first deletes names
nothing in the library would still call, the second takes names off the public entries or moves them to the package
that uses them, and the third and fourth remove the retrying driver wrappers and the bulk loader. The two after those
make a backend class the one way an application builds its storage: the size settings move onto the backend options,
and the separate storage and registry halves and `createBackend` are no longer exported. The tenth makes
the collection refuse a `keep` it used to accept. The next twelve make a call throw where it used to return: seven of
them fix a wrong answer, and the entries under **Fixed** say what the call returned before; one changes when a pin fails;
three hold a call to a rule the rest of the library already kept; the last of the twelve refuses a namespace the library keeps for its own
rows, and says in its own entry what the call returned before. The six after them hold the store, the backends and the registry to what the library itself takes and writes, stop
checking for a local store's older directory layout, and give its errors the library's own brand. The two after them
change what `estimateCost()` compares with and what a `CostReport` carries. The last holds `eraseSubject` to its
budget for the generations it opens.

- **An expired exclusion excludes nothing, in every shape of combine.** `a.intersect([b], { exclude: [stale] })` and
  `a.union([b], { exclude: [stale] })` subtracted the ids of an `exclude` handle whose `expiresAt` had passed, and now
  return what they would with that handle left out of `exclude`, as `a.andNot([stale])` and a `union` whose other
  operands had all expired already did. The same holds with a range (`after`, `through`) and on pinned handles. An
  expired exclusion is skipped without being read, so one that names a segment that does not exist is no longer
  refused as an absent operand. Expiry treats an expired segment as gone, and an exclusion that is gone removes
  nothing; the answer used to depend on how the combine was spelled. A result that used to leave out a lapsed
  opt-out list's ids now includes them, so renew the list's `expiresAt`, or leave the deadline off it, where it
  must keep suppressing. Unchanged: an expired `self` or include operand is empty or dropped, an absent operand is
  refused unless `allowAbsentOperands` is set, and an `*Into` involving an expired handle, an exclusion included,
  throws `ValidationError`.
- **`@cloudbitmaps/roaring` exports an explicit list of names, not everything `@cloudbitmaps/core` exports.** An
  application installs the flavor and sees the store, the errors, the types its signatures name, the backends'
  shared types, and the constants and helpers a user calls. Every name below stays on `@cloudbitmaps/core`, which
  flavor and driver authors still import, and core's main entry and `@cloudbitmaps/core/driver-kit` are unchanged.
  - **Engine internals:** `SegmentEngine`, `EngineDeps`, `EngineCombineOptions` and `BoundedLru`. The engine was
    reachable from the flavor only to build a `Segment`, which can no longer be built (next entry).
  - **Metrics, budget and retry internals:** `safeMetrics`, `NOOP_METRICS`, `resolveBudget`, `resolvePerOpBudget`,
    `collectWithinBudget`, `DEFAULT_BUDGET`, `checkBudget`, `withRetry`, `RetryDeps`, `RetryingStorageChunkSource`
    and `RetryingOptions`. Omit `metrics` for the no-op sink, set `budget` and `retry` on the store, and retry a call
    of your own with a loop that backs off while `isTransientError(err)` holds. `Budget` and `DEFAULT_RETRY_POLICY`
    stay on the flavor.
  - **Other internals:** `groundedReport` (use `seg.costReport()`), `splitId`, `mapWithConcurrency`, `segmentKey`
    (use `seg.key()`), `isStorageBackend` and `PinnedStorageChunkSource` (use `seg.pin()`).
  - **The standalone forms of store methods:** `listGenerations` (use `store.generations`), `rollbackSegment`
    (`store.rollback`, which takes `allowForward`), `segmentExists` (`store.exists`), `listSegments`
    (`store.segments`), `setSegmentRetention`, `getSegmentRetention` and `clearSegmentRetention`
    (`store.setRetention`, `store.getRetention`, `store.clearRetention`), `runConsistencyCheck`
    (`store.checkConsistency`), `runExport` (`store.exportSegments`), `dropSegment` (`store.dropSegment`),
    `retireExpired` (`store.retireExpired`), `estimateCost` (`CloudRoaring.estimateCost`), `loadSegment`
    (`store.load`), and the types `GenerationListDeps`, `RetentionDeps`, `DropDeps` and `LoadDeps`. The flavor's own
    `loadSegment` and `runExport`, which bound the roaring codec, are deleted: core's versions take a `codec`, and the
    flavor no longer exports one. An application writes through the store's methods, on a store built on a backend
    class (`MemoryStorage`, `LocalFsStorage`, `S3Storage`, `GcsStorage` or `AzureBlobStorage`); composing a backend
    from drivers of your own is a driver author's job, done with `brandAsBackend` from
    `@cloudbitmaps/core/driver-kit`. Every result type these produce stays exported,
    because a store method returns it.
  - **Erasure:** `eraseIdFromSegment`, `EraseIdDeps` and `EraseIdResult`. `store.eraseSubject` is the one erasure
    verb.
  - **Still on the flavor:** `destroySegment` and `eraseNamespace`, which take only a registry and have no store
    method, and every other name in `@cloudbitmaps/roaring`'s export index.
- **A `Segment` has no public constructor.** It took the store's internals (a `SegmentEngine`, a metrics sink, and
  the functions that wire it to the store's write path), so `new Segment(…)` could not build a working handle
  outside the store. Get one from `store.segment(name, options)`, or from `seg.pin()`. `Segment` stays exported for
  `instanceof` and to annotate a variable, and `new Segment(…)` from JavaScript throws `ValidationError`.
  `seg.key()`, an opaque string naming the handle's segment that is equal across a live handle and its pins, is
  documented in the API reference.
- **`TimeoutError`, `AuditEventKind`, `VERSION` and `MemoryStorageChunkSource` are deleted.** Nothing in the
  library would still call them.
  - `TimeoutError` was never constructed or thrown by any package: a request timeout a shipped driver recognises
    already reached you as a plain `TransientError`, which is what to catch, and a driver of your own throws that too,
    with the cause attached.
  - `AuditEventKind` was `AuditEvent['kind']`; write that.
  - `VERSION`, which `@cloudbitmaps/roaring` exported, is gone: your lockfile and the installed package's
    `package.json` say which version you run.
  - `MemoryStorageChunkSource` was a test double that skipped `.crbm`, seeded chunk by chunk. Use a `MemoryStorage`
    backend and fill it with `store.load()`; to hand a store a `StorageChunkSource` of your own, implement that
    interface.
- **Names are off the public entries, and `@cloudbitmaps/core/driver-kit` sheds the helpers nothing outside core
  uses.** Each was a lower-level step that `store.load()` or the driver packages already take, a second spelling of
  a name that stays, or a helper one package uses.
  - `writeCrbmGeneration`, `publishGeneration`, `nextGeneration`, `gcOrphanGenerations` and `GenerationDeps` are no
    longer exported, from `@cloudbitmaps/core` or `@cloudbitmaps/roaring`. `writeCrbmGeneration` was kept on purpose
    until now. Load with `store.load(ref, ids, options)`, which takes the
    generation number, writes the object, publishes and collects. Collect with `keep` on `load` and on the `*Into`
    verbs, or retire a segment with `store.dropSegment()` or the retention sweep.
  - `SafeBitmap` and `roaringCodec` are no longer exported from `@cloudbitmaps/roaring`. Every call that takes a
    `codec` has it bound for you, so nothing needs them. An author of another flavor implements `CodecInterface`.
  - `DEFAULT_PRICING` is no longer exported. It was another name for `AWS_US_EAST_1_ONDEMAND`, which stays: clone
    and adjust that one.
  - `registryPrefix`, `registryObjectKey`, `registryListPrefix` and `parseRegistryKey` are no longer exported from
    `@cloudbitmaps/core/driver-kit`. No driver package calls them: `ObjectStoreRegistry` builds every registry key,
    and a driver built on it needs nothing else.
  - `errorName`, `httpStatus`, `isNetworkOrTimeout`, `isSdkRetryable` and `isServerSide` moved out of
    `@cloudbitmaps/core/driver-kit` into `@cloudbitmaps/s3`, the only package that uses them, and are not exported
    from it. A driver of your own classifies its SDK's errors itself.
  - `encodeNameForPath` and `namespacePathPart` moved from `@cloudbitmaps/core` and `@cloudbitmaps/roaring` to
    `@cloudbitmaps/core/driver-kit`, beside `encodeNameForKey` and `namespaceKeyPart`. Import them from there.
  - `validateSegmentRef` is exported from `@cloudbitmaps/core/driver-kit` only. It was also on `@cloudbitmaps/core`
    and `@cloudbitmaps/roaring`.
- **`RetryingStorageDriver` and `RetryingRegistryDriver` are no longer exported**, from `@cloudbitmaps/core` or
  `@cloudbitmaps/roaring`. Nothing in the library used them. The store's read retry is unchanged: the reads that
  answer a query go through `RetryingStorageChunkSource`, which stays on `@cloudbitmaps/core`, with `RetryingOptions`
  and `withRetry`, and the store's `retry` option and `DEFAULT_RETRY_POLICY` are unchanged. The two removed wrappers retried every call of the driver they
  wrapped, writes included, and a retried conditional write can report a write that landed as a conflict: when a
  write-once put or a compare-and-swap lands and its response is lost, the replay finds that write already there,
  so the put throws `WriteConflictError` and a load reports `superseded`, for the caller's own write; a load whose
  pointer write was replayed can report `superseded` while its own generation is current. Each also collected a whole
  `list` before yielding any of it. To retry a write, re-run the call, passing the ids again through a fresh
  iterator: a re-run `load` takes a fresh generation number and re-reads the row, so once the first attempt has
  settled it publishes whenever that attempt would have, whether or not it landed. Each attempt whose object landed
  takes a `keep` slot, so under the default `keep: 1` the re-run collects the generation the segment held before the
  load; pass a `keep` one above the number of attempts that landed to keep it. To learn whether an attempt landed,
  compare `store.generations(ref)` with what it listed before the call rather than replaying the request.
- **`bulkLoadCrbmGeneration` and `BulkLoadResult` are no longer exported**, from `@cloudbitmaps/core` or
  `@cloudbitmaps/roaring`. Load with `store.load(ref, ids, options)`, which
  takes the next generation number itself and publishes, and returns a `LoadResult` whose `published` says whether the load took effect, where the removed result said `becameCurrent`.
  Five more differences can change what a job does:
  - **A load collects.** Once it publishes, it deletes the generations the publish superseded, keeping the newest
    `keep` below the new pointer (default `1`). The removed loader deleted nothing, so a job that keeps older
    generations as `rollback` targets passes the `keep` it needs.
  - **An empty result over a non-empty segment is refused**, as `published: false` with `reason: 'empty'`. Pass
    `allowEmpty: true` when emptying the segment is the point.
  - **A load fences its publish on the row it read**, so a `setRetention`, a `rollback` or an erasure that lands
    while it writes makes it report `reason: 'superseded'`, where the removed loader published forward regardless.
  - **A load reads the current generation's size to guard it**, so a current object that will not open throws
    `IntegrityError`. A load with `allowEmpty: true` and no `guard.minRetained` does not read it.
  - **Neither can be told to write a generation without publishing it, to write one with no registry, or to take its
    generation number from the caller.** Nothing exported can: `writeCrbmGeneration` and `publishGeneration`, which
    could, are no longer exported either (see above).
- **The size settings are options of the backend classes, where they were options of the separate storage halves.**
  Set each one on the backend; a backend refuses the settings of another backend by name, as it refuses any key it
  does not take, and a setting keeps the name and default it had. Each must be a positive safe integer, and a value
  that is not throws `ValidationError` naming the option, from the backend's constructor. `S3Storage` and
  `GcsStorage` used to accept `NaN`, zero, a negative or a fraction for these and size their writes from it.
  - `S3Storage` takes `partBytes`, the multipart part size (default 8 MiB; a smaller value is raised to S3's 5 MiB
    minimum, and the part size grows so 10,000 parts cover `maxObjectBytes`), and `maxObjectBytes`, the largest
    object it writes and advertises (default `partBytes` × 10,000, about 80 GiB). They were options of
    `S3StorageDriver`.
  - `GcsStorage` takes `simpleUploadThresholdBytes`, the size up to which an object is one simple request (default
    8 MiB), and `maxObjectBytes` (default 5 TiB, GCS's maximum). They were options of `GcsStorageDriver`.
  - `AzureBlobStorage` takes `blockBytes`, the staged block size (default 8 MiB), and `maxObjectBytes` (default
    `blockBytes` × 50,000, about 400 GiB). They were options of `AzureBlobStorageDriver`.
  - `MemoryStorage` and `LocalFsStorage` had no size settings, and take none.
- **The separate storage and registry halves, their options types and `createBackend` are no longer exported.** An
  application gets both halves from one backend class and never names one. Removed from `@cloudbitmaps/core` and
  `@cloudbitmaps/roaring`: `MemoryStorageDriver`, `MemoryRegistryDriver`, `MemoryRegistryDriverOptions`,
  `LocalFsStorageDriver`, `LocalFsRegistryDriver`, `LocalFsRegistryDriverOptions` and `createBackend`. Removed from
  `@cloudbitmaps/s3`: `S3StorageDriver`, `S3RegistryDriver`, `S3StorageDriverOptions` and `S3RegistryDriverOptions`;
  from `@cloudbitmaps/gcs` and `@cloudbitmaps/azure-blob`, the same four with their own prefix.
  - **Use a backend class instead:** `MemoryStorage`, `LocalFsStorage`, `S3Storage`, `GcsStorage` or
    `AzureBlobStorage`. The size settings are options of those classes (previous entry). A backend's `.storage` and
    `.registry` are typed as the `IStorageDriver` and `IRegistryDriver` ports, including on `MemoryStorage` and
    `LocalFsStorage`, where they were typed as the concrete classes.
  - **To wrap a backend's half, or to pair it with a registry of your own** (tenant scoping, auditing, a registry in a
    database you already run), build the backend with `brandAsBackend({ storage, registry })` from
    `@cloudbitmaps/core/driver-kit`, in place of `createBackend`. It takes a plain object and returns it, branded. It
    now checks what `createBackend` checked: `storage` needs a `putImmutable` and `registry` a `compareAndSwap`, and
    it throws `ValidationError` naming the half that has neither. A store that refuses a hand-assembled
    `{ storage, registry }` now names the backend classes and `brandAsBackend`, where it named `createBackend`.

- **The collection refuses a `keep` that is not a non-negative integer**, with `ValidationError`. `load` and the
  `*Into` verbs already refused one before writing anything. The collection itself, which `gcOrphanGenerations`
  exposed, read `NaN` as a window that keeps nothing, so it collected the whole grace window, and a negative
  `keep` as `0`. A `keep` that is negative, fractional, `NaN` or infinite now throws on every path that takes one,
  and deletes nothing. Pass a whole number of generations, `0` to keep none below the new pointer.
- **On S3, and on GCS for the registry and for objects up to `simpleUploadThresholdBytes`, a conditional write that
  fails transiently throws `TransientError`**, where the SDK used to send it again and the call could return: a
  dropped connection, a timeout, a 5xx, throttling, and on S3 a signature refused for a clock minutes out, which the
  SDK corrects before the next request. These writes are a generation's write-once put, which `store.load`, the
  `*Into` verbs and an erasure's rewrite make, and the registry's create, compare-and-swap and delete, which writes a
  tombstone, one of which every publish, `rollback`, `setRetention`, drop, crypto-shred and retention sweep makes. The write may or may not have landed: re-run the call, and
  check what landed before treating the write as lost, since `store.generations(ref)` lists what the bucket holds with
  the current generation marked. Every other request keeps the SDK's retry, and a client you pass keeps its
  configuration.
- **A pinned read of a segment whose row is gone or destroyed throws `NotFoundError`**, where it read empty,
  part-way through a call included. Catch it where a pin can outlive its segment: across a `dropSegment`, a
  `retireExpired` or a crypto-shred.
- **A combine that holds one segment at two generations throws `ValidationError`** when it is read: pins of two
  generations, pins of one generation number that are two different objects, or a pin and a live handle, as in
  `live.intersect([snap])` with nothing moved since the pin. Materialise one side first, with
  `intersectInto(dest, [])`.
- **`pin()` opens the generation it pins**, so it fails where the pin's first read used to: `NotFoundError` for a
  pointer at a missing object, `IntegrityError` for a damaged one. Handle both where you call `pin()`, as you did
  around the pin's first read.
- **An object whose footer names another generation is refused with `IntegrityError`** wherever it is opened, a pin
  included, so a default load onto a segment whose current generation is misfiled fails its guard. To move past it,
  roll the segment back to an earlier generation that opens, or load with `allowEmpty: true` and no
  `guard.minRetained`, which then does not read the current generation.
- **A chunk payload that is not a well-formed roaring bitmap is refused with `IntegrityError`**, by every read and
  every erasure that decodes it, and by `SafeBitmap.safeDeserialize` and `roaringCodec.safeDeserialize`, where the
  native deserializer accepted it: containers or values out of order or listed twice, runs that overlap,
  touch or run past their container, a run container with no runs, a bitset whose header cardinality disagrees with
  its bits, and an offset header that disagrees with where the containers are. Nothing the library writes has any of
  these shapes, so a segment it loaded reads as it did.
- **An object whose index is not internally consistent is refused with `IntegrityError` when it is opened**, so
  every call that opens it throws: `has`, `count`, `iterate`, every combine, a load's guard, a pin, an erasure and
  `checkConsistency`. Two shapes were accepted and are now refused: an index entry whose payload runs past the end
  of the payload region, into the index, and an encrypted object's entry whose payload is too short to hold its
  nonce and tag. `count()` summed such an index and returned; a read of the chunk failed later, on its checksum or
  its authentication tag. Nothing the library writes has either shape, so a segment it loaded reads as it did. To move
  past one, roll the segment back to an earlier generation that opens, or load with `allowEmpty: true` and no
  `guard.minRetained`, which then does not read the current generation; a default load fails its guard.
- **A combine whose other operands have all expired checks its own segment as every combine does.**
  `seg.union([expired])` and `seg.andNot([expired])` read `seg` alone, and now refuse a `seg` that names no segment
  with `ValidationError`, as `seg.union([live])` already did, where they returned no ids; `allowAbsentOperands: true`
  still reads it as empty. They also now take the call's `concurrency` and `budget`, so `concurrency: 0` throws and a
  per-op budget too small for `seg` refuses the read. The error, the budget refusal and the `intersect` metrics event
  of such an `andNot` name the verb `union`.
- **A custom `StorageChunkSource` that lists one chunk key twice is refused with `IntegrityError`** by every read
  that lists a segment's chunks: `iterate`, every combine, and a `count` with no index to sum. A combine used to drop
  the duplicate. The sources the library ships never list a key twice; make a custom one's `listChunkKeys` return
  each key once.
- **A read whose pointer refresh fails with anything but a transient fault throws that error**, where it kept
  serving. A `has`, `count`, `iterate` or combine, or a `costReport`'s size read, that finds its segment's pointer
  due for a re-read (once `cache.genTtlMs` has passed) and gets an access denial, an `IntegrityError` for a row
  that will not parse, or any other error that is not a `TransientError` now fails with it, and the reader's
  snapshot is dropped, so the next read resolves the segment afresh. A transient fault is unchanged: the reader
  keeps serving, now with a retry after 500 ms rather than after a whole `cache.genTtlMs`. A dropped or shredded
  row, which the registry reports as no row, still reads empty. See **Fixed**.
- **`eraseNamespace` throws `BudgetExceededError` for a namespace of more than 250,000 segments**, where it erased
  it. It listed the whole namespace with no bound, holding every row resident, when every other fleet scan stops at
  a ceiling. It now holds its listing to `DEFAULT_MAX_SCAN_SEGMENTS` (250,000), and the error tells you to raise
  the new `maxScanSegments` option on the call when the namespace really is that large and the memory is there,
  without the other scans' advice to narrow with a `namespace`, since the call already is one. The call lists the whole namespace before it destroys anything, so the refusal comes first and
  nothing is erased. A `maxScanSegments` that is not a finite number of at least 1 throws `ValidationError`, also
  before anything is destroyed. `eraseNamespace` is a free function over a registry, so no store method forwards
  the option.
- **A namespace starting with `cbm.due.` is refused with `ValidationError`**, in every segment ref and in every
  `namespace` option: `store.segment`, `load`, `exists`, `generations`, `rollback`, `dropSegment`, `setRetention`,
  `getRetention`, `clearRetention`, `invalidate`, `segments`, `retireExpired`, `checkConsistency`, `exportSegments`,
  `subjectReport` and `eraseSubject`, and the free function `eraseNamespace`. The library
  keeps its due index in `cbm.due.<day>`, and every fleet-wide scan skips a row there as bookkeeping, so a segment
  of yours in a namespace such as `cbm.due.eu` was invisible to the calls that scan: `eraseSubject` and
  `subjectReport` returned an empty ledger with `scannedSegments: 0` even with that namespace named, so an erasure
  reported nothing to erase while the id was still in the segment; the unscoped `retireExpired` and
  `checkConsistency` never saw it; `exportSegments` left it out and `segments()` did not list it. Only that exact
  prefix is reserved: `cbm.dueX`, `cbm.due` and `cbmdue.eu` are ordinary namespaces, and a segment name is not
  restricted. The library's own writes to the reserved namespace go through the drivers and are unchanged: a
  driver takes the prefix, since `validateSegmentRef` on `@cloudbitmaps/core/driver-kit` checks the name rules
  only. A segment that already sits in such a namespace stays where it is, but no call names it after the upgrade:
  before upgrading, copy each into another namespace (`iterate()` its ids and `load` them there) and `dropSegment`
  the old one.

The first four of these make the library refuse what it used to ignore or accept, so that a wrong input fails
where it is written. The fifth drops the check for a local store's older directory layout, and the sixth renames
the error brands:

- **`new CloudRoaring(options)` refuses every key it does not take**, at the top level and inside `cache`,
  `encryption`, `retry`, `budget` and `seams`, with a `ValidationError` naming each one and the keys the store or
  the group takes. It refused a fixed list of spellings before, and ignored any other key. A group that is not an
  object is refused too — `null`, an array, a Map, a boxed primitive, `encryption: true` — and `false` is taken
  only by `retry` and `budget`.
- **`new S3Storage(options)`, `new GcsStorage(options)` and `new AzureBlobStorage(options)` refuse every key they do
  not take** the same way, and an options bag that is not an object. `GcsStorage` refused only `storage` before,
  and the other two ignored any key they did not take.
- **`new S3Storage(options)` and `new GcsStorage(options)` refuse a connection setting given beside a `client`.**
  `S3Storage` refuses `region`, `endpoint`, `pathStyle` and `credentials`, and `GcsStorage` refuses `projectId` and
  `apiEndpoint`, with a `ValidationError` naming each one given. They were ignored before: a `client` carries its own
  region, endpoint and credentials, so an `endpoint` meant for MinIO beside a client built for AWS sent the store's
  traffic to AWS. Configure those settings on the client, or drop `client` and let the store build one from them.
  `bucket`, `prefix`, `now` and the size settings (`maxObjectBytes`, `partBytes`, `simpleUploadThresholdBytes`) are still
  taken beside a `client`, as is a setting set to `undefined`. A `client` of
  `null` counts as none, so the settings build one; `AzureBlobStorage` reads a `containerClient` of `null` the same
  way, which throws `ValidationError` at construction unless `connectionString` and `container` are given, where it
  used to build a store that failed on its first read.
- **`RegistryStatus` is `'active' | 'destroyed'`.** A stored registry row with another status, a field its record
  or its envelope does not declare, or no `schemaVersion` is refused on read with `IntegrityError`, and so is every
  `list()` of a registry that holds one, which the retention sweep, `checkConsistency` and subject erasure run. Every
  row a store created at `0.10.0` or later writes passes. A row last written before `0.10.0` does not, nor does a
  tombstone `0.10.0` wrote over one, since the tombstone keeps the row's fields, nor a row a caller set to
  `compacting` or `erasing` through the registry driver: load such a store's segments into a new one from their
  source. The registry drivers also refuse to write any status but `active` and `destroyed`, with `ValidationError`.
- **`LocalFsStorage` does not look for a `cold/` directory.** A root keeps its generations in `storage/`, and one
  that holds them anywhere else opens like any other with its generations missing: a read throws `NotFoundError`,
  and `checkConsistency` reports `missing-storage-generation`. Move a root's generations before you upgrade, while
  `<root>/storage` does not exist yet, with `mv <root>/cold <root>/storage`: the objects inside are unchanged, and until they move, that report is the path,
  not a torn restore.
- **The error brands are `Symbol.for('cloudbitmaps.error')` and `Symbol.for('cloudbitmaps.error.transient')`.**
  Upgrade every `@cloudbitmaps` package together: a package from an earlier release brings its own copy of core,
  and neither your error predicates nor the store's own error handling recognise that copy's errors.

These two change what `estimateCost()` reports:

- **`estimateCost()` compares with the Redis that would hold your data, not one $346 cluster.** The default
  verdict, rationale and read crossover are now against the cheapest ElastiCache for Redis OSS cluster that holds
  the report's stored bytes at their compressed size: enough shards, each a primary and two replicas, with 25%
  of each node's memory reserved, at AWS's us-east-1 on-demand prices from its price list of 2026-09-14, and the
  burstable `t4g` nodes priced only as one shard. One cluster was the wrong size in both directions: 200 MB fits
  three `cache.t4g.micro` nodes at $35.04 a month, and 2 TB does not fit it at all — three `cache.r6gd.16xlarge`
  data-tiering nodes hold it, at about $27,325. The report names what it priced in the new `redisBaseline`,
  `{ basis: 'fixed', monthlyUSD }` or `{ basis: 'sized-to-data', monthlyUSD, cluster: { nodeType, shards, nodes,
  dataTiering } }`, and in the last of its notes. It is the cheapest cluster of one kind, not the least Redis could
  cost: the compressed size is a floor on the memory Redis needs, since a native Redis bitmap is sized by its
  highest id, but reserved nodes, one replica a shard, or ElastiCache for Valkey all cost less than it prices.

  **To keep the old comparison**, pass `pricing: { ...AWS_US_EAST_1_ONDEMAND, redis: ONE_REDIS_HA_CLUSTER }`.
  `ONE_REDIS_HA_CLUSTER` is the $346 cluster the benchmarks page still charts. What else changes:

  - A default report has a different baseline at every data size, so a different crossover, and it can have a
    different verdict.
  - `pricing.redis` must give exactly one of `{ monthlyUSD }` and `{ sizedToData: RedisSizing }`, and one giving
    both is refused with a `ValidationError`, where a key set to `undefined` gives nothing. So is a spread of the
    default's `redis` with a price, `{ ...AWS_US_EAST_1_ONDEMAND.redis, monthlyUSD: 500 }`, since the spread now
    carries the default's `sizedToData` too; it is refused rather than read one way.
  - JavaScript that reads `AWS_US_EAST_1_ONDEMAND.redis.monthlyUSD` gets `undefined`, and a ratio built on it is
    `NaN`. Read `report.redisBaseline.monthlyUSD` instead, or `ONE_REDIS_HA_CLUSTER.monthlyUSD` for the one
    cluster. TypeScript types it `number | undefined`, so under `strictNullChecks` a ratio built on it does not
    compile.
  - A hand-built `CostReport` must carry `redisBaseline`, which is required.
  - `segment.costReport()` sizes the Redis to that one segment — $35.04 for any segment up to 384 MiB, a tenth of
    $346 — so per-segment verdicts move toward the lose-zone, and the baselines of a store's segments do not add up
    to the store's. To judge a store, price all its segments in one `estimateCost()`. To alarm, sum the segments'
    totals and compare the sum with the Redis you would run for the store, as the cost gauge in the dashboards
    guide now does: a per-segment verdict against that whole price fires only when one segment alone costs more than
    all of it.
  - The catalogue is `ELASTICACHE_REDIS_US_EAST_1_ONDEMAND`, with the types `RedisSizing` and `RedisNodeType`. It,
    `ONE_REDIS_HA_CLUSTER` and the default profile are frozen, so a caller that changes one no longer changes every
    other caller's estimates: the change throws in strict mode, as in every ES module, and is ignored in a
    sloppy-mode script.
  - A report with no bytes to size to — nothing stored, or a storage source that cannot measure — compares with the
    catalogue's cheapest cluster, and its rationale and notes say that no bytes were counted.
  - The benchmarks page's line is still drawn against the $346 cluster, and now says that this is 2.4 times the
    $142.35 Redis the default prices for its 1.2 GiB reference set, against which the line would sit at 135.42 reads
    a second. `pnpm bench:check` fails CI when the chart, the page or `bench/results.json` drifts from the
    estimator.
- **`CostReport.monthlyUSD.byOp` gains the required `pointerRefresh`**, so a `CostReport` you build yourself must
  set it, and `estimateCost()` refuses an `operandsPerIntersect` below 1 with `ValidationError`. The rationale names
  intersections, loads and the refresh in new words, and the notes gain lines for intersections, the refresh and a
  hot set larger than the reader cache, and its loads line is reworded, so a check that matches either's text needs
  its new wording. The entry
  under **Fixed** says what the estimator counts now.
This one changes what an erasure charges its budget for:

- **`eraseSubject` charges its budget for the generations it opens, and reports a segment that runs it out.** A
  segment whose current generation lacks the id is searched in every generation still in its bucket, which is one
  open each and, with the keep-everything default of the `*Into` verbs, one for every generation the segment ever
  had. The budget counted one unit for the segment, and the guide and the API reference said the call was
  `O(registered segments)`. It now charges one unit per segment and one for each generation opened beyond the one
  the segment's row names, so the call is `O(registered segments + superseded generations)`; a rewrite of a segment
  that holds the id, and the read that verifies it, are not charged beyond the segment's unit. The default,
  1,000,000, still covers a normal fleet. A segment that runs the budget out is listed with `erased: false` and
  an `error:` note carrying the budget refusal's message, before it deletes anything (the one refusal that can come after a rewrite is
  the last check for a generation a concurrent writer left behind), and the
  scan goes on: the call does not throw for it, so the ledger of the erasures that did happen is not lost. A call
  that listed nothing for such a segment, because the id was in none of its generations, therefore now lists an
  error entry for it. Re-run with a higher `budget`, per call or per store, or `budget: false`.

### Added

- **The guide is split into topic pages, and getting started is the 10-minute path.** The README leads with what the
  library is, a plain definition of segment, generation and pointer, a first run on `MemoryStorage` that can be saved
  and run, and a choice of backend. Getting started goes from install to a bucket, with a glossary. The detail moves
  to new pages in `docs/guide/`: `production.md` (a before-production checklist, with the permissions the library
  issues, the bucket lifecycle rules, and a timeout sample that passes the client to `S3Storage`), `loading.md`,
  `reading.md`, `retention.md`, `encryption.md`, `erasure.md`, `observability.md`, `export.md` and `cost.md`. Each
  page puts what a user does first and the mechanism last. The package READMEs share one template, and
  `site/llms.txt` carries a worked example. The docs also say plainly that the `export-segments` command reads a
  local-filesystem store only, and that an S3, GCS or Azure Blob store exports with `store.exportSegments(sink)`.
- **`IRegistryDriver.delete` takes an optional expected token: `delete(ref, expected?)`.** Without it, nothing
  changes: deleting an absent row is a no-op. With it, the delete lands only while the row still carries that
  token, and otherwise (another token, or no live row) throws `WriteConflictError` and leaves the row, as a
  compare-and-swap does. The memory, local-filesystem and `ObjectStoreRegistry` registries, and so the S3, GCS and
  Azure Blob ones, implement it. **For a third-party registry driver the change is additive:** the parameter is
  optional, so a driver that ignores it still compiles and keeps the unfenced delete. Implement it to make the library's own deletes safe against a concurrent re-create; the
  registry conformance suite now holds every registry to it.
- **The driver ports state the contracts callers rely on, and a conformance suite holds every storage driver to
  them.** `IStorageDriver` and `IRegistryDriver` now say, in their doc comments, the driver kit's header and the
  API reference: `putImmutable` is write-once and throws `WriteConflictError` on a collision; a missing object
  makes `getRange` and `getTail` throw `NotFoundError`; an out-of-range read throws `ValidationError`; `getTail`
  reports the true total size; `delete` is idempotent; `list` is strongly consistent, read-after-delete; a driver
  never replays a conditional write without telling the replay apart, by sending it once or by recognising its
  own write on the read-back; a transient fault is a `TransientError`. The new `storageDriverConformance` suite
  runs each of these against the memory and local-filesystem drivers in the unit suite and the S3 (MinIO), GCS
  (fake-gcs-server) and Azure Blob (Azurite) drivers in the integration suite. A registry fixture whose write lands
  and then fails proves the registry reports that fault and neither retries the write nor reports a conflict.

- **An id-range read: `iterate({ after, through })`, and the same two options on `intersect`, `union`, `andNot` and
  the `*Into` verbs.** A read yields only the ids in `(after, through]`, ascending, and fetches only the chunks the
  range overlaps, on every operand and every `exclude` of a combine, so a keyset page bounded by `through` costs the
  chunks of its window rather than a walk from the first id. The per-op budget is charged once, before the first
  fetch, for every chunk in the range, so with `after` alone it is charged to the end of the segment. Each bound is
  optional and an integer in `0..4294967295`, or the read throws `ValidationError` when first read; `after >= through`
  is an empty read, which fetches nothing. A pinned read fails with `NotFoundError` for any chunk it must fetch from a
  generation that has since been collected, as a full pinned read does. `IdRange` (`{ after?, through? }`) is
  exported, and `BaseCombineOptions` extends it. The `intersect` metrics event, which every combine emits, counts in
  `fetchedChunks` and `skippedChunks` only the chunk keys inside the range.

- **`PinnedAt` names the object a pin holds.** It gains an optional `fingerprint`: the pinned object's size and
  footer checksum, which `seg.pin()` records. `PinnedObject` (`{ version, fingerprint? }`) is exported beside it.
  `CrbmReader` gains `fingerprint`, and `CrbmReader.sameObject(blob, fingerprint)`, which says from one footer's
  worth, with no key, whether the object behind `blob` is the one a fingerprint names. A fingerprint is opaque:
  compare two for equality, and do not parse one.
- **What it saves, and where it doesn't**, a new guide page, `docs/guide/why-cloudbitmaps.md`, and the README now
  opens with the same comparison. It sets CloudBitmaps against an always-on Redis: what each is for, where each
  bill's money goes, what each grows with, and where each costs less, with two charts that `bench/sizing.cjs` draws
  from the estimator, in a light and a dark file each, and `pnpm bench:sizing:check` holds to it, byte for byte.
  It says what the comparison assumes, and how far a Redis bought another way moves the saving: as ElastiCache for
  Valkey, with one replica a shard, or on a reserved term, each priced from the AWS price list the estimator's
  catalogue cites. Bought all three ways, on three years paid upfront, the medium and large deployments' Redis
  costs less than CloudBitmaps. It says where CloudBitmaps loses — small data queried hard, latency, S3's
  per-prefix rate, and overlap — and lists the planned work that addresses them, none of it built yet; the roadmap
  holds the same directions. `pnpm bench:sizing:check` now also refuses, outside the generated regions of a page that
  says its figures are generated, what could be a figure no gate compares: a digit in any form Unicode counts as a
  number, but in a few names, definitions and link targets it lists, such as `us-east-1`; a number word from two up,
  but in a few phrases it lists, such as "the three deployments"; a share or a multiple's sign, a currency sign, and
  any character but plain ASCII, `§` and `—`; HTML, an image, a code fence, or an emoji GitHub shows as a digit; and
  a share, a multiple, a half or a dollar amount in words, in the spellings it knows. It is a check against drift, an
  honest edit that types a figure by hand, and not a bar to one written on purpose in a form it has never seen: on
  those pages it reads no markdown structure, and refuses what it cannot read. It reads the README's section from its
  one `## Why CloudBitmaps` line, and refuses another heading that would show as that one, in markdown or in HTML,
  HTML or a fence above it, and a heading that shows nothing where it ends. It keeps the rest of the README to the
  phrases it lists, each a measurement quoted where it is explained, and refuses a share or a multiple there however
  emphasis, an escape, a link, a footnote, a blockquote's wrap, an invisible character or HTML falls across it; it
  refuses an entity GitHub decodes, a legacy name without its semicolon included, on any page it writes into, and an
  image under `bench/` that a page shows and no generator draws; it holds each region's END marker to ending its
  line; and `scripts/site-figures.cjs` reads `SIZING` markers with the same reader, which takes every comment shaped
  like a marker for one.
- **What it costs at your size**, a new guide page, `docs/guide/sizing.md`. It prices a small, a medium and a
  large deployment with `estimateCost()`, term by term, against the Redis that would hold each one's data, and says
  how much room each has before its bill meets that Redis: illustrative workloads, labelled as such, with every
  dollar figure generated by `bench/sizing.cjs` from the shipped estimator and `pnpm bench:sizing:check` failing CI
  when the page and the estimator disagree. It says what moves the large deployment's bill, the pointer refresh and
  cold intersects, and where a standing cache still wins: a hot path of hundreds of cold intersects a second, and
  the per-prefix request rate S3 documents. There is no latency on it, because none has been measured in-region.
- **The single-bucket bill, measured on AWS.** The calibration harness's first publishable run,
  `2026-09-23-94416`, put the topology that ships on real S3 in `us-east-1` — the registry pointer in the same
  bucket as the data — and the benchmarks page now publishes what it costs. The median cold intersect of two
  500,000-id segments sharing 100 of 1,999 chunks made **206 GETs, $82.40 per million**; with each pointer read
  once, as inside the region, it is expected at 204 GETs, $81.60 per million. Writing and publishing a segment is **2 PUTs and
  3 GETs, $11.20 per million**, pointer included, and $26.20 per million multipart; `store.load()`, which also
  lists and collects, is expected at about twice that, from a test that counts its requests. All 40 cold
  intersects were exact, and each requested only the 100 shared chunks per segment: chunk-skipping, shown on real S3
  at a shape that tests it. The run was driven from a laptop outside the region, so its latency and upload figures
  measured the connection and are not published as the library's. The in-region run is still owed.

  The run's evidence is committed unedited as `bench/calibration/2026-09-23-94416.json`, beside a report that
  explains every figure with a diagram, labels each one measured, derived or expected, and says what the run does
  not establish. A new gate, `tests/docs/calibration-reports.test.ts`, derives every figure from that evidence
  through `bench/lib/calibration-figures.cjs` and holds the report and the benchmarks page's section to it in both
  directions. A missing headline figure fails it, and so does any dollar amount, percentage, duration, byte size,
  bit rate or ratio, or any number written before the request, chunk, id or load it counts, that the evidence cannot
  account for at the precision it is written — or that stands beside the words for another claim, such as the
  expected intersect's cost called measured. It refuses evidence that does not reconcile with itself or that more
  than one commit has touched, and checks the report's bill, its request ledger and its table of cost by overlap
  row by row. `bench/calibration/` has a README of its own, and the directory README gate now lets such a
  subdirectory take one row in its parent's.

  The figure this supersedes, $5.88 per million publishes, left the pointer out: it came from a run that kept the
  pointer in a NoSQL table. The site, both READMEs, `llms.txt` and the roadmap now quote the single-bucket
  figures. `scripts/site-figures.cjs` checks the dollar amounts in `llms.txt`, the READMEs, the roadmap and
  `docs/benchmarks.md` as well as the site's pages, none of which was checked before, and every figure in any
  paragraph, list item or table row on those pages that quotes the run, rates and counts included. It allows the superseded
  figure only on the benchmarks page, which says it is superseded, and either July figure only beside the pointer
  it leaves out. The home page's headline is now the measured cold intersect rather than the July `count()`
  figure.

  Checking the run against the code found that `estimateCost()` under-quoted both operations in this topology;
  it now counts what they send, as the entry under **Fixed** below says. The benchmarks page's claim for the
  estimator is narrowed to what its tests prove: it never quotes fewer chunk reads than the engine makes, and its
  other request counts are held to the engine's.

- **A real-cloud calibration harness for the loaded store** — `pnpm calibrate:aws`. The previous one was
  deleted with the warm tier because it metered a write path through a NoSQL registry that no longer ships,
  which is why load throughput, in-region intersect latency and the single-bucket bill were all listed as owed
  on the benchmarks page. This is the tool that pays them.

  It spends money, so it defaults to a projection that touches nothing, rehearses its workload against MinIO for
  free (the money guards have nothing to guard there, so a rehearsal does not exercise them), and refuses a run
  that cannot state its region, its spend ceiling and its intent separately. The
  guards are pure functions in `bench/lib/calibrate-guards.cjs` with a regression test each, because every one
  is a bug that actually happened — including a `NaN` spend ceiling that silently deleted the bound, and a
  `HeadBucket` 403 read as "absent" for a bucket the caller owned, which in `us-east-1` would have run the
  workload inside a real bucket and deleted it on teardown.

  Its first real run was against a real account from a laptop, and it was more useful for what it exposed than
  for its numbers. Every run now **measures its own distance to the region** and labels latency as in-region or
  network-dominated, because from outside the region a p50 describes internet transit. Intersects are **cold** —
  a fresh store each time, so no cache answers them — and each must return **exactly** the planned ids, count
  and sum, or the run refuses to report a latency. The workload now reproduces the published shape (100 of
  ~2,000 chunks per operand) instead of the three chunks the first run touched, and uploads two segments large
  enough to go **multipart**, which the first run never did. Fetched bytes are split into chunk reads and the
  reader's fixed 256 KiB tail read for the footer and index, which a single "fraction fetched" had merged into a
  misleading 29.8%. `bash bench/calibrate-cloudshell.sh` runs all of it in-region against the published
  packages. A rehearsal writes its own results file, which git ignores, so a plain `git add` cannot commit a
  free run against MinIO as the evidence behind a published figure.

  Fixed before it could matter: **Ctrl-C did not stop a run.** The signal handler printed "tearing down" and
  then did nothing, and since installing a handler replaces Node's default exit, the workload kept spending. It
  now tears down, writes the results — every phase it had finished, and the cost — and exits 130, whichever exit
  path gets there first — proven by interrupting runs mid-load, mid-intersect, twice in quick succession during
  teardown, and inside the new 10-second abort window of a real run.

  Also fixed before it could matter: **the request meter did not count SDK retries.** It sits outside the SDK's
  retry loop, so it counted each call once however many attempts the call took — which undercounts exactly the
  requests a spend ceiling most needs to see. It now reads every attempt from the SDK's own count. The workload
  makes one attempt per request, and the timed intersects run with the store's own read retry off, so the
  projection stays a true upper bound and no retry's backoff lands unseen inside a latency sample. Teardown keeps
  its retries, on a second client metered into the same bill, so a single transient error cannot leave the
  bucket behind — and it now reads only S3's own `NoSuchBucket` as "already removed". It read any 404 that way,
  so an abort retried after a lost answer, which gets back 404 `NoSuchUpload`, made teardown skip the deletes and
  report nothing. Its delete passes are bounded, too: a key that could never be deleted kept it listing, and
  billing, until the process was killed.

### Changed

- **The calibration harness counts what the library does, not what the network does.** Each timed intersect now
  turns off its store's timed pointer refresh (`cache.genTtlMs: 0`). On the default 2 s refresh, an intersect slower than that reads
  each pointer again, so run `2026-09-23-94416` — 83 ms from the region — counted 206 GETs for its median
  intersect, where the same intersect inside the region is expected to make 204, and that used up the projection's
  whole allowance for an intersect. The projection now also allows every pointer read a load can make: three with
  nothing racing it, and up to twelve if every publish attempt loses, where it had allowed one per attempt. Each load
  records its object's size apart from what it uploaded: the harness had recorded the upload, the object plus its
  pointer's 161-byte body, under the object's name.
- **A run's evidence is its own file, and nothing replaces it.** A real run writes `bench/calibration/<runId>.json`,
  where every run used to overwrite one results file. It refuses an id whose evidence exists before it reads any
  credentials, and a run whose name is taken while it runs writes `<runId>.<start>.partial.json` beside it and says
  so. A run that does not finish writes `<runId>.partial.json`, which git ignores and no gate reads. The run id is
  checked before anything uses it, since it names both the bucket and the file: a real date, so that runs sort into
  order, then a label, with none of the suffixes S3 reserves.
- **A calibration run stops cleanly, and leaves nothing behind that it does not report.** A signal now stops the
  workload's client and waits for the requests already sent, before teardown lists anything: teardown used to run
  while loads were still writing, and in two of four rehearsals interrupted during their loads a PUT landed after
  its listing and left the bucket behind. A hang-up, a closed terminal or a dropped session, now tears down like a
  Ctrl-C, where it used to end the run with nothing removed; the harness opens its terminal streams at startup,
  since on macOS Node opening one on a terminal that has hung up never returns. `calibrate-cloudshell.sh` runs the
  harness as a job of its own and passes every signal on to it: a SIGTERM or a closed CloudShell tab used to stop
  the script at once, delete the scratch directory under the harness mid-teardown and copy nothing, and a SIGTERM to
  the script alone never reached the harness. Teardown now lists every upload and object before it touches any, and
  refuses a bucket holding a key the harness did not write; its requests time out rather than hang; a signal during
  `--cleanup` waits for it; and a workload is refused past 500 segments, the most one teardown listing reaches.
  `--cleanup` checks the account pin; a real run is refused outside `us-east-1`, the one region it has prices for;
  error text is printed and stored with ARNs removed and account ids masked; and a harness with uncommitted edits is
  recorded as `-dirty`.
- **The hard RSS ceiling is now a published figure rather than an owed one.** `pnpm rss-gate` records its run
  to `bench/rss-gate-results.json`, and `docs/benchmarks.md` plus the benchmarks page state the ceiling a
  sustained read + combine + re-load workload over 400 segments survives: **384 MiB**, swap disabled, no
  OOM-kill. The gate had been measuring this on every PR and discarding it — the soak inside the container ran
  without `SOAK_INJECT`, so its verdict reached container stdout and nothing else, and the stage directory is
  deleted on exit. What is published is the **ceiling**, not a reader-RSS reading: the ceiling is a property of
  the workload, an RSS number is a property of the machine.

  `docs/benchmarks.md` also gains **What RSS is, and why it is the number we bound** — what resident set size
  actually is, why a JS-heap sample cannot see the roaring addon's off-heap allocations (and so cannot evidence
  the bounded-memory invariant), and why the published figure is a ceiling rather than a reading.

### Fixed

- **`count()` answers from the index, and an open did not check every rule the index must keep.** The per-chunk
  cardinalities the `.crbm` index records are summed with no payload decoded, so a corrupt index changes the answer
  where `iterate()` and the combines, which decode the payloads, return what the payloads hold. An open already refused a key that
  repeats, falls out of order or passes `0xffff`, a cardinality outside `1..65536`, an empty or oversized payload,
  and, on an unencrypted object, a footer chunk count or total that disagrees with the index. It now also refuses an
  entry whose payload runs into the index rather than ending where the index starts, and an encrypted entry too short
  for its nonce and tag (see **Breaking**), once per open and never per call. A corrupt index that is still
  internally consistent still yields a wrong count, and that is now stated where `count()` is described: the guide,
  the API reference, the README, `SECURITY.md` and the TSDoc. The same index feeds a load's `cardinalityBefore` and
  the chunk keys an `intersect` plans from. `iterate()` the segment where the count must be confirmed against the
  payloads.
- **A rollback whose undo failed said the pointer "could NOT be put back", which it could not know.** When the
  target generation was collected while the pointer moved, the rollback swaps the pointer back and throws. If
  that swap threw, the message stated that the pointer still named the missing generation, but a swap that
  applied and lost its response also throws, and then the pointer is already back. The message now says the pointer
  *may* still name it, and the recovery guide says to check which generation is current before acting.
- **An erasure whose sweep of the other generations found an object gone threw a bare `NotFoundError` where the
  pointer had moved.** When the id was not in the current generation, the sweep's rejection bypassed the handler
  that re-reads the row and reports `reason: 'superseded'`, so a storage driver that signals a missing object
  from `delete` could turn a lost race into an error. It now reports `'superseded'`, and still throws when the
  pointer has not moved, because the object is then genuinely absent.
- **A throwing `retry.onRetry` hook replaced the read's error and stopped the retry.** The hook is observability,
  so an error it throws is now swallowed: the retry goes on, and the read fails with its own error, as the option
  documents.
- **`subjectReport` could miss a load or an erasure made by another process.** The access report read through the
  store's cached generation, which can be up to `cache.genTtlMs` behind the registry, and never catches up with
  `genTtlMs: 0`. It now compares each listed segment's row (its generation and its token) with the version the
  store holds, and re-resolves only a segment that differs, so a report sees another process's change at once,
  including a segment retired, purged and loaded again from generation 0, and costs no extra read when nothing
  moved.
- **The retention sweep's row deletes could tombstone a row created after the sweep decided to delete.** The
  tombstone purge decided from the row it scanned, which can be minutes old on a large fleet, and then deleted
  whatever was under the name, so a segment purged and re-created in that window, which is live data, was tombstoned
  and its name fenced. The purge now deletes with the scanned row's token and reports the entry as
  `failed: contended` when the row has changed. The removal of the row of a segment that held nothing now reads the
  row it tombstoned and deletes it only while it is still that `destroyed` row, at that token. A delete the row refuses leaves it, and the entry stays `retired`.
- **A failed pointer refresh served the old generation, and the key it unwrapped, for as long as the registry
  stayed unreadable.** A reader that could not re-read a segment's pointer kept its reader and stamped it fresh,
  so during a registry outage, or after an access denial, a crypto-shredded or dropped segment could keep
  answering well past the `cache.genTtlMs` that `PRIVACY.md` states. Only a transient fault is ridden out now, and
  the bound has the shape the privacy note gives: while the registry cannot be read, a reader keeps serving the
  generation it had, retrying the refresh after 500 ms (never longer than `cache.genTtlMs`) and at most once per
  segment at a time; any other error reaches the reader. Reads inside the TTL, and the one registry read a refresh
  makes, are unchanged.
- **Two local-filesystem backends on one root in one process could both advance a registry row from the same
  token.** The row's compare-and-swap was serialized by a lock each `LocalFsStorage` (or
  `LocalFsRegistryDriver`) kept for itself, so two instances on one root, or a store and a CLI call in one
  process, could both read token T, both pass the check and both return T+1 for different writes.
  That broke the token's promise never to be reused and the erasure's `expectFrom` fence: an erasure's
  collection with `keep: 0` could delete a generation whose load had reported `published: true`. The lock is
  now one per row for the whole process, keyed by the row's resolved path, so a root reached through a symlink
  or a relative path takes the same lock, and an entry lives only while an operation on its row is in flight.
  A root is for one process: two processes on one root are still not fenced, and the guide and the API
  reference now say so.
- **`purgeTombstones: false` kept every tombstone but one.** The option's contract is that the sweep deletes no row
  of a retirement it made, yet a retired segment that held nothing (a `setRetention` on a name that was never
  loaded, or a mistyped one) had its row deleted in the same pass whatever the option said. With `false` that row
  now stays, stamped like the sweep's other tombstones, so a later sweep with purging on deletes it once
  `tombstoneGraceMs` has passed. While it stays it fences the name against every writer, as a kept tombstone does.
  The ledger entry and the `segment.dispose` event are the same either way, and a later sweep with purging off
  skips the row without re-processing it. The default, `purgeTombstones: true`, deletes the row as before. A
  caller that passes `false` and relied on an empty segment's name being free again after the sweep must pass
  `true` for the sweep that should free it.
  With the default, an empty segment's row that the sweep could not delete (a registry fault) is stamped and kept
  too, where it stayed unstamped, which no sweep would ever purge; a later sweep now deletes it after the grace period.
- **A subject erasure could report `erased: true` while another generation of the segment still held the id.**
  `PRIVACY.md` promises that an `erased: true` entry means the id is physically gone from every generation that
  held it. Three cases broke that promise:
  - **Several holders above the pointer, after a `rollback`.** The erasure searched the other generations newest
    first, deleted the first one holding the id and stopped, so an older one stayed in the bucket, one
    `rollback({ allowForward: true })` from being served again. It now reads every generation above the pointer
    and deletes each one that holds the id, re-reading the row before each delete and stopping if the pointer has
    moved. When the current generation does not hold the id, the generations up there that never held it stay as rollback targets.
  - **A `rollback` onto a holder between a rewrite's publish and its collection.** Collection stopped at the lower
    pointer, so the entry said `erased: true` while the segment served the id from the generation rolled back
    onto. The call now throws `WriteConflictError`, which `eraseSubject` records as an `error: …` entry, and a
    re-run erases the id.
  - **Two erasures of different ids racing on one segment.** When the loser took its generation number after the
    winner's object was in the bucket, its refused rewrite sat above the winner's pointer, still holding the
    winner's id, because it was derived from the generation the winner replaced. The loser now deletes it before
    it returns `superseded`.

  An entry says `erased: true` only after the call has listed the bucket and read every generation it has not
  already seen without the id. That adds one `list` to each erasure that succeeds, on the erasure path only;
  reads are unchanged. A `rollback` that lands while the call deletes generations above the pointer is reported as
  `reason: 'superseded'` (`note: 'superseded'` in the ledger). `EraseIdResult.collected` then lists every holder
  the call deleted, and `fromGeneration` names the newest of them.
- **A chunk payload listing its roaring containers out of order read as ids the segment does not hold.** The 16-bit
  range check on a chunk reads `maximum()`, which roaring answers from the last container, and the native deserializer
  accepts containers in any order. So a payload with container 1 before container 0 passed the check, and `iterate`
  and every combine yielded container 1's values masked into the chunk: ids `has()` denied, and missing
  from a range read over the same ids. The native deserializer bounds its reads and checks nothing else —
  CRoaring leaves the rest to its caller, and `roaring` never does it — so the same gap took more shapes: values or
  runs out of order, listed twice or overlapping, which `has()` denied and `size` counted twice; a run past the end of
  its container, which wrapped `maximum()` past the range check the same way; a run container with no runs, which
  crashed the process when iterated, intersected or unioned; and a bitset whose header understated its bits, whose
  `remove()` overflowed the native heap. An erasure over such a chunk reported `erased: true` and carried the
  corruption into the generation it wrote. `SafeBitmap.safeDeserialize` now checks the structure before the native
  addon sees the bytes and refuses each of these with `IntegrityError` (see **Breaking**). The check runs once per
  chunk fetched, never per id or on a cache hit, and costs a third to a half of the CRC32C the `.crbm` reader already
  computes over the same payload: about 0.7 µs for a 2 KB chunk and 2.5 to 3.2 µs for an 8 KB one, measured on an M3
  Pro.
- **`store.checkConsistency` told a caller to raise an option it does not take.** Past its ceiling of 250,000
  registry rows its `BudgetExceededError` said to raise `maxScanSegments`, which `store.checkConsistency` does not
  take, though `runConsistencyCheck` does. It now names `runConsistencyCheck`, over the backend's `storage` and
  `registry`, as the call that raises it, beside narrowing the scan with `namespace`.
- **`store.rollback(ref, generation, { allowForward: true })` did not compile.** Its options type took `audit`
  alone, though the call passed `allowForward` through to `rollbackSegment` and the docs showed it for undoing a
  rollback. The type now takes `allowForward`, as `rollbackSegment`'s does.
- **A conditional write that landed and lost its response was reported as a conflict, on S3 and on GCS.** Each SDK
  sends a request again when its response does not arrive, after a timeout, a reset connection or a 5xx, and a
  conditional write sent again meets the one that landed and fails its own precondition. So a load reported
  `published: false, reason: 'superseded'` for a generation it had just made current, and collected nothing; an
  `*Into` verb threw `WriteConflictError` for a generation that was current; a load whose write-once put landed
  reported that nothing was written, and left the object above the pointer; `rollback` threw `WriteConflictError`
  after moving the pointer; and a crypto-shred reported `cryptoShredded: false, reason: 'already'`, and emitted no
  `segment.erase` event, for a shred that had happened. The S3 driver now sends each conditional write once: it
  replaces the client's retry step for that one command, so a client you pass, whatever its retry strategy or
  `maxAttempts`, is otherwise unchanged. The GCS driver uploads the registry's rows, and objects up to
  `simpleUploadThresholdBytes`, as one request with no retry loop around it, where `file.save()` wrapped the same
  request in one. Tests drive both drivers through the real SDK, over a stub transport that applies a write and then
  drops its response; each failed before the fix. Azure Blob and a GCS object above the threshold have no per-request
  switch, and the next entry says how they tell a replay from a lost race.
- **On Azure Blob, and on GCS for an object above `simpleUploadThresholdBytes`, a conditional write that landed and lost
  its response was reported as a conflict.** The Azure SDK takes its retry policy from the client, and a GCS
  object above the threshold uploads as a resumable session that the SDK retries within, so neither has a
  per-request switch to turn the retry off. The write sent again met the one that landed, and the answer, a 409
  or 412, reached the same wrong outcomes as on S3: a load reporting `superseded` for a generation it had made
  current, an `*Into` verb or `rollback` throwing `WriteConflictError` after the write, a crypto-shred reporting
  `already`. Each such write now tags its blob or object with a random id in its metadata, outside the `.crbm` bytes and
  outside the registry row's body, so neither format changes. When the write reports a conflict, the driver reads
  the stored copy back, one metadata read, and reports success when it carries the write's own id and
  `WriteConflictError` otherwise. The read is made only on a conflict, and it works with a client you pass. A
  generation's `.crbm` object is never overwritten, so its read-back is definitive. A registry row is
  overwritten by compare-and-swap, so a writer that swaps in over a write that landed, before the read-back, makes
  that write report `WriteConflictError`. The callers re-read or report it, and none deletes a generation on it: a load's cleanup
  removes its generation only while the row's token is still the one it started from, which the write it landed has advanced. A read-back that fails transiently throws `TransientError`, neither a success nor a
  conflict.
- **`PRIVACY.md` said subject erasure is physical on return for more segments than it is.** Its table row, and
  the copy npm ships in `@cloudbitmaps/roaring`, said "on return" holds for every segment whose ledger entry is not
  `error: …`. An entry can also say `erased: false, note: 'superseded'`, when a racing writer overtook the rewrite:
  no error, and the id may still be in that segment. The row now says "on return" holds for every segment whose
  entry says `erased: true`, as the detailed text further down already did. `eraseSubject`'s doc comment also said
  that after a collection fault a re-run reports nothing for the segment, leaving the old generation to
  `gcOrphanGenerations` or a sweep; a re-run searches the superseded generations and collects it, as
  `SubjectErasureEntry.note` says.
- **`LoadOptions.keep`'s doc said a wider window "buys nothing a pinned read would not do better".** A pin is never
  re-resolved, so a pinned read fails with `NotFoundError` once its generation is collected, and for a job pinned
  across loads `keep` is what keeps it readable. The doc now says so, and getting-started's "Sizing `keep`" table
  has a row for a long job on a pinned handle: keep at least one generation for every one that can be written above
  the pinned one while it runs, on every writer that loads the segment.
- **A load that lost its generation number to another load emitted no audit event.** Every other refusal emits
  `segment.load-refused`, and this one reported `reason: 'superseded'` to the caller alone, so an audit trail could
  not tell the replacement it asked for had not happened. It now emits `segment.load-refused` with `reason:
  'superseded'` and `cardinality: 0`, since it wrote nothing.

- **A pinned handle could read chunks of another generation than the one it pinned.** A live read of the same
  segment on the same store cached each chunk it fetched under the version it had resolved when it began — but if,
  before the fetch, a publish had landed and `cache.genTtlMs` had lapsed, the reader cache had evicted the segment,
  a sweep had made the read heal forward, or the store had invalidated the segment (its own `load`, `rollback` and
  erasure do), the chunk came from another generation, and was cached under the key of the one the read began on. A
  handle pinned at that generation read the same key, so it was handed the other generation's chunk: its
  `iterate()` mixed two generations while its `count()` still reported the pinned one's total, and, after a sweep
  had collected its generation, a pinned `has()` answered from the newer one where it should have failed. A pinned
  handle now caches its chunks under keys of its own, which no live read writes, and fills them only from the object
  it pinned. Live reads make no extra call for it. What it costs:
  - a pin pays one GET for a chunk that a live read of its generation had already cached, which it used to share;
  - a pin's entries share the chunk cache's bound with the live ones, so under a small `cache.maxChunks` each can
    evict the other;
  - a pin whose generation has been swept now fails even for a chunk a live read had cached from it, where it could
    answer from that entry before.

  Unpinned reads were not affected: every way the library moves a read to another generation also makes it the one
  later reads resolve. Six tests reproduce it, across `iterate`, `intersect` and `has` and all four ways a read can
  move to another generation, and each failed before the fix.
- **A combine that held one segment at two generations answered for one of them.** One call reads a segment at one
  generation, and a combine keyed its pins by segment, so `snap0.andNot([snap1])` — the difference between two
  snapshots of one segment — returned no ids at all, and `live.andNot([snap])` read the live handle at the pin. Such
  a combine is now refused with `ValidationError`, pointing at `intersectInto(dest, [])` to materialise one side
  first. So is one holding two pins of one generation number that are two different objects; two pins of one object
  combine as before. The refusal comes when the combine is read, as its other errors do, and before an `*Into`
  materialisation reads anything; a combine with no pin in it checks nothing. It includes `live.intersect([snap])`
  when nothing has moved since the pin, which answered correctly by chance and now throws.
- **A pin held across a purge and re-load read the new segment as its own.** A name purged and loaded again starts
  again at generation 0, and a pin knew its object only by generation number, so a pin of the old segment opened the
  new one's object of the same number. Once its reader was evicted, its `count()` gave the new total while
  `iterate()` returned chunks of both; while the reader stayed open, its uncached chunks failed with an
  `IntegrityError` that read as damage, or a `ValidationError` when the new object was smaller; and on a store with
  no registry, a new pin of the name was handed the old
  pin's reader and cached chunks. `pin()` now records the object it pins, its size and footer checksum, and a pin
  reads that object only: what it has already read still answers, as the instant it pinned, and anything it would
  have to fetch from a replaced object fails with `NotFoundError`, as a swept pin's does. A pin tells a replacement
  from damage by reading the object's footer, which needs no key; an object of another size counts as another
  object, damaged or not. A replacement written under a key the store lacks is therefore found too, including after
  the pin's reader was dropped. The reads that ask at once share that footer read, and once found, a replacement
  costs later reads no request until the store forgets it: an invalidation of the pin's segment does, as does a later
  `pin()` of the same version that opens the pinned object again, and the store remembers at most `cache.readerMax`
  of them. So once a restore puts the object back, invalidate the pin's store: the pin then reads it again, and a
  pin taken after that reads the object then stored as its generation. An object found gone is not remembered,
  since a 404 can pass. Two pins of one generation number in two incarnations never share a reader or a cached
  chunk, with a registry or without one.
- **A pin whose segment was dropped or destroyed went empty part-way through a read.** A pinned `iterate()` that
  straddled `dropSegment` on its store returned the ids it had read so far and stopped, with no error, and its
  `count()` then said 0. A pin describes one instant, so its read of a segment whose row is gone or destroyed now
  fails with `NotFoundError`. A pin keeps the key its reader unwrapped while that reader stays open, and answers from
  the chunks it decoded while they stay cached. The pin's own store invalidates it:
  - a `load`, a `rollback` or an `*Into` invalidates a pin of the segment it writes;
  - `dropSegment` invalidates a pin of the segment it drops, and `retireExpired` a pin of each segment its ledger
    lists, retired or not, neither on a dry run;
  - `eraseSubject` invalidates a pin of each segment it scans that is not already destroyed.

  An invalidated pin opens its object again, and fails if that object is gone or replaced, or its row is gone or
  destroyed.
  Anything else leaves the pin as it is: after a `destroySegment` beside the pin's store, or an erasure, a drop or a
  retirement through another store, in the same process or another, the pin answers from what it holds until its
  store's reader cache evicts the pin's reader and the store's chunk cache evicts the chunks the pin decoded, or
  `invalidate()` is called on the pin's store. Where the object the
  pin reads has been deleted, by an erasure, a drop or a sweep, a chunk the pin has not cached fails at once. The
  privacy notes now say so.
- **Pinned reads were not retried.** A pinned handle's engine read the storage source directly, so a transient fault
  that a live read retries failed a pinned read, and every live operand of a combine that included a pin. Pinned
  reads now go through the store's retries, and so does `pin()`'s own read of the row. `pin()` also opens the pinned
  generation's reader as it pins, and reads the row once to do both; opening a pinned generation read the row twice.
  With a registry, pins of one generation taken while its row is unchanged share that reader while the store keeps
  it open, as they did before, pins taken at the same moment included, so only the first costs a tail read, and a
  key unwrap for an encrypted segment, even if it is never read. Without a registry every `pin()` lists the segment's
  objects and makes the tail read, since only the object can tell two incarnations of a name apart there.
  A `pin()` whose generation is swept before it can
  open it, as a publish and a `keep: 0` sweep can do, pins the generation current then rather than fail.
- **A store read its own materialisation's predecessor.** `intersectInto`, `unionInto` and `andNotInto` published a
  new generation of `dest` without dropping what the store held of the old one, so the same store went on answering
  from the old generation: until `cache.genTtlMs` lapsed, and indefinitely with no timed refresh. They now
  invalidate `dest` as `load()` does, and what that costs a pin is what a `load()` costs it: a pin of `dest` on the
  same store drops its open reader and decoded chunks at each of them, one its guard refuses included, and reads
  them again. If that call's `keep` collected its generation, it then fails even for a chunk it had read.
- **A cold `has()` could fail with `NotFoundError` when a publish and a `keep: 0` sweep landed as it began.** Before
  it fetches a chunk, a read looks up each operand's version, and that lookup did not heal a swept generation the
  way a chunk fetch and `currentGeneration()` do. `count`, `iterate` and `intersect` survived the same race, since
  their index read heals first; a `has()` failed. Id erasure passes `keep: 0`, so its sweep can land microseconds
  after the publish. The lookup now re-resolves once and reads the newer generation; a second miss still fails the
  read, as it does everywhere else.
- **A generation whose footer names another generation is refused.** Every writer stamps a generation's footer with
  its key's number, and the chunk cache is keyed by it, so an object that disagrees — written under another key, or
  altered — now fails with `IntegrityError` wherever it is opened: by a read, a pin, the load guard, the erasure
  rewrite and its search of superseded generations, and a write's re-read of what it wrote. It was read as the
  generation its footer claimed, and the erasure rewrite republished its content. A default load onto a segment
  whose current generation is misfiled now fails in its guard: roll the segment back to an earlier generation that
  opens, or load with `allowEmpty: true` and no `guard.minRetained`, which then does not read the current
  generation. Such an object was written under one generation and stored under another, and was never a valid
  object.
- **`estimateCost()` counts the pointer, the index and the pointer refresh, which it had left out.** On a
  single-bucket store, the topology that ships, it under-quoted two of the operations it prices: a load as its object's
  PUT-class requests alone, and an intersect as its chunk reads alone.
  - **A load** now adds what `store.load()` makes around the object's write — two listings and the pointer's
    write, and nine GETs — so a single-part load prices at about $23.60 per million at the default rates, where it
    had been quoted at $5.
  - **A cold intersect** adds a pointer read and an index read for each operand (`operandsPerIntersect`, 2 by
    default, `exclude` operands included), so two segments sharing k chunks price at 4 + 2k GETs.
  - **A new term prices the pointer refresh**: `hotSegments`, the segments each long-lived reader keeps reading,
    in each of `readerProcesses` readers, each re-reading its pointer at most every `genTtlMs` (the store's
    `cache.genTtlMs`, 2 s by default), and the term at most once a point read: about $0.53 a segment a month. It is
    reported as `byOp.pointerRefresh`, disclosed in the notes when a report prices point reads without it, and taken out of the read
    crossover's baseline when it is. `segment.costReport()` prices it at the store's own TTL.
  - **GCS and Azure Blob** read an object's metadata before its bytes, so a pointer read or a tail read is two
    requests there, where it is one on S3. A pricing profile's new `storage.requestsPerSizedRead` (1 by default;
    set it to 2 for those two) doubles those reads.

  `chunksPerIntersect` and `requestsPerLoad` keep the meaning they had in `0.10.0`, the chunks an intersect fetches
  and the object's own PUT-class requests: if you followed the docs' and the site's advice, between the
  single-bucket run's publication and this fix, to fold the pointer into them, pass the plain counts again. Each
  count the estimator adds is held by a test to the requests the real engine makes. What this changes in the
  report's type and text is under **Breaking**.

## [0.10.0] — 2026-09-21

The loaded store. A segment is a set of write-once `.crbm` generations in object storage behind one registry
pointer. Data enters by loading a whole new generation, and a read resolves one generation and fetches only the
chunks it needs.

- **Five packages, versioned together.** `@cloudbitmaps/roaring` is the codec and the `CloudRoaring` store;
  `@cloudbitmaps/s3`, `@cloudbitmaps/gcs` and `@cloudbitmaps/azure-blob` are one storage service each, depending on
  its SDK. `@cloudbitmaps/core` arrives transitively, and `@cloudbitmaps/core/driver-kit` is the contract a driver
  package builds against.
- **One backend per service, carrying both halves.** `MemoryStorage`, `LocalFsStorage`, `S3Storage`, `GcsStorage`
  and `AzureBlobStorage` each keep the generations and the registry pointer in the same store, so a deployment needs
  one bucket and no second database.
- **Loading, `store.load()`.** It takes the next generation number, writes one immutable object, refuses an empty
  result over a non-empty segment, publishes it, and collects the generations the publish superseded, keeping one
  by default. The `*Into` verbs write through the same path and the same empty-result guard, but collect nothing
  unless given `keep`. A subject erasure publishes only over the generation it read, and collects with `keep: 0`.
- **Reads.** `has`, `count` (summed from the index, with no payload reads), `iterate`, chunk-skipping `intersect`
  with `exclude`, `union` and `andNot`; and `intersectInto`, `unionInto` and `andNotInto`, which write their result
  as a new generation of a destination, under the same empty-result guard as a load.
- **`segment.pin()`** holds a segment at one generation for the life of a handle.
- **Options** `storage`, `metrics` and `budget`, and four groups: `cache`, `encryption`, `retry` and `seams`.
- **Lifecycle.** `rollback`, `generations`, `exists` and `segments`; retention with `setRetention` and the
  `retireExpired` sweep; `dropSegment`; subject erasure with `eraseSubject` and `subjectReport`; `exportSegments`;
  and `checkConsistency`.
- **Encryption at rest** (AES-256-GCM, with envelope keys from a keystore you hold) and crypto-shred.
- **Cost.** `CloudRoaring.estimateCost()` for planning, and `segment.costReport()` from a segment's real size.
- **ESM only, Node ≥ 22.12.**

<!-- New work goes under [Unreleased] at the top. -->
