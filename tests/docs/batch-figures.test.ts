import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

/**
 * The batch suite's published figures are held to the evidence files under `bench/calibration/batch/`. Nothing
 * here measures: it holds the prose to the files, so a figure retyped by hand, or a newer run committed without
 * the page, fails here.
 *
 * WHICH RUN IS WHICH. A run records the settings its `materializeMany` call was made with (`publishConcurrency`,
 * `concurrency`, `maxBufferedBytes`: a value, or null for "not passed, the library's default"); a file that records
 * none, the two committed before the fields existed, reads as all null (`settingsOf` in `bench/lib/batch-evidence.cjs`).
 * A run whose settings are all null is a run at the defaults. The section of the benchmarks page on "the latest run at
 * the defaults" is held to the newest such run by `startedAt`, so a run at another value, however new, never takes it
 * over. A run at another value has a section of its own: when its evidence lands, add to docs/benchmarks.md a section
 * headed `## Many outputs from one call — run `<run id>` (`publishConcurrency` 64)` (each setting that was passed, as
 * `name` value, comma separated) that states every figure the defaults section states (the list in `figures`), and a
 * row for it in the batch README that names the same settings. That is all this file needs; no other edit makes it
 * pass or fail. A link to the defaults section's anchor must name the latest run at the defaults, so a new such run
 * moves every link in the same change.
 *
 * HELD, each against the run it names:
 *  - docs/benchmarks.md, the section headed with the latest run at the defaults: every figure of the run (every
 *    sample's requests, kinds of read, groups, outputs published, bytes and time, the stage table's rows, the sample
 *    times in order, the run's date, version and number of calls, the median call's peak and mean in flight beside the
 *    word "median", the GET-class per call that found nothing (derived: GET-class less the three kinds) with the
 *    engine's own tail and pointer reads), the settings it states (the library's defaults for the run's version,
 *    named below), the earlier defaults runs' median, 95th percentile, outputs a second and memory range, and the
 *    guide's refresh figures against bench/materialize-many-counts.json; the section of each run at another value;
 *  - docs/ROADMAP.md: each of the two sentences that quote the batch requests, as a phrase;
 *  - bench/calibration/batch/README.md: each run's row (found by its run id) against that run's file: date, version,
 *    harness, number of calls, outputs published in groups, the settings of a run at another value, and the rest of
 *    its figures;
 *  - CHANGELOG.md [Unreleased]: the entry on the batch runs, against the runs at the defaults, including its
 *    workload, version, number of calls and the median call's peak.
 * Numbers are matched whole: no digit, comma or point beside them, so 118.80 does not satisfy 18.80. A count
 * stated with a count unit (GET-class, PUT-class, bytes, range, tail or pointer reads) that no run at the defaults
 * recorded is refused, a rounded one ("about 4,400 GET-class") included; a count kept beside a different unit is not
 * seen.
 *
 * THE LIBRARY'S DEFAULTS are not in a run's evidence when it passed nothing, so `DEFAULTS_BY_VERSION` below names them
 * for each release a run at the defaults installed; a run whose version it lacks fails until it is added (read the
 * defaults from that release's source, never from the repository head, which a later change may move).
 *
 * KNOWN LIMITS. It reads figures, not the sentences around them. Not held: bench/README.md (its batch row and its
 * memory sentence), site/benchmarks.html; the page's `128 sockets`; the rows' and the entry's prose about the run's
 * workload beyond the phrases listed above; the words "median" and "95th percentile" beside a figure (the sample
 * times are held in order, but a median quoted for the wrong sample time is not caught); the order words ("the first
 * run", "in the second") of the prose, which no longer force a sentence a third run could make false; any figure of
 * an earlier run that the page states and this file does not list. The stray-count checks accept a count any run at
 * the defaults recorded. A section on a run at another value is held to its own figures, but not by the stray-number
 * checks the defaults section has, so a mistyped or borrowed figure there is not caught.
 */
const ROOT = join(__dirname, '..', '..');
const evidenceLib = createRequire(import.meta.url)(
  join(ROOT, 'bench', 'lib', 'batch-evidence.cjs'),
) as { settingsOf: (run: unknown) => Record<string, number | null> };
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
    publishConcurrency?: number | null;
    concurrency?: number | null;
    maxBufferedBytes?: number | null;
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

/** The settings the library applies when a run passes nothing, by the release the run installed: `publishConcurrency` and `concurrency`. */
const DEFAULTS_BY_VERSION: Record<string, { publishConcurrency: number; concurrency: number }> = {
  '0.27.0': { publishConcurrency: 8, concurrency: 1 },
};

type Picked = Pick<Evidence, 'startedAt' | 'workload'>;
const settingsOf = (e: Picked): Record<string, number | null> => evidenceLib.settingsOf(e);
/** A run at the defaults passed no setting at all. */
const atDefaults = (e: Picked): boolean => Object.values(settingsOf(e)).every((v) => v === null);
/** The settings a run passed, as the page and the README name them: `publishConcurrency` 64. */
const passedPhrases = (e: Picked): string[] =>
  Object.entries(settingsOf(e))
    .filter(([, v]) => v !== null)
    .map(([k, v]) => `\`${k}\` ${v}`);
/**
 * Sort runs oldest first by when each started (a file name sorts same-day runs by their random suffix), and name the
 * latest run at the defaults, the defaults runs before it, and the runs at another value, each however new.
 */
function pickRuns<T extends Picked>(all: T[]): { runs: T[]; latest: T; earlier: T[]; others: T[] } {
  const runs = [...all].sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
  const defaults = runs.filter(atDefaults);
  return {
    runs,
    latest: defaults[defaults.length - 1]!,
    earlier: defaults.slice(0, -1),
    others: runs.filter((e) => !atDefaults(e)),
  };
}

const read = (f: string): Evidence => JSON.parse(readFileSync(join(DIR, f), 'utf8')) as Evidence;
const files = readdirSync(DIR).filter((f) => /^\d{4}-\d{2}-\d{2}-[0-9a-f]+\.json$/.test(f));
const { runs, latest, earlier, others } = pickRuns(files.map(read));
/** The runs at the defaults, oldest first: what the defaults section, and the entry on them, may state. */
const defaultRuns = [...earlier, latest];
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

const raw = readFileSync(join(ROOT, 'docs/benchmarks.md'), 'utf8');
const page = flat('docs/benchmarks.md');
const HEADING = '## Many outputs from one call — run';
/** The section of the benchmarks page headed with a run's id: its heading line and what follows to the next section. */
function sectionOf(e: { runId: string }): { heading: string; text: string } {
  const start = page.indexOf(`${HEADING} \`${e.runId}\``);
  if (start < 0) return { heading: '', text: '' };
  const end = page.indexOf(' ## ', start + 4);
  const text = page.slice(start, end < 0 ? undefined : end);
  // The heading is the one line of the raw page, so body text after it cannot satisfy a check on the heading.
  const at = raw.indexOf(`${HEADING} \`${e.runId}\``);
  const heading = raw.slice(at, raw.indexOf('\n', at) < 0 ? undefined : raw.indexOf('\n', at));
  return { heading, text };
}
const section = sectionOf(latest).text;

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
    `calls and their read-backs | ${fmt(b.requests.put)} | ${fmt(b.requests.get)} |`,
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
    for (const e of defaultRuns) {
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
    const k = known(defaultRuns).counts;
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
        // A run at another value names what it passed, so its row cannot be read as a run at the defaults.
        ...passedPhrases(e),
      ];
      if (e === latest) {
        need.push(
          fmt(b.p95ms),
          // The figures and their field names, not the words around them: a run whose mean is 6.4 must not need "about five".
          `\`medianMeanInFlight\` ${b.medianMeanInFlight.toFixed(2)}`,
          `${b.medianPeakInFlight} (\`medianPeakInFlight\`, **measured**)`,
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

  it("the changelog's entry on the batch runs holds the figures of the runs at the defaults", () => {
    const log = flat('CHANGELOG.md');
    const at = log.indexOf('**`store.materializeMany` is measured on S3, by the batch suite');
    expect(at, 'CHANGELOG.md has no entry on the batch runs').toBeGreaterThanOrEqual(0);
    const stop = log.indexOf(' - **', at + 4);
    const entry = log.slice(at, stop < 0 ? undefined : stop);
    const b = latest.phases.batch;
    const s = b.perSample[0]!;
    const need = [
      ...defaultRuns.map((e) => e.runId),
      `\`${latest.measured.packageVersion}\` packages`,
      `${fmt(latest.workload.outputs)} outputs over ${fmt(latest.workload.operands)} stored operands of ${fmt(latest.workload.idsPerOperand)} ids`,
      `published ${fmt(s.published)} outputs in ${s.groups} groups`,
      `${b.n} calls`,
      `${fmt(s.put)} PUT-class and ${fmt(s.get)} GET-class`,
      `${fmt(b.requests.put)} PUT-class and ${fmt(b.requests.get)} GET-class`,
      `$${latest.cost.totalUSD}`,
      `${fmt(b.p95ms)} ms`,
      b.medianOutputsPerSec.toFixed(2),
      ...defaultRuns.map((e) => `${fmt(e.phases.batch.p50ms)} ms`),
      ...defaultRuns.map((e) => e.phases.batch.medianMeanInFlight.toFixed(2)),
      `peaked at ${latest.phases.batch.medianPeakInFlight}`,
      `\`peakRssMB\` was ${range(defaultRuns.flatMap(rssOf))} MiB`,
      refreshFigures(),
    ];
    const missing = lacking(entry, need);
    expect(missing, `the CHANGELOG entry lacks: ${missing.join(' | ')}`).toEqual([]);
    const k = known(defaultRuns);
    const bad = [...stray(entry, ' ms\\b', k.ms), ...stray(entry, COUNT_UNITS, k.counts)];
    expect(bad, `the CHANGELOG entry states what no run recorded: ${bad.join(', ')}`).toEqual([]);
  });

  it("the defaults section states the library's defaults for the run's version, and no other publishConcurrency or concurrency", () => {
    const version = latest.measured.packageVersion;
    const d = DEFAULTS_BY_VERSION[version];
    expect(
      d,
      `DEFAULTS_BY_VERSION has no entry for ${version}: add its defaults from that release's source`,
    ).toBeDefined();
    const missing = lacking(section, [
      `\`publishConcurrency\` ${d!.publishConcurrency} and \`concurrency\` ${d!.concurrency}`,
    ]);
    expect(missing, `the defaults section must say: ${missing.join(' | ')}`).toEqual([]);
    const named = (key: string, want: number): string[] =>
      [...section.matchAll(new RegExp('`' + key + '` (\\d+)', 'g'))]
        .map((m) => m[1]!)
        .filter((n) => n !== String(want));
    const bad = [
      ...named('publishConcurrency', d!.publishConcurrency).map((n) => `publishConcurrency ${n}`),
      ...named('concurrency', d!.concurrency).map((n) => `concurrency ${n}`),
    ];
    expect(
      bad,
      `the defaults section names a setting that is not the default: ${bad.join(', ')}`,
    ).toEqual([]);
  });

  it('gives each run at another value a section of its own, headed with what it passed, that states its figures', () => {
    for (const e of others) {
      const own = sectionOf(e);
      expect(
        own.text,
        'docs/benchmarks.md has no section headed "' +
          `${HEADING} \`${e.runId}\` (${passedPhrases(e).join(', ')})"`,
      ).not.toBe('');
      const headed = lacking(own.heading, passedPhrases(e));
      expect(headed, `the heading of ${e.runId} must name: ${headed.join(' | ')}`).toEqual([]);
      const missing = lacking(own.text, figures(e));
      expect(missing, `the section of ${e.runId} lacks: ${missing.join(' | ')}`).toEqual([]);
    }
  });

  it('links to the defaults section only by the anchor of the latest run at the defaults', () => {
    const stale = new Set(defaultRuns.filter((e) => e !== latest).map((e) => e.runId));
    const where = [
      'README.md',
      'CHANGELOG.md',
      'bench/README.md',
      'bench/calibration/batch/README.md',
      'docs/ROADMAP.md',
      'docs/benchmarks.md',
      'docs/guide/loading.md',
    ];
    const bad: string[] = [];
    for (const rel of where) {
      const text = readFileSync(join(ROOT, rel), 'utf8');
      for (const m of text.matchAll(
        /many-outputs-from-one-call--run-(\d{4}-\d{2}-\d{2}-[0-9a-f]+)/g,
      )) {
        if (stale.has(m[1]!)) bad.push(`${rel} links ${m[1]}`);
      }
    }
    expect(
      bad,
      `links to a section that is no longer the defaults section: ${bad.join(', ')}`,
    ).toEqual([]);
    const readme = readFileSync(join(DIR, 'README.md'), 'utf8');
    expect(readme).toContain(`many-outputs-from-one-call--run-${latest.runId}`);
  });
});

describe('which run is the latest at the defaults', () => {
  const run = (
    runId: string,
    startedAt: string,
    call: Record<string, number | null | undefined> = {},
  ) => ({
    runId,
    startedAt,
    workload: {
      operands: 1,
      outputs: 1,
      idsPerOperand: 1,
      samples: 1,
      counts: { batch: { tail: 0, pointer: 0 } },
      ...call,
    },
  });
  const early = run('2026-11-03-aaaaa', '2026-11-03T10:00:00Z');
  const defaults = run('2026-11-08-bbbbb', '2026-11-08T10:00:00Z', {
    publishConcurrency: null,
    concurrency: null,
    maxBufferedBytes: null,
  });

  it('is the newest run that passed nothing, whatever a newer run at another value is', () => {
    const planted = run('2026-12-01-ccccc', '2026-12-01T10:00:00Z', { publishConcurrency: 64 });
    const picked = pickRuns([early, planted, defaults] as never[]) as unknown as {
      latest: { runId: string };
      earlier: { runId: string }[];
      others: { runId: string }[];
    };
    expect(picked.latest.runId).toBe('2026-11-08-bbbbb');
    expect(picked.earlier.map((e) => e.runId)).toEqual(['2026-11-03-aaaaa']);
    expect(picked.others.map((e) => e.runId)).toEqual(['2026-12-01-ccccc']);
  });

  it('reads a file with no settings as the defaults, and any one passed setting as another value', () => {
    expect(atDefaults(early as never)).toBe(true);
    expect(atDefaults(defaults as never)).toBe(true);
    for (const call of [
      { publishConcurrency: 64 },
      { concurrency: 2 },
      { maxBufferedBytes: 1_048_576 },
    ]) {
      expect(
        atDefaults(run('x', '2026-12-01T10:00:00Z', call) as never),
        JSON.stringify(call),
      ).toBe(false);
    }
  });

  it('moves to a newer run at the defaults, and a run that is not the newest by name is still ordered by when it started', () => {
    const newer = run('2026-11-09-aaaaa', '2026-11-09T10:00:00Z');
    const sameDay = run('2026-11-09-00000', '2026-11-09T08:00:00Z');
    const picked = pickRuns([newer, sameDay, defaults, early] as never[]) as unknown as {
      latest: { runId: string };
    };
    expect(picked.latest.runId).toBe('2026-11-09-aaaaa');
  });
});
