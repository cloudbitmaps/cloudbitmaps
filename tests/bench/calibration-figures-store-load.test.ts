import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// A run whose load stage timed `store.load()` records each load's own requests and every stage's, and the figures
// derivation prices each load from what that load made. The fixture is the harness's own output from a rehearsal
// against MinIO, which speaks S3's request shape and bills nothing; the tests dress it as a real run in memory and
// never as a file, so it can never be mistaken for evidence. It is captured again whenever the harness's evidence
// changes shape, and the first test below fails when it has gone stale. A second fixture is a rehearsal of the same
// workload with three faults injected (`CR_CALIBRATE_FAULT_GETS=1200,60000,75000`), which it discarded and ran again.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const require_ = createRequire(import.meta.url);

type Requests = {
  put: number;
  get: number;
  bytesUp: number;
  bytesDown: number;
  parts: number;
  reads: Record<'whole' | 'suffix' | 'range', { n: number; bytes: number }>;
};
type LoadRecord = {
  segment: string;
  kind: 'single' | 'multipart';
  put: number;
  get: number;
  parts: number;
  objectBytes: number;
  uploadBytes: number;
};
type Discarded = {
  of: string;
  sample: number;
  name: string;
  cause: string | null;
  code: string | null;
  attempts: number | null;
  httpStatus: number | null;
  message: string;
  failedAfterMs: number;
  requests: Requests;
};
type Run = {
  runId: string;
  mode: string;
  target: string;
  region: string;
  partial?: boolean;
  error?: unknown;
  leftovers?: string[];
  expectedMissed?: string[];
  discards?: {
    count: number;
    perRun: number;
    perStage: number;
    unfinished?: { stage: string; discarded: Discarded[] };
  };
  workload: { plan: { discards?: { perRun: number; perStage: number } } };
  projectedDiscards?: { put: number; get: number; costliestSample: number };
  network: { client: string; clientRegion: string | null };
  cost: {
    putUSD: number;
    getUSD: number;
    totalUSD: number;
    ops: {
      put: number;
      get: number;
      bytesDown: number;
      byCommand: Record<string, number>;
      reads: Record<'whole' | 'suffix' | 'range', { n: number; bytes: number }>;
    };
  };
  phases: {
    load: { via: string; perLoad: LoadRecord[]; requests: Requests; expectedGets: number };
    intersect: { requests: Requests; runs: number };
    warm: { warmGets: number };
    andNot: { requests: Requests; expectedGets: number };
    [stage: string]: unknown;
  };
  projectedStages: Record<string, { put: number; get: number }>;
};
type Figures = {
  remote: boolean;
  measuredGets: number;
  chunksPerOperand: number;
  payloadFraction: number;
  latency: { p50: number };
  usd: { run: number; singleLoad: number; multipartLoad: number };
  discards: { count: number; byStage: Record<string, number>; get: number };
  loadVia: string | null;
  getsPerLoad: number;
  getsPerMultipart: number;
  putsPerSingle: number;
  putsPerMultipart: number;
  partsPerMultipart: number;
  loads: number;
  ledger: {
    pointerReads: number;
    loadPointerReads: number;
    chunkReads: number;
    tailReads: number;
    get: number;
  };
  meanPointerReads: number;
  shapes: Array<[number, number]>;
  anchors: Array<[string, string]>;
  rows: Array<{ requests: string; label: string; says: RegExp }>;
  stageLedger: Record<
    string,
    { put: number; get: number; keptGet: number; discarded: number; expectedGets: number | null }
  >;
  values: unknown;
};
const figures = require_(join(ROOT, 'bench', 'lib', 'calibration-figures.cjs')) as {
  readSources: (root: string) => unknown;
  derive: (run: Run, src: unknown) => Figures;
  unaccounted: (text: string, values: unknown) => string[];
};
const { STAGES } = require_(join(ROOT, 'bench', 'lib', 'calibrate-stages.cjs')) as {
  STAGES: string[];
};

const SOURCES = figures.readSources(ROOT);
const fixture = JSON.parse(
  readFileSync(join(ROOT, 'tests', 'bench', 'fixtures', 'calibration-rehearsal.json'), 'utf8'),
) as Run;
const withFaults = JSON.parse(
  readFileSync(
    join(ROOT, 'tests', 'bench', 'fixtures', 'calibration-rehearsal-discards.json'),
    'utf8',
  ),
) as Run & { injectedFaults?: Array<{ getObject: number; as: string }> };
/** The rehearsal, dressed as a finished real run: only what a real run's file says about itself is changed. */
const asRealRun = (from: Run = fixture): Run => ({
  ...structuredClone(from),
  mode: 'run',
  target: 'aws',
});
const GET_USD = 0.4 / 1e6;

describe('a run that timed store.load()', () => {
  it('is a rehearsal the harness wrote, with every stage the harness runs recorded', () => {
    expect(fixture.target).toMatch(/rehearsal/);
    expect(fixture.mode).toBe('rehearse');
    expect(
      Object.keys(fixture.phases).sort(),
      're-capture the fixture: the stages changed',
    ).toEqual([...STAGES].sort());
    expect(Object.keys(fixture.projectedStages)).toEqual(STAGES);
    expect(fixture.phases.load.via).toBe('store.load()');
    expect(fixture.phases.load.perLoad.length).toBeGreaterThan(0);
    // Each stage's discards, none in this run, and the run's count of them and the projection's allowance.
    for (const name of STAGES) {
      expect((fixture.phases[name] as { discarded?: unknown }).discarded, name).toEqual([]);
    }
    expect(fixture.discards).toEqual({ count: 0, perRun: 3, perStage: 2 });
    expect((fixture as { projectedDiscards?: unknown }).projectedDiscards).toEqual({
      put: 0,
      get: 12_018,
      costliestSample: 4_006,
    });
  });

  // The harness's own output from a run that met three transient faults, in three kinds of sample. Dressed as a real
  // run it is evidence: each stage held to what it kept, the bill to every request, and its discards stated.
  it("is evidence from a rehearsal that discarded three samples, and its figures are the fault-free run's", () => {
    expect(withFaults.injectedFaults).toEqual([
      { getObject: 56, as: 'reset' },
      { getObject: 1_740, as: 'reset' },
      { getObject: 4_769, as: 'reset' },
    ]);
    expect(withFaults.discards).toEqual({ count: 3, perRun: 3, perStage: 2 });
    const clean = figures.derive(asRealRun(), SOURCES);
    const f = figures.derive(asRealRun(withFaults), SOURCES);
    expect(f.discards.count).toBe(3);
    expect(f.discards.byStage).toMatchObject({ intersect: 1, pointReads: 1, andNot: 1, sweep: 0 });
    expect(f.anchors).toContainEqual([
      'samples discarded after a transient fault',
      '3 discarded samples',
    ]);
    for (const name of ['intersect', 'pointReads', 'andNot']) {
      const d = (withFaults.phases[name] as { discarded: Discarded[] }).discarded;
      expect(d, name).toHaveLength(1);
      expect(d[0], name).toMatchObject({
        name: 'TransientError',
        cause: 'TimeoutError',
        code: 'ECONNRESET',
        attempts: 1,
      });
      // The stage billed its discard, and kept exactly what the fault-free run made.
      expect(f.stageLedger[name]?.get).toBe(
        (clean.stageLedger[name]?.get ?? 0) + (d[0]?.requests.get ?? 0),
      );
      expect(f.stageLedger[name]?.keptGet).toBe(clean.stageLedger[name]?.get);
    }
    expect(f.measuredGets).toBe(clean.measuredGets);
    expect(f.chunksPerOperand).toBe(clean.chunksPerOperand);
    expect(f.ledger.chunkReads).toBe(clean.ledger.chunkReads);
    expect(f.ledger.get).toBe(clean.ledger.get + f.discards.get);
  });

  it('is derived, each load priced from the requests it made', () => {
    const f = figures.derive(asRealRun(), SOURCES);
    expect(f.loadVia).toBe('store.load()');
    // A first load of a segment: the object and the pointer, no listing since it has nothing to collect; three pointer
    // reads and the check of its generation number. A multipart object is a create, its parts and a complete in
    // place of the one PUT.
    expect(f.putsPerSingle).toBe(2);
    expect(f.getsPerLoad).toBe(3);
    expect(f.partsPerMultipart).toBe(2);
    expect(f.putsPerMultipart).toBe(5);
    expect(f.getsPerMultipart).toBe(3);
    expect(f.usd.singleLoad).toBeCloseTo(2 * 5e-6 + 3 * GET_USD, 12);
    expect(f.usd.multipartLoad).toBeCloseTo(5 * 5e-6 + 3 * GET_USD, 12);
    expect(f.loads).toBe(fixture.phases.load.perLoad.length);
  });

  // The price follows the load's own count. A derivation that priced from a table, or from the run's totals divided
  // across its loads, would not move when a load made more requests; here every first load reads the pointer twice
  // more, and the evidence is kept consistent, so only the price can tell.
  it('prices a load from its own record: two more reads in every single-part load move its price by two GETs', () => {
    const run = asRealRun();
    const singles = run.phases.load.perLoad.filter((l) => l.kind === 'single');
    const extra = 2 * singles.length;
    for (const l of singles) l.get += 2;
    run.phases.load.requests.get += extra;
    run.phases.load.expectedGets += extra;
    run.cost.ops.get += extra;
    run.cost.ops.byCommand.GetObjectCommand =
      (run.cost.ops.byCommand.GetObjectCommand ?? 0) + extra;
    run.cost.getUSD = (run.cost.ops.get * 0.4) / 1e6;
    run.cost.totalUSD = run.cost.putUSD + run.cost.getUSD;
    const base = figures.derive(asRealRun(), SOURCES);
    const more = figures.derive(run, SOURCES);
    expect(more.getsPerLoad).toBe(base.getsPerLoad + 2);
    expect(more.usd.singleLoad - base.usd.singleLoad).toBeCloseTo(2 * GET_USD, 12);
    // A multipart load's price did not move.
    expect(more.usd.multipartLoad).toBeCloseTo(base.usd.multipartLoad, 12);
  });

  // The loads read pointers through the same requests an intersect does, and a load's own pointer reads that come
  // back are filed with them. The intersect's pointer reads are the ones its own stage recorded.
  it("counts the intersects' pointer reads from their own stage, not from the run's totals", () => {
    const run = asRealRun();
    const f = figures.derive(run, SOURCES);
    const own = run.phases.intersect.requests.reads.whole.n;
    expect(f.ledger.pointerReads).toBe(own);
    expect(own).toBe(2 * run.phases.intersect.runs);
    expect(f.meanPointerReads).toBe(2);
    // The run's totals hold more, since loads and every other stage read pointers too.
    expect(run.cost.ops.reads.whole.n).toBeGreaterThan(own);
    // The loads' own reads are their records', not the remainder of a total.
    expect(f.ledger.loadPointerReads).toBe(run.phases.load.requests.get);
  });

  it('states store.load() as what the run measured, and no write and publish', () => {
    const f = figures.derive(asRealRun(), SOURCES);
    expect(f.anchors.map(([what]) => what).join('\n')).not.toMatch(
      /write and publish|write-and-publish/,
    );
    expect(f.anchors.map(([what]) => what).join('\n')).toMatch(/store\.load\(\)/);
    expect(f.rows.every((r) => r.label === 'derived' || r.label === 'expected')).toBe(true);
    // The table's load rows are measured counts times prices, labelled derived, and none is called expected.
    const loadRows = f.rows.filter((r) => /store\.load|single-part|multipart/.test(String(r.says)));
    expect(loadRows.length).toBe(2);
    expect(loadRows.every((r) => r.label === 'derived')).toBe(true);
    expect(f.shapes).toContainEqual([2, 3]);
    expect(f.shapes).toContainEqual([5, 3]);
    expect(f.stageLedger.warm?.get).toBe(f.stageLedger.warm?.expectedGets);
  });

  describe('is refused when it does not reconcile', () => {
    const refused = (mutate: (r: Run) => void): string => {
      const run = asRealRun();
      mutate(run);
      try {
        figures.derive(run, SOURCES);
      } catch (err) {
        return (err as Error).message;
      }
      return '';
    };

    it('with a stage unrecorded, or its requests', () => {
      expect(
        refused((r) => {
          delete (r.phases as Record<string, unknown>).spread;
        }),
      ).toMatch(/records no requests for its spread stage/);
      expect(
        refused((r) => {
          r.phases.load.perLoad = [];
        }),
      ).toMatch(/no per-load requests/);
    });

    it("with a load's record that is not what a load makes, or a stage's requests that do not add up", () => {
      expect(
        refused((r) => {
          const l = r.phases.load.perLoad[0];
          if (l !== undefined) l.put = 3; // a listing: not what a load of a new segment makes
        }),
      ).toMatch(/not an object and a pointer write|do not add up to its load stage/);
      expect(
        refused((r) => {
          r.phases.load.requests.get += 1;
        }),
      ).toMatch(/do not add up/);
    });

    it('with a load that read the pointer fewer times than a first load must, or a listing no first load makes', () => {
      // A first load reads twice and checks once: a record of two requests names one read too few.
      expect(
        refused((r) => {
          const l = r.phases.load.perLoad[0];
          if (l !== undefined) l.get = 2;
        }),
      ).toMatch(/at least two pointer reads and a check/);
      // The run's own command tally, which the loads' records must agree with: a listing is a command a first load
      // never sends.
      expect(
        refused((r) => {
          r.cost.ops.byCommand.ListObjectsV2Command =
            (r.cost.ops.byCommand.ListObjectsV2Command ?? 0) + 1;
        }),
      ).toMatch(/the object or its parts and the pointer, and a listing only in a steady load/);
    });

    it('with requests no stage accounts for, or fewer than it billed', () => {
      expect(
        refused((r) => {
          r.cost.ops.get += 1;
          r.cost.ops.byCommand.GetObjectCommand = (r.cost.ops.byCommand.GetObjectCommand ?? 0) + 1;
          r.cost.getUSD = (r.cost.ops.get * 0.4) / 1e6;
          r.cost.totalUSD = r.cost.putUSD + r.cost.getUSD;
        }),
      ).toMatch(/stages' requests and the bucket's own do not add up/);
    });

    it('with a warm intersect that made a request', () => {
      expect(
        refused((r) => {
          r.phases.warm.warmGets = 1;
        }),
      ).toMatch(/warm intersects are not recorded as exact and at no requests/);
    });

    it('with a load stage that timed something other than store.load()', () => {
      expect(
        refused((r) => {
          r.phases.load.via = 'something else';
        }),
      ).toMatch(/does not price/);
    });

    // What the run itself reports as wrong is refused, not read past: it is evidence of a run that did not go the way
    // the stage table says, however well its ledger reconciles.
    it('with anything teardown left behind', () => {
      expect(
        refused((r) => {
          r.leftovers = ['a bucket teardown could not remove'];
        }),
      ).toMatch(/teardown left 1 resource behind/);
    });

    it('with an expected count it missed', () => {
      expect(
        refused((r) => {
          r.expectedMissed = ['pointReads has() first read: 3001 GET-class, expected 3000'];
        }),
      ).toMatch(/it missed an expected count: pointReads has\(\) first read/);
    });

    it('with a stage whose requests are not the ones it expected', () => {
      expect(
        refused((r) => {
          r.phases.andNot.expectedGets += 1;
        }),
      ).toMatch(/its andNot stage made 330 GET-class requests, not the 331 it expected/);
    });

    it('with a stage that records no expected count', () => {
      expect(
        refused((r) => {
          delete (r.phases.andNot as { expectedGets?: number }).expectedGets;
        }),
      ).toMatch(/it records no expected count for its andNot stage$/);
    });

    it('and says every one of them at once, beside a ledger that does not add up', () => {
      const message = refused((r) => {
        r.leftovers = ['a bucket teardown could not remove'];
        r.expectedMissed = ['pointReads has() first read: 3001 GET-class, expected 3000'];
        r.phases.andNot.expectedGets += 1;
        r.region = 'us-east-1';
        r.network.clientRegion = 'us-west-2';
        r.cost.ops.get += 1;
        r.cost.ops.byCommand.GetObjectCommand = (r.cost.ops.byCommand.GetObjectCommand ?? 0) + 1;
        r.cost.getUSD = (r.cost.ops.get * 0.4) / 1e6;
        r.cost.totalUSD = r.cost.putUSD + r.cost.getUSD;
      });
      for (const says of [
        /stages' requests and the bucket's own do not add up/,
        /teardown left 1 resource behind/,
        /it missed an expected count/,
        /its andNot stage made 330 GET-class requests, not the 331 it expected/,
        /it ran from us-west-2, not the bucket's us-east-1/,
      ]) {
        expect(message).toMatch(says);
      }
    });

    it("from a shell in a region other than the bucket's", () => {
      expect(
        refused((r) => {
          r.region = 'us-east-1';
          r.network.clientRegion = 'us-west-2';
        }),
      ).toMatch(/it ran from us-west-2, not the bucket's us-east-1/);
    });

    it('and a run that lists no upload for a load is refused too', () => {
      expect(
        refused((r) => {
          const l = r.phases.load.perLoad[0];
          if (l !== undefined) l.uploadBytes += 1;
        }),
      ).toMatch(/recorded uploads/);
    });
  });
});

// A round-trip floor under 30 ms keeps another continent out, not a neighbouring region, so latency is labelled
// in-region only when the shell's own region is proven to be the bucket's.
describe("a run's latency is in-region", () => {
  const inRegion = (client: string, clientRegion: string | null): boolean => {
    const run = asRealRun();
    run.region = 'us-east-1';
    run.network.client = client;
    run.network.clientRegion = clientRegion;
    return !figures.derive(run, SOURCES).remote;
  };
  it("only when its floor is under the line and its shell's region is the bucket's", () => {
    expect(inRegion('in-region', 'us-east-1')).toBe(true);
    expect(inRegion('in-region', null)).toBe(false);
    expect(inRegion('REMOTE — latency below is network-dominated', 'us-east-1')).toBe(false);
    expect(figures.derive(asRealRun(), SOURCES).remote).toBe(true);
  });
});

/**
 * A sample the harness discarded after a transient fault, as it records one: a read that stopped short, having read
 * some pointers, tails and chunks, and one request that failed and read nothing.
 */
const discard = (
  of: string,
  sample: number,
  n: { whole: number; suffix: number; range: number },
): Discarded => {
  const reads = {
    whole: { n: n.whole, bytes: 161 * n.whole },
    suffix: { n: n.suffix, bytes: 262_144 * n.suffix },
    range: { n: n.range, bytes: 516 * n.range },
  };
  return {
    of,
    sample,
    name: 'TransientError',
    cause: 'TimeoutError',
    code: 'ECONNRESET',
    attempts: 1,
    httpStatus: null,
    message: 'transient S3 fault: TimeoutError',
    failedAfterMs: 812.5,
    requests: {
      put: 0,
      get: n.whole + n.suffix + n.range + 1,
      bytesUp: 0,
      bytesDown: reads.whole.bytes + reads.suffix.bytes + reads.range.bytes,
      parts: 0,
      reads,
    },
  };
};
const IN_INTERSECT = (): Discarded =>
  discard('calibration-layout cold intersect', 17, { whole: 2, suffix: 2, range: 115 });
const IN_ANDNOT = (): Discarded =>
  discard('andNot call', 4, { whole: 11, suffix: 11, range: 1_177 });

/**
 * `run` as the harness writes one that discarded each sample in its stage: billed, in the stage's requests and the
 * run's, recorded beside the stage, and counted. `record: false` bills them and records nothing, as a harness that lost
 * track of a discard would.
 */
function withDiscards(
  run: Run,
  discards: Array<[string, Discarded]>,
  { record = true, perRun = 3, perStage = 2 } = {},
): Run {
  const ops = run.cost.ops;
  for (const [stage, d] of discards) {
    const phase = run.phases[stage] as { requests: Requests; discarded?: Discarded[] };
    const r = d.requests;
    phase.requests.get += r.get;
    phase.requests.bytesDown += r.bytesDown;
    ops.get += r.get;
    ops.bytesDown += r.bytesDown;
    ops.byCommand.GetObjectCommand = (ops.byCommand.GetObjectCommand ?? 0) + r.get;
    for (const shape of ['whole', 'suffix', 'range'] as const) {
      phase.requests.reads[shape].n += r.reads[shape].n;
      phase.requests.reads[shape].bytes += r.reads[shape].bytes;
      ops.reads[shape].n += r.reads[shape].n;
      ops.reads[shape].bytes += r.reads[shape].bytes;
    }
    if (record) (phase.discarded ??= []).push(d);
  }
  run.cost.getUSD = (ops.get * 0.4) / 1e6;
  run.cost.totalUSD = run.cost.putUSD + run.cost.getUSD;
  run.discards = { count: record ? discards.length : 0, perRun, perStage };
  return run;
}

// A sample that met a transient fault was discarded whole and run again: its requests were billed and are in its
// stage's, and every figure is derived from the samples the stage kept.
describe('a run that discarded a sample after a transient fault', () => {
  const refused = (run: Run): string => {
    try {
      figures.derive(run, SOURCES);
    } catch (err) {
      return (err as Error).message;
    }
    return '';
  };
  const both = (): Array<[string, Discarded]> => [
    ['intersect', IN_INTERSECT()],
    ['andNot', IN_ANDNOT()],
  ];

  it("is evidence within its bounds, its figures the kept samples' and its discards stated beside them", () => {
    const base = figures.derive(asRealRun(), SOURCES);
    const f = figures.derive(withDiscards(asRealRun(), both()), SOURCES);
    expect(f.discards).toMatchObject({ count: 2, get: 120 + 1_200 });
    expect(f.discards.byStage).toMatchObject({ intersect: 1, andNot: 1, load: 0 });
    expect(f.anchors).toContainEqual([
      'samples discarded after a transient fault',
      '2 discarded samples',
    ]);
    expect(base.discards.count).toBe(0);
    expect(base.anchors.map(([what]) => what)).not.toContain(
      'samples discarded after a transient fault',
    );
    // Every figure about the reads is what the kept samples made, as in a run that met no fault.
    expect(f.measuredGets).toBe(base.measuredGets);
    expect(f.chunksPerOperand).toBe(base.chunksPerOperand);
    expect(f.payloadFraction).toBe(base.payloadFraction);
    expect(f.latency.p50).toBe(base.latency.p50);
    expect(f.ledger.chunkReads).toBe(base.ledger.chunkReads);
    expect(f.ledger.tailReads).toBe(base.ledger.tailReads);
    expect(f.ledger.pointerReads).toBe(base.ledger.pointerReads);
    // The bill is what was billed, discards and all.
    expect(f.ledger.get).toBe(base.ledger.get + 1_320);
    expect(f.usd.run - base.usd.run).toBeCloseTo(1_320 * GET_USD, 12);
    expect(f.stageLedger.intersect).toMatchObject({
      get: (base.stageLedger.intersect?.get ?? 0) + 120,
      keptGet: base.stageLedger.intersect?.expectedGets,
      discarded: 1,
    });
    expect(f.stageLedger.spread?.discarded).toBe(0);
  });

  // The same discard, billed both times: recorded, the stage is held to what it kept; lost track of, it made more than
  // it expected.
  it('is accepted with its discard recorded, and refused with the same discard billed and not recorded', () => {
    expect(refused(withDiscards(asRealRun(), [['intersect', IN_INTERSECT()]]))).toBe('');
    expect(
      refused(withDiscards(asRealRun(), [['intersect', IN_INTERSECT()]], { record: false })),
    ).toMatch(/its intersect stage made 360 GET-class requests, not the 240 it expected/);
  });

  it('is refused past its bounds: a fourth discard in a run, a third in a stage', () => {
    const four: Array<[string, Discarded]> = [
      ['intersect', IN_INTERSECT()],
      ['spread', discard('spread-layout cold intersect', 3, { whole: 2, suffix: 2, range: 9 })],
      ['sweep', discard('sweep k = 1000 cold intersect', 1, { whole: 2, suffix: 2, range: 40 })],
      ['andNot', IN_ANDNOT()],
    ];
    expect(refused(withDiscards(asRealRun(), four))).toMatch(
      /it discarded more samples than the harness allows \(3 a run, 2 a stage\)/,
    );
    // A file that states looser bounds of its own, in its count and in its plan alike, is held to the harness's.
    const loose = withDiscards(asRealRun(), four, { perRun: 4 });
    if (loose.workload.plan.discards !== undefined) loose.workload.plan.discards.perRun = 4;
    expect(refused(loose)).toMatch(/more samples than the harness allows/);
    expect(refused(loose)).toMatch(
      /its bounds on discards \(4 a run, 2 a stage, and its plan's 4 and 2\) are not the harness's \(3 a run, 2 a stage\)/,
    );
    const three: Array<[string, Discarded]> = [0, 1, 2].map((i) => [
      'intersect',
      discard('calibration-layout cold intersect', i, { whole: 2, suffix: 2, range: 7 }),
    ]);
    expect(refused(withDiscards(asRealRun(), three))).toMatch(
      /more samples than the harness allows/,
    );
  });

  // Each bound on its own: the file's and its plan's, a run's and a stage's. A file that differs from the harness in any
  // one of them is refused, whatever the others say.
  it("is refused when any one of its four bounds on discards is not the harness's", () => {
    for (const [what, loosen] of [
      ["the file's bound a run", (r: Run) => r.discards !== undefined && (r.discards.perRun = 4)],
      [
        "the file's bound a stage",
        (r: Run) => r.discards !== undefined && (r.discards.perStage = 3),
      ],
      [
        "the plan's bound a run",
        (r: Run) => r.workload.plan.discards !== undefined && (r.workload.plan.discards.perRun = 4),
      ],
      [
        "the plan's bound a stage",
        (r: Run) =>
          r.workload.plan.discards !== undefined && (r.workload.plan.discards.perStage = 3),
      ],
    ] as const) {
      const run = withDiscards(asRealRun(), both());
      expect(refused(run), what).toBe('');
      loosen(run);
      expect(refused(run), what).toMatch(/its bounds on discards .* are not the harness's/);
    }
  });

  // The allowance is what the projection held the run to: three samples at the costliest one its plan makes.
  it('is refused when its allowance for discards is not three samples at the costliest its plan makes', () => {
    expect(refused(withDiscards(asRealRun(), both()))).toBe('');
    for (const edit of [
      (a: { put: number; get: number; costliestSample: number }) => (a.get = 1),
      (a: { put: number; get: number; costliestSample: number }) => (a.costliestSample = 206),
      (a: { put: number; get: number; costliestSample: number }) => (a.put = 1),
    ]) {
      const run = withDiscards(asRealRun(), both());
      if (run.projectedDiscards !== undefined) edit(run.projectedDiscards);
      expect(refused(run)).toMatch(
        /its allowance for discards .* is not 3 samples at the costliest its plan makes \(4006\)/,
      );
    }
  });

  // The same discards: in a run that finished, evidence; in one a fault past the bound stopped, not.
  it('is accepted when it finished, and refused when it did not, as a run past its bounds does not', () => {
    expect(refused(withDiscards(asRealRun(), both()))).toBe('');
    const run = withDiscards(asRealRun(), both());
    run.partial = true;
    run.error = {
      name: 'DiscardBoundExceeded',
      cause: 'TimeoutError',
      code: 'ECONNRESET',
      attempts: 1,
      httpStatus: null,
      message: 'andNot: andNot call 5 met a transient fault (transient S3 fault: TimeoutError) …',
    };
    expect(refused(run)).toMatch(/the run did not finish/);
  });

  it("is refused when its count of discards is not its stages'", () => {
    const miscounted = withDiscards(asRealRun(), both());
    if (miscounted.discards !== undefined) miscounted.discards.count = 1;
    expect(refused(miscounted)).toMatch(
      /its stages record 2 discarded samples, not the 1 it counted/,
    );
    const cutShort = withDiscards(asRealRun(), both());
    if (cutShort.discards !== undefined) {
      cutShort.discards.unfinished = { stage: 'andNot', discarded: [IN_ANDNOT()] };
    }
    // The counts agree; what is wrong is the stage cut short, and the refusal says so.
    expect(refused(cutShort)).toMatch(
      /it records a stage cut short \(andNot\), which a run that finished has none of/,
    );
    expect(refused(cutShort)).not.toMatch(/discarded samples, not the/);
  });

  // A report's numbers are read back against the run. A discard's request count is small and could equal any other
  // GET figure, so it passes only beside a word for a discard; and a stated count of discards has to be the run's.
  it("lets a report state a discard's requests only as a discard's, and its count of discards only as the run's", () => {
    const f = figures.derive(withDiscards(asRealRun(), both()), SOURCES);
    expect(
      figures.unaccounted('The discarded sample made 120 GETs before it failed.', f.values),
    ).toEqual([]);
    expect(figures.unaccounted('The median cold intersect made 120 GETs.', f.values)).toEqual([
      '120 GETs',
    ]);
    expect(figures.unaccounted('The run has 2 discarded samples, 1 in andNot.', f.values)).toEqual(
      [],
    );
    expect(figures.unaccounted('The run has 5 discarded samples.', f.values)).toEqual([
      '5 discarded samples',
    ]);
  });

  it('is refused for a discarded load, or a discard that wrote', () => {
    const load = withDiscards(asRealRun(), [
      ['load', discard('load', 0, { whole: 3, suffix: 0, range: 0 })],
    ]);
    expect(refused(load)).toMatch(/its load stage discarded a load/);
    const wrote = withDiscards(asRealRun(), [['intersect', IN_INTERSECT()]]);
    const d = (wrote.phases.intersect as { discarded?: Discarded[] }).discarded?.[0];
    if (d !== undefined) d.requests.put = 1;
    expect(refused(wrote)).toMatch(
      /its intersect stage records a discard that is not a read sample/,
    );
  });
});

describe('a run of the engine that reads chunks as ranges', () => {
  const refused = (run: Run): string => {
    try {
      figures.derive(run, SOURCES);
    } catch (err) {
      return (err as Error).message;
    }
    return '';
  };
  /** The fixture's intersect stage as the harness now records it: the requests made of each operand, not its chunks. */
  const asRanged = (rangesPerOperand: number): Run => {
    const run = asRealRun();
    const it = run.phases.intersect as Record<string, unknown>;
    delete it.chunksFetchedPerOperand;
    it.rangesPerOperand = rangesPerOperand;
    return run;
  };
  const chunks = (fixture.phases.intersect as unknown as { rangesPerOperand: number })
    .rangesPerOperand;

  it('is accepted when its range requests are what the ledger counted, however many chunks they held', () => {
    expect(() => figures.derive(asRanged(chunks), SOURCES)).not.toThrow();
  });

  it('is refused when its range requests are not what the ledger counted, or are none, or exceed the chunks it needed', () => {
    expect(refused(asRanged(chunks - 1))).toMatch(/chunk range requests .* are not between 1 and/);
    expect(refused(asRanged(0))).toMatch(/chunk range requests/);
    expect(refused(asRanged(chunks + 1))).toMatch(/chunk range requests/);
  });

  it('keeps holding a file from the engine before to one request for every chunk', () => {
    const before = asRealRun();
    const it = before.phases.intersect as unknown as Record<string, unknown>;
    delete it.rangesPerOperand;
    it.chunksFetchedPerOperand = 100; // one request for each of the layout's shared chunks
    expect(refused(before)).toMatch(/chunk reads .* are not/);
  });
});

// The steady-load stage: one segment loaded again and again at a keep that makes its loads collect by name. A run's
// figures state each kind's requests, and a run whose loads made other requests than their kind's is refused: an engine
// that lists on every load is such a run.
describe('a run with a steady-load stage', () => {
  type SteadyLoad = {
    kind: string;
    generation: number;
    put: number;
    get: number;
    free: number;
    uploadBytes: number;
  };
  type Steady = { keep: number; loads: number; perLoad: SteadyLoad[]; requests: Requests };
  type Measured = { measured: { packageVersion: string } };
  const versioned = (r: Run, packageVersion: string): void => {
    const m = r as unknown as Measured;
    m.measured = { ...m.measured, packageVersion };
  };
  const steadyOf = (run: Run): Steady => run.phases.steadyLoad as unknown as Steady;
  const stable = require_(join(ROOT, 'bench', 'lib', 'calibrate-stages.cjs')) as {
    STEADY_LOAD_REQUESTS: Record<string, { put: number; get: number; free: number }>;
  };
  const refused = (mutate: (r: Run) => void): string => {
    const run = asRealRun();
    mutate(run);
    try {
      figures.derive(run, SOURCES);
    } catch (err) {
      return (err as Error).message;
    }
    return '';
  };
  const stageFigures = figures as unknown as {
    derive: (
      r: Run,
      s: unknown,
    ) => {
      steadyLoad: {
        keep: number;
        loads: number;
        byKind: Record<string, { put: number; get: number; free: number; perMillion: number }>;
        averageUSD: number | null;
      } | null;
    };
    stagesOf: (r: Run) => string[];
  };

  it('is the fixture the harness wrote, with 18 loads in the kinds its generations make', () => {
    const s = steadyOf(fixture);
    expect(s.perLoad.map((l) => l.kind)).toEqual([
      'first',
      ...Array(12).fill('reload'),
      'byName',
      'byName',
      'byName',
      'listing',
      'byName',
    ]);
    expect(s.keep).toBe(12);
  });

  it('states each kind of load from the requests it made, priced, and the average over the listing cadence', () => {
    const f = stageFigures.derive(asRealRun(), SOURCES).steadyLoad;
    expect(f?.loads).toBe(18);
    expect(f?.byKind.byName).toMatchObject({ put: 2, get: 4, free: 1 });
    expect(f?.byKind.listing).toMatchObject({ put: 3, get: 5, free: 1 });
    expect(f?.byKind.reload).toMatchObject({ put: 2, get: 2, free: 0 });
    expect(f?.byKind.first).toMatchObject({ put: 2, get: 3, free: 0 });
    expect(f?.byKind.byName?.perMillion).toBeCloseTo(1e6 * (2 * 5e-6 + 4 * GET_USD), 6);
    // One listing in sixteen loads, the rest by name.
    expect(f?.averageUSD).toBeCloseTo(
      (15 * (2 * 5e-6 + 4 * GET_USD) + (3 * 5e-6 + 5 * GET_USD)) / 16,
      12,
    );
  });

  it('is held to the stage on a release that collects by name, and every committed run still derives without it', () => {
    const named = asRealRun();
    delete (named.phases as Record<string, unknown>).steadyLoad;
    // Of an earlier release, it is not asked for; of 0.17.0 on, it is.
    versioned(named, '0.16.0');
    expect(stageFigures.stagesOf(named)).not.toContain('steadyLoad');
    versioned(named, '0.17.0');
    expect(stageFigures.stagesOf(named)).toContain('steadyLoad');
    expect(
      refused((r) => {
        delete (r.phases as Record<string, unknown>).steadyLoad;
        versioned(r, '0.17.0');
      }),
    ).toMatch(/it records no requests for its steadyLoad stage/);
    // The committed evidence predates the stage: derived as before, with no steady figure.
    const lib = figures as unknown as {
      evidenceFiles: (root: string) => string[];
    };
    const files = lib.evidenceFiles(ROOT);
    expect(files.length).toBeGreaterThan(0);
    for (const rel of files) {
      const run = JSON.parse(readFileSync(join(ROOT, rel), 'utf8')) as Run;
      expect(run.phases.steadyLoad, rel).toBeUndefined();
      expect(() => stageFigures.derive(run, SOURCES), rel).not.toThrow();
      expect(stageFigures.derive(run, SOURCES).steadyLoad, rel).toBeNull();
    }
  });

  // An engine that lists on every load, or keeps its window by listing, makes a by-name load a listing's requests.
  it('refuses a run whose loads made other requests than their kind: an engine that lists every load', () => {
    const message = refused((r) => {
      const s = steadyOf(r);
      for (const l of s.perLoad.filter((x) => x.kind === 'byName')) {
        l.put += 1; // the listing
        l.get += 1; // the pointer read around it
        s.requests.put += 1;
        s.requests.get += 1;
      }
    });
    expect(message).toMatch(
      /its steady load 13 \(byName\) made 3 PUT-class, 5 GET-class and 1 deletes, not the 2, 4 and 1 of a byName load/,
    );
  });

  it('refuses a steady stage of other loads or another window than the harness runs, one that discarded, and records that do not add up', () => {
    expect(
      refused((r) => {
        steadyOf(r).keep = 1;
      }),
    ).toMatch(/its steady stage ran 18 loads at keep 1, not the harness's 18 at 12/);
    expect(
      refused((r) => {
        steadyOf(r).perLoad.pop();
      }),
    ).toMatch(/its steady stage ran 17 loads/);
    expect(
      refused((r) => {
        steadyOf(r).requests.get += 1;
      }),
    ).toMatch(/steady loads' own requests do not add up to its steady stage's/);
    expect(
      refused((r) => {
        const l = steadyOf(r).perLoad[5];
        if (l !== undefined) l.kind = 'byName';
      }),
    ).toMatch(/its steady load 5 \(byName\)/);
  });

  it('holds a steady listing to the PUT-class ledger: a listing the meter did not count is refused', () => {
    expect(
      refused((r) => {
        r.cost.ops.byCommand.ListObjectsV2Command = 0;
        r.cost.ops.byCommand.PutObjectCommand = (r.cost.ops.byCommand.PutObjectCommand ?? 0) + 1;
      }),
    ).toMatch(/its PUT-class commands are not what its loads make/);
  });

  it('names a steady load that did not stay in the table, in the table the harness holds', () => {
    expect(stable.STEADY_LOAD_REQUESTS.byName).toEqual({ put: 2, get: 4, free: 1 });
  });
});
