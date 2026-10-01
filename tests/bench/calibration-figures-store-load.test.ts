import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// A run whose load stage timed `store.load()` records each load's own requests and every stage's, and the figures
// derivation prices each load from what that load made. The fixture is the harness's own output from a rehearsal
// against MinIO, which speaks S3's request shape and bills nothing; the tests dress it as a real run in memory and
// never as a file, so it can never be mistaken for evidence. It is captured again whenever the harness's evidence
// changes shape, and the first test below fails when it has gone stale.
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
type Run = {
  runId: string;
  mode: string;
  target: string;
  region: string;
  leftovers?: string[];
  expectedMissed?: string[];
  network: { client: string; clientRegion: string | null };
  cost: {
    putUSD: number;
    getUSD: number;
    totalUSD: number;
    ops: {
      put: number;
      get: number;
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
  loadVia: string | null;
  getsPerLoad: number;
  getsPerMultipart: number;
  putsPerSingle: number;
  putsPerMultipart: number;
  partsPerMultipart: number;
  loads: number;
  usd: { singleLoad: number; multipartLoad: number };
  ledger: { pointerReads: number; loadPointerReads: number };
  meanPointerReads: number;
  shapes: Array<[number, number]>;
  anchors: Array<[string, string]>;
  rows: Array<{ requests: string; label: string; says: RegExp }>;
  stageLedger: Record<string, { put: number; get: number; expectedGets: number | null }>;
};
const figures = require_(join(ROOT, 'bench', 'lib', 'calibration-figures.cjs')) as {
  readSources: (root: string) => unknown;
  derive: (run: Run, src: unknown) => Figures;
};
const { STAGES } = require_(join(ROOT, 'bench', 'lib', 'calibrate-stages.cjs')) as {
  STAGES: string[];
};

const SOURCES = figures.readSources(ROOT);
const fixture = JSON.parse(
  readFileSync(join(ROOT, 'tests', 'bench', 'fixtures', 'calibration-rehearsal.json'), 'utf8'),
) as Run;
/** The rehearsal, dressed as a finished real run: only what a real run's file says about itself is changed. */
const asRealRun = (): Run => ({ ...structuredClone(fixture), mode: 'run', target: 'aws' });
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
  });

  it('is derived, each load priced from the requests it made', () => {
    const f = figures.derive(asRealRun(), SOURCES);
    expect(f.loadVia).toBe('store.load()');
    // A first load of a segment: the object, two listings and the pointer; seven pointer reads. A multipart object is
    // a create, its parts and a complete in place of the one PUT.
    expect(f.putsPerSingle).toBe(4);
    expect(f.getsPerLoad).toBe(7);
    expect(f.partsPerMultipart).toBe(2);
    expect(f.putsPerMultipart).toBe(7);
    expect(f.getsPerMultipart).toBe(7);
    expect(f.usd.singleLoad).toBeCloseTo(4 * 5e-6 + 7 * GET_USD, 12);
    expect(f.usd.multipartLoad).toBeCloseTo(7 * 5e-6 + 7 * GET_USD, 12);
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
    expect(f.shapes).toContainEqual([4, 7]);
    expect(f.shapes).toContainEqual([7, 7]);
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
          if (l !== undefined) l.put = 3;
        }),
      ).toMatch(/not an object, two listings and a pointer write|do not add up to its load stage/);
      expect(
        refused((r) => {
          r.phases.load.requests.get += 1;
        }),
      ).toMatch(/do not add up/);
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
      ).toMatch(/its andNot stage made 30,210 GET-class requests, not the 30,211 it expected/);
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
        /its andNot stage made 30,210 GET-class requests, not the 30,211 it expected/,
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
