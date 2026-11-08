import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The benchmarks page's section on the batch suite's latest run, and the roadmap's sentence on it, state the
 * figures the latest evidence file under `bench/calibration/batch/` gives. Nothing here measures: it holds the
 * prose to the file, so a figure retyped by hand, or a newer run committed without the page, fails here.
 *
 * KNOWN LIMIT. It reads figures, not the sentences around them, and it checks the milliseconds the section
 * states against both runs' evidence (so a figure from the wrong run of the two still passes).
 */
const ROOT = join(__dirname, '..', '..');
const DIR = join(ROOT, 'bench', 'calibration', 'batch');

interface Sample {
  ms: number;
  put: number;
  get: number;
  readBackGet: number;
  rangeReads: number;
  rangeBytes: number;
  tailReads: number;
  tailBytes: number;
  pointerReads: number;
  bytesRead: number;
  peakRssMB: number;
}
interface Evidence {
  runId: string;
  measured: { packageVersion: string };
  resources: { memoryMB: number };
  network: { rttFloorMs: number };
  cost: { totalUSD: number; ops: { put: number; get: number; peakInFlight: number } };
  phases: {
    batchLoad: { requests: { put: number; get: number } };
    batch: {
      requests: { put: number; get: number };
      p50ms: number;
      p95ms: number;
      medianOutputsPerSec: number;
      medianMeanInFlight: number;
      perSample: Sample[];
    };
  };
}

const files = readdirSync(DIR)
  .filter((f) => /^\d{4}-\d{2}-\d{2}-[0-9a-f]+\.json$/.test(f))
  .sort();
const read = (f: string): Evidence => JSON.parse(readFileSync(join(DIR, f), 'utf8')) as Evidence;
const runs = files.map(read);
const latest = runs[runs.length - 1]!;
const fmt = (n: number): string => Math.round(n).toLocaleString('en-US');
const flat = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8').replace(/\s+/g, ' ');

const page = flat('docs/benchmarks.md');
const start = page.indexOf(`## Many outputs from one call — run \`${latest.runId}\``);
const end = page.indexOf(' ## ', start + 4);
const section = start < 0 ? '' : page.slice(start, end < 0 ? undefined : end);

/** Every figure of the latest run the section must state. */
function figures(e: Evidence): string[] {
  const b = e.phases.batch;
  const s = b.perSample[0]!;
  const rss = b.perSample.map((x) => x.peakRssMB);
  return [
    e.runId,
    e.measured.packageVersion,
    fmt(s.put),
    fmt(s.get),
    fmt(s.readBackGet),
    fmt(e.phases.batchLoad.requests.put),
    fmt(e.phases.batchLoad.requests.get),
    fmt(b.requests.put),
    fmt(b.requests.get),
    fmt(e.cost.ops.put),
    fmt(e.cost.ops.get),
    `$${e.cost.totalUSD}`,
    fmt(s.rangeReads),
    fmt(s.rangeBytes),
    fmt(s.tailReads),
    fmt(s.tailBytes),
    fmt(s.pointerReads),
    fmt(s.bytesRead),
    fmt(b.p50ms),
    fmt(b.p95ms),
    b.medianOutputsPerSec.toFixed(2),
    b.medianMeanInFlight.toFixed(2),
    String(e.cost.ops.peakInFlight),
    ...rss.map(String),
    fmt(e.resources.memoryMB),
    e.network.rttFloorMs.toFixed(2),
    ...b.perSample.map((x) => fmt(x.ms)),
  ];
}

describe('the batch suite figures', () => {
  it('has a latest run and its section on the benchmarks page', () => {
    expect(files.length).toBeGreaterThanOrEqual(2);
    expect(section, 'docs/benchmarks.md has no section headed with the latest run id').not.toBe('');
  });

  it("the benchmarks page states every figure of the latest run's evidence", () => {
    const missing = figures(latest).filter((f) => !section.includes(f));
    expect(missing, `docs/benchmarks.md lacks: ${missing.join(', ')}`).toEqual([]);
  });

  it('the page names each earlier run with its own median and outputs a second', () => {
    for (const e of runs.slice(0, -1)) {
      for (const f of [
        e.runId,
        fmt(e.phases.batch.p50ms),
        e.phases.batch.medianOutputsPerSec.toFixed(2),
      ]) {
        expect(section, `the section must quote ${f} for ${e.runId}`).toContain(f);
      }
    }
  });

  it('every millisecond figure the section states is one a run recorded', () => {
    const known = new Set<string>();
    for (const e of runs) {
      known.add(fmt(e.phases.batch.p50ms));
      known.add(fmt(e.phases.batch.p95ms));
      for (const s of e.phases.batch.perSample) known.add(fmt(s.ms));
      known.add(e.network.rttFloorMs.toFixed(2));
    }
    const stated = [...section.matchAll(/(\d[\d,]*(?:\.\d+)?) ms\b/g)].map((m) => m[1]!);
    const stray = stated.filter((n) => !known.has(n));
    expect(stray, `milliseconds no run recorded: ${stray.join(', ')}`).toEqual([]);
  });

  it('every request count and byte count the section states is one a run recorded', () => {
    // The refresh call's counted figures stay on the page, named as counted and not measured.
    const refresh = (
      JSON.parse(readFileSync(join(ROOT, 'bench', 'materialize-many-counts.json'), 'utf8')) as {
        shapes: { refresh: { batch: { getClass: number; putClass: number } } };
      }
    ).shapes.refresh.batch;
    const known = new Set<string>([fmt(refresh.getClass), fmt(refresh.putClass)]);
    for (const e of runs) {
      for (const n of [
        e.phases.batchLoad.requests.put,
        e.phases.batchLoad.requests.get,
        e.phases.batch.requests.put,
        e.phases.batch.requests.get,
        e.cost.ops.put,
        e.cost.ops.get,
      ]) {
        known.add(fmt(n));
      }
      for (const s of e.phases.batch.perSample) {
        for (const n of [
          s.put,
          s.get,
          s.readBackGet,
          s.rangeReads,
          s.rangeBytes,
          s.tailBytes,
          s.bytesRead,
        ]) {
          known.add(fmt(n));
        }
      }
    }
    const stated = [
      ...section.matchAll(
        /(\d[\d,]*) (?:GET-class|PUT-class|bytes|range reads|tail reads|pointer reads)/g,
      ),
    ].map((m) => m[1]!);
    for (const e of runs) {
      for (const s of e.phases.batch.perSample) {
        known.add(fmt(s.tailReads));
        known.add(fmt(s.pointerReads));
      }
    }
    const stray = stated.filter((n) => !known.has(n));
    expect(stray, `counts no run recorded: ${stray.join(', ')}`).toEqual([]);
  });

  it('the roadmap quotes the requests of the latest run and median', () => {
    const road = flat('docs/ROADMAP.md');
    const s = latest.phases.batch.perSample[0]!;
    for (const f of [fmt(s.get), fmt(s.put), fmt(latest.phases.batch.p50ms), latest.runId]) {
      expect(road, `docs/ROADMAP.md must quote ${f}`).toContain(f);
    }
  });
});
