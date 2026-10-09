import { randomBytes } from 'node:crypto';
import { RecordingAuditSink } from '@/index';
import type { AuditEvent, IKeystore, SegmentRef } from '@/index';
import { eraseIdFromSegment } from '@/core/erase-id';
import { destroySegment, dropSegment, eraseNamespace } from '@/core/erasure';
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

  it('emits nothing when another collection took the holder first: the call deleted nothing', async () => {
    const w = world();
    await loadSegment(SEG, [1, 2], w.deps);
    await loadSegment(SEG, [1], w.deps);
    await gcOrphanGenerations(SEG, { storage: w.storage, registry: w.registry }, { keep: 0 });
    const audit = new RecordingAuditSink();
    const res = await eraseIdFromSegment(SEG, 2, w.deps, { audit });
    expect(res).toMatchObject({ erased: false, reason: 'not-member' });
    expect(audit.snapshot()).toEqual([]);
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
