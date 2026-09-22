import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Guards on a script that spends real money against a real cloud account. Every case below is a bug that
// actually happened in the harness this replaces — the one that ran the July 2026 calibration and was deleted
// with the warm tier, taking its regression suite with it. Rebuilt from the recorded post-mortem, because a
// guard nobody can plant a defect against is decoration.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const require_ = createRequire(import.meta.url);

const guards = require_(join(ROOT, 'bench', 'lib', 'calibrate-guards.cjs')) as {
  CONFIRM_PHRASE: string;
  parseCeiling: (raw: unknown) => number;
  resolveSize: (raw: unknown, fallback: number, label: string) => number;
  probeMeansAbsent: (err: unknown) => boolean;
  projectOps: (i: { loads: number; reads: number; chunksPerRead: number; retryBound: number }) => {
    put: number;
    get: number;
  };
  breached: (spent: number, ceiling: number) => boolean;
};

const meterLib = require_(join(ROOT, 'bench', 'lib', 'aws-meter.cjs')) as {
  classify: (command: string) => 'put' | 'get' | 'free';
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
