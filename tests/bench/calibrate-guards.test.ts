import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CloudRoaring,
  MemoryStorage,
  MemoryStorageDriver,
  bulkLoadCrbmGeneration,
  createBackend,
} from '@/index';
import { WriteConflictError } from '@/core/errors';
import {
  ObjectStoreRegistry,
  type ObjectRegistryStore,
  type ObjectRow,
} from '@/drivers/_shared/object-registry';

// Guards on a script that spends real money against a real cloud account. Every case below is a bug that
// actually happened in the harness this replaces — the one that ran the July 2026 calibration and was deleted
// with the warm tier, taking its regression suite with it. Each is rebuilt from what went wrong, which its test
// below records, because a guard nobody can plant a defect against is decoration.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const require_ = createRequire(import.meta.url);

const guards = require_(join(ROOT, 'bench', 'lib', 'calibrate-guards.cjs')) as {
  CONFIRM_PHRASE: string;
  parseCeiling: (raw: unknown) => number;
  resolveSize: (raw: unknown, fallback: number, label: string) => number;
  probeMeansAbsent: (err: unknown) => boolean;
  projectOps: (i: {
    loads: number;
    reads: number;
    chunksPerRead: number;
    retryBound: number;
    operandsPerRead?: number;
    largeLoads?: number;
    partsPerLargeLoad?: number;
    fixedPuts?: number;
    fixedGets?: number;
  }) => { put: number; get: number };
  breached: (spent: number, ceiling: number) => boolean;
  RETRY_BOUND: number;
  CHUNK_SPAN: number;
  DEFAULT_LAYOUT: { overlap: number; stride: number };
  exceedsProjection: (
    measured: { put: number; get: number },
    projected: { put: number; get: number },
  ) => string[];
  planLayout: (i: { segments: number; idsPerSegment: number; overlap: number; stride: number }) => {
    shared: number;
    stride: number;
    sharedChunks: number;
    privateChunks: number;
    chunksPerSegment: number;
    bases: number[];
    expected: { count: number; sum: number };
  };
  layoutIds: (layout: unknown, i: number, idsPerSegment: number) => Iterable<number>;
  maskAccount: (account: unknown) => string;
  resultsFile: (rehearse: boolean, runId?: string, options?: { partial?: boolean }) => string;
  checkRunId: (runId: unknown) => string;
  checkCleanupId: (runId: unknown) => string;
  evidenceConflict: (i: {
    rehearse: boolean;
    file: string;
    exists: (file: string) => boolean;
  }) => string | null;
  checkWorkload: (i: { segments: number; reads: number }) => void;
  EVIDENCE_DIR: string;
  TIMED_STORE: { retry: false; cache: { genTtlMs: number } };
  clientConfigs: (base: Record<string, unknown>) => {
    work: Record<string, unknown>;
    admin: Record<string, unknown>;
  };
  ADMIN_ATTEMPTS: number;
  TEARDOWN_PASSES: number;
  TEARDOWN_PUTS: number;
  bucketIsGone: (err: unknown) => boolean;
  uploadIsGone: (err: unknown) => boolean;
};

type Billed = { put: number; get: number };
const calibrationFigures = require_(join(ROOT, 'bench', 'lib', 'calibration-figures.cjs')) as {
  STORE_LOAD_REQUESTS: { first: Billed; reload: Billed; collecting: Billed };
};

const meterLib = require_(join(ROOT, 'bench', 'lib', 'aws-meter.cjs')) as {
  meter: (
    client: unknown,
    tally?: unknown,
  ) => { put: number; get: number; byCommand: Record<string, number> };
  classify: (command: string) => 'put' | 'get' | 'free';
  rangeShape: (range: unknown) => 'whole' | 'suffix' | 'range';
  priceTally: (
    t: { put: number; get: number },
    p: { storage: { putPerMillion: number; getPerMillion: number } },
  ) => { putUSD: number; getUSD: number; totalUSD: number };
};

describe('calibrate guards', () => {
  describe('parseCeiling', () => {
    it('accepts a positive number', () => {
      expect(guards.parseCeiling('0.25')).toBe(0.25);
      expect(guards.parseCeiling(1)).toBe(1);
    });

    // THE one that matters. `Number('abc')` is NaN, and `total > NaN` is false for every total — so a
    // malformed ceiling used to silently DELETE the bound rather than fail.
    it('refuses a non-numeric ceiling rather than producing NaN', () => {
      expect(() => guards.parseCeiling('abc')).toThrow(/not a finite number/);
      expect(() => guards.parseCeiling('0.1abc')).toThrow(/not a finite number/);
      expect(() => guards.parseCeiling(Number.NaN)).toThrow(/not a finite number/);
      expect(() => guards.parseCeiling(Infinity)).toThrow(/not a finite number/);
    });

    it('refuses a missing, empty, zero or negative ceiling', () => {
      expect(() => guards.parseCeiling(undefined)).toThrow(/required/);
      expect(() => guards.parseCeiling('   ')).toThrow(/required/);
      expect(() => guards.parseCeiling('0')).toThrow(/greater than zero/);
      expect(() => guards.parseCeiling('-1')).toThrow(/greater than zero/);
    });

    // The property the guard is really asserting: whatever comes back can be compared meaningfully.
    it('never returns a value that makes a comparison vacuous', () => {
      const ceiling = guards.parseCeiling('0.25');
      expect(guards.breached(0.26, ceiling)).toBe(true);
      expect(guards.breached(0.24, ceiling)).toBe(false);
    });
  });

  describe('resolveSize', () => {
    it('falls back only when unset', () => {
      expect(guards.resolveSize(undefined, 2000, 'CR_CALIBRATE_WRITES')).toBe(2000);
      expect(guards.resolveSize('', 2000, 'CR_CALIBRATE_WRITES')).toBe(2000);
    });

    // An explicit 0 used to map to the DEFAULT, handing someone shrinking a run the full workload.
    it('treats an explicit zero as zero, not as the default', () => {
      expect(guards.resolveSize('0', 2000, 'CR_CALIBRATE_WRITES')).toBe(0);
    });

    it('refuses a malformed size', () => {
      expect(() => guards.resolveSize('ten', 10, 'X')).toThrow(/non-negative integer/);
      expect(() => guards.resolveSize('1.5', 10, 'X')).toThrow(/non-negative integer/);
      expect(() => guards.resolveSize('-1', 10, 'X')).toThrow(/non-negative integer/);
    });
  });

  describe('probeMeansAbsent', () => {
    it('treats a genuine not-found as absent', () => {
      expect(guards.probeMeansAbsent({ $metadata: { httpStatusCode: 404 } })).toBe(true);
      expect(guards.probeMeansAbsent({ name: 'NotFound' })).toBe(true);
      expect(guards.probeMeansAbsent({ name: 'NoSuchBucket' })).toBe(true);
    });

    // The dangerous one. HeadBucket answers 403 for a bucket you OWN but cannot list, and in us-east-1
    // CreateBucket on a bucket you already own returns 200 OK — so reading 403 as "absent" would run the
    // workload inside a real bucket of yours and then delete it on teardown.
    it('does NOT treat 403 as absent', () => {
      expect(guards.probeMeansAbsent({ $metadata: { httpStatusCode: 403 } })).toBe(false);
      expect(
        guards.probeMeansAbsent({ name: 'Forbidden', $metadata: { httpStatusCode: 403 } }),
      ).toBe(false);
    });

    it('does not treat a throttle, a timeout or a network error as absent', () => {
      expect(guards.probeMeansAbsent({ $metadata: { httpStatusCode: 503 } })).toBe(false);
      expect(guards.probeMeansAbsent({ name: 'TimeoutError' })).toBe(false);
      expect(guards.probeMeansAbsent({ name: 'ECONNRESET' })).toBe(false);
      expect(guards.probeMeansAbsent(new Error('socket hang up'))).toBe(false);
    });

    it('treats a successful probe as present', () => {
      expect(guards.probeMeansAbsent(undefined)).toBe(false);
      expect(guards.probeMeansAbsent(null)).toBe(false);
    });
  });

  describe('projectOps', () => {
    // A projection the run can exceed is not a ceiling. Reads must be projected at least as high as writes,
    // because every write path here reads before it writes — an earlier version gave reads a SMALLER
    // multiplier, so the read slot always breached first.
    it('projects reads at least as high as writes', () => {
      for (const loads of [1, 20, 500]) {
        for (const reads of [0, 1, 2000]) {
          const p = guards.projectOps({ loads, reads, chunksPerRead: 100, retryBound: 3 });
          expect(p.get).toBeGreaterThanOrEqual(p.put);
        }
      }
    });

    // The specific trigger that broke it before: concurrency above segment count is what you set to make a
    // run cheaper, and it inverted the ratio.
    it('holds when there are far more reads than loads, and vice versa', () => {
      const readHeavy = guards.projectOps({
        loads: 1,
        reads: 5000,
        chunksPerRead: 100,
        retryBound: 3,
      });
      const writeHeavy = guards.projectOps({
        loads: 5000,
        reads: 1,
        chunksPerRead: 1,
        retryBound: 3,
      });
      expect(readHeavy.get).toBeGreaterThanOrEqual(readHeavy.put);
      expect(writeHeavy.get).toBeGreaterThanOrEqual(writeHeavy.put);
    });

    it('accounts for the engine retry bound rather than a fixed multiplier', () => {
      const low = guards.projectOps({ loads: 10, reads: 0, chunksPerRead: 0, retryBound: 1 });
      const high = guards.projectOps({ loads: 10, reads: 0, chunksPerRead: 0, retryBound: 8 });
      expect(high.put).toBeGreaterThan(low.put);
    });

    it('refuses a retry bound that is not a positive integer', () => {
      expect(() =>
        guards.projectOps({ loads: 1, reads: 1, chunksPerRead: 1, retryBound: 0 }),
      ).toThrow(/positive integer/);
    });
  });

  describe('breached', () => {
    it('treats landing exactly on the ceiling as a breach', () => {
      expect(guards.breached(0.25, 0.25)).toBe(true);
      expect(guards.breached(0.2499, 0.25)).toBe(false);
    });
  });

  describe('the confirmation phrase', () => {
    it('is long enough that a typo cannot spend money', () => {
      expect(guards.CONFIRM_PHRASE.length).toBeGreaterThan(8);
      expect(guards.CONFIRM_PHRASE).not.toMatch(/^(y|yes|true|1)$/i);
    });
  });
});

describe('aws-meter classification', () => {
  // S3 prices PUT/COPY/POST/LIST together and GET/SELECT together. Filing a LIST as a read understates an
  // enumerating workload by 12.5x, and nothing downstream would notice.
  it('bills LIST at the PUT rate, not the GET rate', () => {
    expect(meterLib.classify('ListObjectsV2Command')).toBe('put');
    // The one teardown uses to empty a versioned bucket; it once fell through to the GET rate.
    expect(meterLib.classify('ListObjectVersionsCommand')).toBe('put');
    expect(meterLib.classify('ListMultipartUploadsCommand')).toBe('put');
  });

  it('bills the multipart commands at the PUT rate', () => {
    for (const c of [
      'CreateMultipartUploadCommand',
      'UploadPartCommand',
      'CompleteMultipartUploadCommand',
    ]) {
      expect(meterLib.classify(c)).toBe('put');
    }
  });

  it('bills reads as GET', () => {
    expect(meterLib.classify('GetObjectCommand')).toBe('get');
    expect(meterLib.classify('HeadObjectCommand')).toBe('get');
  });

  it('treats deletes and aborted uploads as free', () => {
    for (const c of [
      'DeleteObjectCommand',
      'DeleteObjectsCommand',
      'AbortMultipartUploadCommand',
    ]) {
      expect(meterLib.classify(c)).toBe('free');
    }
  });

  // An unknown command must COST something, not nothing: a new call added to a driver should show up in the
  // bill rather than silently price at zero.
  it('counts an unrecognised command rather than treating it as free', () => {
    expect(meterLib.classify('SomeFutureCommand')).toBe('get');
  });

  // One combined bytes-fetched figure hid a fixed 256 KiB tail read behind the chunk reads. The shape of the
  // Range header is what separates the index read from the payload reads.
  it('tells a suffix (tail) read from an explicit range and a whole-object read', () => {
    expect(meterLib.rangeShape(undefined)).toBe('whole');
    expect(meterLib.rangeShape('bytes=-262144')).toBe('suffix');
    expect(meterLib.rangeShape('bytes=1024-1539')).toBe('range');
    expect(meterLib.rangeShape('bytes=1024-')).toBe('range');
  });

  it('prices a tally from the pricing profile rather than hardcoded rates', () => {
    const priced = meterLib.priceTally(
      { put: 1_000_000, get: 1_000_000 },
      { storage: { putPerMillion: 5, getPerMillion: 0.4 } },
    );
    expect(priced.putUSD).toBeCloseTo(5, 10);
    expect(priced.getUSD).toBeCloseTo(0.4, 10);
    expect(priced.totalUSD).toBeCloseTo(5.4, 10);
  });
});

describe("calibrate guards — found by this harness's real runs", () => {
  // The harness said RETRY_BOUND = 4 and called it "1 + DEFAULT_MAX_RETRIES". No such constant exists and the
  // loop runs five attempts, so every load was projected one attempt short. Read the bound out of the source
  // rather than retyping it, so the two cannot disagree silently again.
  it('uses the same retry bound as publishGeneration actually loops', () => {
    const src = readFileSync(
      join(ROOT, 'packages', 'core', 'src', 'core', 'crbm-storage-source.ts'),
      'utf8',
    );
    const body = src.slice(src.indexOf('export async function publishGeneration'));
    const bound = /for \(let attempt = 0; attempt < (\d+); attempt\+\+\)/.exec(body);
    expect(
      bound,
      'publishGeneration no longer has the attempt loop this test reads',
    ).not.toBeNull();
    expect(guards.RETRY_BOUND).toBe(Number(bound?.[1]));
  });

  // An intersect has two operands and each opens its own generation. Counting one per read halved the term.
  it('projects every operand of a read, not one', () => {
    const base = { loads: 0, reads: 40, chunksPerRead: 100, retryBound: 5 };
    const one = guards.projectOps({ ...base, operandsPerRead: 1 });
    const two = guards.projectOps({ ...base, operandsPerRead: 2 });
    expect(two.get).toBe(2 * one.get);
    expect(two.get).toBeGreaterThanOrEqual(40 * 2 * 100);
  });

  it('projects multipart parts for large loads', () => {
    const base = { loads: 0, reads: 0, chunksPerRead: 0, retryBound: 5 };
    const small = guards.projectOps({ ...base, largeLoads: 2, partsPerLargeLoad: 0 });
    const big = guards.projectOps({ ...base, largeLoads: 2, partsPerLargeLoad: 3 });
    expect(big.put - small.put).toBe(2 * 3);
  });

  // Run 2026-09-23-94416's GETs did not add up until the loads were counted: 36 pointer reads that each answered 404,
  // three per load of a new segment. The loader reads the row, the publish reads it again, and the registry reads
  // it once more before its conditional write — and a publish that loses its race goes round again, up to the
  // retry bound, then reads the row one last time. The projection allowed one read per attempt. That held only
  // because nothing races the harness's loads, and a bound that holds only by luck is not a bound.
  it('projects every pointer read a load can make, even when each publish attempt loses its race', async () => {
    const load = async (lostRaces: number): Promise<{ reads: number; writes: number }> => {
      const store = new CountingObjectStore(lostRaces);
      const registry = new ObjectStoreRegistry(store, undefined, () => 0);
      try {
        await bulkLoadCrbmGeneration(
          new MemoryStorageDriver(),
          { segment: 's', generation: 0 },
          [1, 2, 3],
          { registry },
        );
      } catch (err) {
        if (!(err instanceof WriteConflictError)) throw err;
      }
      return { reads: store.reads, writes: store.writes };
    };
    // Nothing racing: three reads and the one conditional write, as both real runs measured.
    expect(await load(0)).toEqual({ reads: 3, writes: 1 });
    const worst = await load(guards.RETRY_BOUND);
    expect(worst.writes).toBe(guards.RETRY_BOUND);
    const p = guards.projectOps({
      loads: 1,
      reads: 0,
      chunksPerRead: 0,
      retryBound: guards.RETRY_BOUND,
    });
    expect(p.get).toBeGreaterThanOrEqual(worst.reads);
    // The generation's own PUT, then every attempt at the pointer.
    expect(p.put).toBeGreaterThanOrEqual(1 + worst.writes);
  });

  it('flags a run that exceeded its projection, and only then', () => {
    expect(guards.exceedsProjection({ put: 10, get: 10 }, { put: 10, get: 10 })).toEqual([]);
    expect(guards.exceedsProjection({ put: 11, get: 10 }, { put: 10, get: 10 })).toHaveLength(1);
    expect(guards.exceedsProjection({ put: 11, get: 99 }, { put: 10, get: 10 })).toHaveLength(2);
  });

  describe('planLayout', () => {
    const params = { segments: 3, idsPerSegment: 4_000, overlap: 0.05, stride: 262 };
    const L = guards.planLayout(params);
    const seg = (i: number): number[] => [...guards.layoutIds(L, i, params.idsPerSegment)];

    // The claim the harness asserts against a real object store is that ANY pair intersects in exactly
    // `expected` — so check that claim here, in plain JS, over every pair.
    it('intersects every pair in exactly the expected ids', () => {
      for (const [a, b] of [
        [0, 1],
        [0, 2],
        [1, 2],
      ] as const) {
        const other = new Set(seg(b));
        const both = seg(a).filter((id) => other.has(id));
        expect(both.length).toBe(L.expected.count);
        expect(both.reduce((acc, id) => acc + id, 0)).toBe(L.expected.sum);
      }
    });

    // Chunk-skipping fetches by KEY overlap — a chunk whose key exists in both operands is fetched from both,
    // whether or not the payloads end up sharing an id. So the property that decides what a run measures is
    // chunk overlap, not id overlap: two bands placed too close share chunks without sharing a single id,
    // passing the exact-id check above while quietly adding fetches to the measurement.
    it('shares exactly the planned chunks between every pair, and no more', () => {
      const keys = (i: number) => new Set(seg(i).map((id) => id >>> 16));
      for (const [a, b] of [
        [0, 1],
        [0, 2],
        [1, 2],
      ] as const) {
        const kb = keys(b);
        const common = [...keys(a)].filter((k) => kb.has(k));
        expect(common.length).toBe(L.sharedChunks);
      }
    });

    it('yields ascending u32 ids, as the loader expects', () => {
      for (const i of [0, 1, 2]) {
        const ids = seg(i);
        expect(ids.length).toBe(params.idsPerSegment);
        for (let k = 1; k < ids.length; k += 1) expect(ids[k]).toBeGreaterThan(ids[k - 1] ?? -1);
        expect(ids[ids.length - 1]).toBeLessThanOrEqual(0xffff_ffff);
      }
    });

    it('spans the chunk counts it reports', () => {
      const chunks = new Set(seg(0).map((id) => id >>> 16));
      expect(chunks.size).toBe(L.chunksPerSegment);
    });

    // The published figure is "100 of 2,000 chunks". A layout that packed the shared ids into a handful of
    // chunks — this harness's first real run did, at a stride of 7 — is not evidence about that figure.
    it('reproduces the published 100-of-2,000 shape at the harness defaults', () => {
      const d = guards.planLayout({
        segments: 10,
        idsPerSegment: 500_000,
        ...guards.DEFAULT_LAYOUT,
      });
      expect(d.sharedChunks).toBe(100);
      expect(d.chunksPerSegment).toBeGreaterThanOrEqual(1_990);
      expect(d.chunksPerSegment).toBeLessThanOrEqual(2_010);
    });

    it('refuses a layout that would wrap the 32-bit id space', () => {
      expect(() =>
        guards.planLayout({ segments: 100, idsPerSegment: 500_000, overlap: 0.05, stride: 262 }),
      ).toThrow(/32-bit id space/);
    });

    it('refuses a layout that shares nothing, or puts every id in its own chunk', () => {
      expect(() =>
        guards.planLayout({ segments: 2, idsPerSegment: 10, overlap: 0.05, stride: 262 }),
      ).toThrow(/shares nothing/);
      expect(() =>
        guards.planLayout({ segments: 2, idsPerSegment: 1_000, overlap: 0.05, stride: 65_536 }),
      ).toThrow(/its own chunk/);
    });
  });

  describe('maskAccount', () => {
    // Built at runtime, never written as a literal. The leak scan's structural needles flag any 12-digit run and
    // any ARN, and they cannot tell a fixture from a real account — which is the point of them. Allowlisting this
    // whole file would blind the scanner to the one file a real id is most likely to be pasted into while
    // debugging the pin, so the fixture changes instead: an all-zeros prefix is unmistakably not an account, and a
    // real id pasted here as a literal is still caught.
    const FAKE_ACCOUNT = '0'.repeat(8) + '4321';

    it('shows the last four digits and nothing else', () => {
      const masked = guards.maskAccount(FAKE_ACCOUNT);
      expect(masked.endsWith('4321')).toBe(true);
      expect(masked).not.toContain('00000000');
    });

    it('does not pretend to have verified something that is not an account id', () => {
      expect(guards.maskAccount(undefined)).toBe('(unverified)');
      // Contains an account id without being one — an ARN, a URI, a log line — must not be read as verified.
      expect(guards.maskAccount(`${FAKE_ACCOUNT}:user/x`)).toBe('(unverified)');
      expect(guards.maskAccount(`${FAKE_ACCOUNT}9`)).toBe('(unverified)');
    });
  });
});

// `.gitignore` and the harness each name the file a rehearsal writes, and they drifted: the ignore rule outlived
// the harness that wrote that file, and its replacement wrote rehearsals under the real run's name — one
// `git add` from committing a free run against MinIO as the evidence. Asked of git itself, so the rule and the
// harness cannot drift apart again without one of these failing.
describe('a rehearsal cannot be committed as the evidence', () => {
  const ignored = (rel: string): boolean => {
    const { status } = spawnSync('git', ['check-ignore', '-q', rel], { cwd: ROOT });
    // 0 is ignored and 1 is not. Anything else means git could not answer, which must not read as "not ignored".
    if (status !== 0 && status !== 1)
      throw new Error(`git check-ignore could not answer for ${rel}`);
    return status === 0;
  };

  it('writes a rehearsal to a file git ignores', () => {
    expect(ignored(guards.resultsFile(true))).toBe(true);
  });

  // One file per run, named by its id, so a second run cannot overwrite the evidence behind a figure already
  // published — the benchmarks page cites a run by id, and the file under that id is what its gate reads.
  it('writes a real run to an evidence file of its own, which git does not ignore', () => {
    const file = guards.resultsFile(false, '2026-09-23-94416');
    expect(file).toBe(`${guards.EVIDENCE_DIR}/2026-09-23-94416.json`);
    expect(ignored(file)).toBe(false);
  });

  // A run that did not finish is not evidence. It once went to the evidence name, where one aborted run made both
  // figures gates fail until someone deleted it.
  it('writes a run that did not finish beside the evidence, under a name git ignores', () => {
    const file = guards.resultsFile(false, '2026-09-23-94416', { partial: true });
    expect(file).toBe(`${guards.EVIDENCE_DIR}/2026-09-23-94416.partial.json`);
    expect(ignored(file)).toBe(true);
    expect(guards.resultsFile(true, '2026-09-23-94416', { partial: true })).toBe(
      guards.resultsFile(true),
    );
  });

  // The id names the bucket AND the evidence file, and the gates read the latest run by its order — so it is a date,
  // then a label that is safe in both a bucket name and a file name.
  it('refuses a run id that would not make a bucket name, a file name, and run order', () => {
    for (const ok of ['2026-09-23-94416', '2026-09-23-a', `2026-09-23-a${'-'.repeat(31)}b`]) {
      expect(guards.checkRunId(ok)).toBe(ok);
    }
    for (const bad of [
      undefined,
      '',
      '94416', // no date, so it would sort after every dated run
      'inregion-1',
      'crash-recovery-1', // no date — and a name the fuzzers' `crash-*` ignore rule would swallow
      'con', // a name Windows reserves
      '2026-09-23',
      '2026-09-23-',
      '2026-09-23-../x',
      '2026-09-23-runs/1',
      '2026-09-23-94416.json',
      '2026-09-23-Run',
      '2026-09-23--a',
      '2026-09-23-a-',
      '2026-09-23-x-s3alias', // S3 reserves the suffix, and would refuse it only after the abort window
      `2026-09-23-a${'b'.repeat(33)}`, // 45 characters: the bucket name would pass 63
    ]) {
      expect(() => guards.checkRunId(bad), String(bad)).toThrow(/run id/);
    }
    expect(() => guards.resultsFile(false, '../x')).toThrow(/run id/);
  });

  // `--cleanup` writes no file, so it takes any id that names a legal bucket. Older harnesses accepted any id and
  // printed `--cleanup <id>` for their leftovers; the date rule would strand those buckets.
  it('lets --cleanup remove any bucket an older harness could have made', () => {
    for (const ok of ['v0.10.0-inregion', '-x', '2026-09-22-bfee0', 'inregion-1', 'a']) {
      expect(guards.checkCleanupId(ok)).toBe(ok);
    }
    for (const bad of [
      undefined,
      '',
      '../x',
      'a/b',
      'A',
      'a..b',
      'a.',
      'a-',
      `a${'b'.repeat(44)}`,
    ]) {
      expect(() => guards.checkCleanupId(bad), String(bad)).toThrow(/bucket/);
    }
  });

  it('refuses a workload that pairs a segment with itself', () => {
    expect(() => guards.checkWorkload({ segments: 1, reads: 40 })).toThrow(/at least 2/);
    expect(() => guards.checkWorkload({ segments: 0, reads: 1 })).toThrow(/at least 2/);
    expect(() => guards.checkWorkload({ segments: 1, reads: 0 })).not.toThrow();
    expect(() => guards.checkWorkload({ segments: 2, reads: 40 })).not.toThrow();
  });

  // The two tests above tie `.gitignore` to `resultsFile()`; these tie the harness and the CloudShell script to it.
  // Without them, putting the old hard-coded path back into the harness — the exact regression this block exists
  // for — passed every test here.
  it('the harness takes its output paths from resultsFile(), and names no file itself', () => {
    const src = readFileSync(join(ROOT, 'bench', 'calibrate-aws.cjs'), 'utf8');
    expect(src).toContain('resolve(ROOT, resultsFile(REHEARSE, runId))');
    expect(src).toContain('resolve(ROOT, resultsFile(REHEARSE, runId, { partial: true }))');
    expect(src).not.toMatch(/calibrate-aws-(?:results|rehearsal)\.json|bench\/calibration/);
  });

  // Evidence is write-once, like the generations it measures. A run given the id of a published one — by
  // CR_CALIBRATE_RUN_ID, which exists so a run can be named — would otherwise replace the file its figures are
  // checked against, and the check would then pass against numbers the page never quoted.
  it('refuses to overwrite evidence, and only evidence', () => {
    const exists = (file: string): boolean => file.endsWith('2026-09-23-94416.json');
    const committed = `${guards.EVIDENCE_DIR}/2026-09-23-94416.json`;
    expect(guards.evidenceConflict({ rehearse: false, file: committed, exists })).toMatch(
      /already exists/,
    );
    // A new id, a rehearsal, and a retry after a partial run are all free to write.
    expect(
      guards.evidenceConflict({
        rehearse: false,
        file: `${guards.EVIDENCE_DIR}/2026-09-24-a.json`,
        exists,
      }),
    ).toBeNull();
    expect(guards.evidenceConflict({ rehearse: true, file: committed, exists })).toBeNull();
    // A retry after a run that failed part-way: only its partial file exists, and the evidence path is free.
    expect(
      guards.evidenceConflict({
        rehearse: false,
        file: guards.resultsFile(false, '2026-09-25-a'),
        exists: (f) => f === guards.resultsFile(false, '2026-09-25-a', { partial: true }),
      }),
    ).toBeNull();
  });

  it('checks for existing evidence in every mode, before anything reads a credential', () => {
    const src = readFileSync(join(ROOT, 'bench', 'calibrate-aws.cjs'), 'utf8');
    const main = src.indexOf('async function main');
    const check = src.indexOf('evidenceConflict(', main);
    expect(check, 'the harness no longer checks for existing evidence').toBeGreaterThan(main);
    // Before the projection-only return, so a dry run with a used id says so too.
    expect(check).toBeLessThan(src.indexOf("if (MODE === 'project')", main));
    expect(check).toBeLessThan(src.indexOf('await identity(', main));
    expect(check).toBeLessThan(src.indexOf('new s3.CreateBucketCommand', main));
    expect(src.indexOf('checkRunId(runId)', main)).toBeLessThan(check);
  });

  // The CloudShell script runs the harness from a scratch copy, where this clone's evidence is out of sight — so the
  // write-once rule has to be applied by the script, before anything is installed or spent.
  it('the CloudShell script refuses a run id whose evidence is committed', () => {
    const sh = readFileSync(join(ROOT, 'bench', 'calibrate-cloudshell.sh'), 'utf8');
    const fn = /^refuse_committed_run_id\(\) \{[\s\S]*?^\}/m.exec(sh)?.[0];
    expect(fn, 'the script no longer defines refuse_committed_run_id').toBeDefined();
    // Called before the scratch directory exists, so a refusal leaves nothing behind.
    expect(sh.indexOf('\nrefuse_committed_run_id\n')).toBeGreaterThan(-1);
    expect(sh.indexOf('\nrefuse_committed_run_id\n')).toBeLessThan(
      sh.indexOf('WORK="$(mktemp -d)"'),
    );
    const clone = mkdtempSync(join(tmpdir(), 'calib-clone-'));
    try {
      mkdirSync(join(clone, 'bench', 'calibration'), { recursive: true });
      writeFileSync(join(clone, 'bench', 'calibration', '2026-09-23-94416.json'), '{}');
      const run = (id: string): ReturnType<typeof spawnSync> =>
        spawnSync('bash', ['-c', `${fn}\nrefuse_committed_run_id\necho ran`], {
          cwd: clone,
          env: { PATH: process.env.PATH ?? '', CR_CALIBRATE_RUN_ID: id },
          encoding: 'utf8',
        });
      const committed = run('2026-09-23-94416');
      expect(committed.status).toBe(2);
      expect(committed.stderr).toMatch(/committed evidence/);
      expect(run('2026-09-24-a').stdout).toContain('ran');
    } finally {
      rmSync(clone, { recursive: true, force: true });
    }
  });

  // What `finish()` does on the way out decides whether a paid run's results survive, so it is run, not read.
  it("the CloudShell script's exit copies every result out, overwrites nothing, and keeps what it cannot copy", () => {
    const sh = readFileSync(join(ROOT, 'bench', 'calibrate-cloudshell.sh'), 'utf8');
    const fn = /^finish\(\) \{[\s\S]*?^\}/m.exec(sh)?.[0];
    expect(fn, 'the script no longer defines finish').toBeDefined();
    const root = mkdtempSync(join(tmpdir(), 'calib-finish-'));
    try {
      const work = join(root, 'work');
      const home = join(root, 'home');
      mkdirSync(join(work, 'bench', 'calibration'), { recursive: true });
      mkdirSync(home);
      writeFileSync(join(work, 'bench', 'calibration', '2026-09-24-a.json'), 'evidence');
      writeFileSync(join(work, 'bench', 'calibration', '2026-09-24-b.partial.json'), 'partial');
      writeFileSync(
        join(work, 'bench', guards.resultsFile(true).split('/').pop() ?? ''),
        'rehearsal',
      );
      writeFileSync(join(home, '2026-09-24-b.partial.json'), 'an older copy');
      const out = spawnSync('bash', ['-c', `set -euo pipefail\n${fn}\nfinish`], {
        env: { PATH: process.env.PATH ?? '', WORK: work, HOME: home },
        encoding: 'utf8',
      });
      expect(out.status).toBe(0);
      expect(readFileSync(join(home, '2026-09-24-a.json'), 'utf8')).toBe('evidence');
      expect(
        readFileSync(join(home, guards.resultsFile(true).split('/').pop() ?? ''), 'utf8'),
      ).toBe('rehearsal');
      // The file already in $HOME is left alone, so the scratch directory holding this run's copy is kept.
      expect(readFileSync(join(home, '2026-09-24-b.partial.json'), 'utf8')).toBe('an older copy');
      expect(existsSync(join(work, 'bench', 'calibration', '2026-09-24-b.partial.json'))).toBe(
        true,
      );
      expect(out.stderr).toMatch(/left alone/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // A rehearsal with --run ran the real identity check against whatever credentials the environment held. The pair
  // is refused before the harness imports anything — run with no credentials and no confirmation, so even a broken
  // refusal cannot get past the next check.
  it('refuses --rehearse with --run before doing anything', () => {
    const out = spawnSync(
      process.execPath,
      [join(ROOT, 'bench', 'calibrate-aws.cjs'), '--rehearse', '--run'],
      {
        env: { PATH: process.env.PATH ?? '' },
        encoding: 'utf8',
      },
    );
    expect(out.status).toBe(2);
    expect(out.stderr).toMatch(/exclusive/);
  });

  it('tears down on a hang-up too, and records the object apart from the bytes a load uploaded', () => {
    const src = readFileSync(join(ROOT, 'bench', 'calibrate-aws.cjs'), 'utf8');
    expect(src).toContain("for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'])");
    expect(src).toContain('objectBytes: size');
    expect(src).toContain('medianObjectBytes: median(xs.map((l) => l.objectBytes))');
    expect(src).toContain('medianUploadBytes: median(xs.map((l) => l.uploadBytes))');
  });
});

// The meter runs at the SDK's `initialize` step, and the SDK's retry loop sits further in, at `finalizeRequest` —
// so one call through the meter can be several requests on the wire. It once claimed to count retries "as AWS
// bills them" and counted each send once. These drive the REAL SDK retry path against a local server that
// answers 503 until told otherwise, so the claim is tested against the SDK's behaviour rather than restated.
describe('the meter counts every attempt the SDK makes, not every send', () => {
  const s3 = require_('@aws-sdk/client-s3') as {
    S3Client: new (cfg: Record<string, unknown>) => {
      send: (c: unknown) => Promise<unknown>;
      destroy: () => void;
    };
    HeadBucketCommand: new (i: { Bucket: string }) => unknown;
  };

  /** A stand-in S3 that fails the first `failures` requests with 503, then answers 200. */
  async function flakyS3(
    failures: number,
  ): Promise<{ url: string; hits: () => number; close: () => Promise<void> }> {
    let hits = 0;
    const server = createServer((_req, res) => {
      hits += 1;
      res.writeHead(hits <= failures ? 503 : 200, { 'content-length': '0' });
      res.end();
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const { port } = server.address() as AddressInfo;
    return {
      url: `http://127.0.0.1:${port}`,
      hits: () => hits,
      close: () => new Promise<void>((done) => server.close(() => done())),
    };
  }

  const clientFor = (url: string, maxAttempts: number) =>
    new s3.S3Client({
      endpoint: url,
      region: 'us-east-1',
      forcePathStyle: true,
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
      maxAttempts,
    });

  it('counts a retried request once per attempt', async () => {
    const server = await flakyS3(1);
    const client = clientFor(server.url, 3);
    const tally = meterLib.meter(client);
    try {
      await client.send(new s3.HeadBucketCommand({ Bucket: 'b' }));
      expect(server.hits()).toBe(2); // the premise: the SDK really did retry
      expect(tally.get).toBe(2);
      expect(tally.byCommand.HeadBucketCommand).toBe(2);
    } finally {
      client.destroy();
      await server.close();
    }
  });

  it('counts every attempt of a request that failed for good', async () => {
    const server = await flakyS3(Number.POSITIVE_INFINITY);
    const client = clientFor(server.url, 2);
    const tally = meterLib.meter(client);
    try {
      await expect(client.send(new s3.HeadBucketCommand({ Bucket: 'b' }))).rejects.toBeDefined();
      expect(server.hits()).toBe(2);
      expect(tally.get).toBe(2);
    } finally {
      client.destroy();
      await server.close();
    }
  });

  const baseFor = (url: string): Record<string, unknown> => ({
    endpoint: url,
    region: 'us-east-1',
    forcePathStyle: true,
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  });

  it('meters a second client into the same bill', async () => {
    const one = await flakyS3(0);
    const two = await flakyS3(1);
    const a = clientFor(one.url, 3);
    const b = clientFor(two.url, 3);
    const tally = meterLib.meter(a);
    meterLib.meter(b, tally);
    try {
      await a.send(new s3.HeadBucketCommand({ Bucket: 'b' }));
      await b.send(new s3.HeadBucketCommand({ Bucket: 'b' }));
      expect(tally.get).toBe(3);
    } finally {
      a.destroy();
      b.destroy();
      await one.close();
      await two.close();
    }
  });

  // The workload's client makes ONE attempt: the projection has no term for its retries, and a retry's backoff
  // would sit inside a latency sample unseen. Driven against the failing server rather than read from the source,
  // because an explicit `retryStrategy` beside `maxAttempts: 1` would pass a regex and still retry.
  it('the workload client fails on a transient error instead of retrying', async () => {
    const server = await flakyS3(1);
    const client = new s3.S3Client(guards.clientConfigs(baseFor(server.url)).work);
    try {
      await expect(client.send(new s3.HeadBucketCommand({ Bucket: 'b' }))).rejects.toBeDefined();
      expect(server.hits()).toBe(1);
    } finally {
      client.destroy();
      await server.close();
    }
  });

  // Teardown keeps its retries. The one-attempt pin once reached it too, and a single 503 on `ListObjectVersions`
  // then left the bucket and everything in it behind.
  it('the teardown client retries, so one transient error cannot leave the bucket behind', async () => {
    const server = await flakyS3(1);
    const client = new s3.S3Client(guards.clientConfigs(baseFor(server.url)).admin);
    try {
      await client.send(new s3.HeadBucketCommand({ Bucket: 'b' }));
      expect(server.hits()).toBe(2);
    } finally {
      client.destroy();
      await server.close();
    }
  });

  it('the harness builds exactly those two clients, meters both, and tears down with the retrying one', () => {
    const src = readFileSync(join(ROOT, 'bench', 'calibrate-aws.cjs'), 'utf8');
    // Each variable tied to its config, and the workload metered: a swap of the two configs, or a workload client
    // with a tally of its own, passed the looser version of these checks.
    expect(src.match(/new s3\.S3Client\(/g)?.length).toBe(2);
    expect(src).toContain('const client = new s3.S3Client(configs.work)');
    expect(src).toContain('const admin = new s3.S3Client(configs.admin)');
    expect(src).toContain('const tally = meter(client)');
    expect(src).toContain('meter(admin, tally)');
    const teardown = teardownSource(src);
    expect(teardown).toContain('admin.send(');
    expect(teardown).not.toMatch(/\bclient\b/);
  });

  // The store has a retry layer of its own, above the client's, and it re-runs a failed read INSIDE the timed
  // window. The client's one-attempt pin does not reach it, so the timed store turns it off.
  it("the timed reads run with the store's own retry off, and its pointer pinned", () => {
    expect(guards.TIMED_STORE.retry).toBe(false);
    expect(guards.TIMED_STORE.cache.genTtlMs).toBe(0);
    const src = readFileSync(join(ROOT, 'bench', 'calibrate-aws.cjs'), 'utf8');
    expect(src.match(/new CloudRoaring\(/g)?.length).toBe(1);
    expect(src).toMatch(/new CloudRoaring\(\{\s*storage,\s*\.\.\.TIMED_STORE\s*\}\)/);
  });

  it('counts a request that needed no retry exactly once', async () => {
    const server = await flakyS3(0);
    const client = clientFor(server.url, 3);
    const tally = meterLib.meter(client);
    try {
      await client.send(new s3.HeadBucketCommand({ Bucket: 'b' }));
      expect(server.hits()).toBe(1);
      expect(tally.get).toBe(1);
    } finally {
      client.destroy();
      await server.close();
    }
  });
});

/**
 * An object store for the registry protocol that counts its reads and writes, and loses the first `lostRaces`
 * conditional writes the way a concurrent writer would make them lose. Its writes fence for real.
 */
class CountingObjectStore implements ObjectRegistryStore {
  readonly label = 'counting';
  reads = 0;
  writes = 0;
  private readonly objects = new Map<string, { bytes: Uint8Array; version: number }>();
  private nextVersion = 1;

  constructor(private lostRaces: number) {}

  read(key: string): Promise<ObjectRow | null> {
    this.reads += 1;
    const found = this.objects.get(key);
    return Promise.resolve(
      found === undefined ? null : { bytes: found.bytes, version: String(found.version) },
    );
  }

  write(key: string, body: Uint8Array, expect: 'absent' | { version: string }): Promise<void> {
    this.writes += 1;
    if (this.lostRaces > 0) {
      this.lostRaces -= 1;
      return Promise.reject(new WriteConflictError(`lost race: ${key}`));
    }
    const found = this.objects.get(key);
    const holds =
      expect === 'absent'
        ? found === undefined
        : found !== undefined && String(found.version) === expect.version;
    if (!holds) return Promise.reject(new WriteConflictError(`precondition failed: ${key}`));
    this.objects.set(key, { bytes: body, version: this.nextVersion++ });
    return Promise.resolve();
  }

  async *listKeys(prefix: string): AsyncIterable<string> {
    for (const key of this.objects.keys()) if (key.startsWith(prefix)) yield key;
  }
}

// A store re-reads a segment's pointer once `cache.genTtlMs` (2 s by default) has passed since it last read it —
// in the middle of an intersect, too. Run 2026-09-23-94416 was 83 ms from the region, its cold intersects took about
// 3 s, and the median one read both pointers twice: 206 GETs where the same intersect inside the region makes 204. A count
// that moves with the network is not a property of the library, and the projection had no term for it. These drive
// the real engine on a clock where every storage read takes three seconds.
describe("a cold intersect's request count does not depend on the network", () => {
  /** Wrap one method of `target` so `before` runs ahead of every call to it. */
  function around<T extends object>(target: T, methods: string[], before: () => void): T {
    return new Proxy(target, {
      get(t, prop, receiver) {
        const value: unknown = Reflect.get(t, prop, receiver);
        if (typeof value !== 'function') return value;
        const fn = value as (...args: unknown[]) => unknown;
        if (!methods.includes(String(prop))) return fn.bind(t);
        return (...args: unknown[]) => {
          before();
          return fn.apply(t, args);
        };
      },
    });
  }

  it("resolves each operand's pointer once when the store is built the way the harness builds it", async () => {
    const backend = new MemoryStorage();
    // One shared id in each of chunks 0, 1 and 2, and a private chunk each: three chunk reads per operand.
    const shared = [1, 65_537, 131_073];
    for (const [segment, own] of [
      ['a', 5 * 65_536],
      ['b', 7 * 65_536],
    ] as const) {
      await bulkLoadCrbmGeneration(backend.storage, { segment, generation: 0 }, [...shared, own], {
        registry: backend.registry,
      });
    }

    let now = 0;
    const clock = {
      now: (): number => now,
      sleep: (ms: number): Promise<void> => {
        now += Math.max(0, ms);
        return Promise.resolve();
      },
      yieldNow: (): Promise<void> => Promise.resolve(),
    };
    let pointerReads = 0;
    const registry = around(backend.registry, ['get'], () => {
      pointerReads += 1;
    });
    // Three seconds per storage read: longer than the default 2 s a store trusts a pointer for.
    const storage = around(backend.storage, ['getRange', 'getTail'], () => {
      now += 3_000;
    });

    const intersect = async (
      options: Record<string, unknown>,
    ): Promise<{ ids: number[]; pointerReads: number }> => {
      pointerReads = 0;
      const store = new CloudRoaring({
        storage: createBackend({ storage, registry }),
        ...options,
        seams: { clock },
      });
      const ids: number[] = [];
      for await (const id of store.segment('a').intersect([store.segment('b')])) ids.push(id);
      return { ids, pointerReads };
    };

    const byDefault = await intersect({ retry: false });
    const timed = await intersect(guards.TIMED_STORE);
    expect(byDefault.ids).toEqual(shared);
    expect(timed.ids).toEqual(shared);
    // On the default TTL the slow link reads the pointers again part-way through: the network is in the count.
    expect(byDefault.pointerReads).toBeGreaterThan(2);
    // Pinned, it is two — one per operand — however long the intersect takes.
    expect(timed.pointerReads).toBe(2);
  });
});

/** `target`, with every call to each of its methods counted in `counts` under the method's name. */
function counting<T extends object>(target: T, counts: Record<string, number>): T {
  return new Proxy(target, {
    get(t, prop, receiver) {
      const value: unknown = Reflect.get(t, prop, receiver);
      if (typeof value !== 'function') return value;
      const fn = value as (...args: unknown[]) => unknown;
      return (...args: unknown[]) => {
        counts[String(prop)] = (counts[String(prop)] ?? 0) + 1;
        return fn.apply(t, args);
      };
    },
  });
}

// The harness times `bulkLoadCrbmGeneration` with the generation number given: a load's write and its publish.
// `store.load()`, the one-call load the guide leads with, also works out the next generation from a listing, reads
// the current one's cardinality to guard against a shrink, and collects superseded generations after the publish.
// The benchmarks page says it should cost roughly twice as much, with no run behind the figure — so the requests it
// adds are counted here, against local drivers and the real registry protocol. On S3 a listing bills at the PUT rate.
describe('what the harness does not measure: store.load()', () => {
  it('lists twice, and reads the pointer four more times, beyond a write and publish', async () => {
    const storageCalls: Record<string, number> = {};
    const pointer = new CountingObjectStore(0);
    const store = new CloudRoaring({
      storage: createBackend({
        storage: counting(new MemoryStorageDriver(), storageCalls),
        registry: new ObjectStoreRegistry(pointer, undefined, () => 0),
      }),
    });
    const load = async (ids: number[]): Promise<Record<string, number>> => {
      for (const k of Object.keys(storageCalls)) delete storageCalls[k];
      pointer.reads = 0;
      pointer.writes = 0;
      const result = await store.load({ namespace: 'ns', segment: 's' }, ids);
      expect(result.published).toBe(true);
      return {
        putImmutable: storageCalls.putImmutable ?? 0,
        list: storageCalls.list ?? 0,
        getTail: storageCalls.getTail ?? 0,
        getRange: storageCalls.getRange ?? 0,
        delete: storageCalls.delete ?? 0,
        pointerReads: pointer.reads,
        pointerWrites: pointer.writes,
      };
    };
    // A write and publish alone is 1 object write, 1 pointer write and 3 pointer reads (the test above). A segment's
    // first load through store.load() adds two listings and four pointer reads.
    const first = await load([1, 2, 3]);
    expect(first).toEqual({
      putImmutable: 1,
      list: 2,
      getTail: 0,
      getRange: 0,
      delete: 0,
      pointerReads: 7,
      pointerWrites: 1,
    });
    // A reload also opens the current generation's index, to count what the load would replace.
    const reload = await load([1, 2, 3, 4]);
    expect(reload).toEqual({
      putImmutable: 1,
      list: 2,
      getTail: 1,
      getRange: 0,
      delete: 0,
      pointerReads: 7,
      pointerWrites: 1,
    });
    // From the third load on, the collection pass has a generation to delete, and re-reads the pointer before it.
    const collecting = await load([1, 2, 3, 4, 5]);
    expect(collecting).toEqual({
      putImmutable: 1,
      list: 2,
      getTail: 1,
      getRange: 0,
      delete: 1,
      pointerReads: 8,
      pointerWrites: 1,
    });
    // The published figures price these three, so they must be these three. In a single-bucket store on S3 the
    // object, the listings and the pointer bill as PUT-class requests, every read as a GET, and a delete is free.
    const billed = (c: Record<string, number>): { put: number; get: number } => ({
      put: (c.putImmutable ?? 0) + (c.list ?? 0) + (c.pointerWrites ?? 0),
      get: (c.pointerReads ?? 0) + (c.getTail ?? 0) + (c.getRange ?? 0),
    });
    expect({
      first: billed(first),
      reload: billed(reload),
      collecting: billed(collecting),
    }).toEqual(calibrationFigures.STORE_LOAD_REQUESTS);
  });
});

/** The harness's teardown function, comments stripped — what the structural checks below read. */
function teardownSource(src: string): string {
  return src
    .slice(src.indexOf('const teardown = () =>'), src.indexOf('return teardownPromise;'))
    .replace(/\/\/.*$/gm, '');
}

// Teardown is the one path whose failure leaves money on the table, so what counts as "done" is spelled out here.
// Each rule below is a bug a fault-injecting proxy in front of MinIO reproduced: a lost-answer abort whose retry
// got 404 NoSuchUpload made teardown skip the deletes and report nothing; and a key that could never be deleted
// made the listing loop bill forever.
describe('teardown — what counts as done', () => {
  it('treats only NoSuchBucket as the bucket being gone', () => {
    expect(guards.bucketIsGone({ name: 'NoSuchBucket', $metadata: { httpStatusCode: 404 } })).toBe(
      true,
    );
    expect(guards.bucketIsGone({ Code: 'NoSuchBucket' })).toBe(true);
    // Every other 404 is someone else's "not found" — above all an abort's NoSuchUpload.
    expect(guards.bucketIsGone({ name: 'NoSuchUpload', $metadata: { httpStatusCode: 404 } })).toBe(
      false,
    );
    expect(guards.bucketIsGone({ name: 'NotFound', $metadata: { httpStatusCode: 404 } })).toBe(
      false,
    );
    expect(guards.bucketIsGone({ $metadata: { httpStatusCode: 404 } })).toBe(false);
    expect(guards.bucketIsGone({ name: 'AccessDenied', $metadata: { httpStatusCode: 403 } })).toBe(
      false,
    );
    expect(guards.bucketIsGone(undefined)).toBe(false);
  });

  it('treats an abort that finds its upload gone as done, and nothing else', () => {
    expect(guards.uploadIsGone({ name: 'NoSuchUpload', $metadata: { httpStatusCode: 404 } })).toBe(
      true,
    );
    expect(guards.uploadIsGone({ name: 'NoSuchBucket' })).toBe(false);
    expect(
      guards.uploadIsGone({ name: 'ServiceUnavailable', $metadata: { httpStatusCode: 503 } }),
    ).toBe(false);
    expect(guards.uploadIsGone(undefined)).toBe(false);
  });

  it('bounds its delete passes, and projects every listing they can make at every attempt', () => {
    expect(Number.isInteger(guards.TEARDOWN_PASSES) && guards.TEARDOWN_PASSES >= 1).toBe(true);
    // One ListMultipartUploads, a listing per pass, and the listing that finds the bucket empty — each at every
    // attempt the retrying client may make.
    expect(guards.TEARDOWN_PUTS).toBe(guards.ADMIN_ATTEMPTS * (1 + guards.TEARDOWN_PASSES + 1));
  });

  it('the harness applies those rules, and projects them', () => {
    const src = readFileSync(join(ROOT, 'bench', 'calibrate-aws.cjs'), 'utf8');
    const teardown = teardownSource(src);
    expect(teardown).toContain('bucketIsGone(');
    expect(teardown).not.toContain('probeMeansAbsent(');
    expect(teardown).toContain('uploadIsGone(');
    expect(teardown).toContain('TEARDOWN_PASSES');
    expect(src).toMatch(/fixedPuts:\s*1 \/\* CreateBucket \*\/ \+ TEARDOWN_PUTS/);
  });

  // An interrupt while CreateBucket is in flight used to meet the do-nothing handler, and exit without teardown.
  it('arms the interrupt handler before the bucket is created', () => {
    const src = readFileSync(join(ROOT, 'bench', 'calibrate-aws.cjs'), 'utf8');
    // Searched from `main`: the module-level default, `let onInterrupt = async () => {}`, sits before it and does
    // nothing — the first version of this check found that and passed.
    const main = src.indexOf('async function main');
    const armed = src.indexOf('onInterrupt = async', main);
    expect(main).toBeGreaterThan(-1);
    expect(armed).toBeGreaterThan(main);
    expect(armed).toBeLessThan(src.indexOf('new s3.CreateBucketCommand', main));
  });
});
