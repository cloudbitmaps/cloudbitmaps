import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The batch suite's published figures are held to the evidence files under `bench/calibration/batch/`. Nothing
 * here measures: it holds the prose to the files, so a figure retyped by hand, or a newer run committed without
 * the page, fails here.
 *
 * HELD, each against the run it names (the latest run is the one with the newest `startedAt`):
 *  - docs/benchmarks.md, the section headed with the latest run id: every figure of the latest run (every sample's
 *    requests, kinds of read, groups, outputs published, bytes and time, the stage table's rows, the sample times in
 *    order, the run's date, version and number of calls, the median call's peak and mean in flight beside the word
 *    "median", the 3,000 GET-class per call that found nothing (derived: GET-class less the three kinds) with the
 *    engine's own 1,100 tail and 2,627 pointer reads), the earlier runs' median, 95th percentile, outputs a second
 *    and memory range, and the guide's refresh figures against bench/materialize-many-counts.json;
 *  - docs/ROADMAP.md: each of the two sentences that quote the batch requests, as a phrase;
 *  - bench/calibration/batch/README.md: each run's row (found by its run id) against that run's file: date, version,
 *    harness, number of calls, outputs published in groups, and the rest of its figures;
 *  - CHANGELOG.md [Unreleased]: the entry on the batch runs, against both runs' files, including its workload,
 *    version, number of calls and the median call's peak.
 * Numbers are matched whole: no digit, comma or point beside them, so 118.80 does not satisfy 18.80. A count
 * stated with a count unit (GET-class, PUT-class, bytes, range, tail or pointer reads) that no run recorded is
 * refused, a rounded one ("about 4,400 GET-class") included; a count kept beside a different unit is not seen.
 *
 * KNOWN LIMITS. It reads figures, not the sentences around them. Not held: bench/README.md (its batch row and its
 * memory sentence), site/benchmarks.html and tests/README.md; the page's `128 sockets`; the rows' and the entry's
 * prose about the run's workload beyond the phrases listed above; the words "median" and
 * "95th percentile" beside a figure (the three sample times are held in order, but a median quoted for the wrong
 * sample time is not caught); any figure of an earlier run that the page states and this file does not list. The
 * stray-count checks accept a count either run recorded (the two runs' counts are identical today). The evidence
 * records no `publishConcurrency`, so the prose "publishConcurrency 8" is held by nothing, and a run at another
 * value or shape would be forced into the existing sentences until the harness option that sets it records the
 * value in the evidence and this gate holds it (that option is a later change).
 */
const ROOT = join(__dirname, '..', '..');
const DIR = join(ROOT, 'bench', 'calibration', 'batch');

interface Sample {
  ms: number;
  groups: number;
  published: number;
  put: number;
  get: number;
  readBackPut: number;
  readBackGet: number;
  rangeReads: number;
  rangeBytes: number;
  tailReads: number;
  tailBytes: number;
  pointerReads: number;
  bytesRead: number;
  bytesWritten: number;
  peakRssMB: number;
}
interface Evidence {
  runId: string;
  startedAt: string;
  measured: { packageVersion: string; harness: string };
  resources: { memoryMB: number; cpus: number };
  network: { rttFloorMs: number };
  workload: {
    operands: number;
    outputs: number;
    idsPerOperand: number;
    samples: number;
    counts: { batch: { tail: number; pointer: number } };
  };
  cost: { totalUSD: number; ops: { put: number; get: number } };
  phases: {
    batchLoad: { requests: { put: number; get: number } };
    batch: {
      requests: { put: number; get: number };
      p50ms: number;
      p95ms: number;
      n: number;
      medianOutputsPerSec: number;
      medianPeakInFlight: number;
      medianMeanInFlight: number;
      perSample: Sample[];
    };
  };
}

const read = (f: string): Evidence => JSON.parse(readFileSync(join(DIR, f), 'utf8')) as Evidence;
const files = readdirSync(DIR).filter((f) => /^\d{4}-\d{2}-\d{2}-[0-9a-f]+\.json$/.test(f));
// Oldest first, by when each run started: a file name sorts same-day runs by their random suffix.
const runs = files.map(read).sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
const latest = runs[runs.length - 1]!;
const earlier = runs.slice(0, -1);
const fmt = (n: number): string => Math.round(n).toLocaleString('en-US');
const flat = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8').replace(/\s+/g, ' ');
const esc = (t: string): string => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Whether `text` holds `phrase` with no digit, comma or point running on from a number at either end. */
function holds(text: string, phrase: string): boolean {
  const lead = /^\d/.test(phrase) ? '(?<![\\d.,])' : '';
  const tail = /\d$/.test(phrase) ? '(?!\\d|[.,]\\d)' : '';
  return new RegExp(lead + esc(phrase) + tail).test(text);
}
const lacking = (text: string, phrases: string[]): string[] =>
  phrases.filter((f) => !holds(text, f));
const list = (xs: (number | string)[]): string =>
  xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;
const range = (xs: number[]): string => `${Math.min(...xs)} to ${Math.max(...xs)}`;
const rssOf = (e: Evidence): number[] => e.phases.batch.perSample.map((x) => x.peakRssMB);
const mib = (n: number): string => fmt(n);
/** A call's GET-class that returned no object: not filed under a kind of read by the meter (derived). */
const unfiled = (x: Sample): number => x.get - x.rangeReads - x.tailReads - x.pointerReads;
const day = (e: Evidence): string => e.startedAt.slice(0, 10);
const inFlight = (e: Evidence): string =>
  `median call peaked at ${e.phases.batch.medianPeakInFlight} requests in flight and averaged ${e.phases.batch.medianMeanInFlight.toFixed(2)}`;

/** The stated numbers (by unit) that are not in `known`. */
function stray(text: string, unitPattern: string, known: Set<string>): string[] {
  const stated = [...text.matchAll(new RegExp(`(\\d[\\d,]*(?:\\.\\d+)?)${unitPattern}`, 'g'))].map(
    (m) => m[1]!,
  );
  return stated.filter((n) => !known.has(n));
}
/** Every request count, byte count and millisecond figure a run records. */
function known(es: Evidence[]): { ms: Set<string>; counts: Set<string>; mib: Set<string> } {
  const refresh = (
    JSON.parse(readFileSync(join(ROOT, 'bench', 'materialize-many-counts.json'), 'utf8')) as {
      shapes: { refresh: { batch: { getClass: number; putClass: number } } };
    }
  ).shapes.refresh.batch;
  const ms = new Set<string>();
  // The refresh call's counted figures stay on the page, named as counted and not measured.
  const counts = new Set<string>([fmt(refresh.getClass), fmt(refresh.putClass)]);
  const mibs = new Set<string>();
  for (const e of es) {
    const b = e.phases.batch;
    for (const n of [b.p50ms, b.p95ms, ...b.perSample.map((x) => x.ms)]) ms.add(fmt(n));
    ms.add(e.network.rttFloorMs.toFixed(2));
    mibs.add(mib(e.resources.memoryMB));
    for (const n of rssOf(e)) mibs.add(String(n));
    for (const n of [
      e.phases.batchLoad.requests.put,
      e.phases.batchLoad.requests.get,
      b.requests.put,
      b.requests.get,
      e.cost.ops.put,
      e.cost.ops.get,
    ]) {
      counts.add(fmt(n));
    }
    for (const x of b.perSample) {
      for (const n of [
        unfiled(x),
        e.workload.counts.batch.tail,
        e.workload.counts.batch.pointer,
        x.put,
        x.get,
        x.readBackGet,
        x.rangeReads,
        x.rangeBytes,
        x.tailReads,
        x.tailBytes,
        x.pointerReads,
        x.bytesRead,
      ]) {
        counts.add(fmt(n));
      }
    }
  }
  return { ms, counts, mib: mibs };
}
const refreshFigures = (): string => {
  const r = (
    JSON.parse(readFileSync(join(ROOT, 'bench', 'materialize-many-counts.json'), 'utf8')) as {
      shapes: { refresh: { batch: { getClass: number; putClass: number; groups: number } } };
    }
  ).shapes.refresh.batch;
  return `${fmt(r.getClass)} GET-class, ${fmt(r.putClass)} PUT-class, ${r.groups} groups`;
};
const COUNT_UNITS = ' (?:GET-class|PUT-class|bytes|range reads|tail reads|pointer reads)';

const page = flat('docs/benchmarks.md');
const start = page.indexOf(`## Many outputs from one call — run \`${latest.runId}\``);
const end = page.indexOf(' ## ', start + 4);
const section = start < 0 ? '' : page.slice(start, end < 0 ? undefined : end);

/** Every figure of the latest run the section must state: all three samples, each stage row, the times in order. */
function figures(e: Evidence): string[] {
  const b = e.phases.batch;
  const w = e.workload;
  const out = [
    e.runId,
    e.measured.packageVersion,
    `${fmt(b.requests.put)}`,
    fmt(b.requests.get),
    fmt(e.cost.ops.put),
    fmt(e.cost.ops.get),
    fmt(b.p50ms),
    fmt(b.p95ms),
    b.medianOutputsPerSec.toFixed(2),
    `on ${day(e)} (UTC)`,
    `published \`${e.measured.packageVersion}\` packages`,
    `of ${b.n} calls`,
    `with ${b.n} calls`,
    // The median of the calls' peaks and of their means: the evidence records no maximum for the run.
    inFlight(e),
    `${fmt(e.resources.memoryMB)} MiB`,
    e.network.rttFloorMs.toFixed(2),
    `${e.resources.cpus} CPUs`,
    `${fmt(w.outputs)} outputs`,
    `${fmt(w.operands)} stored operands of ${fmt(w.idsPerOperand)} ids`,
    `| each sample's call | ${fmt(b.perSample[0]!.put)} | ${fmt(b.perSample[0]!.get)} |`,
    `| each sample's read-back | ${fmt(b.perSample[0]!.readBackPut)} | ${fmt(b.perSample[0]!.readBackGet)} |`,
    `| the ${fmt(w.operands)} operands' loads | ${fmt(e.phases.batchLoad.requests.put)} | ${fmt(e.phases.batchLoad.requests.get)} |`,
    `| the three calls and their read-backs | ${fmt(b.requests.put)} | ${fmt(b.requests.get)} |`,
    `| the whole run, the bucket's own requests included | ${fmt(e.cost.ops.put)} | ${fmt(e.cost.ops.get)} |`,
    `${list(b.perSample.map((x) => `${fmt(x.ms)} ms`))}`,
    `${list(rssOf(e))} MiB`,
  ];
  for (const x of b.perSample) {
    out.push(
      `published ${fmt(x.published)} outputs in ${x.groups} groups`,
      `${fmt(x.put)} PUT-class and ${fmt(x.get)} GET-class`,
      `The other ${fmt(unfiled(x))} found nothing`,
      `${fmt(e.workload.counts.batch.tail)} tail reads and ${fmt(e.workload.counts.batch.pointer)} pointer reads`,
      `${fmt(x.readBackGet)} more GET-class`,
      `${fmt(x.rangeReads)} were range reads (${fmt(x.rangeBytes)} bytes)`,
      `${fmt(x.tailReads)} tail reads (${fmt(x.tailBytes)} bytes)`,
      `${fmt(x.pointerReads)} pointer reads that returned an object, ${fmt(x.bytesRead)} bytes in all`,
      `wrote about ${(x.bytesWritten / 1e6).toFixed(1)} MB`,
    );
  }
  return out;
}

describe('the batch suite figures', () => {
  it('takes the latest run by when it started, and finds its section on the benchmarks page', () => {
    expect(files.length).toBeGreaterThanOrEqual(2);
    expect(section, 'docs/benchmarks.md has no section headed with the latest run id').not.toBe('');
  });

  it("the benchmarks page states every figure of the latest run's evidence, every sample", () => {
    const missing = lacking(section, figures(latest));
    expect(missing, `docs/benchmarks.md lacks: ${missing.join(' | ')}`).toEqual([]);
  });

  it('the page names each earlier run with its own figures and the guide refresh figures as counted', () => {
    for (const e of earlier) {
      const b = e.phases.batch;
      const missing = lacking(section, [
        e.runId,
        fmt(b.p50ms),
        fmt(b.p95ms),
        b.medianOutputsPerSec.toFixed(2),
        `\`peakRssMB\` ${range(rssOf(e))}`,
      ]);
      expect(missing, `the section must quote, for ${e.runId}: ${missing.join(' | ')}`).toEqual([]);
    }
    expect(lacking(section, [refreshFigures()])).toEqual([]);
  });

  it('every millisecond figure the section states is one a run recorded, the earlier run only by its median and 95th percentile', () => {
    const ok = new Set<string>();
    for (const e of [latest, ...earlier]) ok.add(e.network.rttFloorMs.toFixed(2));
    for (const x of latest.phases.batch.perSample) ok.add(fmt(x.ms));
    for (const e of runs) {
      ok.add(fmt(e.phases.batch.p50ms));
      ok.add(fmt(e.phases.batch.p95ms));
    }
    const bad = stray(section, ' ms\\b', ok);
    expect(bad, `milliseconds no run recorded: ${bad.join(', ')}`).toEqual([]);
  });

  it('every CPU count the section states is the one the latest run recorded', () => {
    const bad = stray(section, ' CPUs', new Set([String(latest.resources.cpus)]));
    expect(bad, `CPU counts the run did not record: ${bad.join(', ')}`).toEqual([]);
  });

  it('every request count and byte count the section states is one a run recorded', () => {
    const k = known(runs).counts;
    const bad = stray(section, COUNT_UNITS, k);
    expect(bad, `counts no run recorded: ${bad.join(', ')}`).toEqual([]);
  });

  it("the roadmap's two sentences on the batch requests each state them, as a phrase", () => {
    const road = flat('docs/ROADMAP.md');
    const b = latest.phases.batch;
    const s = b.perSample[0]!;
    const req = `${fmt(s.get)} GET-class and ${fmt(s.put)} PUT-class`;
    const sentences = [
      `run \`${latest.runId}\`: ${req} a call, in ${s.groups} groups`,
      `${req} requests a call, a median of ${fmt(b.p50ms)} ms`,
    ];
    const missing = lacking(road, sentences);
    expect(missing, `docs/ROADMAP.md must say: ${missing.join(' | ')}`).toEqual([]);
  });

  it("the batch README's row for each run holds that run's figures", () => {
    const rows = readFileSync(join(DIR, 'README.md'), 'utf8').split('\n');
    for (const e of runs) {
      const row = rows.find((r) => r.startsWith('|') && r.includes(`[\`${e.runId}.json\`]`));
      expect(row, `bench/calibration/batch/README.md has no row for ${e.runId}`).toBeDefined();
      const b = e.phases.batch;
      const s0 = b.perSample[0]!;
      const need = [
        fmt(b.p50ms),
        b.medianOutputsPerSec.toFixed(2),
        `\`peakRssMB\` ${range(rssOf(e))}`,
        `${day(e)} (UTC)`,
        `\`${e.measured.packageVersion}\` packages, harness \`${e.measured.harness}\``,
        `(${b.n} calls)`,
      ];
      if (e === latest) {
        need.push(
          fmt(b.p95ms),
          `median call averaged about five requests in flight (\`medianMeanInFlight\` ${b.medianMeanInFlight.toFixed(2)}`,
          `peaked at ${b.medianPeakInFlight} (\`medianPeakInFlight\`, **measured**)`,
          `${fmt(e.resources.memoryMB)} MiB`,
          e.network.rttFloorMs.toFixed(2),
        );
      }
      const missing = lacking(row!, need);
      expect(missing, `the row of ${e.runId} lacks: ${missing.join(' | ')}`).toEqual([]);
      const k = known([e]);
      const bad = [
        ...stray(row!, ' ms\\b', k.ms),
        ...stray(row!, COUNT_UNITS, k.counts),
        ...stray(row!, ' MiB', k.mib),
        ...[...row!.matchAll(/\$(\d+\.\d+)/g)]
          .map((m) => m[1]!)
          .filter((n) => n !== String(e.cost.totalUSD)),
        ...stray(row!, ' outputs a second', new Set([b.medianOutputsPerSec.toFixed(2)])),
      ];
      expect(bad, `the row of ${e.runId} states what its file does not: ${bad.join(', ')}`).toEqual(
        [],
      );
      if (e === runs[0]) {
        // The row that states the per-sample requests states each sample's.
        expect(
          lacking(row!, [
            `${s0.groups} groups with ${fmt(s0.published)} outputs published`,
            ...b.perSample.map((x) => `${fmt(x.put)} PUT-class and ${fmt(x.get)} GET-class`),
            `${fmt(b.requests.put)} PUT-class and ${fmt(b.requests.get)} GET-class`,
            `${fmt(e.cost.ops.put)} PUT-class and ${fmt(e.cost.ops.get)} GET-class`,
          ]),
        ).toEqual([]);
      }
    }
  });

  it("the changelog's entry on the batch runs holds both runs' figures", () => {
    const log = flat('CHANGELOG.md');
    const at = log.indexOf('**`store.materializeMany` is measured on S3, by the batch suite');
    expect(at, 'CHANGELOG.md has no entry on the batch runs').toBeGreaterThanOrEqual(0);
    const stop = log.indexOf(' - **', at + 4);
    const entry = log.slice(at, stop < 0 ? undefined : stop);
    const b = latest.phases.batch;
    const s = b.perSample[0]!;
    const need = [
      ...runs.map((e) => e.runId),
      `\`${latest.measured.packageVersion}\` packages`,
      `${fmt(latest.workload.outputs)} outputs over ${fmt(latest.workload.operands)} stored operands of ${fmt(latest.workload.idsPerOperand)} ids`,
      `published ${fmt(s.published)} outputs in ${s.groups} groups`,
      `${b.n} calls`,
      `${fmt(s.put)} PUT-class and ${fmt(s.get)} GET-class`,
      `${fmt(b.requests.put)} PUT-class and ${fmt(b.requests.get)} GET-class`,
      `$${latest.cost.totalUSD}`,
      `${fmt(b.p50ms)} ms in the second run`,
      `${fmt(b.p95ms)} ms`,
      b.medianOutputsPerSec.toFixed(2),
      ...earlier.map((e) => `${fmt(e.phases.batch.p50ms)} ms in the first`),
      ...runs.map((e) => e.phases.batch.medianMeanInFlight.toFixed(2)),
      `peaked at ${latest.phases.batch.medianPeakInFlight}`,
      `\`peakRssMB\` was ${range(runs.flatMap(rssOf))} MiB`,
      refreshFigures(),
    ];
    const missing = lacking(entry, need);
    expect(missing, `the CHANGELOG entry lacks: ${missing.join(' | ')}`).toEqual([]);
    const k = known(runs);
    const bad = [...stray(entry, ' ms\\b', k.ms), ...stray(entry, COUNT_UNITS, k.counts)];
    expect(bad, `the CHANGELOG entry states what no run recorded: ${bad.join(', ')}`).toEqual([]);
  });
});
