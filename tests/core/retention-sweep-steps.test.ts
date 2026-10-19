import { describe, expect, it } from 'vitest';
import { MIN_EXPIRES_AT_MS } from '@/core/retention';
import { ValidationError, WriteConflictError } from '@/core/errors';
import { DEFAULT_MAX_SCAN_SEGMENTS } from '@/core/registry-scan';
import {
  DEFAULT_LOOKBACK_BUCKETS,
  DEFAULT_RETIRE_LIMIT,
  MIN_TOMBSTONE_GRACE_MS,
  SweepTally,
  resolveRetireOptions,
} from '@/core/retention-sweep';

const NOW = MIN_EXPIRES_AT_MS + 86_400_000;

describe('resolveRetireOptions', () => {
  it('fills every default from just `now`', () => {
    expect(resolveRetireOptions({ now: NOW })).toEqual({
      audit: undefined,
      namespace: undefined,
      now: NOW,
      limit: DEFAULT_RETIRE_LIMIT,
      purgeTombstones: true,
      grace: 86_400_000,
      maxScanSegments: DEFAULT_MAX_SCAN_SEGMENTS,
      dryRun: false,
      scan: 'fleet',
      lookbackBuckets: DEFAULT_LOOKBACK_BUCKETS,
      shards: undefined,
      totalShards: 0,
    });
  });

  it('keeps what the caller set, and reads `dryRun` only when it is exactly true', () => {
    const shards = [0, 2];
    const resolved = resolveRetireOptions({
      now: NOW,
      limit: 5,
      purgeTombstones: false,
      tombstoneGraceMs: 3_600_000,
      scan: 'index',
      lookbackBuckets: 3,
      shards,
      totalShards: 3,
      dryRun: true,
    });
    expect(resolved).toMatchObject({
      limit: 5,
      purgeTombstones: false,
      grace: 3_600_000,
      scan: 'index',
      lookbackBuckets: 3,
      shards,
      totalShards: 3,
      dryRun: true,
    });
    expect(resolveRetireOptions({ now: NOW, dryRun: 1 as unknown as boolean }).dryRun).toBe(false);
  });

  it('does not touch its input', () => {
    const options = Object.freeze({ now: NOW, shards: Object.freeze([1]), totalShards: 2 });
    expect(() => resolveRetireOptions(options)).not.toThrow();
  });

  it.each([
    [{ now: NOW, audit: {} as never }, /audit must be a sink/],
    [{ now: NOW, shards: [0] }, /shards needs totalShards/],
    [{ now: NOW, shards: [2], totalShards: 2 }, /a shard/],
    [{ now: NOW, shards: 'x' as never, totalShards: 2 }, /shards must be an array/],
    [{ now: Number.NaN }, /`now`/],
    [{ now: 1_700_000_000 }, /almost certainly epoch SECONDS/],
    [{ now: NOW, limit: 0 }, /`limit`/],
    [{ now: NOW, tombstoneGraceMs: -1 }, /`tombstoneGraceMs`/],
    [{ now: NOW, maxScanSegments: 0 }, /`maxScanSegments`/],
    [{ now: NOW, scan: 'bogus' as never }, /`scan` must be 'fleet' or 'index'; got "bogus"/],
    [{ now: NOW, scan: 'idnex' as never }, /`scan` must be 'fleet' or 'index'; got "idnex"/],
    [{ now: NOW, scan: 'Index' as never }, /`scan` must be 'fleet' or 'index'; got "Index"/],
    [{ now: NOW, scan: null as never }, /`scan` must be 'fleet' or 'index'; got null/],
    [
      { now: NOW, lookbackBuckets: -1 },
      /`lookbackBuckets` must be an integer of at least 0; got -1/,
    ],
    [{ now: NOW, lookbackBuckets: 'x' as never }, /`lookbackBuckets` must be an integer/],
    [{ now: NOW, lookbackBuckets: null as never }, /`lookbackBuckets` must be an integer/],
    [
      { now: NOW, scan: 'index' as const, lookbackBuckets: 1.5 },
      /`lookbackBuckets` must be an integer/,
    ],
    [
      { now: NOW, tombstoneGraceMs: 0 },
      /`tombstoneGraceMs` must be a finite number of at least 3600000 \(one hour: .*; got 0$/,
    ],
    [{ now: NOW, tombstoneGraceMs: 3_599_999 }, /at least 3600000 .*; got 3599999$/],
    [{ now: NOW, tombstoneGraceMs: Infinity }, /`tombstoneGraceMs` must be a finite number/],
    [{ now: NOW, limit: null as never }, /`limit` must be an integer/],
    [{ now: NOW, tombstoneGraceMs: null as never }, /`tombstoneGraceMs` must be a finite number/],
    [{ now: NOW, shards: [], totalShards: 2 }, /shards is empty/],
    [{ now: NOW, shards: [0, 0], totalShards: 2 }, /shard 0 is listed twice/],
    [{ now: NOW, shards: [0, 1, 1], totalShards: 3 }, /shard 1 is listed twice/],
  ])('refuses %j', (options, message) => {
    expect(() => resolveRetireOptions(options)).toThrow(ValidationError);
    expect(() => resolveRetireOptions(options)).toThrow(message);
  });

  it('takes a tombstoneGraceMs of exactly one hour, and refuses it with purging off too', () => {
    expect(MIN_TOMBSTONE_GRACE_MS).toBe(3_600_000);
    expect(resolveRetireOptions({ now: NOW, tombstoneGraceMs: MIN_TOMBSTONE_GRACE_MS }).grace).toBe(
      3_600_000,
    );
    expect(() =>
      resolveRetireOptions({ now: NOW, tombstoneGraceMs: 1_000, purgeTombstones: false }),
    ).toThrow(/at least 3600000/);
    expect(() => resolveRetireOptions({ now: NOW, tombstoneGraceMs: 1_000, dryRun: true })).toThrow(
      /at least 3600000/,
    );
  });

  it('takes a lookbackBuckets of 0 and each scan', () => {
    expect(resolveRetireOptions({ now: NOW, lookbackBuckets: 0 }).lookbackBuckets).toBe(0);
    expect(resolveRetireOptions({ now: NOW, scan: 'fleet' }).scan).toBe('fleet');
    expect(resolveRetireOptions({ now: NOW, scan: 'index' }).scan).toBe('index');
  });

  it('reports the first bad option in the order the checks run', () => {
    expect(() => resolveRetireOptions({ now: 1, limit: 0 })).toThrow(
      /almost certainly epoch SECONDS/,
    );
    expect(() => resolveRetireOptions({ now: NOW, limit: 0, maxScanSegments: 0 })).toThrow(
      /`limit`/,
    );
  });
});

describe('SweepTally', () => {
  it('records an entry, and nothing for a step that has none', () => {
    const tally = new SweepTally();
    tally.add(null);
    tally.add({ segment: 's', action: 'skipped', reason: 'limit' });
    expect(tally.entries).toEqual([{ segment: 's', action: 'skipped', reason: 'limit' }]);
  });

  it('counts a refused delete and keeps the first one’s reason', () => {
    const tally = new SweepTally();
    tally.noteFault(new Error('Access Denied'));
    tally.noteFault(new Error('Throttled'));
    expect(tally.purgeFaults).toBe(2);
    expect(tally.firstPurgeFault).toBe('failed: Access Denied');
  });

  it('does not count a lost race as a fault', () => {
    const tally = new SweepTally();
    tally.noteFault(new WriteConflictError('row changed'));
    expect(tally.purgeFaults).toBe(0);
    expect(tally.firstPurgeFault).toBeUndefined();
  });

  it('gives a refused purge’s charge back and stops purging after three in a row', () => {
    const tally = new SweepTally();
    tally.attempted = 5;
    tally.refusedPurge();
    tally.refusedPurge();
    expect(tally.attempted).toBe(3);
    expect(tally.purging).toBe(true);
    tally.refusedPurge();
    expect(tally.attempted).toBe(2);
    expect(tally.purging).toBe(false);
  });
});
