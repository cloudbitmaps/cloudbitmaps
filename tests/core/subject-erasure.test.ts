import { randomBytes } from 'node:crypto';
import {
  CloudRoaring,
  CrbmColdChunkSource,
  MemoryColdDriver,
  MemoryRegistryDriver,
  RecordingAuditSink,
  bulkLoadCrbmGeneration,
  destroySegment,
} from '@/index';
import type { BlobSink, GenKey, IColdDriver, IKeystore, SegmentRef } from '@/index';
import { InProcessKeystore } from '@/drivers/crypto';
import {
  BudgetExceededError,
  KeyUnavailableError,
  TransientError,
  UnsupportedError,
  ValidationError,
} from '@/core/errors';
import { collect, loadedStore } from '../helpers/loaded';

/**
 * `subjectReport` (Art. 15) and `eraseSubject` (Art. 17) — the store-level admin scans over every registered
 * segment.
 *
 * An erasure is a **rewrite**: for each segment the id is in, the current generation is streamed through with
 * that one bit cleared, published forward-only, and the generation that held the bit is deleted before the call
 * returns. So the ledger entry is `{ erased, fromGeneration, generation }` — and the assertions here check both
 * halves: the reads (a fresh reader no longer sees the id) and the bucket (the old object is gone).
 */

const NS = 'ns';
const k = (): Uint8Array => randomBytes(32);

async function world(keystore?: IKeystore) {
  const w = await loadedStore({}, { keystore, retry: false });
  // A FRESH store for every post-erase read: the fixture passes no clock, so a store pins a segment's resolved
  // generation (and its hot chunks) for its lifetime — the documented `coldGenTtlMs: 0` caveat. A reader that
  // touched the segment before the erase would keep answering from that snapshot.
  const reader = (): CloudRoaring =>
    new CloudRoaring({ cold: w.cold, registry: w.registry, keystore, retry: false });
  const seed = (segment: string, ids: number[], namespace = NS) =>
    w.load({ namespace, segment }, ids);
  return { ...w, reader, seed };
}

const members = (store: CloudRoaring, segment: string, namespace = NS): Promise<number[]> =>
  collect(store.segment(segment, { namespace }).iterate());

async function generations(cold: IColdDriver, ref: SegmentRef): Promise<number[]> {
  const gens: number[] = [];
  for await (const key of cold.list(ref)) gens.push(key.generation);
  return gens.sort((a, b) => a - b);
}

/** Wrap a raw Cold driver so `getTail` (what opening a generation reads first) rejects for one segment. */
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

/**
 * Forward every method to the real driver, overriding one. A Proxy rather than a spread-and-override: driver
 * methods live on the prototype and touch private fields, so a spread copies none of them.
 */
function hook<T extends object>(target: T, prop: string, impl: (...args: never[]) => unknown): T {
  return new Proxy(target, {
    get(t, p) {
      if (p === prop) return impl;
      const v = Reflect.get(t, p, t) as unknown;
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
    },
  });
}

describe('subjectReport', () => {
  it('returns exactly the segments the id is a member of', async () => {
    const w = await world();
    await w.seed('a', [1, 2, 3]);
    await w.seed('b', [2, 3]); // no id 1
    await w.seed('c', [1, 9]);

    const report = await w.reader().subjectReport(1, { allNamespaces: true });
    expect(report.scannedSegments).toBe(3);
    expect(report.segments.map((s) => s.segment).sort()).toEqual(['a', 'c']);
    expect(report.segments.every((s) => s.namespace === NS)).toBe(true);
  });

  it('respects the namespace filter', async () => {
    const w = await world();
    await w.seed('a', [1], 'ns');
    await w.seed('a', [1], 'other');
    const report = await w.reader().subjectReport(1, { namespace: 'ns' });
    expect(report.scannedSegments).toBe(1);
    expect(report.segments).toEqual([{ segment: 'a', namespace: 'ns' }]);
  });

  it('fails fast on a non-u32 id even with no registered segments', async () => {
    const w = await world();
    // { allNamespaces: true } satisfies the scope guard so we reach — and actually exercise — id validation.
    await expect(w.reader().subjectReport(-1, { allNamespaces: true })).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(w.reader().subjectReport(2 ** 32, { allNamespaces: true })).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it('scans many segments under bounded concurrency and reports exactly the members', async () => {
    const w = await world();
    for (let i = 0; i < 12; i++) await w.seed(`seg${i}`, i % 2 === 0 ? [1, 2] : [3]); // even segs hold id 1
    const report = await w.reader().subjectReport(1, { namespace: NS, concurrency: 4 });
    expect(report.scannedSegments).toBe(12);
    expect(report.segments.map((s) => s.segment).sort()).toEqual(
      ['seg0', 'seg10', 'seg2', 'seg4', 'seg6', 'seg8'].sort(),
    );
  });

  it('rejects a bad concurrency before scanning, and fails loud on a read fault', async () => {
    const w = await world();
    await w.seed('a', [1]);
    // Bad concurrency ⇒ fail fast (a SAR must not silently mis-scan). Scope ack so we reach concurrency validation.
    await expect(
      w.reader().subjectReport(1, { allNamespaces: true, concurrency: 0 }),
    ).rejects.toBeInstanceOf(ValidationError);
    // A segment whose read faults must make the report THROW — never silently omit a (possible) member.
    const store = new CloudRoaring({
      cold: poisonColdReadOf(w.cold, 'a'), // raw cold → the facade wraps it; the registry resolves generations
      registry: w.registry,
      retry: false,
    });
    await expect(store.subjectReport(1, { namespace: NS })).rejects.toThrow(/poison/);
  });
});

describe('tenancy guard (global-scope admin scans)', () => {
  it('subjectReport/eraseSubject refuse a scan with no explicit scope', async () => {
    const w = await world();
    await w.seed('a', [1]);
    // No `namespace` and no `allNamespaces` ack ⇒ a fleet-wide sweep is refused fail-fast.
    await expect(w.reader().subjectReport(1)).rejects.toBeInstanceOf(ValidationError);
    await expect(w.reader().eraseSubject(1)).rejects.toBeInstanceOf(ValidationError);
    expect(await members(w.reader(), 'a')).toEqual([1]); // and nothing was erased
  });

  it('a namespace or an { allNamespaces: true } ack satisfies the guard', async () => {
    const w = await world();
    await w.seed('a', [1], 'ns');
    await expect(w.reader().subjectReport(1, { namespace: 'ns' })).resolves.toMatchObject({
      segments: [{ segment: 'a', namespace: 'ns' }],
    });
    await expect(w.reader().subjectReport(1, { allNamespaces: true })).resolves.toMatchObject({
      scannedSegments: 1,
    });
  });
});

describe('eraseSubject', () => {
  it('rewrites every member segment without the id — gone from reads, gone from the bucket', async () => {
    const w = await world();
    await w.seed('a', [1, 2, 3]);
    await w.seed('b', [2, 3]);
    await w.seed('c', [1, 9]);

    const res = await w.reader().eraseSubject(1, { allNamespaces: true });

    expect(res.id).toBe(1);
    expect(res.scannedSegments).toBe(3);
    expect(res.erasedFrom.map((e) => e.segment).sort()).toEqual(['a', 'c']); // not 'b' (1 absent)
    for (const e of res.erasedFrom) {
      // The ledger shape: a rewrite from generation 0 to generation 1, nothing else on the entry.
      expect(e).toEqual({
        segment: e.segment,
        namespace: NS,
        erased: true,
        fromGeneration: 0,
        generation: 1,
        note: undefined,
      });
    }

    // Reads: a fresh store sees the id gone from its segments; unrelated members untouched.
    const store = w.reader();
    expect(await members(store, 'a')).toEqual([2, 3]);
    expect(await members(store, 'c')).toEqual([9]);
    expect(await members(store, 'b')).toEqual([2, 3]);
    expect(await store.segment('a', { namespace: NS }).has(1)).toBe(false);
    expect(await store.segment('a', { namespace: NS }).count()).toBe(2);
    expect(await store.segment('c', { namespace: NS }).count()).toBe(1);

    // The bucket: the generation that held the bit is physically gone on return; only the rewrite remains.
    expect(await generations(w.cold, { namespace: NS, segment: 'a' })).toEqual([1]);
    expect(await generations(w.cold, { namespace: NS, segment: 'c' })).toEqual([1]);
    expect((await w.registry.get({ namespace: NS, segment: 'a' }))!.currentGen).toBe(1);
  });

  it('leaves non-member segments untouched — not rewritten, not listed', async () => {
    const w = await world();
    await w.seed('a', [1]);
    await w.seed('b', [2]); // id 1 absent

    const res = await w.reader().eraseSubject(1, { allNamespaces: true });
    expect(res.erasedFrom.map((e) => e.segment)).toEqual(['a']);
    // 'b' was never rewritten → still at generation 0, with its original object.
    expect((await w.registry.get({ segment: 'b', namespace: NS }))!.currentGen).toBe(0);
    expect(await generations(w.cold, { namespace: NS, segment: 'b' })).toEqual([0]);
  });

  it('scopes to a namespace when given one', async () => {
    const w = await world();
    await w.seed('a', [1], 'ns');
    await w.seed('a', [1], 'other');

    const res = await w.reader().eraseSubject(1, { namespace: 'ns' });
    expect(res.scannedSegments).toBe(1);
    expect(await members(w.reader(), 'a', 'ns')).toEqual([]);
    expect(await members(w.reader(), 'a', 'other')).toEqual([1]); // untouched
  });

  it('skips a destroyed segment — already unreadable, never listed', async () => {
    const w = await world();
    await w.seed('dead', [1]);
    await w.seed('live', [1]);
    await destroySegment(
      { namespace: NS, segment: 'dead' },
      { registry: w.registry },
      { confirmSegment: 'dead', allowCleartext: true },
    );

    const res = await w.reader().eraseSubject(1, { namespace: NS });
    expect(res.scannedSegments).toBe(2); // scanned, but…
    expect(res.erasedFrom.map((e) => e.segment)).toEqual(['live']); // …a tombstone holds nothing to erase
  });

  it('emits segment.rewrite with fromGeneration/generation for each rewritten segment', async () => {
    const w = await world();
    await w.seed('a', [1, 2]);
    await w.seed('b', [3]);
    const audit = new RecordingAuditSink();

    await w.reader().eraseSubject(1, { namespace: NS, audit });

    expect(audit.snapshot()).toEqual([
      { kind: 'segment.rewrite', namespace: NS, segment: 'a', fromGeneration: 0, generation: 1 },
    ]);
  });

  it('fails fast on a non-u32 id even with no registered segments', async () => {
    const w = await world();
    await expect(w.reader().eraseSubject(-5, { allNamespaces: true })).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it('rejects a bad concurrency before scanning', async () => {
    const w = await world();
    await w.seed('a', [1]);
    await expect(
      w.reader().eraseSubject(1, { allNamespaces: true, concurrency: 0 }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(await members(w.reader(), 'a')).toEqual([1]);
  });

  it('validates the budget, and refuses an enumeration over it before erasing anything', async () => {
    const w = await world();
    for (const s of ['a', 'b', 'c']) await w.seed(s, [1]);
    await expect(
      w.reader().eraseSubject(1, { allNamespaces: true, budget: { maxRequests: 0 } }),
    ).rejects.toBeInstanceOf(ValidationError);
    // Three registered segments under a budget of two: refused while enumerating — no segment was rewritten.
    await expect(
      w.reader().eraseSubject(1, { allNamespaces: true, budget: { maxRequests: 2 } }),
    ).rejects.toBeInstanceOf(BudgetExceededError);
    for (const s of ['a', 'b', 'c']) expect(await members(w.reader(), s)).toEqual([1]);
    // `budget: false` lifts it for this call.
    const res = await w.reader().eraseSubject(1, { allNamespaces: true, budget: false });
    expect(res.erasedFrom).toHaveLength(3);
  });

  it('reports `superseded` when a load publishes past the rewrite mid-flight — and a re-run finishes', async () => {
    // The one race the rewrite can lose: it reads gen 0, writes gen 1, and a load publishes gen 2 before its
    // publish lands. Forward-only, so gen 1 never becomes current. Modelled at the driver: the load fires the
    // moment the rewrite's object is written, which is exactly the window.
    const w = await world();
    await w.seed('a', [1, 2, 3]);
    const ref: SegmentRef = { namespace: NS, segment: 'a' };
    let fired = false;
    const cold = hook(w.cold, 'putImmutable', async (...args: never[]) => {
      const [key, write] = args as unknown as [GenKey, (sink: BlobSink) => Promise<void>];
      const out = await w.cold.putImmutable(key, write);
      if (!fired && key.segment === 'a' && key.generation === 1) {
        fired = true;
        await w.load(ref, [1, 2, 3, 4]); // lands as gen 2 and is published while the rewrite is in flight
      }
      return out;
    });
    const audit = new RecordingAuditSink();

    const res = await new CloudRoaring({ cold, registry: w.registry, retry: false }).eraseSubject(
      1,
      {
        namespace: NS,
        audit,
      },
    );

    expect(fired).toBe(true);
    expect(res.erasedFrom).toEqual([
      {
        segment: 'a',
        namespace: NS,
        erased: false,
        fromGeneration: 0,
        generation: 1,
        note: 'superseded',
      },
    ]);
    expect(audit.snapshot()).toEqual([]); // the rewrite never became current → no rewrite record
    expect((await w.registry.get(ref))!.currentGen).toBe(2);
    expect(await members(w.reader(), 'a')).toEqual([1, 2, 3, 4]); // the id is still there — honestly reported

    // Re-running against the new generation erases it, and collects every superseded object incl. the orphan.
    const again = await w.reader().eraseSubject(1, { namespace: NS });
    expect(again.erasedFrom).toEqual([
      {
        segment: 'a',
        namespace: NS,
        erased: true,
        fromGeneration: 2,
        generation: 3,
        note: undefined,
      },
    ]);
    expect(await members(w.reader(), 'a')).toEqual([2, 3, 4]);
    expect(await generations(w.cold, ref)).toEqual([3]);
  });

  it('isolates a per-segment read fault — the ledger stays complete, the others are erased', async () => {
    const w = await world();
    for (const s of ['a', 'b', 'poison']) await w.seed(s, [1, 2]);
    const store = new CloudRoaring({
      cold: poisonColdReadOf(w.cold, 'poison'), // bites when the rewrite opens `poison`'s generation
      registry: w.registry,
      retry: false,
    });

    const res = await store.eraseSubject(1, { namespace: NS, concurrency: 3 });

    expect(res.scannedSegments).toBe(3);
    const byName = new Map(res.erasedFrom.map((e) => [e.segment, e]));
    expect(byName.get('a')).toMatchObject({ erased: true, fromGeneration: 0, generation: 1 });
    expect(byName.get('b')).toMatchObject({ erased: true, fromGeneration: 0, generation: 1 });
    // The poison segment's fault is isolated: recorded, not thrown — one bad segment never aborts the ledger.
    expect(byName.get('poison')).toEqual({
      segment: 'poison',
      namespace: NS,
      erased: false,
      note: 'error: poison cold read',
    });
    // …and it still holds the id, which is what `erased: false` promises.
    expect(await members(w.reader(), 'poison')).toEqual([1, 2]);
    expect(await members(w.reader(), 'a')).toEqual([2]);
  });

  it('isolates a cold WRITE fault too — nothing published, the id honestly still present', async () => {
    const w = await world();
    await w.seed('a', [1, 2, 3]);
    await w.seed('b', [1, 4]);
    const cold = hook(w.cold, 'putImmutable', () =>
      Promise.reject(new TransientError('injected cold-write fault')),
    );

    const res = await new CloudRoaring({ cold, registry: w.registry, retry: false }).eraseSubject(
      1,
      {
        allNamespaces: true,
      },
    );

    expect(res.erasedFrom).toHaveLength(2); // both member segments recorded, not lost to the first throw
    for (const e of res.erasedFrom) {
      expect(e.erased).toBe(false);
      expect(e.note).toBe('error: injected cold-write fault');
      expect(e.generation).toBeUndefined();
    }
    // The pointer never moved, so a fresh reader still sees the id — a failed erasure is not a partial one.
    expect((await w.registry.get({ namespace: NS, segment: 'a' }))!.currentGen).toBe(0);
    expect(await members(w.reader(), 'a')).toEqual([1, 2, 3]);
    expect(await members(w.reader(), 'b')).toEqual([1, 4]);
  });

  it('works on an encrypted segment: reuses the DEK, readable with the keystore, not without', async () => {
    const keystore = new InProcessKeystore({ keys: { k1: k() }, activeKeyId: 'k1' });
    const w = await world(keystore);
    await w.seed('enc', [1, 2, 3]); // the fixture loads through the keystore
    const ref: SegmentRef = { namespace: NS, segment: 'enc' };
    const wrappedBefore = (await w.registry.get(ref))!.wrappedDeks;
    expect(wrappedBefore).toHaveLength(1);

    const res = await w.reader().eraseSubject(2, { namespace: NS });

    expect(res.erasedFrom[0]).toMatchObject({ erased: true, fromGeneration: 0, generation: 1 });
    expect((await w.registry.get(ref))!.wrappedDeks).toEqual(wrappedBefore); // same DEK, not re-minted
    expect(await members(w.reader(), 'enc')).toEqual([1, 3]);
    // The rewritten generation is genuinely encrypted: a store without the keystore cannot read it.
    const noKeystore = new CloudRoaring({ cold: w.cold, registry: w.registry, retry: false });
    await expect(members(noKeystore, 'enc')).rejects.toBeInstanceOf(KeyUnavailableError);
  });

  it('requireEncryption refuses to rewrite a cleartext segment — recorded on the ledger, id kept', async () => {
    const w = await world();
    await w.seed('plain', [1, 2]);
    const strict = new CloudRoaring({
      cold: w.cold,
      registry: w.registry,
      requireEncryption: true,
      retry: false,
    });

    const res = await strict.eraseSubject(1, { namespace: NS });

    expect(res.erasedFrom).toHaveLength(1);
    expect(res.erasedFrom[0]).toMatchObject({ segment: 'plain', erased: false });
    expect(res.erasedFrom[0]!.note).toMatch(/^error: requireEncryption/);
    expect(await members(w.reader(), 'plain')).toEqual([1, 2]);
    expect(await generations(w.cold, { namespace: NS, segment: 'plain' })).toEqual([0]);
  });

  it('is idempotent — a second run lists nothing and writes nothing', async () => {
    const w = await world();
    await w.seed('a', [1, 2]);
    await w.seed('b', [1]);
    await w.reader().eraseSubject(1, { namespace: NS });

    const again = await w.reader().eraseSubject(1, { namespace: NS });

    expect(again.erasedFrom).toEqual([]);
    expect(again.scannedSegments).toBe(2);
    expect(await generations(w.cold, { namespace: NS, segment: 'a' })).toEqual([1]);
    expect(await generations(w.cold, { namespace: NS, segment: 'b' })).toEqual([1]);
    expect((await w.registry.get({ namespace: NS, segment: 'a' }))!.currentGen).toBe(1);
  });

  it('works with retry left ON (default) — the lifecycle helpers use the raw drivers', async () => {
    const w = await world();
    await w.seed('a', [1, 2, 3]);
    const res = await new CloudRoaring({ cold: w.cold, registry: w.registry }).eraseSubject(1, {
      allNamespaces: true,
    });
    expect(res.erasedFrom[0]).toMatchObject({ erased: true, fromGeneration: 0, generation: 1 });
    expect(await members(w.reader(), 'a')).toEqual([2, 3]);
  });
});

describe('lifecycle helpers require a raw cold driver + registry', () => {
  it('throws UnsupportedError naming the op when the store was built with a pre-built ColdChunkSource', async () => {
    const cold = new MemoryColdDriver();
    const registry = new MemoryRegistryDriver();
    await bulkLoadCrbmGeneration(cold, { segment: 'a', generation: 0 }, [1, 2, 3], { registry });
    // A pre-built-source store has no raw IColdDriver to write through (and can't carry a top-level registry).
    const store = new CloudRoaring({
      cold: new CrbmColdChunkSource(cold, { registry }),
      retry: false,
    });
    // eraseSubject fires the cold-driver guard; subjectReport (registry-only) fires the registry guard. Distinct
    // messages pin which clause fired, and each names the operation the caller actually invoked.
    await expect(store.eraseSubject(1, { allNamespaces: true })).rejects.toBeInstanceOf(
      UnsupportedError,
    );
    await expect(store.eraseSubject(1, { allNamespaces: true })).rejects.toThrow(
      /eraseSubject.*raw cold driver/,
    );
    await expect(store.subjectReport(1)).rejects.toThrow(/subjectReport.*registry/);
  });

  it('throws UnsupportedError when the store has no registry', async () => {
    const store = new CloudRoaring({ cold: new MemoryColdDriver() });
    await expect(store.eraseSubject(1, { allNamespaces: true })).rejects.toThrow(
      /eraseSubject.*registry/,
    );
    await expect(store.subjectReport(1)).rejects.toBeInstanceOf(UnsupportedError);
  });
});
