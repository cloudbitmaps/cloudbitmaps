#!/usr/bin/env node
/**
 * `compact-segments` — the standalone compaction daemon CLI (Phase 4d).
 *
 * A thin wrapper over {@link runCompactionCycle}: discover dirty segments → 2-phase-commit compact → GC. It
 * ships the **local-filesystem** backend (zero-dependency, the dev/reference target) and two **deploy modes**:
 *
 *   - `once`  — run a single cycle and exit (the **Lambda / one-shot / cron** shape).
 *   - `loop`  — run a cycle every `intervalMs`, until SIGINT/SIGTERM (the **K8s Deployment / ECS service** shape).
 *
 * **Cloud backends:** rather than have the CLI guess your AWS config, production wires its own ~10-line
 * handler that constructs an `S3ColdDriver` + `DynamoDb{Warm,Registry}Driver` and calls `runCompactionCycle`
 * directly (same two modes — call once, or on a `setInterval`). The library exports everything needed; this
 * binary stays SDK-free (so the core install never pulls a cloud SDK). See the getting-started guide.
 *
 * Config is read from the environment (so it's identical across `once`/`loop` and 12-factor-friendly):
 *   CR_COMPACT_ROOT       (required) — the local-filesystem root holding cold/ warm/ registry/
 *   CR_COMPACT_MODE       once | loop                  (default: once)
 *   CR_COMPACT_INTERVAL_MS                              (default: 30000, loop mode)
 *   CR_COMPACT_NAMESPACE  scope discovery to one namespace
 *   CR_COMPACT_THRESHOLD  min dirty chunks to compact   (default: 1)
 *   CR_COMPACT_KEEP       superseded generations to retain as a reader grace window (default: 1)
 *   CR_COMPACT_OWNER      lease owner id                 (default: `<hostname>:<pid>`)
 *   CR_COMPACT_SHARD / CR_COMPACT_TOTAL_SHARDS  run this worker as shard i of N (set both) — partition the
 *                         fleet across N daemons so each drains only ~1/N of Warm per cycle (gap #3)
 *   CR_COMPACT_MAX_SEGMENTS  cap segments compacted per cycle (a time budget for a Lambda window); the rest
 *                         are deferred to the next cycle, most-dirty first
 *   CR_COMPACT_METRICS    1 to emit each per-attempt compaction `MetricEvent` (retries, bytes, ms, faults) as a
 *                         JSON line on stdout — pipe to your metrics pipeline. Off by default (cycle summaries
 *                         still print regardless); the library's `IMetricsSink` seam is what this wires.
 *
 * **Retention (opt-in).** With `CR_RETIRE=1` each cycle also runs {@link retireExpired}, retiring the segments
 * whose `expiresAt` has passed. It is a *separate phase after* compaction, not part of `runCompactionCycle`:
 * compaction's job is to make a segment cheap, retirement's is to delete it, and a destructive step that runs
 * implicitly inside a maintenance cycle is the wrong default for anyone who just wanted their Warm tier drained.
 * Off unless you ask for it, and a custom worker composes the same two calls in the same order.
 *   CR_RETIRE             1 to enable the retention sweep (default: off)
 *   CR_RETIRE_INTERVAL_MS how often to sweep, independent of the compaction interval (default: 86400000, i.e.
 *                         daily). Retention windows are measured in days, so sweeping at the 30 s compaction
 *                         cadence would re-scan the whole registry 2,880 times a day — on DynamoDB that is a
 *                         full-table Scan each time, billed, competing with the hot path for read capacity.
 *   CR_RETIRE_LIMIT       max segments retired per sweep    (default: 100)
 *   CR_RETIRE_DRY_RUN     1 to report what it would retire and delete nothing — start here
 *   CR_RETIRE_TOMBSTONE_GRACE_MS  ms a retirement's tombstone row must age before the row is deleted
 *                         (default: 86400000)
 *   CR_RETIRE_KEEP_TOMBSTONES  1 to never delete a tombstone row
 *   Scope follows CR_COMPACT_NAMESPACE. **Run the sweep from ONE process** — it has no shard option, so N
 *   replicas each sweep the whole registry and contend over the same segments.
 */
import { SystemClock } from '../system-clock';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  DEFAULT_RETIRE_LIMIT,
  DEFAULT_TOMBSTONE_GRACE_MS,
  LocalFsColdDriver,
  LocalFsRegistryDriver,
  LocalFsWarmDriver,
  retireExpired,
  runCompactionCycle,
} from '../index';
import type {
  CompactionCycleResult,
  CompactionDeps,
  IMetricsSink,
  RetireExpiredResult,
} from '../index';

export interface CompactConfig {
  readonly root: string;
  readonly mode: 'once' | 'loop';
  readonly intervalMs: number;
  readonly namespace?: string;
  readonly threshold: number;
  readonly keep: number;
  readonly owner: string;
  readonly shard?: number;
  readonly totalShards?: number;
  readonly maxSegments?: number;
  /** Retention sweep (opt-in) — absent ⇒ the daemon never retires anything. */
  readonly retire?: RetireConfig;
}

export interface RetireConfig {
  readonly limit: number;
  readonly dryRun: boolean;
  readonly intervalMs: number;
  readonly purgeTombstones: boolean;
  readonly tombstoneGraceMs: number;
}

/** Parse + validate config from an environment map. Throws a clear `Error` on misconfiguration. */
export function parseConfig(env: Record<string, string | undefined>): CompactConfig {
  const root = env.CR_COMPACT_ROOT;
  if (root === undefined || root === '') {
    throw new Error('CR_COMPACT_ROOT is required (the local-filesystem storage root)');
  }
  const mode = env.CR_COMPACT_MODE ?? 'once';
  if (mode !== 'once' && mode !== 'loop') {
    throw new Error(`CR_COMPACT_MODE must be "once" or "loop"; got ${mode}`);
  }
  const num = (name: string, def: number): number => {
    const raw = env[name];
    if (raw === undefined || raw === '') return def; // unset OR empty (a common unset-var expansion) → default
    const v = Number(raw);
    if (!Number.isFinite(v) || v < 0)
      throw new Error(`${name} must be a non-negative number; got ${raw}`);
    return v;
  };
  const intOpt = (name: string, min = 0): number | undefined => {
    const raw = env[name];
    if (raw === undefined || raw === '') return undefined;
    const v = Number(raw);
    if (!Number.isInteger(v) || v < min)
      throw new Error(`${name} must be an integer >= ${min}; got ${raw}`);
    return v;
  };
  const shard = intOpt('CR_COMPACT_SHARD');
  const totalShards = intOpt('CR_COMPACT_TOTAL_SHARDS');
  if ((shard === undefined) !== (totalShards === undefined)) {
    throw new Error('set both CR_COMPACT_SHARD and CR_COMPACT_TOTAL_SHARDS, or neither');
  }
  return {
    root,
    mode,
    intervalMs: num('CR_COMPACT_INTERVAL_MS', 30_000),
    namespace: env.CR_COMPACT_NAMESPACE,
    threshold: num('CR_COMPACT_THRESHOLD', 1),
    keep: num('CR_COMPACT_KEEP', 1),
    owner: env.CR_COMPACT_OWNER ?? `${hostname()}:${process.pid}`,
    shard,
    totalShards,
    maxSegments: intOpt('CR_COMPACT_MAX_SEGMENTS', 1),
    retire: env.CR_RETIRE === '1' ? parseRetireConfig(env, num, intOpt) : undefined,
  };
}

function parseRetireConfig(
  env: Record<string, string | undefined>,
  num: (name: string, def: number) => number,
  intOpt: (name: string, min?: number) => number | undefined,
): RetireConfig {
  return {
    // `intOpt(name, 1)`, not `num`: `num` accepts 0 and 1.5, and `retireExpired` then throws a ValidationError
    // from *inside* the cycle — swallowed into a generic `{"event":"error"}` line every 30 s in loop mode, so
    // compaction keeps reporting healthy cycles while retention silently never runs. `parseConfig` promises to
    // throw a clear error on misconfiguration; this is what keeps that promise. (CR_COMPACT_MAX_SEGMENTS, the
    // identical concept, already used `intOpt`.)
    limit: intOpt('CR_RETIRE_LIMIT', 1) ?? DEFAULT_RETIRE_LIMIT,
    dryRun: env.CR_RETIRE_DRY_RUN === '1',
    intervalMs: num('CR_RETIRE_INTERVAL_MS', DEFAULT_TOMBSTONE_GRACE_MS),
    purgeTombstones: env.CR_RETIRE_KEEP_TOMBSTONES !== '1',
    tombstoneGraceMs: num('CR_RETIRE_TOMBSTONE_GRACE_MS', DEFAULT_TOMBSTONE_GRACE_MS),
  };
}

/** Build LocalFs compaction deps rooted at `<root>/{cold,warm,registry}`, optionally with a metrics sink. */
export function localFsDeps(root: string, metrics?: IMetricsSink): CompactionDeps {
  return {
    cold: new LocalFsColdDriver(join(root, 'cold')),
    warm: new LocalFsWarmDriver(join(root, 'warm')),
    registry: new LocalFsRegistryDriver(join(root, 'registry')),
    // A real clock, not `{ now }`: outside `core/` ambient time is allowed, and a full clock is what lets
    // the generation write hand the event loop back instead of blocking the daemon for its whole duration.
    clock: new SystemClock(),
    ...(metrics ? { metrics } : {}),
  };
}

/** Run a single compaction cycle and return the full result (the unit of work for both deploy modes). */
export async function runOnce(
  deps: CompactionDeps,
  config: CompactConfig,
): Promise<CompactionCycleResult> {
  return runCompactionCycle(deps, {
    owner: config.owner,
    namespace: config.namespace,
    threshold: config.threshold,
    keep: config.keep,
    shard: config.shard,
    totalShards: config.totalShards,
    maxSegments: config.maxSegments,
  });
}

/**
 * Run the retention sweep for one cycle, if configured. Returns `undefined` when retention is off.
 *
 * `now` comes from the deps clock — the same one compaction uses — so a daemon wired with a test clock sweeps
 * against that clock too.
 */
export async function retireOnce(
  deps: CompactionDeps,
  config: CompactConfig,
  /**
   * When the sweep last ran (epoch-ms), or `undefined` for "never". A sweep is skipped — returning `undefined` —
   * until `CR_RETIRE_INTERVAL_MS` has elapsed, so the retention cadence is independent of the compaction one.
   * `once` mode passes nothing and therefore always sweeps, which is the cron/Lambda shape.
   */
  lastSweptAt?: number,
): Promise<RetireExpiredResult | undefined> {
  const retire = config.retire;
  if (retire === undefined) return undefined;
  if (lastSweptAt !== undefined && deps.clock.now() - lastSweptAt < retire.intervalMs) {
    return undefined;
  }
  return retireExpired(
    { registry: deps.registry, warm: deps.warm, cold: deps.cold },
    {
      namespace: config.namespace,
      now: deps.clock.now(),
      limit: retire.limit,
      dryRun: retire.dryRun,
      purgeTombstones: retire.purgeTombstones,
      tombstoneGraceMs: retire.tombstoneGraceMs,
    },
  );
}

/** How many skipped segments one log line names before switching to per-reason counts. */
const LOG_SKIPPED_SAMPLE = 20;

/**
 * One JSON line summarising a sweep. Skips are counted per reason AND a bounded sample is named — a silent skip is
 * a lost signal, but the whole list is not loggable: a bad backfill over a 250,000-row fleet would otherwise
 * serialise megabytes into a single line, which is ~78× CloudWatch's 256 KB event limit, so the line that mattered
 * would be truncated or dropped. `retired` and `wouldRetire` are separate fields for the same reason — a counter
 * that means "deleted" in one mode and "would delete" in another puts phantom deletions on a graph.
 */
function logRetire(result: RetireExpiredResult): void {
  const skipped = result.entries.filter((e) => e.action === 'skipped');
  const byReason: Record<string, number> = {};
  for (const e of skipped) {
    // Collapse `failed: <driver message>` into one bucket; the sample below carries the actual text.
    const key = e.reason.startsWith('failed:') ? 'failed' : e.reason;
    byReason[key] = (byReason[key] ?? 0) + 1;
  }
  const notReclaimed = result.entries.filter(
    (e) => e.action === 'retired' && e.result.generationsRemaining.length > 0,
  );
  log({
    event: 'retire',
    dryRun: result.dryRun,
    scanned: result.scanned,
    eligible: result.eligible,
    retired: result.retired,
    wouldRetire: result.wouldRetire,
    tombstonesPurged: result.tombstonesPurged,
    limited: result.limited,
    skippedByReason: byReason,
    skippedSample: skipped
      .slice(0, LOG_SKIPPED_SAMPLE)
      .map((e) => ({ segment: e.segment, namespace: e.namespace, reason: e.reason })),
    notFullyReclaimed: notReclaimed.slice(0, LOG_SKIPPED_SAMPLE).map((e) => e.segment),
    notFullyReclaimedCount: notReclaimed.length,
  });
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const log = (obj: unknown): void => {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
};

/** A stdout `IMetricsSink` (opt-in via CR_COMPACT_METRICS) — one JSON line per compaction `MetricEvent`. */
function stdoutMetricsSink(): IMetricsSink {
  return {
    onEvent: (event) => log({ event: 'metric', ...event }),
  };
}

/** CLI entry: parse env, then run one cycle (`once`) or loop until a termination signal (`loop`). */
export async function main(env: Record<string, string | undefined> = process.env): Promise<void> {
  const config = parseConfig(env);
  const deps = localFsDeps(
    config.root,
    env.CR_COMPACT_METRICS === '1' ? stdoutMetricsSink() : undefined,
  );

  if (config.mode === 'once') {
    const cycle = await runOnce(deps, config);
    log({
      event: 'cycle',
      mode: 'once',
      candidates: cycle.candidates,
      compacted: cycle.compacted,
      deferred: cycle.deferred,
      results: cycle.results,
    });
    const swept = await retireOnce(deps, config);
    if (swept !== undefined) logRetire(swept);
    return;
  }

  // loop mode: run forever, one cycle per interval, until SIGINT/SIGTERM.
  let stop = false;
  const onSignal = (): void => {
    stop = true;
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  log({ event: 'start', mode: 'loop', intervalMs: config.intervalMs, owner: config.owner });
  // `undefined` so the first cycle sweeps; thereafter the retention interval gates it independently of this loop's.
  let lastSweptAt: number | undefined;
  while (!stop) {
    try {
      const cycle = await runOnce(deps, config);
      log({
        event: 'cycle',
        candidates: cycle.candidates,
        compacted: cycle.compacted,
        deferred: cycle.deferred,
        results: cycle.results,
      });
      const swept = await retireOnce(deps, config, lastSweptAt);
      if (swept !== undefined) {
        lastSweptAt = deps.clock.now();
        logRetire(swept);
      }
    } catch (err) {
      log({ event: 'error', message: (err as Error).message }); // a cycle error must not kill the daemon
    }
    if (!stop) await sleep(config.intervalMs);
  }
  log({ event: 'stopped' });
}

// Run only when invoked directly (not when imported by tests). `process.argv[1]` is this file when run as a bin;
// `pathToFileURL` builds a spec-correct file:// URL (drive letters, spaces, UNC paths) for a robust compare.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    process.stderr.write(`${(err as Error).message}\n`);
    process.exit(1);
  });
}
