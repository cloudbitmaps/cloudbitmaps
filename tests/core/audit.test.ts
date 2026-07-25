import { randomBytes } from 'node:crypto';
import {
  CloudRoaring,
  CrbmColdChunkSource,
  MemoryColdDriver,
  MemoryRegistryDriver,
  MemoryWarmDriver,
  NOOP_AUDIT,
  RecordingAuditSink,
  bulkLoadCrbmGeneration,
  compactSegment,
  destroySegment,
  eraseNamespace,
  runCompactionCycle,
} from '@/index';
import type { AuditEvent, CompactionDeps, IKeystore, SegmentRef } from '@/index';
import { safeAudit } from '@/core/audit';
import { InProcessKeystore } from '@/drivers/crypto';
import { ValidationError } from '@/core/errors';

const SEG: SegmentRef = { segment: 's' };
const OWNER = 'worker-1';
const k = (): Uint8Array => randomBytes(32);

function world(keystore?: IKeystore) {
  const cold = new MemoryColdDriver();
  const warm = new MemoryWarmDriver();
  const registry = new MemoryRegistryDriver();
  const deps: CompactionDeps = { cold, warm, registry, clock: { now: () => Date.now() }, keystore };
  const store = (): CloudRoaring =>
    new CloudRoaring({
      warm,
      cold: new CrbmColdChunkSource(cold, { registry, keystore }),
      retry: false,
    });
  return { cold, warm, registry, deps, store };
}

const THROWS: IAuditSinkLike = {
  onEvent() {
    throw new Error('sink is down');
  },
};
type IAuditSinkLike = { onEvent(e: AuditEvent): void };

// ─────────────────────────────────────────────────────────────────────────────
// The module itself
// ─────────────────────────────────────────────────────────────────────────────

describe('RecordingAuditSink', () => {
  it('records events in emission order', () => {
    const a = new RecordingAuditSink();
    a.onEvent({ kind: 'segment.publish', segment: 's', generation: 0 });
    a.onEvent({ kind: 'segment.compact', segment: 's', generation: 1 });
    expect(a.snapshot()).toEqual([
      { kind: 'segment.publish', segment: 's', generation: 0 },
      { kind: 'segment.compact', segment: 's', generation: 1 },
    ]);
  });

  it('snapshot() returns an independent copy (later events do not mutate it)', () => {
    const a = new RecordingAuditSink();
    a.onEvent({ kind: 'namespace.erase', namespace: 'ns', segmentsShredded: 1 });
    const first = a.snapshot();
    a.onEvent({ kind: 'namespace.erase', namespace: 'ns2', segmentsShredded: 0 });
    expect(first).toHaveLength(1); // the earlier snapshot is frozen at its point in time
    expect(a.snapshot()).toHaveLength(2);
  });

  it('reset() clears the recorded events', () => {
    const a = new RecordingAuditSink();
    a.onEvent({ kind: 'segment.erase', segment: 's' });
    a.reset();
    expect(a.snapshot()).toEqual([]);
  });
});

describe('safeAudit', () => {
  it('swallows a throwing sink so it can never break the operation', () => {
    const boom = safeAudit(THROWS);
    expect(() => boom.onEvent({ kind: 'segment.erase', segment: 's' })).not.toThrow();
  });

  it('returns NOOP_AUDIT unchanged (identity fast-path)', () => {
    expect(safeAudit(NOOP_AUDIT)).toBe(NOOP_AUDIT);
  });

  it('forwards events through to a healthy wrapped sink', () => {
    const inner = new RecordingAuditSink();
    safeAudit(inner).onEvent({ kind: 'segment.publish', segment: 's', generation: 2 });
    expect(inner.snapshot()).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Emission — bulk-load publish
// ─────────────────────────────────────────────────────────────────────────────

describe('audit: segment.publish (bulk-load)', () => {
  it('emits publish with the namespace + generation when a registry is wired', async () => {
    const w = world();
    const audit = new RecordingAuditSink();
    await bulkLoadCrbmGeneration(
      w.cold,
      { namespace: 'ns', segment: 's', generation: 3 },
      [1, 2, 3],
      { registry: w.registry, audit },
    );
    expect(audit.snapshot()).toEqual([
      { kind: 'segment.publish', namespace: 'ns', segment: 's', generation: 3 },
    ]);
  });

  it('emits nothing without a registry (there is no published "current generation")', async () => {
    const w = world();
    const audit = new RecordingAuditSink();
    await bulkLoadCrbmGeneration(w.cold, { ...SEG, generation: 0 }, [1, 2, 3], { audit });
    expect(audit.snapshot()).toEqual([]);
  });

  it('does NOT emit when a forward-only publish no-ops (a generation below the current one)', async () => {
    const w = world();
    await bulkLoadCrbmGeneration(w.cold, { ...SEG, generation: 0 }, [1], { registry: w.registry });
    await bulkLoadCrbmGeneration(w.cold, { ...SEG, generation: 5 }, [2], { registry: w.registry });
    expect((await w.registry.get(SEG))!.currentGen).toBe(5);
    const audit = new RecordingAuditSink();

    // Writes a fresh gen-3 object, but currentGen (5) never regresses → gen 3 does not become current.
    await bulkLoadCrbmGeneration(w.cold, { ...SEG, generation: 3 }, [3], {
      registry: w.registry,
      audit,
    });
    expect((await w.registry.get(SEG))!.currentGen).toBe(5);
    expect(audit.snapshot()).toEqual([]); // no "became current" claim for a generation that didn't
  });

  it('a throwing audit sink never breaks the bulk-load', async () => {
    const w = world();
    const res = await bulkLoadCrbmGeneration(w.cold, { ...SEG, generation: 0 }, [1, 2], {
      registry: w.registry,
      audit: THROWS,
    });
    expect(res.cardinality).toBe(2);
    expect((await w.registry.get(SEG))!.currentGen).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Emission — compaction
// ─────────────────────────────────────────────────────────────────────────────

describe('audit: segment.compact', () => {
  it('emits compact once per committed generation (namespace + generation), no purge coupling', async () => {
    const w = world();
    await bulkLoadCrbmGeneration(
      w.cold,
      { namespace: 'ns', segment: 's', generation: 0 },
      [1, 2, 3, 100_000],
      { registry: w.registry },
    );
    await w.store().segment('s', { namespace: 'ns' }).add(4); // one dirty chunk
    const audit = new RecordingAuditSink();

    const res = await compactSegment({ namespace: 'ns', segment: 's' }, w.deps, {
      owner: OWNER,
      audit,
    });
    expect(res).toMatchObject({ compacted: true, toGen: 1 });
    expect(audit.snapshot()).toEqual([
      { kind: 'segment.compact', namespace: 'ns', segment: 's', generation: 1 },
    ]);
  });

  it('emits generation 0 on a bootstrap (all-warm) compaction', async () => {
    const w = world();
    await w.store().segment('s').addMany([1, 2, 3]);
    const audit = new RecordingAuditSink();

    await compactSegment(SEG, w.deps, { owner: OWNER, audit });
    expect(audit.snapshot()).toEqual([{ kind: 'segment.compact', segment: 's', generation: 0 }]);
  });

  it('emits nothing on a no-op (clean) compaction', async () => {
    const w = world();
    await bulkLoadCrbmGeneration(w.cold, { ...SEG, generation: 0 }, [1, 2], {
      registry: w.registry,
    });
    const audit = new RecordingAuditSink();

    const res = await compactSegment(SEG, w.deps, { owner: OWNER, audit });
    expect(res.compacted).toBe(false);
    expect(audit.snapshot()).toEqual([]);
  });

  it('emits nothing when the segment is destroyed (a no-op contention/terminal path)', async () => {
    const keystore = new InProcessKeystore({ keys: { k1: k() }, activeKeyId: 'k1' });
    const w = world(keystore);
    await bulkLoadCrbmGeneration(w.cold, { ...SEG, generation: 0 }, [1, 2], {
      registry: w.registry,
      keystore,
    });
    await destroySegment(SEG, w.deps, { confirmSegment: 's' }); // now a tombstone
    const audit = new RecordingAuditSink();

    const res = await compactSegment(SEG, w.deps, { owner: OWNER, audit });
    expect(res.reason).toBe('destroyed');
    expect(audit.snapshot()).toEqual([]);
  });

  it('a throwing audit sink never breaks the compaction commit', async () => {
    const w = world();
    await w.store().segment('s').add(1);
    const res = await compactSegment(SEG, w.deps, { owner: OWNER, audit: THROWS });
    expect(res.compacted).toBe(true); // the commit + purge still succeeded
    expect((await w.registry.get(SEG))!.currentGen).toBe(0);
  });

  it('runCompactionCycle threads the audit sink through, emitting the right generation per segment', async () => {
    const w = world();
    for (const seg of ['a', 'b']) {
      await bulkLoadCrbmGeneration(
        w.cold,
        { namespace: 'ns', segment: seg, generation: 0 },
        [1, 2],
        { registry: w.registry },
      );
      await w.store().segment(seg, { namespace: 'ns' }).add(3);
    }
    const audit = new RecordingAuditSink();

    const { results } = await runCompactionCycle(w.deps, { owner: OWNER, namespace: 'ns', audit });
    expect(results.filter((r) => r.compacted)).toHaveLength(2);
    expect(
      audit
        .snapshot()
        .sort((x, y) =>
          (x as { segment: string }).segment.localeCompare((y as { segment: string }).segment),
        ),
    ).toEqual([
      { kind: 'segment.compact', namespace: 'ns', segment: 'a', generation: 1 },
      { kind: 'segment.compact', namespace: 'ns', segment: 'b', generation: 1 },
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Emission — erasure
// ─────────────────────────────────────────────────────────────────────────────

describe('audit: segment.erase / namespace.erase', () => {
  it('destroySegment emits segment.erase (with namespace) on a genuine crypto-shred', async () => {
    const keystore = new InProcessKeystore({ keys: { k1: k() }, activeKeyId: 'k1' });
    const w = world(keystore);
    await bulkLoadCrbmGeneration(
      w.cold,
      { namespace: 'ns', segment: 's', generation: 0 },
      [1, 2, 3],
      { registry: w.registry, keystore },
    );
    const audit = new RecordingAuditSink();

    const res = await destroySegment({ namespace: 'ns', segment: 's' }, w.deps, {
      confirmSegment: 's',
      audit,
    });
    expect(res.cryptoShredded).toBe(true);
    expect(audit.snapshot()).toEqual([{ kind: 'segment.erase', namespace: 'ns', segment: 's' }]);
  });

  it('does NOT emit on the idempotent already-destroyed call', async () => {
    const keystore = new InProcessKeystore({ keys: { k1: k() }, activeKeyId: 'k1' });
    const w = world(keystore);
    await bulkLoadCrbmGeneration(w.cold, { ...SEG, generation: 0 }, [1], {
      registry: w.registry,
      keystore,
    });
    await destroySegment(SEG, w.deps, { confirmSegment: 's' }); // first shred (no sink)
    const audit = new RecordingAuditSink();

    const again = await destroySegment(SEG, w.deps, { confirmSegment: 's', audit });
    expect(again.reason).toBe('already');
    expect(again.cryptoShredded).toBe(false);
    expect(audit.snapshot()).toEqual([]); // nothing changed at rest → no audit record
  });

  it('does NOT emit when a cleartext segment is skipped (no key to shred)', async () => {
    const w = world(); // no keystore → cleartext
    await bulkLoadCrbmGeneration(w.cold, { ...SEG, generation: 0 }, [1, 2], {
      registry: w.registry,
    });
    const audit = new RecordingAuditSink();

    const res = await destroySegment(SEG, w.deps, { confirmSegment: 's', audit });
    expect(res.reason).toBe('cleartext');
    expect(audit.snapshot()).toEqual([]);
  });

  it('does NOT emit segment.erase for a cleartext tombstone (allowCleartext) — Cold bytes remain readable', async () => {
    const w = world(); // cleartext
    await bulkLoadCrbmGeneration(w.cold, { ...SEG, generation: 0 }, [1, 2], {
      registry: w.registry,
    });
    const audit = new RecordingAuditSink();

    const res = await destroySegment(SEG, w.deps, {
      confirmSegment: 's',
      allowCleartext: true,
      audit,
    });
    expect(res.destroyed).toBe(true); // tombstoned…
    expect(res.cryptoShredded).toBe(false); // …but not an irreversible crypto-shred
    expect(audit.snapshot()).toEqual([]); // so no false erasure receipt
  });

  it('a throwing audit sink never breaks the erase', async () => {
    const keystore = new InProcessKeystore({ keys: { k1: k() }, activeKeyId: 'k1' });
    const w = world(keystore);
    await bulkLoadCrbmGeneration(w.cold, { ...SEG, generation: 0 }, [1], {
      registry: w.registry,
      keystore,
    });
    const res = await destroySegment(SEG, w.deps, { confirmSegment: 's', audit: THROWS });
    expect(res.destroyed).toBe(true);
    expect((await w.registry.get(SEG))!.status).toBe('destroyed');
  });

  it('eraseNamespace emits a per-segment segment.erase plus one namespace.erase carrying the shredded count', async () => {
    const keystore = new InProcessKeystore({ keys: { k1: k() }, activeKeyId: 'k1' });
    const w = world(keystore);
    for (const seg of ['a', 'b']) {
      await bulkLoadCrbmGeneration(
        w.cold,
        { namespace: 'ns', segment: seg, generation: 0 },
        [1, 2],
        { registry: w.registry, keystore },
      );
    }
    const audit = new RecordingAuditSink();

    const { destroyed } = await eraseNamespace('ns', w.deps, { confirmNamespace: 'ns', audit });
    expect(destroyed).toHaveLength(2);
    const events = audit.snapshot();
    expect(events.filter((e) => e.kind === 'segment.erase')).toHaveLength(2);
    expect(events.at(-1)).toEqual({
      kind: 'namespace.erase',
      namespace: 'ns',
      segmentsShredded: 2,
    });
  });

  it('eraseNamespace records segmentsShredded: 0 (no false receipt) for an empty namespace', async () => {
    const w = world();
    const audit = new RecordingAuditSink();
    await eraseNamespace('empty', w.deps, { confirmNamespace: 'empty', audit });
    expect(audit.snapshot()).toEqual([
      { kind: 'namespace.erase', namespace: 'empty', segmentsShredded: 0 },
    ]);
  });

  it('eraseNamespace over an all-cleartext namespace shreds nothing and records the honest 0', async () => {
    const w = world(); // no keystore → segments are cleartext
    await bulkLoadCrbmGeneration(w.cold, { namespace: 'ns', segment: 'a', generation: 0 }, [1], {
      registry: w.registry,
    });
    const audit = new RecordingAuditSink();

    await eraseNamespace('ns', w.deps, { confirmNamespace: 'ns', audit }); // allowCleartext omitted
    expect(audit.snapshot()).toEqual([
      { kind: 'namespace.erase', namespace: 'ns', segmentsShredded: 0 },
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Config validation at the compaction boundary
// ─────────────────────────────────────────────────────────────────────────────

describe('compaction option validation (fail fast at the boundary)', () => {
  it('rejects an empty owner', async () => {
    const w = world();
    await expect(compactSegment(SEG, w.deps, { owner: '' })).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it('rejects a non-positive / non-finite leaseMs', async () => {
    const w = world();
    for (const leaseMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(compactSegment(SEG, w.deps, { owner: OWNER, leaseMs })).rejects.toBeInstanceOf(
        ValidationError,
      );
    }
  });

  it('runCompactionCycle fails fast on a bad owner / bad leaseMs even with zero candidates', async () => {
    const w = world(); // no segments discovered
    await expect(runCompactionCycle(w.deps, { owner: '' })).rejects.toBeInstanceOf(ValidationError);
    await expect(runCompactionCycle(w.deps, { owner: OWNER, leaseMs: -5 })).rejects.toBeInstanceOf(
      ValidationError,
    );
  });
});

// A real compile-time exhaustiveness guard over the AuditEvent union (replaces a hand-written literal list):
// if a variant is added/removed without updating this switch, `tsc` fails on the `never` assignment.
describe('AuditEvent union', () => {
  it('is exhaustively handled', () => {
    const label = (e: AuditEvent): string => {
      switch (e.kind) {
        case 'segment.publish':
          return e.segment;
        case 'segment.compact':
          return e.segment;
        case 'segment.erase':
          return e.segment;
        case 'namespace.erase':
          return e.namespace;
        default: {
          const _exhaustive: never = e;
          return _exhaustive;
        }
      }
    };
    expect(label({ kind: 'namespace.erase', namespace: 'ns', segmentsShredded: 0 })).toBe('ns');
  });
});
