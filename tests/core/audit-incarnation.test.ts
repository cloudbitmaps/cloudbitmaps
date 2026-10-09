import { randomBytes } from 'node:crypto';
import { RecordingAuditSink } from '@/index';
import type {
  AuditEvent,
  IKeystore,
  IRegistryDriver,
  IStorageDriver,
  RegistryRecord,
  SegmentRef,
} from '@/index';
import { eraseIdFromSegment } from '@/core/erase-id';
import { destroySegment, dropSegment, eraseNamespace } from '@/core/erasure';
import { WriteConflictError } from '@/core/errors';
import { gcOrphanGenerations } from '@/core/generation-gc';
import { loadSegment } from '@/core/load';
import { rollbackSegment } from '@/core/rollback';
import { incarnationField, incarnationOf } from '@/core/token';
import { InProcessKeystore } from '@/drivers/crypto';
import { MemoryRegistryDriver, MemoryStorageDriver } from '@/drivers/memory';
import { roaringCodec } from '@/roaring-codec';
import { bulkLoadCrbmGeneration } from '../helpers/bulk-load';

/**
 * Every segment audit event names the incarnation of the registry row it is about, and an erasure that deletes the
 * generations holding an id without rewriting one emits `segment.collect`.
 *
 * A name purged and created again starts its generations at `0` again, so `(segment, generation)` alone names two
 * different generations; a consumer keyed on `(segment, incarnation, generation)` tells them apart.
 */

const SEG: SegmentRef = { namespace: 'ns', segment: 's' };
const k = (): Uint8Array => randomBytes(32);

function world(keystore?: IKeystore) {
  const storage = new MemoryStorageDriver();
  const registry = new MemoryRegistryDriver();
  const deps = { storage, registry, keystore, codec: roaringCodec };
  /** The incarnation id of the segment's row now. */
  const incarnation = async (ref: SegmentRef = SEG): Promise<string> => {
    const row = await registry.get(ref);
    const id = row === null ? undefined : incarnationOf(row.token);
    if (id === undefined) throw new Error('the row has no incarnation id');
    return id;
  };
  return { storage, registry, deps, incarnation };
}

/**
 * A registry of someone else's: the same rows, under tokens with no incarnation id (`"1"`, `"2"`, …), translated both
 * ways so every fence still holds.
 */
function foreignTokens(base: IRegistryDriver): IRegistryDriver {
  const toForeign = new Map<string, string>();
  const toBase = new Map<string, string>();
  const out = (token: string): string => {
    let foreign = toForeign.get(token);
    if (foreign === undefined) {
      foreign = String(toForeign.size + 1);
      toForeign.set(token, foreign);
      toBase.set(foreign, token);
    }
    return foreign;
  };
  const inn = (token: string): string => toBase.get(token) ?? token;
  const rowOut = (row: RegistryRecord | null): RegistryRecord | null =>
    row === null ? null : { ...row, token: out(row.token) };
  const held = <O extends { held?: RegistryRecord | null } | undefined>(options: O): O =>
    options?.held == null
      ? options
      : { ...options, held: { ...options.held, token: inn(options.held.token) } };
  return {
    capabilities: () => base.capabilities(),
    get: async (ref) => rowOut(await base.get(ref)),
    create: async (ref, record, options) => ({
      token: out((await base.create(ref, record, held(options))).token),
    }),
    compareAndSwap: async (ref, expected, patch, options) => ({
      token: out((await base.compareAndSwap(ref, inn(expected), patch, held(options))).token),
    }),
    list: async function* (namespace) {
      for await (const row of base.list(namespace)) yield rowOut(row)!;
    },
    delete: (ref, expected) => base.delete(ref, expected === undefined ? undefined : inn(expected)),
  };
}

const keystore = (): InProcessKeystore =>
  new InProcessKeystore({ keys: { k1: k() }, activeKeyId: 'k1' });

describe('incarnationField', () => {
  it('reads the incarnation id from an incarnation-form token', () => {
    const id = 'a'.repeat(32);
    expect(incarnationField(`${id}.4.${'b'.repeat(16)}`)).toEqual({ incarnation: id });
  });

  it('is empty for a token in another form, and for none, so the event carries no field at all', () => {
    expect(incarnationField('7')).toEqual({});
    expect(incarnationField('opaque-token-from-another-registry')).toEqual({});
    expect(incarnationField(undefined)).toEqual({});
  });
});

describe('audit: every segment event names the row incarnation', () => {
  it('segment.publish from a load', async () => {
    const w = world();
    const audit = new RecordingAuditSink();
    await loadSegment(SEG, [1, 2], w.deps, { audit });
    await loadSegment(SEG, [3], w.deps, { audit });
    const id = await w.incarnation();
    expect(audit.snapshot()).toEqual([
      { kind: 'segment.publish', namespace: 'ns', segment: 's', incarnation: id, generation: 0 },
      { kind: 'segment.publish', namespace: 'ns', segment: 's', incarnation: id, generation: 1 },
    ]);
  });

  it('segment.publish from a bulk load', async () => {
    const w = world();
    const audit = new RecordingAuditSink();
    await bulkLoadCrbmGeneration(w.storage, { ...SEG, generation: 0 }, [1], {
      registry: w.registry,
      audit,
    });
    await bulkLoadCrbmGeneration(w.storage, { ...SEG, generation: 1 }, [2], {
      registry: w.registry,
      audit,
    });
    const id = await w.incarnation();
    expect(
      audit.snapshot().map((e) => [e.kind, (e as { incarnation?: string }).incarnation]),
    ).toEqual([
      ['segment.publish', id],
      ['segment.publish', id],
    ]);
  });

  it('segment.load-refused names the row the load read', async () => {
    const w = world();
    await loadSegment(SEG, [1, 2, 3], w.deps);
    const audit = new RecordingAuditSink();
    const r = await loadSegment(SEG, [], w.deps, { audit });
    expect(r).toMatchObject({ published: false, reason: 'empty' });
    expect(audit.snapshot()).toEqual([
      {
        kind: 'segment.load-refused',
        namespace: 'ns',
        segment: 's',
        incarnation: await w.incarnation(),
        generation: 1,
        reason: 'empty',
        cardinality: 0,
      },
    ]);
  });

  it('segment.load-refused carries no incarnation when the load found no row', async () => {
    const w = world();
    const audit = new RecordingAuditSink();
    const r = await loadSegment(SEG, [1], w.deps, { audit, guard: { minCardinality: 2 } });
    expect(r).toMatchObject({ published: false, reason: 'min-cardinality' });
    const [event] = audit.snapshot();
    expect(event).toMatchObject({ kind: 'segment.load-refused', reason: 'min-cardinality' });
    expect(event).not.toHaveProperty('incarnation');
  });

  it('segment.rollback', async () => {
    const w = world();
    await loadSegment(SEG, [1], w.deps);
    await loadSegment(SEG, [2], w.deps);
    const audit = new RecordingAuditSink();
    await rollbackSegment(SEG, 0, w.deps, { audit });
    expect(audit.snapshot()).toEqual([
      {
        kind: 'segment.rollback',
        namespace: 'ns',
        segment: 's',
        incarnation: await w.incarnation(),
        fromGeneration: 1,
        generation: 0,
      },
    ]);
  });

  it('segment.rewrite', async () => {
    const w = world();
    await loadSegment(SEG, [1, 2, 3], w.deps);
    const audit = new RecordingAuditSink();
    await eraseIdFromSegment(SEG, 2, w.deps, { audit });
    expect(audit.snapshot()).toEqual([
      {
        kind: 'segment.rewrite',
        namespace: 'ns',
        segment: 's',
        incarnation: await w.incarnation(),
        fromGeneration: 0,
        generation: 1,
      },
    ]);
  });

  it('segment.erase from destroySegment and from eraseNamespace', async () => {
    const ks = keystore();
    const w = world(ks);
    await loadSegment(SEG, [1], w.deps);
    await loadSegment({ namespace: 'ns', segment: 't' }, [2], w.deps);
    const s = await w.incarnation();
    const t = await w.incarnation({ namespace: 'ns', segment: 't' });
    const audit = new RecordingAuditSink();
    await destroySegment(SEG, w.deps, { confirmSegment: 's', audit });
    expect(audit.snapshot()).toEqual([
      { kind: 'segment.erase', namespace: 'ns', segment: 's', incarnation: s },
    ]);

    audit.reset();
    await eraseNamespace('ns', w.deps, { confirmNamespace: 'ns', audit });
    expect(audit.snapshot()).toEqual([
      { kind: 'segment.erase', namespace: 'ns', segment: 't', incarnation: t },
      { kind: 'namespace.erase', namespace: 'ns', segmentsShredded: 1 },
    ]);
  });

  it('segment.erase and segment.dispose from dropping an encrypted segment', async () => {
    const w = world(keystore());
    await loadSegment(SEG, [1], w.deps);
    const id = await w.incarnation();
    const audit = new RecordingAuditSink();
    await dropSegment(SEG, w.deps, { confirmSegment: 's', audit });
    expect(audit.snapshot()).toEqual([
      { kind: 'segment.erase', namespace: 'ns', segment: 's', incarnation: id },
      {
        kind: 'segment.dispose',
        namespace: 'ns',
        segment: 's',
        incarnation: id,
        generationsDeleted: 1,
      },
    ]);
  });

  it('segment.dispose from a drop that finds a tombstone already there', async () => {
    const w = world();
    await loadSegment(SEG, [1], w.deps);
    await destroySegment(SEG, w.deps, { confirmSegment: 's', allowCleartext: true });
    const id = await w.incarnation();
    const audit = new RecordingAuditSink();
    await dropSegment(SEG, w.deps, { confirmSegment: 's', audit });
    expect(audit.snapshot()).toEqual([
      {
        kind: 'segment.dispose',
        namespace: 'ns',
        segment: 's',
        incarnation: id,
        generationsDeleted: 1,
      },
    ]);
  });

  it('segment.dispose from a drop of objects with no row names the tombstone it wrote', async () => {
    const w = world();
    await loadSegment(SEG, [1], w.deps);
    await w.registry.delete(SEG);
    const audit = new RecordingAuditSink();
    await dropSegment(SEG, w.deps, { confirmSegment: 's', audit });
    expect(audit.snapshot()).toEqual([
      {
        kind: 'segment.dispose',
        namespace: 'ns',
        segment: 's',
        incarnation: await w.incarnation(),
        generationsDeleted: 1,
      },
    ]);
  });

  it('two incarnations of one name publish generation 0 under different incarnations', async () => {
    const w = world();
    const audit = new RecordingAuditSink();
    await loadSegment(SEG, [1], w.deps, { audit });
    const first = await w.incarnation();
    await dropSegment(SEG, w.deps, { confirmSegment: 's' });
    await w.registry.delete(SEG); // the tombstone purged: the name is free again
    await loadSegment(SEG, [2], w.deps, { audit });
    const second = await w.incarnation();

    expect(first).not.toBe(second);
    expect(audit.snapshot()).toEqual([
      { kind: 'segment.publish', namespace: 'ns', segment: 's', incarnation: first, generation: 0 },
      {
        kind: 'segment.publish',
        namespace: 'ns',
        segment: 's',
        incarnation: second,
        generation: 0,
      },
    ]);
  });
});

describe('audit: segment.collect (an erasure that rewrites nothing)', () => {
  it('an id only an older generation holds: the generations below the pointer are deleted, and recorded', async () => {
    const w = world();
    await loadSegment(SEG, [1, 2, 3], w.deps); // gen 0 holds the id
    await loadSegment(SEG, [1, 3], w.deps); // gen 1 dropped it; `keep: 1` retains gen 0
    const audit = new RecordingAuditSink();

    const res = await eraseIdFromSegment(SEG, 2, w.deps, { audit });

    expect(res).toMatchObject({ erased: true, fromGeneration: 0, collected: [0] });
    expect(res.generation).toBeUndefined(); // nothing was written
    expect(audit.snapshot()).toEqual([
      {
        kind: 'segment.collect',
        namespace: 'ns',
        segment: 's',
        incarnation: await w.incarnation(),
        fromGeneration: 0,
        collected: [0],
      },
    ]);
  });

  it('a holder above the pointer after a rollback is deleted and recorded, with every generation below it', async () => {
    const w = world();
    const keep = { keep: 5 }; // every generation stays in the bucket
    await loadSegment(SEG, [1], w.deps, keep); // gen 0
    await loadSegment(SEG, [1, 4], w.deps, keep); // gen 1
    await loadSegment(SEG, [1, 2], w.deps, keep); // gen 2 holds the id
    await loadSegment(SEG, [1, 5], w.deps, keep); // gen 3
    await rollbackSegment(SEG, 1, w.deps); // pointer at 1: gen 2 and gen 3 are above it
    const audit = new RecordingAuditSink();

    const res = await eraseIdFromSegment(SEG, 2, w.deps, { audit });

    expect(res).toMatchObject({ erased: true, fromGeneration: 2 });
    const [event] = audit.snapshot();
    expect(event).toEqual({
      kind: 'segment.collect',
      namespace: 'ns',
      segment: 's',
      incarnation: await w.incarnation(),
      fromGeneration: 2,
      collected: [...res.collected].sort((a, b) => a - b),
    });
    // Gen 0, below the pointer, goes whether it held the id or not; gen 3, above it without the id, stays.
    expect((event as Extract<AuditEvent, { kind: 'segment.collect' }>).collected).toEqual([0, 2]);
  });

  it('a readable object under a tombstone: deleted and recorded against the tombstone', async () => {
    const w = world();
    await loadSegment(SEG, [1, 2], w.deps);
    await destroySegment(SEG, w.deps, { confirmSegment: 's', allowCleartext: true }); // bytes stay readable
    const id = await w.incarnation();
    const audit = new RecordingAuditSink();

    const res = await eraseIdFromSegment(SEG, 2, w.deps, { audit });

    expect(res).toMatchObject({ erased: true, fromGeneration: 0, collected: [0] });
    expect(audit.snapshot()).toEqual([
      {
        kind: 'segment.collect',
        namespace: 'ns',
        segment: 's',
        incarnation: id,
        fromGeneration: 0,
        collected: [0],
      },
    ]);
  });

  it('emits nothing when no generation holds the id', async () => {
    const w = world();
    await loadSegment(SEG, [1, 3], w.deps);
    await loadSegment(SEG, [1], w.deps);
    const audit = new RecordingAuditSink();
    const res = await eraseIdFromSegment(SEG, 2, w.deps, { audit });
    expect(res).toMatchObject({ erased: false, reason: 'not-member' });
    expect(audit.snapshot()).toEqual([]);
  });

  it('emits nothing when another collection deleted the holder before the call looked: no generation holds the id', async () => {
    const w = world();
    await loadSegment(SEG, [1, 2], w.deps);
    await loadSegment(SEG, [1], w.deps);
    await gcOrphanGenerations(SEG, { storage: w.storage, registry: w.registry }, { keep: 0 });
    const audit = new RecordingAuditSink();
    const res = await eraseIdFromSegment(SEG, 2, w.deps, { audit });
    expect(res).toMatchObject({ erased: false, reason: 'not-member' });
    expect(audit.snapshot()).toEqual([]);
  });

  it('the list is ascending even when holders above the pointer are deleted newest first', async () => {
    const w = world();
    const keep = { keep: 5 };
    await loadSegment(SEG, [2], w.deps, keep); // gen 0 holds the id
    await loadSegment(SEG, [1], w.deps, keep); // gen 1 does not
    await loadSegment(SEG, [2, 4], w.deps, keep); // gen 2 holds it
    await loadSegment(SEG, [2, 5], w.deps, keep); // gen 3 holds it
    await rollbackSegment(SEG, 1, w.deps); // pointer at 1: holders 2 and 3 above it, 0 below
    const audit = new RecordingAuditSink();

    const res = await eraseIdFromSegment(SEG, 2, w.deps, { audit });

    expect(res).toMatchObject({ erased: true, fromGeneration: 3 });
    expect(audit.snapshot()).toEqual([
      {
        kind: 'segment.collect',
        namespace: 'ns',
        segment: 's',
        incarnation: await w.incarnation(),
        fromGeneration: 3,
        collected: [0, 2, 3],
      },
    ]);
  });

  it('an erasure that meets a drop part-way records what both of its passes deleted, once', async () => {
    // The first pass deletes the newest holder above the pointer; a drop that cannot delete objects then tombstones the
    // row, and the second pass finds the older holders under the tombstone. One event covers the whole call.
    const w = world();
    const keep = { keep: 5 };
    await loadSegment(SEG, [1], w.deps, keep); // gen 0, clean
    await loadSegment(SEG, [1, 9], w.deps, keep); // gen 1 holds the id
    await loadSegment(SEG, [1, 9], w.deps, keep); // gen 2 holds it
    await loadSegment(SEG, [1, 9, 4], w.deps, keep); // gen 3 holds it
    await rollbackSegment(SEG, 0, w.deps); // pointer at 0: every holder is above it
    const denied: IStorageDriver = {
      capabilities: () => w.storage.capabilities(),
      getTail: (k, m) => w.storage.getTail(k, m),
      getRange: (k, o, l) => w.storage.getRange(k, o, l),
      list: (r) => w.storage.list(r),
      putImmutable: (k, b) => w.storage.putImmutable(k, b),
      delete: () => Promise.reject(new Error('AccessDenied')),
    };
    let fired = false;
    const racing: IStorageDriver = {
      ...denied,
      delete: async (k) => {
        await w.storage.delete(k);
        if (!fired && k.generation === 3) {
          fired = true;
          await dropSegment(
            SEG,
            { storage: denied, registry: w.registry },
            { confirmSegment: 's' },
          ).catch(() => undefined);
        }
      },
    };
    const audit = new RecordingAuditSink();

    const res = await eraseIdFromSegment(SEG, 9, { ...w.deps, storage: racing }, { audit });

    expect(fired).toBe(true);
    expect(res).toMatchObject({ erased: true, fromGeneration: 3, collected: [0, 1, 2, 3] });
    expect(audit.snapshot()).toEqual([
      {
        kind: 'segment.collect',
        namespace: 'ns',
        segment: 's',
        incarnation: await w.incarnation(),
        fromGeneration: 3,
        collected: [0, 1, 2, 3],
      },
    ]);
  });

  it('records the finished erasure when another collection deletes the holder during the call, with nothing collected', async () => {
    // The event attests the state of the bucket the call verified, whoever emptied it: a finished erasure is never left
    // unrecorded because a load's or a drop's collection won the race.
    const w = world();
    await loadSegment(SEG, [1, 2], w.deps);
    await loadSegment(SEG, [1], w.deps); // `keep: 1` retains gen 0, which holds the id
    let lists = 0;
    const racing: IStorageDriver = {
      capabilities: () => w.storage.capabilities(),
      getTail: (k, m) => w.storage.getTail(k, m),
      getRange: (k, o, l) => w.storage.getRange(k, o, l),
      delete: (k) => w.storage.delete(k),
      putImmutable: (k, b) => w.storage.putImmutable(k, b),
      list: (r) => {
        lists += 1;
        if (lists !== 2) return w.storage.list(r);
        // The second listing is the erasure's collection: another collector takes the holder first.
        return (async function* () {
          await gcOrphanGenerations(SEG, { storage: w.storage, registry: w.registry }, { keep: 0 });
          yield* w.storage.list(r);
        })();
      },
    };
    const audit = new RecordingAuditSink();

    const res = await eraseIdFromSegment(SEG, 2, { ...w.deps, storage: racing }, { audit });

    expect(res).toMatchObject({ erased: true, fromGeneration: 0, collected: [] });
    expect(audit.snapshot()).toEqual([
      {
        kind: 'segment.collect',
        namespace: 'ns',
        segment: 's',
        incarnation: await w.incarnation(),
        fromGeneration: 0,
        collected: [],
      },
    ]);
  });

  it('emits nothing when a holder is still in the bucket and the call throws', async () => {
    const w = world();
    await loadSegment(SEG, [1, 2, 3], w.deps); // gen 0 holds the id
    await loadSegment(SEG, [1, 3], w.deps); // gen 1 dropped it; `keep: 1` retains gen 0
    let reads = 0;
    // The erasure's own first read sees the row; the collection's read then finds none, so it declines to delete.
    const flaky = new Proxy(w.registry, {
      get(t, p, rx) {
        if (p !== 'get') return Reflect.get(t, p, rx) as unknown;
        return async (ref: SegmentRef) => ((reads += 1) === 2 ? null : t.get(ref));
      },
    }) as IRegistryDriver;
    const audit = new RecordingAuditSink();

    await expect(
      eraseIdFromSegment(SEG, 2, { ...w.deps, registry: flaky }, { audit }),
    ).rejects.toBeInstanceOf(WriteConflictError);
    expect(audit.snapshot()).toEqual([]);

    const rerun = await eraseIdFromSegment(SEG, 2, w.deps, { audit });
    expect(rerun).toMatchObject({ erased: true, fromGeneration: 0 });
    expect(audit.snapshot().map((e) => e.kind)).toEqual(['segment.collect']);
  });

  it("the sink's copy of the list is its own: a snapshot is not changed by a later edit of the event", async () => {
    const audit = new RecordingAuditSink();
    const collected = [0, 1];
    audit.onEvent({ kind: 'segment.collect', segment: 's', fromGeneration: 1, collected });
    const snap = audit.snapshot();
    collected.push(2);
    expect(snap).toEqual([
      { kind: 'segment.collect', segment: 's', fromGeneration: 1, collected: [0, 1] },
    ]);
  });
});

describe('audit: a registry whose tokens carry no incarnation id', () => {
  it('every segment event leaves the field out entirely', async () => {
    const ks = keystore();
    const storage = new MemoryStorageDriver();
    const registry = foreignTokens(new MemoryRegistryDriver());
    const deps = { storage, registry, keystore: ks, codec: roaringCodec };
    const audit = new RecordingAuditSink();
    const keep = { keep: 5, audit };
    await loadSegment(SEG, [1, 2, 3], deps, keep);
    await loadSegment(SEG, [1, 3], deps, keep);
    expect((await registry.get(SEG))!.token).toMatch(/^\d+$/); // the foreign form really reaches the library
    await loadSegment(SEG, [], deps, { audit }); // refused: empty
    await eraseIdFromSegment(SEG, 2, deps, { audit }); // only gen 0 holds it: collected
    await eraseIdFromSegment(SEG, 1, deps, { audit }); // rewritten
    await loadSegment(SEG, [9], deps, keep);
    await rollbackSegment(SEG, 2, deps, { audit });
    await dropSegment(SEG, deps, { confirmSegment: 's', audit });

    const events = audit.snapshot();
    expect(events.map((e) => e.kind)).toEqual([
      'segment.publish',
      'segment.publish',
      'segment.load-refused',
      'segment.collect',
      'segment.rewrite',
      'segment.publish',
      'segment.rollback',
      'segment.erase',
      'segment.dispose',
    ]);
    for (const event of events) expect(event).not.toHaveProperty('incarnation');
  });
});

describe('audit: the incarnation is the one the operation acted on, not the row found afterwards', () => {
  it('a load refused because the name was purged and created again names the row it read', async () => {
    const w = world();
    await loadSegment(SEG, [1], w.deps);
    const before = await w.incarnation();
    let fired = false;
    // While the load writes its object, the segment is dropped, its tombstone purged, and the name loaded again.
    const racing = new Proxy(w.storage, {
      get(t, p, rx) {
        if (p !== 'put' && p !== 'putImmutable') return Reflect.get(t, p, rx) as unknown;
        const inner = Reflect.get(t, p, rx) as (...a: never[]) => Promise<unknown>;
        return async (...args: never[]) => {
          if (!fired) {
            fired = true;
            await dropSegment(SEG, w.deps, { confirmSegment: 's' });
            await w.registry.delete(SEG);
            await loadSegment(SEG, [7], w.deps);
          }
          return inner.apply(t, args);
        };
      },
    }) as IStorageDriver;
    const audit = new RecordingAuditSink();
    const r = await loadSegment(SEG, [2], { ...w.deps, storage: racing }, { audit });

    expect(r).toMatchObject({ published: false, reason: 'superseded' });
    const after = await w.incarnation();
    expect(after).not.toBe(before);
    expect(audit.snapshot()).toEqual([
      expect.objectContaining({ kind: 'segment.load-refused', incarnation: before }),
    ]);
  });

  it('eraseNamespace names each segment its own row, and a skipped cleartext segment emits nothing', async () => {
    const ks = keystore();
    const w = world(ks);
    const names = ['a', 'b', 'c'];
    for (const segment of names) await loadSegment({ namespace: 'ns', segment }, [1], w.deps);
    // A cleartext segment in the same namespace: no key to shred, so no event.
    await loadSegment({ namespace: 'ns', segment: 'plain' }, [1], {
      ...w.deps,
      keystore: undefined,
    });
    const own = new Map<string, string>();
    for (const segment of names)
      own.set(segment, await w.incarnation({ namespace: 'ns', segment }));
    expect(new Set(own.values()).size).toBe(3);

    const audit = new RecordingAuditSink();
    const { destroyed } = await eraseNamespace('ns', w.deps, { confirmNamespace: 'ns', audit });

    const erased = audit.snapshot().filter((e) => e.kind === 'segment.erase');
    expect(erased).toHaveLength(3);
    for (const e of erased) expect(e).toEqual({ ...e, incarnation: own.get(e.segment) });
    // The token the shred read is the audit event's, never the caller's: it stays off every ledger entry.
    for (const entry of destroyed) expect(entry).not.toHaveProperty('token');
  });

  it('destroySegment returns no token', async () => {
    const w = world(keystore());
    await loadSegment(SEG, [1], w.deps);
    const res = await destroySegment(SEG, w.deps, { confirmSegment: 's' });
    expect(res.cryptoShredded).toBe(true);
    expect(res).not.toHaveProperty('token');
  });
});
