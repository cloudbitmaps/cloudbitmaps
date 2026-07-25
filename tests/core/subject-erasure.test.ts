import { randomBytes } from 'node:crypto';
import {
  CloudRoaring,
  CrbmColdChunkSource,
  MemoryColdDriver,
  MemoryRegistryDriver,
  MemoryWarmDriver,
  bulkLoadCrbmGeneration,
} from '@/index';
import type { GenKey, IColdDriver, IKeystore, SegmentRef } from '@/index';
import { InProcessKeystore } from '@/drivers/crypto';
import { TransientError, UnsupportedError, ValidationError } from '@/core/errors';

const OWNER = 'eraser-1';
const k = (): Uint8Array => randomBytes(32);

function world(keystore?: IKeystore) {
  const cold = new MemoryColdDriver();
  const warm = new MemoryWarmDriver();
  const registry = new MemoryRegistryDriver();
  // A FRESH store each call — the store's CrbmColdChunkSource pins its generation per lifetime, so a post-erase
  // read must use a new store to observe the newly-committed generation (the documented snapshot caveat). The
  // store is wired with the RAW driver + registry (+ keystore), so its lifecycle helpers reuse them — no deps
  // to re-pass.
  const read = (): CloudRoaring =>
    new CloudRoaring({ warm, cold, registry, keystore, retry: false });
  return { cold, warm, registry, read };
}

async function members(
  store: CloudRoaring,
  segment: string,
  namespace?: string,
): Promise<number[]> {
  const out: number[] = [];
  for await (const id of store.segment(segment, { namespace }).iterate()) out.push(id);
  return out;
}

/** Seed a registered generation for `segment` in namespace `ns` holding `ids`. */
async function seed(
  w: ReturnType<typeof world>,
  segment: string,
  ids: number[],
  namespace = 'ns',
  keystore?: IKeystore,
): Promise<void> {
  await bulkLoadCrbmGeneration(w.cold, { namespace, segment, generation: 0 }, ids, {
    registry: w.registry,
    keystore,
  });
}

/** Wrap a raw Cold driver so `getTail` (what compaction + a cold-resident `has()` read) rejects for one segment. */
function poisonColdReadOf(base: IColdDriver, segment: string): IColdDriver {
  return {
    capabilities: () => base.capabilities(),
    putImmutable: (key, wr) => base.putImmutable(key, wr),
    getRange: (key, o, l) => base.getRange(key, o, l),
    getTail: (key, m) =>
      key.segment === segment
        ? Promise.reject(new Error('poison cold read'))
        : base.getTail(key, m),
    delete: (key) => base.delete(key),
    list: (r) => base.list(r),
  };
}

describe('subjectReport', () => {
  it('returns exactly the segments the id is a member of', async () => {
    const w = world();
    await seed(w, 'a', [1, 2, 3]);
    await seed(w, 'b', [2, 3]); // no id 1
    await seed(w, 'c', [1, 9]);

    const report = await w.read().subjectReport(1, { allNamespaces: true });
    expect(report.scannedSegments).toBe(3);
    expect(report.segments.map((s) => s.segment).sort()).toEqual(['a', 'c']);
    expect(report.segments.every((s) => s.namespace === 'ns')).toBe(true);
  });

  it('respects the namespace filter', async () => {
    const w = world();
    await seed(w, 'a', [1], 'ns');
    await seed(w, 'a', [1], 'other');
    const report = await w.read().subjectReport(1, { namespace: 'ns' });
    expect(report.scannedSegments).toBe(1);
    expect(report.segments).toEqual([{ segment: 'a', namespace: 'ns' }]);
  });

  it('fails fast on a non-u32 id even with no registered segments', async () => {
    const w = world();
    // { allNamespaces: true } satisfies the scope guard so we reach — and actually exercise — id validation.
    await expect(w.read().subjectReport(-1, { allNamespaces: true })).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(w.read().subjectReport(2 ** 32, { allNamespaces: true })).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it('scans many segments under bounded concurrency and reports exactly the members (Phase E)', async () => {
    const w = world();
    for (let i = 0; i < 12; i++) await seed(w, `seg${i}`, i % 2 === 0 ? [1, 2] : [3]); // even segs hold id 1
    const report = await w.read().subjectReport(1, { namespace: 'ns', concurrency: 4 });
    expect(report.scannedSegments).toBe(12);
    expect(report.segments.map((s) => s.segment).sort()).toEqual(
      ['seg0', 'seg10', 'seg2', 'seg4', 'seg6', 'seg8'].sort(),
    );
  });

  it('rejects a bad concurrency before scanning, and fails loud on a read fault (Phase E)', async () => {
    const w = world();
    await seed(w, 'a', [1]);
    // Bad concurrency ⇒ fail fast (a SAR must not silently mis-scan). Scope ack so we reach concurrency validation.
    await expect(
      w.read().subjectReport(1, { allNamespaces: true, concurrency: 0 }),
    ).rejects.toBeInstanceOf(ValidationError);
    // A segment whose read faults must make the report THROW — never silently omit a (possible) member.
    const store = new CloudRoaring({
      warm: w.warm,
      cold: poisonColdReadOf(w.cold, 'a'), // raw cold → the facade wraps it; the registry resolves generations
      registry: w.registry,
      retry: false,
    });
    await expect(store.subjectReport(1, { namespace: 'ns' })).rejects.toThrow(/poison/);
  });
});

describe('Phase F — tenancy guard (global-scope admin scans)', () => {
  it('subjectReport/eraseSubject refuse a scan with no explicit scope', async () => {
    const w = world();
    await seed(w, 'a', [1]);
    // No `namespace` and no `allNamespaces` ack ⇒ a fleet-wide sweep is refused fail-fast.
    await expect(w.read().subjectReport(1)).rejects.toBeInstanceOf(ValidationError);
    await expect(w.read().eraseSubject(1, { owner: OWNER })).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it('a namespace or an { allNamespaces: true } ack satisfies the guard', async () => {
    const w = world();
    await seed(w, 'a', [1], 'ns');
    await expect(w.read().subjectReport(1, { namespace: 'ns' })).resolves.toMatchObject({
      segments: [{ segment: 'a', namespace: 'ns' }],
    });
    await expect(w.read().subjectReport(1, { allNamespaces: true })).resolves.toMatchObject({
      scannedSegments: 1,
    });
  });
});

describe('eraseSubject', () => {
  it('removes + physically purges the id from every member segment (fresh read confirms gone)', async () => {
    const w = world();
    await seed(w, 'a', [1, 2, 3]);
    await seed(w, 'b', [2, 3]);
    await seed(w, 'c', [1, 9]);

    const res = await w.read().eraseSubject(1, { owner: OWNER, allNamespaces: true });
    expect(res.scannedSegments).toBe(3);
    expect(res.erasedFrom.map((e) => e.segment).sort()).toEqual(['a', 'c']); // not 'b' (1 absent)
    for (const e of res.erasedFrom) {
      expect(e).toMatchObject({ removed: true, physicallyPurged: true, toGen: 1 });
      expect(e.note).toBeUndefined();
    }

    // A fresh store sees the id gone from its segments; unrelated members untouched.
    const store = w.read();
    expect(await members(store, 'a', 'ns')).toEqual([2, 3]);
    expect(await members(store, 'c', 'ns')).toEqual([9]);
    expect(await members(store, 'b', 'ns')).toEqual([2, 3]);
  });

  it('leaves non-member segments untouched (no spurious tombstone, not compacted)', async () => {
    const w = world();
    await seed(w, 'a', [1]);
    await seed(w, 'b', [2]); // id 1 absent

    await w.read().eraseSubject(1, { owner: OWNER, allNamespaces: true });
    // 'b' was never compacted → still at generation 0.
    expect((await w.registry.get({ segment: 'b', namespace: 'ns' }))!.currentGen).toBe(0);
    // 'a' advanced to a new generation.
    expect((await w.registry.get({ segment: 'a', namespace: 'ns' }))!.currentGen).toBe(1);
  });

  it('physically purges an idle/archival segment (P13 — organic compaction would never fire)', async () => {
    const w = world();
    await seed(w, 'archival', [1, 2, 3]); // written once, never touched again

    const res = await w.read().eraseSubject(2, { owner: OWNER, allNamespaces: true });
    expect(res.erasedFrom).toEqual([
      {
        segment: 'archival',
        namespace: 'ns',
        removed: true,
        physicallyPurged: true,
        toGen: 1,
        note: undefined,
      },
    ]);
    expect(await members(w.read(), 'archival', 'ns')).toEqual([1, 3]);
  });

  it('scopes to a namespace when given one', async () => {
    const w = world();
    await seed(w, 'a', [1], 'ns');
    await seed(w, 'a', [1], 'other');

    const res = await w.read().eraseSubject(1, { owner: OWNER, namespace: 'ns' });
    expect(res.scannedSegments).toBe(1);
    expect(await members(w.read(), 'a', 'ns')).toEqual([]);
    expect(await members(w.read(), 'a', 'other')).toEqual([1]); // untouched
  });

  it('works on an encrypted segment (reuses the DEK; fresh read confirms gone)', async () => {
    const keystore = new InProcessKeystore({ keys: { k1: k() }, activeKeyId: 'k1' });
    const w = world(keystore);
    await seed(w, 'enc', [1, 2, 3], 'ns', keystore);

    const res = await w.read().eraseSubject(2, { owner: OWNER, allNamespaces: true });
    expect(res.erasedFrom[0]).toMatchObject({ physicallyPurged: true, toGen: 1 });
    expect(await members(w.read(), 'enc', 'ns')).toEqual([1, 3]);
  });

  it('defers the physical purge honestly when a daemon holds the lease (leased-by-other)', async () => {
    const w = world();
    await seed(w, 'a', [1, 2]);
    const ref: SegmentRef = { segment: 'a', namespace: 'ns' };
    // Simulate a live foreign compaction lease.
    const rec = (await w.registry.get(ref))!;
    await w.registry.compareAndSwap(ref, rec.token, {
      status: 'compacting',
      leaseOwner: 'other-daemon',
      leaseExpiresAt: Date.now() + 1_000_000,
    });

    const res = await w.read().eraseSubject(1, { owner: OWNER, allNamespaces: true });
    expect(res.erasedFrom[0]).toMatchObject({
      removed: true,
      physicallyPurged: false,
      note: 'leased-by-other',
    });
    expect(res.erasedFrom[0]?.toGen).toBeUndefined();
    // The logical removal still holds — a fresh read excludes the id (the tombstone remains until the daemon purges).
    expect(await members(w.read(), 'a', 'ns')).toEqual([2]);
  });

  it('fails fast on a non-u32 id even with no registered segments', async () => {
    const w = world();
    await expect(
      w.read().eraseSubject(-5, { owner: OWNER, allNamespaces: true }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('rejects a bad concurrency before scanning (Phase E)', async () => {
    const w = world();
    await seed(w, 'a', [1]);
    await expect(
      w.read().eraseSubject(1, { owner: OWNER, allNamespaces: true, concurrency: 0 }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('isolates a per-segment compaction fault under concurrent fan-out — the ledger stays complete (Phase E)', async () => {
    const cold0 = new MemoryColdDriver();
    const warm = new MemoryWarmDriver();
    const registry = new MemoryRegistryDriver();
    // Three registered members; poison only the COLD READ of `poison`, which bites during its compaction (not
    // its has(): id 1 is a Warm add, so has() resolves warm-only, no cold read).
    for (const s of ['a', 'b', 'poison']) {
      await bulkLoadCrbmGeneration(cold0, { namespace: 'ns', segment: s, generation: 0 }, [999], {
        registry,
      });
    }
    const cold: IColdDriver = {
      capabilities: () => cold0.capabilities(),
      putImmutable: (key, wr) => cold0.putImmutable(key, wr),
      getRange: (key, o, l) => cold0.getRange(key, o, l),
      getTail: (key, m) =>
        key.segment === 'poison'
          ? Promise.reject(new Error('poison cold read'))
          : cold0.getTail(key, m),
      delete: (key) => cold0.delete(key),
      list: (r) => cold0.list(r),
    };
    const store = new CloudRoaring({ warm, cold, registry, retry: false });
    for (const s of ['a', 'b', 'poison']) await store.segment(s, { namespace: 'ns' }).add(1); // warm member

    const res = await store.eraseSubject(1, { owner: OWNER, namespace: 'ns', concurrency: 3 });

    expect(res.scannedSegments).toBe(3);
    const byName = new Map(res.erasedFrom.map((e) => [e.segment, e]));
    expect(byName.get('a')).toMatchObject({ removed: true, physicallyPurged: true });
    expect(byName.get('b')).toMatchObject({ removed: true, physicallyPurged: true });
    // The poison segment's fault is isolated: recorded, not thrown — one bad segment never aborts the ledger.
    expect(byName.get('poison')).toMatchObject({ physicallyPurged: false });
    expect(byName.get('poison')?.note).toMatch(/^error:/);
  });

  it('isolates a membership has() fault too — the ledger still records it (Phase E)', async () => {
    // A fault in the *membership* check (not just compaction) must also be caught + recorded, not abort the
    // whole erasure. Here id 1 is COLD-resident, so has() reads cold — poison that read for `poison`.
    const w = world();
    await seed(w, 'ok', [1]);
    await seed(w, 'poison', [1]);
    const cold = poisonColdReadOf(w.cold, 'poison');
    const store = new CloudRoaring({ warm: w.warm, cold, registry: w.registry, retry: false });
    const res = await store.eraseSubject(1, { owner: OWNER, namespace: 'ns', concurrency: 2 });
    const byName = new Map(res.erasedFrom.map((e) => [e.segment, e]));
    expect(byName.get('ok')).toMatchObject({ removed: true, physicallyPurged: true });
    expect(byName.get('poison')?.note).toMatch(/^error:/); // has() fault recorded, not thrown
    expect(res.scannedSegments).toBe(2);
  });
});

describe('compact (store method)', () => {
  it("compacts a dirty segment in place using the store's own drivers", async () => {
    const w = world();
    await seed(w, 'a', [1, 2, 3]); // gen 0 published
    // Create a Warm delta so the segment is dirty (compaction has something to fold).
    const store = w.read();
    await store.segment('a', { namespace: 'ns' }).add(4);
    await store.segment('a', { namespace: 'ns' }).remove(2);

    const res = await store.compact({ segment: 'a', namespace: 'ns' }, { owner: OWNER });
    expect(res.compacted).toBe(true);
    expect(res.toGen).toBe(1);
    // Prove a real commit happened (not just a read-time tier-merge of the still-live Warm delta): the store's
    // OWN registry advanced its currentGen. A no-op compact returning {compacted:true} would leave this at 0.
    expect((await w.registry.get({ segment: 'a', namespace: 'ns' }))!.currentGen).toBe(1);
    // A fresh store reads the compacted generation: {1,3,4} (added 4, removed 2).
    expect(await members(w.read(), 'a', 'ns')).toEqual([1, 3, 4]);
  });

  it('is a no-op on a clean segment (nothing dirty)', async () => {
    const w = world();
    await seed(w, 'a', [1, 2, 3]);
    const res = await w.read().compact({ segment: 'a', namespace: 'ns' }, { owner: OWNER });
    expect(res.compacted).toBe(false);
    expect(res.reason).toBe('clean');
    expect((await w.registry.get({ segment: 'a', namespace: 'ns' }))!.currentGen).toBe(0); // untouched
  });

  it('validates the segment ref', async () => {
    const w = world();
    await expect(w.read().compact({ segment: '../bad' }, { owner: OWNER })).rejects.toBeInstanceOf(
      ValidationError,
    );
  });
});

describe('lifecycle helpers require a raw cold driver + registry', () => {
  it('throws UnsupportedError when the store was built with a pre-built ColdChunkSource', async () => {
    const cold = new MemoryColdDriver();
    const registry = new MemoryRegistryDriver();
    await bulkLoadCrbmGeneration(cold, { segment: 'a', generation: 0 }, [1, 2, 3], { registry });
    // A pre-built-source store has no raw IColdDriver to compact through (and can't carry a top-level registry).
    const store = new CloudRoaring({
      warm: new MemoryWarmDriver(),
      cold: new CrbmColdChunkSource(cold, { registry }),
      retry: false,
    });
    // Pre-built source → no raw driver: compact/eraseSubject fire the cold-driver guard; subjectReport
    // (registry-only) fires the registry guard. Distinct messages pin which clause fired.
    await expect(store.compact({ segment: 'a' }, { owner: OWNER })).rejects.toThrow(
      UnsupportedError,
    );
    await expect(store.eraseSubject(1, { owner: OWNER, allNamespaces: true })).rejects.toThrow(
      /raw cold driver/,
    );
    await expect(store.subjectReport(1)).rejects.toThrow(/registry/);
  });

  it('throws UnsupportedError when the store has no registry', async () => {
    // Raw driver present but no registry → all three fire the registry guard.
    const store = new CloudRoaring({ warm: new MemoryWarmDriver(), cold: new MemoryColdDriver() });
    await expect(store.compact({ segment: 'a' }, { owner: OWNER })).rejects.toThrow(/registry/);
    await expect(store.eraseSubject(1, { owner: OWNER, allNamespaces: true })).rejects.toThrow(
      UnsupportedError,
    );
    await expect(store.subjectReport(1)).rejects.toThrow(UnsupportedError);
  });
});

/** A cold driver whose WRITES fail — to exercise per-segment fault isolation during force-compaction. */
class ColdWritesFail implements IColdDriver {
  constructor(private readonly inner: MemoryColdDriver) {}
  capabilities() {
    return this.inner.capabilities();
  }
  putImmutable(): Promise<{ size: number; sha256: string }> {
    return Promise.reject(new TransientError('injected cold-write fault'));
  }
  getRange(key: GenKey, offset: number, length: number): Promise<Uint8Array> {
    return this.inner.getRange(key, offset, length);
  }
  getTail(key: GenKey, maxBytes: number): Promise<{ bytes: Uint8Array; size: number }> {
    return this.inner.getTail(key, maxBytes);
  }
  delete(key: GenKey): Promise<void> {
    return this.inner.delete(key);
  }
  list(ref: SegmentRef): AsyncIterable<GenKey> {
    return this.inner.list(ref);
  }
}

describe('eraseSubject — robustness (fault isolation & fail-fast)', () => {
  it('isolates a per-segment force-compaction fault: ledger survives, logical removal holds', async () => {
    const inner = new MemoryColdDriver();
    const warm = new MemoryWarmDriver();
    const registry = new MemoryRegistryDriver();
    await bulkLoadCrbmGeneration(inner, { segment: 'a', generation: 0 }, [1, 2, 3], { registry });
    await bulkLoadCrbmGeneration(inner, { segment: 'b', generation: 0 }, [1, 4], { registry });
    // Cold WRITES fail → every force-compaction throws; a single throw must NOT discard the whole ledger.
    const store = new CloudRoaring({
      warm,
      cold: new ColdWritesFail(inner),
      registry,
      retry: false,
    });

    const res = await store.eraseSubject(1, { owner: OWNER, allNamespaces: true });
    expect(res.erasedFrom).toHaveLength(2); // both member segments recorded, not lost to the first throw
    for (const e of res.erasedFrom) {
      expect(e.removed).toBe(true); // logical removal committed
      expect(e.physicallyPurged).toBe(false); // physical purge failed — honestly reported
      expect(e.note).toMatch(/^error:/);
    }
    // The logical removal held (a fresh read over the real driver excludes id 1); the purge is recovered with
    // store.compact(ref) — NOT by re-running eraseSubject (has() now reads false).
    const read = new CloudRoaring({ warm, cold: inner, registry, retry: false });
    expect(await members(read, 'a')).toEqual([2, 3]);
    expect(await members(read, 'b')).toEqual([4]);
  });

  it('fails fast on a bad owner BEFORE writing any tombstone', async () => {
    const w = world();
    await seed(w, 'a', [1, 2, 3]);
    await expect(w.read().eraseSubject(1, { owner: '' })).rejects.toThrow(ValidationError);
    // No tombstone written, no compaction: the id is still present and currentGen is unchanged.
    expect((await w.registry.get({ segment: 'a', namespace: 'ns' }))!.currentGen).toBe(0);
    expect(await members(w.read(), 'a', 'ns')).toEqual([1, 2, 3]);
  });

  it('works with retry left ON (default) — lifecycle deps share the store’s warm instance', async () => {
    const cold = new MemoryColdDriver();
    const warm = new MemoryWarmDriver();
    const registry = new MemoryRegistryDriver();
    await bulkLoadCrbmGeneration(cold, { segment: 'a', generation: 0 }, [1, 2, 3], { registry });
    // retry ON: the engine's remove() writes through RetryingWarmDriver; compaction reads/purges through the raw
    // warm. This passes only because that wrapper is a pass-through over the SAME instance (DECISIONS #30).
    const res = await new CloudRoaring({ warm, cold, registry }).eraseSubject(1, {
      owner: OWNER,
      allNamespaces: true,
    });
    expect(res.erasedFrom[0]).toMatchObject({ removed: true, physicallyPurged: true, toGen: 1 });
    expect(await members(new CloudRoaring({ warm, cold, registry, retry: false }), 'a')).toEqual([
      2, 3,
    ]);
  });
});
