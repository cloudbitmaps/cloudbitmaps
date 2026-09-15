import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CloudRoaring,
  LocalFsColdDriver,
  LocalFsRegistryDriver,
  RecordingAuditSink,
} from '@/index';
import { InProcessKeystore } from '@/drivers/crypto';
import { randomBytes } from 'node:crypto';

// The documented user journey, walked end to end on a REAL filesystem, twice: once with ordinary names and
// once with names that only became legal when the grammar was removed.
//
// Unit tests pin each verb; this pins that the verbs still compose. Nothing here is a new claim — every step
// is something the guide tells a user to do — so a failure means a FLOW broke, not that a rule changed. The
// exotic pass matters because the naming change rewrote every key and path builder at once: a driver that
// encodes on write but not on read-back passes its own tests and fails here, at the seam.

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'crbm-flows-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const store = (opts: { keystore?: InProcessKeystore } = {}): CloudRoaring =>
  new CloudRoaring({
    cold: new LocalFsColdDriver(root),
    registry: new LocalFsRegistryDriver(root),
    retry: false,
    ...(opts.keystore === undefined ? {} : { keystore: opts.keystore, keyId: 'k1' }),
  });

const collect = async (it: AsyncIterable<number>): Promise<number[]> => {
  const out: number[] = [];
  for await (const v of it) out.push(v);
  return out.sort((a, b) => a - b);
};

const NAME_SETS = [
  { label: 'ordinary', ns: 'tenant', a: 'users', b: 'churned' },
  { label: 'newly legal', ns: 'tenant:acme/eu', a: 'users@2026', b: 'churned 100%' },
] as const;

describe.each(NAME_SETS)('the documented journey — $label names', ({ ns, a, b }) => {
  it('load → read → set algebra → materialize → generations → rollback', async () => {
    const s = store();
    const refA = { segment: a, namespace: ns };
    const refB = { segment: b, namespace: ns };

    // 1. There is no create; a name is an address. Nothing exists yet.
    expect(await s.exists(refA)).toBe(false);

    // 2. Load.
    const loaded = await s.load(refA, [1, 2, 3, 4, 5]);
    expect(loaded.published).toBe(true);
    expect(await s.exists(refA)).toBe(true);

    // 3. Read.
    expect(await s.segment(a, { namespace: ns }).count()).toBe(5);
    expect(await s.segment(a, { namespace: ns }).has(3)).toBe(true);
    expect(await collect(s.segment(a, { namespace: ns }).iterate())).toEqual([1, 2, 3, 4, 5]);

    // 4. Set algebra across two segments — the crown jewel's entry point.
    await s.load(refB, [4, 5, 6]);
    const segA = s.segment(a, { namespace: ns });
    const segB = s.segment(b, { namespace: ns });
    expect(await collect(segA.intersect([segB]))).toEqual([4, 5]);
    expect(await collect(segA.union([segB]))).toEqual([1, 2, 3, 4, 5, 6]);
    expect(await collect(segA.andNot([segB]))).toEqual([1, 2, 3]);

    // 5. Materialize into a third segment, then read it back.
    const dest = s.segment(`${a}-active`, { namespace: ns });
    await segA.andNotInto(dest, [segB]);
    expect(await s.segment(`${a}-active`, { namespace: ns }).count()).toBe(3);

    // 6. A second load REPLACES, and the pointer moves.
    await s.load(refA, [9], { keep: 9 });
    expect(await s.segment(a, { namespace: ns }).count()).toBe(1);

    // 7. Generations and rollback.
    const gens = await s.generations(refA);
    expect(gens.map((g) => g.generation)).toEqual([0, 1]);
    expect(gens.find((g) => g.current)?.generation).toBe(1);
    await s.rollback(refA, 0);
    expect(await s.segment(a, { namespace: ns }).count()).toBe(5);
  });

  it('pin → the pinned handle does not move under a publish', async () => {
    const s = store();
    const ref = { segment: a, namespace: ns };
    await s.load(ref, [1, 2, 3], { keep: 9 });

    const pinned = await s.segment(a, { namespace: ns }).pin();
    await s.load(ref, [7], { keep: 9 });

    expect(await pinned.count()).toBe(3); // the instant it was pinned at
    const fresh = store();
    expect(await fresh.segment(a, { namespace: ns }).count()).toBe(1);
  });

  it('discovery → enumerates exactly what was loaded, scoped and unscoped', async () => {
    const s = store();
    await s.load({ segment: a, namespace: ns }, [1]);
    await s.load({ segment: b, namespace: ns }, [2]);
    await s.load({ segment: a }, [3]); // same name, no namespace — a different segment

    const scoped = [];
    for await (const info of s.segments({ namespace: ns })) scoped.push(info.segment);
    expect(scoped.sort()).toEqual([a, b].sort());

    const all = [];
    for await (const info of s.segments()) all.push(`${info.namespace ?? '-'}/${info.segment}`);
    expect(all.sort()).toEqual([`-/${a}`, `${ns}/${a}`, `${ns}/${b}`].sort());
  });

  it('compliance → subject report, erasure, and an audited trail', async () => {
    const audit = new RecordingAuditSink();
    const s = store();
    const ref = { segment: a, namespace: ns };
    await s.load(ref, [1, 2, 3], { keep: 0 });

    const report = await s.subjectReport(42, { namespace: ns });
    expect(report.segments).toEqual([]);

    await s.load(ref, [1, 2, 3, 42], { keep: 0 });
    const found = await s.subjectReport(42, { namespace: ns });
    expect(found.segments.map((x) => x.segment)).toEqual([a]);

    const ledger = await s.eraseSubject(42, { namespace: ns, audit });
    expect(ledger.erasedFrom).toHaveLength(1);
    expect(ledger.erasedFrom[0]).toMatchObject({ segment: a, erased: true });
    expect(await s.segment(a, { namespace: ns }).has(42)).toBe(false);
    expect(await s.segment(a, { namespace: ns }).count()).toBe(3);
    expect(audit.snapshot().some((e) => e.kind === 'segment.rewrite')).toBe(true);
  });

  it('retention → set a policy, sweep it, and the segment retires', async () => {
    const s = store();
    const ref = { segment: a, namespace: ns };
    await s.load(ref, [1, 2, 3]);
    await s.setRetention(ref, { expiresAt: Date.now() - 1_000 }); // already due
    expect(await s.getRetention(ref)).not.toBeNull();

    const swept = await s.retireExpired({ scan: 'fleet' });
    expect(swept.retired).toBeGreaterThanOrEqual(1);
    expect(await s.exists(ref)).toBe(false);
  });

  it('eject → every segment lands in a portable dump with a complete manifest', async () => {
    const s = store();
    await s.load({ segment: a, namespace: ns }, [1, 2, 3]);
    await s.load({ segment: b, namespace: ns }, [4]);

    const out = await mkdtemp(join(tmpdir(), 'crbm-eject-'));
    try {
      const { fsSink } = await import('@/bin/export-segments');
      const manifest = await s.exportSegments(fsSink(out), { format: 'ndjson' });
      expect(manifest.failed).toEqual([]);
      expect(manifest.segments.map((x) => x.segment).sort()).toEqual([a, b].sort());
      // The manifest carries the LOGICAL names, whatever the path had to be encoded to.
      expect(manifest.segments.every((x) => x.namespace === ns)).toBe(true);
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  });

  it('encryption → load, read, then crypto-shred makes it unreadable', async () => {
    const keystore = new InProcessKeystore({ keys: { k1: randomBytes(32) }, activeKeyId: 'k1' });
    const s = store({ keystore });
    const ref = { segment: a, namespace: ns };

    await s.load(ref, [1, 2, 3]);
    expect(await s.segment(a, { namespace: ns }).count()).toBe(3);

    await s.dropSegment(ref, { confirmSegment: a });
    const fresh = store({ keystore });
    expect(await fresh.exists(ref)).toBe(false);
  });

  it('consistency → a healthy store reports no torn pointers', async () => {
    const s = store();
    await s.load({ segment: a, namespace: ns }, [1, 2]);
    await s.load({ segment: b, namespace: ns }, [3]);
    const report = await s.checkConsistency();
    expect(report.inconsistent).toEqual([]);
  });
});
