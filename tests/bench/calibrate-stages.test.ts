import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CloudRoaring } from '@/index';
import { ObjectStoreRegistry } from '@/drivers/_shared/object-registry';
import { CountingObjectStore, counting } from '../helpers/counting';
import { brandAsBackend } from '@/core/ports';
import { WriteConflictError } from '@/core/errors';
import { MemoryStorageDriver } from '@/drivers/memory';

// The stages the harness runs, and what each is allowed to cost. A stage nobody projected would spend money the
// ceiling never saw, so the table of stages, the projection and the harness are held to one another here.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const require_ = createRequire(import.meta.url);

type Bound = { put: number; get: number };
type Plan = {
  loads: { segments: number; largeSegments: number; partsBound: number };
  intersect: { reads: number; sharedChunks: number };
  spread: { segments: number; reads: number; sharedChunks: number };
  sweep: { segments: number; entries: { k: number; intersects: number }[] };
  warm: { segments: number; sharedChunks: number };
  pointReads: { segments: number; sharedChunks: number };
  andNot: { calls: number; excludes: number; includeChunks: number; sharedChunks: number };
  retryBound: number;
  fixedPuts: number;
  fixedGets: number;
};
const stages = require_(join(ROOT, 'bench', 'lib', 'calibrate-stages.cjs')) as {
  STAGES: string[];
  DEFAULT_SWEEP: { k: number; intersects: number }[];
  parseSweep: (raw: unknown) => { k: number; intersects: number }[];
  coldIntersectGets: (k: number) => number;
  coldIntersectBound: (k: number) => number;
  projectStages: (w: Plan) => { stages: Record<string, Bound>; total: Bound };
  expectedReads: (w: Plan) => Record<string, number>;
  FIRST_LOAD: Bound;
  firstLoadRequests: (parts: number) => Bound;
};
type Layout = {
  shared: number;
  priv: number;
  stride: number;
  sharedChunks: number;
  privateChunks: number;
  chunksPerSegment: number;
  ownSums: number[];
  expected: { count: number; sum: number };
};
const guards = require_(join(ROOT, 'bench', 'lib', 'calibrate-guards.cjs')) as {
  RETRY_BOUND: number;
  DEFAULT_LAYOUT: { overlap: number; stride: number };
  planLayout: (i: {
    segments: number;
    idsPerSegment: number;
    overlap: number;
    stride: number;
  }) => Layout;
  planSweepLayout: (i: {
    segments: number;
    sharedChunks: number;
    privateIds: number;
    stride: number;
  }) => Layout;
  layoutIds: (layout: Layout, i: number) => Iterable<number>;
  TIMED_STORE: { retry: false; cache: { genTtlMs: number } };
  WARM_GEN_TTL_MS: number;
  warmStore: (chunks: number) => {
    retry: false;
    cache: { genTtlMs: number; maxChunks: number };
  };
  checkWorkload: (i: Record<string, number>) => void;
  MAX_SEGMENTS: number;
  firstLoads: () => (segment: string) => void;
  projectOps: (i: { loads: number; reads: number; chunksPerRead: number; retryBound: number }) => {
    put: number;
    get: number;
  };
};
const harnessSrc = readFileSync(join(ROOT, 'bench', 'calibrate-aws.cjs'), 'utf8');

/** The harness's default plan, for the calibration layout at 500,000 ids. */
function defaultPlan(): Plan {
  const layout = guards.planLayout({
    segments: 20,
    idsPerSegment: 500_000,
    ...guards.DEFAULT_LAYOUT,
  });
  return {
    loads: { segments: 20, largeSegments: 5, partsBound: 3 },
    intersect: { reads: 40, sharedChunks: layout.sharedChunks },
    spread: { segments: 10, reads: 40, sharedChunks: layout.sharedChunks },
    sweep: { segments: 3, entries: stages.DEFAULT_SWEEP },
    warm: { segments: 20, sharedChunks: layout.sharedChunks },
    pointReads: { segments: 10, sharedChunks: layout.sharedChunks },
    andNot: {
      calls: 10,
      excludes: 10,
      includeChunks: layout.chunksPerSegment,
      sharedChunks: layout.sharedChunks,
    },
    retryBound: guards.RETRY_BOUND,
    fixedPuts: 16,
    fixedGets: 11,
  };
}

describe('the stage table', () => {
  // A stage the harness runs that the table does not name would not be projected, and a name in the table the
  // harness never runs would project requests nothing makes. Either way the list and the harness disagree.
  it('names exactly the stages the harness runs, once each, in order', () => {
    const run = [...harnessSrc.matchAll(/await stage\('(\w+)'/g)].map((m) => m[1]);
    expect(run).toEqual(stages.STAGES);
    expect(new Set(stages.STAGES).size).toBe(stages.STAGES.length);
    // And the harness refuses a stage the projection does not cover, at run time too.
    expect(harnessSrc).toContain('if (!STAGES.includes(name))');
  });

  it('projects every stage in the table, and only those', () => {
    const { stages: bounds } = stages.projectStages(defaultPlan());
    expect(Object.keys(bounds)).toEqual(stages.STAGES);
    for (const name of stages.STAGES) {
      expect(Number.isInteger(bounds[name]?.get), name).toBe(true);
      expect(Number.isInteger(bounds[name]?.put), name).toBe(true);
    }
  });

  it('prints and records a bound for each stage', () => {
    // The projection-only report has a row for every stage, and a finished run's file carries each stage's bound.
    expect(harnessSrc).toContain('for (const name of STAGES) {');
    expect(harnessSrc).toContain('projectedStages: stageBounds');
    expect(harnessSrc).toContain(
      'for (const m of exceedsProjection(used, stageBounds[name])) over.push',
    );
  });

  it('adds the stage bounds to the total, with the fixed requests, and never projects reads below writes', () => {
    const w = defaultPlan();
    const { stages: bounds, total } = stages.projectStages(w);
    const put = Object.values(bounds).reduce((n, b) => n + b.put, 0) + w.fixedPuts;
    const get = Object.values(bounds).reduce((n, b) => n + b.get, 0) + w.fixedGets;
    expect(total.put).toBe(put);
    expect(total.get).toBe(Math.max(get, put));
    // A workload of nothing but loads: reads are still at least the writes.
    const loadsOnly = stages.projectStages({
      ...w,
      intersect: { ...w.intersect, reads: 0 },
      spread: { ...w.spread, segments: 0, reads: 0 },
      sweep: { ...w.sweep, entries: [] },
      warm: { ...w.warm, segments: 0 },
      pointReads: { ...w.pointReads, segments: 0 },
      andNot: { ...w.andNot, calls: 0 },
    });
    expect(loadsOnly.total.get).toBeGreaterThanOrEqual(loadsOnly.total.put);
  });

  // The projection is the ceiling's input. A stage added to the table with no bound, or one whose bound is under what
  // the engine is expected to make, would spend past a ceiling that said it was safe.
  it('bounds every stage at or above what the engine is expected to make', () => {
    for (const w of [
      defaultPlan(),
      { ...defaultPlan(), andNot: { ...defaultPlan().andNot, excludes: 3 } },
    ]) {
      const { stages: bounds } = stages.projectStages(w);
      const expected = stages.expectedReads(w);
      for (const [name, gets] of Object.entries(expected)) {
        const setupGets = 0;
        expect(bounds[name]?.get ?? 0, name).toBeGreaterThanOrEqual(gets + setupGets);
      }
    }
  });

  it('counts every value of the sweep, loads and reads, in the projection', () => {
    const w = defaultPlan();
    const base = stages.projectStages({ ...w, sweep: { ...w.sweep, entries: [] } }).stages.sweep;
    expect(base).toEqual({ put: 0, get: 0 });
    const one = stages.projectStages({
      ...w,
      sweep: { ...w.sweep, entries: [{ k: 1_000, intersects: 10 }] },
    }).stages.sweep;
    const both = stages.projectStages(w).stages.sweep;
    // Every entry loads its own segments and reads its own pairs, so a second entry adds its own and only its own.
    const second = stages.projectStages({
      ...w,
      sweep: { ...w.sweep, entries: [{ k: 2_000, intersects: 5 }] },
    }).stages.sweep;
    expect(both?.get).toBe((one?.get ?? 0) + (second?.get ?? 0));
    expect(both?.put).toBe((one?.put ?? 0) + (second?.put ?? 0));
    expect(both?.get).toBeGreaterThanOrEqual(
      10 * stages.coldIntersectGets(1_000) + 5 * stages.coldIntersectGets(2_000),
    );
    // A further value of k raises the bound; it is not absorbed by the others.
    const three = stages.projectStages({
      ...w,
      sweep: { ...w.sweep, entries: [...stages.DEFAULT_SWEEP, { k: 500, intersects: 4 }] },
    }).stages.sweep;
    expect(three?.get).toBeGreaterThan(both?.get ?? 0);
  });
});

describe('the sweep list', () => {
  it('defaults to ten at 1,000 shared chunks and five at 2,000', () => {
    expect(stages.parseSweep(undefined)).toEqual([
      { k: 1_000, intersects: 10 },
      { k: 2_000, intersects: 5 },
    ]);
    expect(stages.parseSweep('  ')).toEqual(stages.parseSweep(undefined));
  });

  it('reads a list, and none', () => {
    expect(stages.parseSweep('500:3, 1000:2')).toEqual([
      { k: 500, intersects: 3 },
      { k: 1_000, intersects: 2 },
    ]);
    expect(stages.parseSweep('none')).toEqual([]);
  });

  // A sweep that silently dropped an entry would measure less than it says.
  it('refuses an entry it cannot read, a zero, and a value named twice', () => {
    for (const bad of [
      '1000',
      '1000:',
      ':5',
      '0:5',
      '1000:0',
      'a:b',
      '1000:5,',
      '1000:5,1000:6',
      '-1:5',
      '1.5:2',
    ]) {
      expect(() => stages.parseSweep(bad), bad).toThrow(/CR_CALIBRATE_SWEEP/);
    }
  });

  // The default default sweep's seed: the harness takes it from the environment, and a refusal stops the run before
  // anything is created.
  it('is read before anything is created, and refuses with the exit code of every other bad input', () => {
    const src = harnessSrc.slice(harnessSrc.indexOf('async function main'));
    expect(src.indexOf('parseSweep(process.env.CR_CALIBRATE_SWEEP)')).toBeGreaterThan(-1);
    expect(src.indexOf('parseSweep(process.env.CR_CALIBRATE_SWEEP)')).toBeLessThan(
      src.indexOf("await import('@cloudbitmaps/roaring')"),
    );
  });
});

describe('the sweep layout', () => {
  const stride = guards.DEFAULT_LAYOUT.stride;
  const sweepLayout = (k: number): Layout =>
    guards.planSweepLayout({ segments: 3, sharedChunks: k, privateIds: 40_000, stride });

  it('shares exactly the number of chunks asked for, at 1,000 and at 2,000 and in between', () => {
    for (const k of [1, 2, 7, 100, 1_000, 1_999, 2_000, 2_001]) {
      expect(sweepLayout(k).sharedChunks, `k = ${k}`).toBe(k);
    }
  });

  it('intersects every pair in exactly the expected ids, and shares no more chunks than asked', () => {
    for (const k of [3, 40]) {
      const L = sweepLayout(k);
      const seg = (i: number): number[] => [...guards.layoutIds(L, i)];
      for (const [a, b] of [
        [0, 1],
        [1, 2],
        [2, 0],
      ] as const) {
        const other = new Set(seg(b));
        const both = seg(a).filter((id) => other.has(id));
        expect(both.length).toBe(L.expected.count);
        expect(both.reduce((acc, id) => acc + id, 0)).toBe(L.expected.sum);
        const keysB = new Set(seg(b).map((id) => id >>> 16));
        const common = new Set(
          seg(a)
            .map((id) => id >>> 16)
            .filter((c) => keysB.has(c)),
        );
        expect(common.size).toBe(k);
      }
      // Each segment's own ids sum to what the layout says: the exact answer of `andNot` reads depends on it.
      for (let i = 0; i < 3; i += 1) {
        const ids = seg(i);
        expect(ids.length).toBe(L.shared + L.priv);
        expect(ids.slice(L.shared).reduce((acc, id) => acc + id, 0)).toBe(L.ownSums[i]);
      }
    }
  });

  it('refuses a stride that would put every id in its own chunk, or a count that is not a count', () => {
    expect(() =>
      guards.planSweepLayout({ segments: 3, sharedChunks: 10, privateIds: 100, stride: 65_536 }),
    ).toThrow(/its own chunk/);
    expect(() =>
      guards.planSweepLayout({ segments: 3, sharedChunks: 0, privateIds: 100, stride }),
    ).toThrow(/positive integer/);
  });
});

describe('the workload the stages need', () => {
  const base = { segments: 20, largeSegments: 5, reads: 40 };

  it('refuses a set of segments too small to pair, for every stage that pairs them', () => {
    expect(() => guards.checkWorkload({ ...base, spreadSegments: 1, spreadReads: 4 })).toThrow(
      /spread: 1 segment/,
    );
    expect(() => guards.checkWorkload({ ...base, sweepSegments: 1, sweepEntries: 2 })).toThrow(
      /sweep: 1 segment/,
    );
    expect(() =>
      guards.checkWorkload({
        ...base,
        spreadSegments: 1,
        spreadReads: 0,
        sweepSegments: 1,
        sweepEntries: 0,
      }),
    ).not.toThrow();
  });

  it('refuses point reads and an andNot that need more calibration segments than there are', () => {
    expect(() => guards.checkWorkload({ ...base, segments: 5, pointSegments: 6 })).toThrow(
      /point-read/,
    );
    expect(() =>
      guards.checkWorkload({ ...base, segments: 10, andNotCalls: 1, andNotExcludes: 10 }),
    ).toThrow(/needs 11 calibration/);
    expect(() =>
      guards.checkWorkload({ ...base, segments: 11, andNotCalls: 1, andNotExcludes: 10 }),
    ).not.toThrow();
    expect(() => guards.checkWorkload({ ...base, andNotCalls: 1, andNotExcludes: 0 })).toThrow(
      /needs 1 calibration/,
    );
  });

  // Teardown lists 500 segments' two versions in its first listing, whichever stage loaded them.
  it("counts every stage's loads against what teardown's first listing reaches", () => {
    const all = { ...base, segments: 480, spreadSegments: 10, sweepSegments: 3, sweepEntries: 2 };
    expect(() => guards.checkWorkload(all)).toThrow(/501 segments/);
    expect(() => guards.checkWorkload({ ...all, segments: 479 })).not.toThrow();
  });
});

describe('a stage that reads from memory', () => {
  it('trusts its pointer for the whole stage, holds the chunks it reads, and has its own retry off', () => {
    const store = guards.warmStore(10);
    expect(store.retry).toBe(false);
    expect(store.cache.genTtlMs).toBe(guards.WARM_GEN_TTL_MS);
    expect(guards.WARM_GEN_TTL_MS).toBeGreaterThanOrEqual(60 * 60 * 1000);
    // Never below the default cache, and as large as asked above it.
    expect(store.cache.maxChunks).toBe(1_024);
    expect(guards.warmStore(4_000).cache.maxChunks).toBe(4_000);
    expect(() => guards.warmStore(-1)).toThrow(/capacity/);
  });

  // The source of one stage: from its call to the next stage's, or to the end of the stages.
  const stageSource = (name: string): string => {
    const from = harnessSrc.indexOf(`await stage('${name}'`);
    const rest = harnessSrc.slice(from + 1);
    const next = rest.search(/\n {4}await stage\(|\n {4}results\.partial = false;/);
    return rest.slice(0, next);
  };

  it('fails the stage, and not just the figure, when a warm read makes a request', () => {
    const warm = stageSource('warm');
    expect(warm).toContain('if (after.get !== before.get || after.put !== before.put) {');
    expect(warm).toMatch(/throw new Error\(\s*`warm intersect/);
  });

  it('fails the stage when a warm point read makes a request', () => {
    const points = stageSource('pointReads');
    expect(points).toContain("mustMake('a warm count()', countWarm, 0)");
    expect(points).toContain("mustMake('a warm has()', hasWarm, 0)");
  });
});

// The engine's own requests, counted the way the load stage's are: against local drivers and the real registry
// protocol. What the stages' formulas say a read makes is what the engine makes, on a layout small enough to run
// here; the rehearsal then holds the harness to the same formulas on S3's request shape.
describe('what the stages request, counted against the engine', () => {
  const stride = guards.DEFAULT_LAYOUT.stride;
  const layout = guards.planLayout({ segments: 14, idsPerSegment: 20_000, overlap: 0.1, stride });
  const calls: Record<string, number> = {};
  const pointer = new CountingObjectStore(0);
  const backend = brandAsBackend({
    storage: counting(new MemoryStorageDriver(), calls),
    registry: new ObjectStoreRegistry(pointer, undefined, () => 0),
  });
  /** GET-class requests so far: the pointer reads, the tail reads and the chunk reads. */
  const gets = (): number => pointer.reads + (calls.getTail ?? 0) + (calls.getRange ?? 0);
  const countOf = async (fn: () => Promise<void>): Promise<number> => {
    const before = gets();
    await fn();
    return gets() - before;
  };
  const drain = async (it: AsyncIterable<number>): Promise<number> => {
    let n = 0;
    for await (const id of it) {
      void id;
      n += 1;
    }
    return n;
  };
  const plan = (): Plan => ({
    ...defaultPlan(),
    intersect: { reads: 6, sharedChunks: layout.sharedChunks },
    // Six pairs, each a segment and the next: seven segments.
    warm: { segments: 7, sharedChunks: layout.sharedChunks },
    pointReads: { segments: 4, sharedChunks: layout.sharedChunks },
    andNot: {
      calls: 2,
      excludes: 3,
      includeChunks: layout.chunksPerSegment,
      sharedChunks: layout.sharedChunks,
    },
  });
  const loaded = (async () => {
    const loader = new CloudRoaring({ storage: backend, ...guards.TIMED_STORE });
    for (let i = 0; i < 14; i += 1) {
      await loader.load({ segment: `seg-${i}` }, guards.layoutIds(layout, i));
    }
  })();
  const expected = stages.expectedReads(plan());

  it('a cold intersect makes 4 + 2k, and a first load makes its counted 4 PUT-class and 7 GET', async () => {
    await loaded;
    expect(stages.FIRST_LOAD).toEqual({ put: 4, get: 7 });
    expect(stages.firstLoadRequests(0)).toEqual({ put: 4, get: 7 });
    // A multipart object is a create, its parts and a complete in place of one PUT.
    expect(stages.firstLoadRequests(2)).toEqual({ put: 7, get: 7 });
    let total = 0;
    for (let i = 0; i < 6; i += 1) {
      const store = new CloudRoaring({ storage: backend, ...guards.TIMED_STORE });
      total += await countOf(async () => {
        const n = await drain(
          store.segment(`seg-${i}`).intersect([store.segment(`seg-${(i + 1) % 14}`)]),
        );
        expect(n).toBe(layout.expected.count);
      });
    }
    expect(total).toBe(expected.intersect);
    expect(stages.coldIntersectGets(layout.sharedChunks)).toBe(4 + 2 * layout.sharedChunks);
  });

  it('a warm store reads each segment once and then nothing', async () => {
    await loaded;
    const store = new CloudRoaring({ storage: backend, ...guards.warmStore(1_024) });
    const pair = async (i: number): Promise<void> => {
      const n = await drain(
        store.segment(`seg-${i}`).intersect([store.segment(`seg-${(i + 1) % 14}`)]),
      );
      expect(n).toBe(layout.expected.count);
    };
    let priming = 0;
    for (let i = 0; i < 6; i += 1) priming += await countOf(() => pair(i));
    expect(priming).toBe(expected.warm);
    for (let i = 0; i < 6; i += 1) expect(await countOf(() => pair(i))).toBe(0);
  });

  it('point reads open each segment once, and a warm read makes none', async () => {
    await loaded;
    const names = ['seg-0', 'seg-1', 'seg-2', 'seg-3'];
    const counted = new CloudRoaring({ storage: backend, ...guards.warmStore(1_024) });
    let total = 0;
    for (const name of names) {
      total += await countOf(async () => {
        expect(await counted.segment(name).count()).toBe(20_000);
      });
    }
    for (let i = 0; i < 20; i += 1) {
      expect(
        await countOf(async () => void (await counted.segment(names[i % 4] ?? '').count())),
      ).toBe(0);
    }
    const idIn = (c: number): number => Math.ceil((c * 65_536) / stride) * stride;
    const ids = Array.from({ length: layout.sharedChunks }, (_, c) => idIn(c));
    const probed = new CloudRoaring({ storage: backend, ...guards.warmStore(1_024) });
    const has = async (): Promise<void> => {
      for (const name of names)
        for (const id of ids) expect(await probed.segment(name).has(id)).toBe(true);
    };
    total += await countOf(has);
    expect(total).toBe(expected.pointReads);
    expect(await countOf(has)).toBe(0);
  });

  it('an andNot reads every chunk of the include operand and each exclude where it overlaps', async () => {
    await loaded;
    let total = 0;
    for (let i = 0; i < 2; i += 1) {
      const store = new CloudRoaring({ storage: backend, ...guards.TIMED_STORE });
      total += await countOf(async () => {
        const n = await drain(
          store.segment('seg-0').andNot([1, 2, 3].map((j) => store.segment(`seg-${j}`))),
        );
        expect(n).toBe(layout.priv);
      });
    }
    expect(total).toBe(expected.andNot);
  });

  it('projects each of these above what it counted', () => {
    const bounds = stages.projectStages(plan()).stages;
    for (const name of ['intersect', 'warm', 'pointReads', 'andNot']) {
      expect(bounds[name]?.get ?? 0, name).toBeGreaterThanOrEqual(expected[name] ?? Infinity);
    }
  });
});

// No stage reloads a segment: the projection bounds a segment's first load. What a reload costs under repeated lost
// races is counted here, against the real registry protocol, to show why the harness refuses one instead of
// projecting it.
describe('a segment is loaded once', () => {
  it('refuses a second load of a name, before anything is sent, and the harness claims every load through it', () => {
    const claim = guards.firstLoads();
    claim('seg-0');
    claim('seg-1');
    expect(() => claim('seg-0')).toThrow(/seg-0 was loaded already/);
    // A claim belongs to its run: a fresh ledger has claimed nothing.
    expect(() => guards.firstLoads()('seg-0')).not.toThrow();
    expect(harnessSrc).toContain('const claimFirstLoad = firstLoads();');
    // The one place the harness loads is the helper that claims first, and nothing else calls the loader.
    expect(harnessSrc.match(/loader\.load\(/g)?.length).toBe(1);
    const helper = harnessSrc.slice(harnessSrc.indexOf('const load = async'));
    expect(helper.indexOf('claimFirstLoad(segment)')).toBeLessThan(helper.indexOf('loader.load('));
  });

  it("a reload that loses four races makes more requests than a first load's bound, so it is not projected", async () => {
    const reload = async (lost: number): Promise<{ gets: number; threw: boolean }> => {
      const calls: Record<string, number> = {};
      const pointer = new CountingObjectStore(0);
      const store = new CloudRoaring({
        storage: brandAsBackend({
          storage: counting(new MemoryStorageDriver(), calls),
          registry: new ObjectStoreRegistry(pointer, undefined, () => 0),
        }),
      });
      await store.load({ segment: 's' }, [1, 2, 3]);
      (pointer as unknown as { lostRaces: number }).lostRaces = lost;
      pointer.reads = 0;
      for (const k of Object.keys(calls)) delete calls[k];
      let threw = false;
      try {
        await store.load({ segment: 's' }, [1, 2, 3, 4]);
      } catch (err) {
        if (!(err instanceof WriteConflictError)) throw err;
        threw = true;
      }
      // The pointer reads, and the one tail read of the current generation's index.
      return { gets: pointer.reads + (calls.getTail ?? 0), threw };
    };
    const bound = guards.projectOps({
      loads: 1,
      reads: 0,
      chunksPerRead: 0,
      retryBound: guards.RETRY_BOUND,
    }).get;
    expect(bound).toBe(15);
    // Nothing racing: a reload is the counted eight, one more than a first load's seven.
    expect(await reload(0)).toEqual({ gets: 8, threw: false });
    // Four lost publishes, the last attempt winning: sixteen, past the bound of fifteen.
    expect(await reload(4)).toEqual({ gets: 16, threw: false });
    expect((await reload(4)).gets).toBeGreaterThan(bound);
  });
});
