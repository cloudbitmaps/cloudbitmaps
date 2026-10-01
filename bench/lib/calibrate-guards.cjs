'use strict';
/*
 * The guards that stand between `pnpm calibrate:aws` and someone's cloud bill.
 *
 * These are pure functions with no I/O, for one reason: the only way to keep a guard honest is to be able to
 * plant its defect in a test and watch it fail. Each guard's comment below says what it prevents.
 *
 * Read `RELEASING.md` for the release pipeline's guards; this file is the money-spending equivalent.
 */

/** The typed phrase `--run` demands. Long and unguessable on purpose: a typo must not spend money. */
const CONFIRM_PHRASE = 'yes-spend-money';

/**
 * Attempts `publishGeneration` makes to advance a segment pointer, from the loop in
 * `packages/core/src/core/crbm-storage-source.ts`.
 *
 * The loop runs FIVE attempts, and nothing in core names that count (there is no `DEFAULT_MAX_RETRIES`), so it is
 * easy to retype wrong. A bound of 4 projects every load one attempt short — the exact "a projection the run can
 * exceed is not a ceiling" bug `projectOps` is documented to prevent, sitting in its own input.
 * `tests/bench/calibrate-guards.test.ts` reads the bound out of the source and fails if the two disagree.
 */
const RETRY_BOUND = 5;

/**
 * Parse the spend ceiling.
 *
 * THE BUG THIS EXISTS FOR: a ceiling read as `Number(process.env.CR_CALIBRATE_MAX_USD)` and compared with
 * `total > max`. `Number('abc')` is `NaN`, and **every comparison against NaN is false** — so a malformed ceiling
 * read that way does not fail loudly, it silently deletes the bound on a script whose whole job is spending money.
 * Zero and negative are rejected too: both are almost certainly a mistake, and "spend nothing" is what the
 * default dry run is for.
 */
function parseCeiling(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    throw new Error('CR_CALIBRATE_MAX_USD is required for --run: set a spend ceiling in dollars');
  }
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw new Error(
      `CR_CALIBRATE_MAX_USD is "${raw}", which is not a finite number. Refusing to run: a NaN ceiling ` +
        'compares false against every total and would silently remove the bound.',
    );
  }
  if (n <= 0) {
    throw new Error(`CR_CALIBRATE_MAX_USD is ${n}; a ceiling must be greater than zero`);
  }
  return n;
}

/**
 * Resolve a workload size from the environment.
 *
 * THE BUG THIS EXISTS FOR: a helper that maps a falsy value to the default hands `CR_CALIBRATE_READS=0` — what
 * someone shrinking a run to almost nothing would set — the FULL default instead of zero. Explicit zero must mean
 * zero.
 */
function resolveSize(raw, fallback, label) {
  if (raw === undefined || String(raw).trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`${label} is "${raw}"; expected a non-negative integer`);
  }
  return n;
}

/**
 * Decide whether a probe result means "this resource does not exist".
 *
 * THE BUG THIS EXISTS FOR, and it is the most dangerous one in the file. `HeadBucket` answers **403, not
 * 404**, for a bucket you own but cannot `ListBucket`. Reading 403 as "absent" would be catastrophic in
 * `us-east-1`, where `CreateBucket` on a bucket you ALREADY OWN returns **200 OK** rather than an error: the
 * run would proceed into a real bucket of yours and then **delete it on teardown**.
 *
 * So only a genuine not-found counts as absent. Anything else — 403, a throttle, a timeout, a network error —
 * is "cannot prove it is absent", which must abort rather than create.
 */
function probeMeansAbsent(err) {
  if (err === undefined || err === null) return false; // the call succeeded: it exists
  const status = err?.$metadata?.httpStatusCode;
  const name = err?.name ?? err?.Code ?? '';
  if (status === 404) return true;
  if (name === 'NotFound' || name === 'NoSuchBucket') return true;
  return false;
}

/**
 * Project the worst-case op count for a run, as a real upper bound.
 *
 * THE BUG THIS EXISTS FOR: a projection that is not a bound. One that doubles the loads counts only the two PUTs an
 * unraced load makes, with no room for a lost race or for the run's own bucket and teardown requests; one that gives
 * READS a smaller multiplier than writes has the read slot breach first — and a run with far more reads than loads,
 * such as one shrunk to a few segments to make it *cheaper*, triggers it.
 *
 * AND ONE MORE: a projection that counts a single operand per read. An intersect has two, and each resolves its own
 * pointer, reads its own index and fetches its own chunks — so a one-operand read term is half of what the workload
 * issues. `operandsPerRead` is explicit, and the harness checks the measured counts against this projection at the
 * end of every run, so "it is an upper bound" is a checked property rather than a claim.
 *
 * Reads are projected at least as high as writes because every write path in this engine reads before it
 * writes.
 */
function projectOps({
  loads,
  reads,
  chunksPerRead,
  retryBound,
  operandsPerRead = 1,
  largeLoads = 0,
  partsPerLargeLoad = 0,
  fixedPuts = 0,
  fixedGets = 0,
}) {
  if (!Number.isInteger(retryBound) || retryBound < 1) {
    throw new Error(`retryBound must be a positive integer, got ${retryBound}`);
  }
  if (!Number.isInteger(operandsPerRead) || operandsPerRead < 1) {
    throw new Error(`operandsPerRead must be a positive integer, got ${operandsPerRead}`);
  }
  // A load, `store.load()` of a new segment: the object PUT, two listings (one to choose the generation number, one
  // to collect after the publish; on S3 a listing bills at the PUT rate), then the pointer advance — a conditional
  // PUT, each attempt of which can lose the compare-and-swap and go round again. Its reads are more than one per
  // attempt: counted against the real registry protocol in tests/bench/calibrate-guards.test.ts, a load of a new
  // segment reads the pointer seven times with nothing racing it, twice more for each attempt it loses, and fifteen
  // times at most; one that loses every attempt throws after fourteen. The harness is the only writer, so its loads
  // never race; the bound still has to hold if one did.
  const putPerLoad = 3 + retryBound;
  const getPerLoad = 5 + 2 * retryBound;
  // A multipart load: create + parts + complete for the object, then the same listings and pointer advance.
  const putPerLargeLoad = 4 + partsPerLargeLoad + retryBound;
  // A read, per operand: resolve the pointer, read the footer and the index, then one GET per chunk fetched.
  // Three fixed GETs is the generous reading of "open a generation": the pointer, the tail read, and a second read
  // for an index longer than the tail. The pointer is read once only because the timed store has no timed refresh
  // (`TIMED_STORE`) — on the default 2 s refresh, an intersect slower than that reads it again, and the median
  // intersect of run 2026-09-23-94416, from a laptop, used exactly this allowance. The end-of-run check keeps it
  // honest.
  const getPerOperand = 3 + chunksPerRead;
  const put = loads * putPerLoad + largeLoads * putPerLargeLoad + fixedPuts;
  const getForLoads = (loads + largeLoads) * getPerLoad;
  const getForReads = reads * operandsPerRead * getPerOperand;
  const get = Math.max(getForLoads + getForReads + fixedGets, put);
  return { put, get };
}

/**
 * A claim on each segment's FIRST load, refusing a second.
 *
 * The projection bounds a segment's first load: its pointer read seven times with nothing racing it, fifteen at most
 * when every publish attempt but the last is lost. A reload also opens the current generation's index to count what
 * it replaces, so at four lost races it makes sixteen GET-class requests against that bound of fifteen, and a load
 * that collects adds a pointer read more. A stage that loaded a name twice would overspend a projection that said it
 * was safe, so the harness loads each name once and a repeat is refused before it sends anything.
 */
function firstLoads() {
  const seen = new Set();
  return (segment) => {
    if (seen.has(segment)) {
      throw new Error(
        `${segment} was loaded already; the projection bounds a segment's first load, and a reload makes more requests`,
      );
    }
    seen.add(segment);
  };
}

/**
 * Did the run issue more than its projection?
 *
 * A projection is only a ceiling if the run cannot exceed it. Checking that after the fact is cheap and turns
 * the property from documentation into evidence: a run that breaks it is flagged in its own results, so an
 * under-projecting change is caught by the next rehearsal rather than by an invoice.
 */
function exceedsProjection(measured, projected) {
  const over = [];
  if (measured.put > projected.put)
    over.push(`PUT-class ${measured.put} > projected ${projected.put}`);
  if (measured.get > projected.get)
    over.push(`GET-class ${measured.get} > projected ${projected.get}`);
  return over;
}

/**
 * Has the run breached its ceiling?
 *
 * Called at phase boundaries AND inside the unbounded phase, because a phase-boundary-only check leaves the
 * one phase whose op count is not known in advance completely unchecked — which is the phase that can run
 * away.
 */
function breached(spentUSD, ceilingUSD) {
  // Written as `>=` rather than `>`: landing exactly on the ceiling is already the ceiling.
  return spentUSD >= ceilingUSD;
}

/**
 * The harness's workload shape, here rather than in the harness so a test can pin it.
 *
 * A bad stride is the HARNESS choosing a bad value, not `planLayout` computing one wrongly — so a test that passes
 * its own stride to `planLayout` proves nothing about what a run actually does. At these values a 500,000-id
 * segment spans ~2,000 chunks with 100 shared, the shape behind the published figure.
 */
const DEFAULT_LAYOUT = Object.freeze({ overlap: 0.05, stride: 262 });

/** One roaring chunk: the top 16 bits of a 32-bit id choose it, so it spans 65,536 consecutive ids. */
const CHUNK_SPAN = 65_536;
/** How many chunks a 32-bit id space holds. */
const ID_SPACE_CHUNKS = 65_536;

/**
 * Plan the intersect workload's id layout — and refuse one that cannot be what it claims to be.
 *
 * THE BUG THIS EXISTS FOR, twice over.
 *
 * A layout that gives each segment its own id range shares NOTHING between adjacent segments, so the intersect
 * phase times the empty intersection: chunk-skipping's best case, fetching no payload at all. It would publish a
 * confident p50 over zero work.
 *
 * One that shares a 5% core but packs it at a stride of 7 fits 25,000 shared ids in about THREE chunks. The
 * headline claim this measurement is meant to back is "100 of 2,000 chunks fetched", and a three-chunk workload is
 * not evidence about it.
 *
 * So the layout is derived from the shape it must reproduce. Every segment is `sharedChunks` chunks of a
 * common core plus a private band of its own; bands are separated by an empty chunk so no two can touch; and
 * the expected intersection of ANY pair — its count and its sum — is known exactly, which lets the harness
 * assert that a read against a real object store returned precisely the right ids, not merely some.
 */
function planLayout({ segments, idsPerSegment, overlap, stride }) {
  for (const [k, v] of Object.entries({ segments, idsPerSegment, stride })) {
    if (!Number.isInteger(v) || v < 1) throw new Error(`${k} must be a positive integer, got ${v}`);
  }
  if (!(overlap > 0 && overlap < 1)) throw new Error(`overlap must be in (0, 1), got ${overlap}`);
  const shared = Math.floor(idsPerSegment * overlap);
  if (shared === 0) throw new Error(`overlap ${overlap} of ${idsPerSegment} ids shares nothing`);
  return layoutFromCounts({ segments, shared, priv: idsPerSegment - shared, stride });
}

/** How many chunks `n` ids placed `stride` apart from id 0 occupy. */
const chunksFor = (n, stride) => (n === 0 ? 0 : Math.floor(((n - 1) * stride) / CHUNK_SPAN) + 1);

/**
 * The layout for segments that each hold `shared` ids in a common core and `priv` ids of their own. Both
 * {@link planLayout}, which takes a share of the segment, and {@link planSweepLayout}, which takes a number of shared
 * chunks, come here, so every calibration layout is checked the same way.
 */
function layoutFromCounts({ segments, shared, priv, stride }) {
  if (stride >= CHUNK_SPAN) {
    throw new Error(
      `stride ${stride} puts every id in its own chunk — nothing would share a chunk`,
    );
  }
  const sharedChunks = chunksFor(shared, stride);
  const privateChunks = chunksFor(priv, stride);
  const bandChunks = privateChunks + 1; // the +1 is the empty chunk that keeps adjacent bands apart
  const firstBandChunk = sharedChunks + 1;
  const totalChunks = firstBandChunk + segments * bandChunks;
  if (totalChunks > ID_SPACE_CHUNKS) {
    throw new Error(
      `layout needs ${totalChunks} chunks but a 32-bit id space holds ${ID_SPACE_CHUNKS} — ` +
        'shrink the workload rather than let ids wrap',
    );
  }
  const sum = (stride * shared * (shared - 1)) / 2;
  if (!Number.isSafeInteger(sum)) {
    throw new Error(
      'the expected intersection sum exceeds 2^53 — the exact-content check would be unsound',
    );
  }
  const bases = Array.from(
    { length: segments },
    (_, i) => (firstBandChunk + i * bandChunks) * CHUNK_SPAN,
  );
  return {
    shared,
    priv,
    stride,
    sharedChunks,
    privateChunks,
    chunksPerSegment: sharedChunks + privateChunks,
    bases,
    expected: { count: shared, sum },
  };
}

/**
 * The layout of a sweep over how many chunks the operands share: segments that share exactly `sharedChunks` chunks
 * and hold `privateIds` ids of their own. The shared core is the fewest ids that fill that many chunks, so the
 * overlap is the number asked for and not the nearest one the stride allows.
 */
function planSweepLayout({ segments, sharedChunks, privateIds, stride }) {
  for (const [k, v] of Object.entries({ segments, sharedChunks, privateIds, stride })) {
    if (!Number.isInteger(v) || v < 1) throw new Error(`${k} must be a positive integer, got ${v}`);
  }
  if (stride >= CHUNK_SPAN) {
    throw new Error(
      `stride ${stride} puts every id in its own chunk — nothing would share a chunk`,
    );
  }
  const shared = Math.ceil(((sharedChunks - 1) * CHUNK_SPAN) / stride) + 1;
  const layout = layoutFromCounts({ segments, shared, priv: privateIds, stride });
  if (layout.sharedChunks !== sharedChunks) {
    throw new Error(
      `${shared} ids ${stride} apart fill ${layout.sharedChunks} chunks, not the ${sharedChunks} asked for`,
    );
  }
  return layout;
}

/** The ids of segment `i` under `layout`, ascending. A generator, so no workload is ever materialised twice. */
function* layoutIds(layout, i) {
  for (let k = 0; k < layout.shared; k += 1) yield k * layout.stride;
  const base = layout.bases[i];
  for (let k = 0; k < layout.priv; k += 1) yield base + k * layout.stride;
}

/**
 * The last four digits of an account id, and nothing more.
 *
 * Enough to eyeball that this is the intended account; not enough to be worth pasting anywhere. The whole id would
 * sit in a terminal scrollback, a CI log, or a message asking for help.
 */
function maskAccount(account) {
  const s = String(account ?? '');
  return /^\d{12}$/.test(s) ? `••••••••${s.slice(-4)}` : '(unverified)';
}

/**
 * Error text with its ARNs removed and its account ids masked, for a terminal or a file.
 *
 * AWS puts the caller's ARN, account id and all, in an AccessDenied message ("User: <the caller's ARN> is not
 * authorized to perform …"). The harness prints error text and stores it in the partial results, so unredacted it
 * would carry the one id the harness masks everywhere else into a scrollback, a log, or a message asking for help.
 */
function redact(text) {
  return String(text ?? '')
    .replace(/\barn:aws[a-z-]*:[^\s"',)]*/g, 'arn:(redacted)')
    .replace(/\b\d{12}\b/g, (id) => maskAccount(id));
}

/**
 * How many attempts each of the harness's two S3 clients makes per request.
 *
 * The WORKLOAD's client makes one. The projection has no term for its retries, and a retry's backoff would sit
 * inside a latency sample unseen — so a transient failure there fails the run instead. TEARDOWN's keeps the SDK's
 * usual three: with one attempt, a single 503 on `ListObjectVersions` would leave the bucket, and everything in it,
 * behind. The projection allows for every one of teardown's attempts.
 */
const WORK_ATTEMPTS = 1;
const ADMIN_ATTEMPTS = 3;

/**
 * How long each of teardown's attempts may take. The SDK's HTTP handler waits for ever by default, so a teardown
 * whose listing stops answering would hang until it is killed, leaving the bucket and writing no results. A request
 * timeout alone only logs a warning in this SDK; `throwOnRequestTimeout` makes it fail the attempt, which the
 * client then retries.
 */
const ADMIN_TIMEOUTS = Object.freeze({
  connectionTimeout: 5_000,
  requestTimeout: 30_000,
  throwOnRequestTimeout: true,
});

/**
 * Does a teardown error mean "the bucket is already gone"?
 *
 * Narrower than `probeMeansAbsent`, on purpose: that reads ANY 404 as absent — and `AbortMultipartUpload` answers
 * 404 `NoSuchUpload` for an upload already aborted or completed, which is exactly what a retried abort gets back
 * when its first attempt landed but the answer was lost. Read as "the bucket is gone", that answer would skip
 * deleting the objects and the bucket, and report nothing. Only S3's own `NoSuchBucket` means the bucket is gone.
 */
function bucketIsGone(err) {
  return (err?.name ?? err?.Code) === 'NoSuchBucket';
}

/** An abort that finds its upload already gone — completed, or aborted by an earlier attempt — has nothing to do. */
function uploadIsGone(err) {
  return (err?.name ?? err?.Code) === 'NoSuchUpload';
}

/**
 * The most delete passes teardown makes before it reports what is left instead of trying again.
 *
 * `DeleteObjects` reports a key it could not delete INSIDE a 200, where the SDK's retries never see it, and each
 * listing starts again from the first page — so a key that can never be deleted (a policy that forbids it) would
 * keep an unbounded loop listing, and billing, for as long as it runs, under no ceiling and in no projection. So
 * the passes are bounded, and projected.
 */
const TEARDOWN_PASSES = 3;

/**
 * Teardown's PUT-class requests at most: one `ListMultipartUploads`, a `ListObjectVersions` per pass and the one
 * that finds the bucket empty — each at every attempt its retrying client may make. Its deletes are free.
 */
const TEARDOWN_PUTS = ADMIN_ATTEMPTS * (1 + TEARDOWN_PASSES + 1);

/**
 * The two clients' configurations, from the one a run resolved. `maxAttempts` last, so nothing in `base` wins. The
 * workload's client has no timeout of its own, since a timed request must not be cut short, and an interrupt waits
 * for it only so long. Teardown's has one, so that it cannot hang.
 */
function clientConfigs(base, { adminTimeouts = ADMIN_TIMEOUTS } = {}) {
  return {
    work: { ...base, maxAttempts: WORK_ATTEMPTS },
    admin: { ...base, requestHandler: { ...adminTimeouts }, maxAttempts: ADMIN_ATTEMPTS },
  };
}

/**
 * How every timed intersect's store is built.
 *
 * `retry: false` — the store has a transient-read retry of its own, above the client, and it would re-run a
 * failed read INSIDE the timed window: a second retry layer the client's one-attempt pin does not reach.
 *
 * `cache.genTtlMs: 0` — no timed pointer refresh. A store re-reads a segment's pointer once `genTtlMs` (2 s by
 * default) has passed since it last read it, in the middle of an intersect too. Run 2026-09-23-94416 was 83 ms from
 * the region, its cold intersects took about 3 s, and the median one read both pointers twice: 206 GETs where the
 * same intersect inside the region would make 204. A request count that moves with the network describes the
 * network, and the projection has no term for it. Every timed intersect has a store of its own, so turning the
 * refresh off costs nothing in coldness: each pointer is still read, exactly once. What the default refresh costs a
 * long-lived reader is a separate figure — at most one pointer read per segment per `genTtlMs` while it is read —
 * and the run report states it rather than this harness measuring it by accident.
 */
const TIMED_STORE = Object.freeze({ retry: false, cache: Object.freeze({ genTtlMs: 0 }) });
/**
 * Where real runs' evidence lives: one file per run, named by its id.
 *
 * One per run, not one file for "the latest run", because a figure is published from a particular run and cited
 * by its id — a second run under the same name would replace the evidence behind numbers already on the page.
 */
const EVIDENCE_DIR = 'bench/calibration';

/**
 * A run id names the run's bucket, `cloudbitmaps-calib-<id>`, and its evidence file, so it has to be valid as both,
 * and it has to sort into run order. So it is a UTC date, a day that exists, then a label of lowercase letters,
 * digits and hyphens that starts and ends with a letter or digit: 44 characters at most, which is what the
 * 19-character prefix leaves of a bucket name's 63. A bucket name may also hold dots; an id does not, because it is
 * a file name too. Nothing outside that set can reach a path, and the date prefix rules out every name Windows
 * reserves.
 */
const RUN_ID = /^\d{4}-\d{2}-\d{2}-[a-z0-9](?:[a-z0-9-]{0,31}[a-z0-9])?$/;

/**
 * The bucket-name suffixes S3 keeps for its own kinds of bucket and access point: an access point alias, an Object
 * Lambda access point, a Multi-Region Access Point, a directory bucket and a table bucket. `CreateBucket` refuses
 * them only after the abort window, when the run has already been waited for. And a name ending in one may not be a
 * bucket at all but S3's name for someone else's, which `--cleanup`, emptying everything it finds, must never be
 * pointed at. So both kinds of id refuse them.
 */
const RESERVED_SUFFIX = /(?:-s3alias|--ol-s3|\.mrap|--x-s3|--table-s3)$/;

/** Whether `YYYY-MM-DD` is a day on the calendar, not only the shape of one: `9999-99-99` has the shape. */
function isCalendarDay(day) {
  const t = Date.parse(`${day}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === day;
}

function checkRunId(runId) {
  if (
    typeof runId !== 'string' ||
    !RUN_ID.test(runId) ||
    !isCalendarDay(runId.slice(0, 10)) ||
    RESERVED_SUFFIX.test(runId)
  ) {
    throw new Error(
      `run id "${String(runId)}" is not usable: it names the bucket and the evidence file and must sort into run ` +
        'order, so it is a date and a label, YYYY-MM-DD-<label>, 44 characters at most, where the date is a real ' +
        'day and the label is lowercase letters, digits and hyphens beginning and ending with a letter or digit, ' +
        'and not ending in a suffix S3 reserves',
    );
  }
  return runId;
}

/**
 * The id `--cleanup` accepts: anything that makes a legal bucket name, because it writes no file.
 *
 * Narrower rules would strand buckets. A harness checked out at another commit may name its bucket by other rules,
 * and `--cleanup` must still remove it: S3 allows dots and a hyphen straight after the prefix, so `v0.10.0-inregion`
 * is a legal bucket name that `checkRunId` refuses.
 */
const CLEANUP_ID = /^[a-z0-9.-]{0,43}[a-z0-9]$/;

function checkCleanupId(runId) {
  if (
    typeof runId !== 'string' ||
    !CLEANUP_ID.test(runId) ||
    runId.includes('..') ||
    RESERVED_SUFFIX.test(runId)
  ) {
    throw new Error(
      `"${String(runId)}" cannot name a calibration bucket: 1 to 44 lowercase letters, digits, dots and hyphens, ` +
        'ending with a letter or digit, with no two dots together and no suffix S3 reserves',
    );
  }
  return runId;
}

/**
 * Where a run's results are written, relative to the repository root.
 *
 * A real run that finished writes its evidence under {@link EVIDENCE_DIR}. One that did not — interrupted, failed
 * part-way — writes `<id>.partial.json` beside it, which git ignores and the figures gates skip: under the evidence
 * name, a single aborted run would make both gates fail until someone deleted it. A rehearsal gets a file of its
 * own, which git also ignores: it writes the same shape as a real run, and under the real run's name it would sit
 * one `git add` away from being committed as the evidence behind a published figure.
 */
function resultsFile(rehearse, runId, { partial = false, stamp } = {}) {
  if (rehearse) return 'bench/calibrate-aws-rehearsal.json';
  const id = checkRunId(runId);
  if (stamp !== undefined) {
    // Where a run goes whose own name was taken while it ran: named for its start, which only it can have.
    if (!/^\d{8}T\d{9}Z$/.test(stamp)) throw new Error(`"${stamp}" is not a run's start stamp`);
    return `${EVIDENCE_DIR}/${id}.${stamp}.partial.json`;
  }
  return `${EVIDENCE_DIR}/${id}${partial ? '.partial' : ''}.json`;
}

/** A run's start as a file-name stamp: `2026-09-23T05:01:02.345Z` is `20260923T050102345Z`. */
function stampOf(iso) {
  return String(iso).replace(/[-:.]/g, '');
}

/**
 * Whether a run would replace evidence that already exists, and what to say if so; `null` when it would not.
 *
 * Evidence is write-once, like the generations it measures. A figure published from a run is checked against the
 * file under that run's id, and `CR_CALIBRATE_RUN_ID` exists so a run can be named — so a second run under a
 * published run's id would replace the file its figures are checked against. A partial file does not count: it is
 * not evidence, and a run that failed part-way can be retried under its own id.
 */
function evidenceConflict({ rehearse, file, exists }) {
  if (rehearse || !exists(file)) return null;
  return (
    `${file} already exists — that run's evidence is committed. Choose another CR_CALIBRATE_RUN_ID, or leave ` +
    'it unset for a fresh one.'
  );
}

/**
 * The most segments a run may load: what one teardown listing can hold.
 *
 * `ListObjectVersions` returns at most 1,000 versions a page, and teardown lists one page a pass. Each segment leaves
 * two versions, its generation and its pointer, so a workload of 1,510 segments leaves 3,020 versions: 20 past what
 * teardown's three passes list. At 500 segments the whole bucket fits in the first listing, and the other passes
 * are left for what a concurrent write or a refused delete leaves behind.
 */
const MAX_SEGMENTS = 1000 / 2;

/**
 * Refuse a workload that cannot measure what it claims to, or that teardown could not remove.
 *
 * Every intersect pairs segment i with segment i + 1, wrapping round. With one segment that is a segment with
 * itself: every chunk is shared, so a run shrunk to one segment — what someone does to make it cheaper — would fetch
 * all 1,999 chunks an intersect, fail its exactness check and overspend its projection before the ceiling check
 * could see it. Each set of segments the stages load is held to the same rule.
 *
 * `loaded` is every segment the run loads, the stages' own included: it is what teardown's first listing has to hold.
 */
function checkWorkload({
  segments,
  largeSegments = 0,
  reads,
  spreadSegments = 0,
  spreadReads = 0,
  sweepSegments = 0,
  sweepEntries = 0,
}) {
  const pairs = (n, reading, name, env) => {
    if (reading > 0 && n < 2) {
      throw new Error(
        `${name === '' ? '' : `${name}: `}${n} segment(s) cannot make an intersect of two different segments; set ${env} to at least 2, ` +
          'or the reads that use them to 0',
      );
    }
  };
  pairs(segments, reads, '', 'CR_CALIBRATE_SEGMENTS');
  pairs(spreadSegments, spreadReads, 'spread', 'CR_CALIBRATE_SPREAD_SEGMENTS');
  pairs(sweepSegments, sweepEntries, 'sweep', 'CR_CALIBRATE_SWEEP_SEGMENTS');
  const loaded =
    segments +
    largeSegments +
    spreadSegments +
    (sweepEntries > 0 ? sweepSegments * sweepEntries : 0);
  if (loaded > MAX_SEGMENTS) {
    throw new Error(
      `${loaded} segments would leave more object versions than teardown's first listing reaches; ` +
        `load at most ${MAX_SEGMENTS}, counting every stage's`,
    );
  }
}

/**
 * The prefix the harness gives its store, under which everything it writes lives: generations and the registry
 * pointer alike.
 */
const STORE_PREFIX = 'calib';

/**
 * Keys in a calibration bucket that the harness did not write.
 *
 * Teardown deletes every version of every key it lists, and `--cleanup` points it at a bucket by the name it was
 * given. A key outside {@link STORE_PREFIX} means the bucket is not what its name says, so teardown refuses to
 * empty it and reports it instead.
 */
function foreignKeys(keys) {
  return keys.filter((k) => typeof k !== 'string' || !k.startsWith(`${STORE_PREFIX}/`));
}

/**
 * How many pages of a listing teardown reads before it touches anything. The harness's own bucket fits one; one that
 * runs past this many is not a bucket it made, and is refused rather than read without end.
 */
const MAX_LISTING_PAGES = 10;

/**
 * The last line of a LEFTOVERS report: how to remove what is left, or, for a bucket that holds keys the harness did
 * not write, that `--cleanup` will not.
 */
function leftoversHint({ notOurs, rehearse, runId }) {
  return notOurs
    ? '  --cleanup will not empty a bucket holding keys the harness did not write; inspect it by hand'
    : `  remove them with: node bench/calibrate-aws.cjs${rehearse ? ' --rehearse' : ''} --cleanup ${runId}`;
}

/**
 * The one region this harness has prices for.
 *
 * It prices every run at `AWS_US_EAST_1_ONDEMAND`, so a run elsewhere would record the wrong bill and check its
 * ceiling against the wrong one: too low, in every region that costs more. A run anywhere else is refused until a
 * pricing profile for that region exists. `--cleanup` is not refused, because it spends almost nothing.
 */
const PRICED_REGION = 'us-east-1';

function checkRunRegion(region) {
  if (region !== PRICED_REGION) {
    throw new Error(
      `this harness has prices for ${PRICED_REGION} only, and a run in ${String(region)} would record the wrong ` +
        `bill and check the wrong ceiling — run it in ${PRICED_REGION}`,
    );
  }
  return region;
}

module.exports = {
  CONFIRM_PHRASE,
  RETRY_BOUND,
  CHUNK_SPAN,
  DEFAULT_LAYOUT,
  parseCeiling,
  resolveSize,
  probeMeansAbsent,
  projectOps,
  firstLoads,
  exceedsProjection,
  breached,
  planLayout,
  planSweepLayout,
  layoutIds,
  maskAccount,
  redact,
  resultsFile,
  stampOf,
  checkRunId,
  checkCleanupId,
  evidenceConflict,
  checkWorkload,
  MAX_SEGMENTS,
  STORE_PREFIX,
  foreignKeys,
  MAX_LISTING_PAGES,
  leftoversHint,
  ADMIN_TIMEOUTS,
  PRICED_REGION,
  checkRunRegion,
  EVIDENCE_DIR,
  TIMED_STORE,
  ADMIN_ATTEMPTS,
  clientConfigs,
  bucketIsGone,
  uploadIsGone,
  TEARDOWN_PASSES,
  TEARDOWN_PUTS,
};
