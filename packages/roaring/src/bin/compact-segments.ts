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
 */
import { hostname } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  LocalFsColdDriver,
  LocalFsRegistryDriver,
  LocalFsWarmDriver,
  runCompactionCycle,
} from '../index';
import type { CompactionCycleResult, CompactionDeps, IMetricsSink } from '../index';

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
  };
}

/** Build LocalFs compaction deps rooted at `<root>/{cold,warm,registry}`, optionally with a metrics sink. */
export function localFsDeps(root: string, metrics?: IMetricsSink): CompactionDeps {
  return {
    cold: new LocalFsColdDriver(join(root, 'cold')),
    warm: new LocalFsWarmDriver(join(root, 'warm')),
    registry: new LocalFsRegistryDriver(join(root, 'registry')),
    clock: { now: () => Date.now() }, // the bin is outside core/, so ambient time is allowed here
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
