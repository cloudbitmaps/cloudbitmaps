import { describe, expect, it } from 'vitest';
import { CloudRoaring } from '@/index';
import {
  CapabilityError,
  UnsupportedError,
  ValidationError,
  WriteConflictError,
} from '@/core/errors';
import { brandAsBackend, type SegmentRef } from '@/core/ports';
import { reapRegistryTombstones } from '@/core/registry-reap';
import { MemoryRegistryDriver, MemoryStorageDriver } from '@/drivers/memory';
import { ObjectStoreRegistry } from '@/drivers/_shared/object-registry';
import { registryObjectKey } from '@/drivers/_shared/object-registry-keys';
import { CountingObjectStore } from '../../helpers/counting';
import { tokenParts } from '../../helpers/tokens';

/**
 * The tombstone reaper removes the `deleted: true` rows that a release before 0.12 left in a registry: rows whose token
 * carries no incarnation id, which no `delete` removes and every full listing still reads. These pin what it removes,
 * what it never touches, that each removal is fenced on the version it read, and what it costs in requests.
 */

const PREFIX = 'p';
const ref = (segment: string, namespace?: string): SegmentRef => ({ segment, namespace });
const keyOf = (r: SegmentRef): string => registryObjectKey(PREFIX, r);
const clock = (): (() => number) => {
  let t = 1_000;
  return () => (t += 1);
};

/**
 * A row as a release before 0.12 wrote it, planted as it left it: schema 1 with a bare counter for a token, or, once a
 * 0.12+ build had written it again, schema 2 with the counter and a write part and still no incarnation id.
 */
function legacy(
  store: CountingObjectStore,
  r: SegmentRef,
  fields: {
    deleted: boolean;
    status?: 'active' | 'destroyed';
    token?: string;
    currentGen?: number;
  },
): void {
  store.plant(
    keyOf(r),
    JSON.stringify({
      schemaVersion: (fields.token ?? '12').includes('.') ? 2 : 1,
      deleted: fields.deleted,
      record: {
        namespace: r.namespace,
        segment: r.segment,
        currentGen: fields.currentGen ?? 3,
        status: fields.status ?? 'destroyed',
        createdAt: 1,
        updatedAt: 1,
        token: fields.token ?? '12',
      },
    }),
  );
}

function world(options: { conditionalDelete?: boolean } = { conditionalDelete: true }) {
  const store = new CountingObjectStore(0, options);
  const registry = new ObjectStoreRegistry(store, PREFIX, clock());
  const counts = () => ({
    lists: store.lists,
    reads: store.reads,
    deletes: store.deletes,
    writes: store.writes,
  });
  return { store, registry, counts };
}

const CONFIRM = { confirmNoLegacyWriters: true } as const;

describe('what the reaper removes', () => {
  it('removes a deleted envelope with a bare token, and one with a counter and a write part', async () => {
    const w = world();
    legacy(w.store, ref('bare'), { deleted: true, token: '12' });
    legacy(w.store, ref('counted'), { deleted: true, token: '13.1f9c0a7be2d4c3a1' });

    const result = await reapRegistryTombstones(w.registry, CONFIRM);

    expect(result).toMatchObject({
      dryRun: false,
      examined: 2,
      reaped: 2,
      wouldReap: 0,
      limited: false,
    });
    expect(w.store.text(keyOf(ref('bare')))).toBeUndefined();
    expect(w.store.text(keyOf(ref('counted')))).toBeUndefined();
  });

  it('after a run the full listing reads nothing for them: one more run finds nothing', async () => {
    const w = world();
    legacy(w.store, ref('a'), { deleted: true });
    await reapRegistryTombstones(w.registry, CONFIRM);
    const again = await reapRegistryTombstones(w.registry, CONFIRM);
    expect(again).toMatchObject({ examined: 0, reaped: 0 });
  });
});

describe('what the reaper never touches', () => {
  async function plantEverything(w: ReturnType<typeof world>) {
    // a live row, born before 0.12 (bare token)
    legacy(w.store, ref('live-legacy'), { deleted: false, status: 'active', token: '7' });
    // a live row a 0.12+ build created
    await w.registry.create(ref('live-new'), { currentGen: 0 });
    // a destroyed row with no incarnation and no sweep stamp: a hand-run dropSegment or a crypto-shred
    legacy(w.store, ref('destroyed-legacy'), { deleted: false, status: 'destroyed', token: '9' });
    // a tombstone a 0.12+ build wrote: it keeps its incarnation id (the store did not remove rows when it was written)
    const young = world({ conditionalDelete: false });
    const { token } = await young.registry.create(ref('tomb-new'), { currentGen: 0 });
    await young.registry.delete(ref('tomb-new'), token);
    w.store.plant(keyOf(ref('tomb-new')), young.store.text(keyOf(ref('tomb-new')))!);
    // the reapable one, so the run has something to do beside the refusals
    legacy(w.store, ref('envelope'), { deleted: true });
  }

  it('removes only the envelope, and says why it left the rest', async () => {
    const w = world();
    await plantEverything(w);
    const before = new Map(
      ['live-legacy', 'live-new', 'destroyed-legacy', 'tomb-new'].map((s) => [
        s,
        w.store.text(keyOf(ref(s))),
      ]),
    );

    const result = await reapRegistryTombstones(w.registry, CONFIRM);

    expect(result).toMatchObject({
      examined: 5,
      reaped: 1,
      skipped: { live: 2, destroyed: 1, incarnated: 1, raced: 0 },
    });
    expect(w.store.text(keyOf(ref('envelope')))).toBeUndefined();
    for (const [s, text] of before) expect(w.store.text(keyOf(ref(s)))).toBe(text);
  });

  it('a tombstone dropSegment leaves is not an envelope: the reaper leaves it', async () => {
    const store = new CountingObjectStore(0, { conditionalDelete: true });
    const registry = new ObjectStoreRegistry(store, PREFIX, clock());
    // dropSegment tombstones a row as `destroyed`, not as `deleted: true`, and stamps nothing
    legacy(store, ref('dropped'), {
      deleted: false,
      status: 'destroyed',
      token: '10.1f9c0a7be2d4c3a1',
    });
    const text = store.text(keyOf(ref('dropped')));
    const result = await reapRegistryTombstones(registry, CONFIRM);
    expect(result).toMatchObject({ reaped: 0, skipped: { destroyed: 1 } });
    expect(store.text(keyOf(ref('dropped')))).toBe(text);
    expect(store.deletes).toBe(0);
  });
});

describe('the confirmation and the dry run', () => {
  it('a real run without the flag is a ValidationError and sends no request', async () => {
    const w = world();
    legacy(w.store, ref('a'), { deleted: true });
    for (const options of [{}, { confirmNoLegacyWriters: false }, { dryRun: false }]) {
      await expect(
        reapRegistryTombstones(w.registry, options as Parameters<typeof reapRegistryTombstones>[1]),
      ).rejects.toBeInstanceOf(ValidationError);
    }
    expect(w.counts()).toEqual({ lists: 0, reads: 0, deletes: 0, writes: 0 });
  });

  it('a dry run needs no flag, deletes nothing and reports exactly what a real run then deletes', async () => {
    const w = world();
    for (let i = 0; i < 5; i++) legacy(w.store, ref(`e${i}`), { deleted: true });
    legacy(w.store, ref('live'), { deleted: false, status: 'active', token: '7' });
    const bytes = w.store.size(`${PREFIX}/registry/`);

    const dry = await reapRegistryTombstones(w.registry, { dryRun: true });

    expect(dry).toMatchObject({
      dryRun: true,
      examined: 6,
      reaped: 0,
      wouldReap: 5,
      skipped: { live: 1 },
    });
    expect(w.store.size(`${PREFIX}/registry/`)).toBe(bytes);
    expect(w.store.deletes).toBe(0);

    const real = await reapRegistryTombstones(w.registry, CONFIRM);
    expect(real).toMatchObject({
      examined: dry.examined,
      reaped: dry.wouldReap,
      wouldReap: 0,
      skipped: dry.skipped,
    });
    expect(w.store.size(`${PREFIX}/registry/`)).toBe(bytes - 5);
  });

  it('a dry run with the flag is still a dry run', async () => {
    const w = world();
    legacy(w.store, ref('a'), { deleted: true });
    const r = await reapRegistryTombstones(w.registry, { dryRun: true, ...CONFIRM });
    expect(r).toMatchObject({ reaped: 0, wouldReap: 1 });
    expect(w.store.deletes).toBe(0);
  });
});

describe('a registry whose delete is not fenced', () => {
  it('conditionalDelete off: CapabilityError, for a dry run too, and zero requests', async () => {
    const w = world({ conditionalDelete: false });
    legacy(w.store, ref('a'), { deleted: true });
    for (const options of [CONFIRM, { dryRun: true }]) {
      await expect(reapRegistryTombstones(w.registry, options)).rejects.toBeInstanceOf(
        CapabilityError,
      );
    }
    expect(w.counts()).toEqual({ lists: 0, reads: 0, deletes: 0, writes: 0 });
    expect(w.store.text(keyOf(ref('a')))).toBeDefined();
  });

  it('a registry with no reaper at all is an UnsupportedError', async () => {
    const memory = brandAsBackend({
      storage: new MemoryStorageDriver(),
      registry: new MemoryRegistryDriver(),
    });
    const store = new CloudRoaring({ storage: memory });
    await expect(store.reapRegistryTombstones(CONFIRM)).rejects.toBeInstanceOf(UnsupportedError);
  });
});

describe('a re-create racing the delete', () => {
  it('the delete loses to a write that lands between its read and its delete, and the new row survives', async () => {
    const w = world();
    legacy(w.store, ref('a'), { deleted: true, token: '12' });
    let created = '';
    w.store.beforeDelete = async () => {
      // another process re-creates the name over the envelope, under the envelope's version
      created = (
        await new ObjectStoreRegistry(w.store, PREFIX, clock()).create(ref('a'), { currentGen: 0 })
      ).token;
    };

    const result = await reapRegistryTombstones(w.registry, CONFIRM);

    expect(result).toMatchObject({ examined: 1, reaped: 0, skipped: { raced: 1 } });
    expect(tokenParts(created).counter).toBeGreaterThan(12); // a new incarnation, its counter carried on
    expect(await w.registry.get(ref('a'))).toMatchObject({ currentGen: 0, token: created });
  });

  it('a re-create that comes after the delete finds no row and creates one', async () => {
    const w = world();
    legacy(w.store, ref('a'), { deleted: true });
    await reapRegistryTombstones(w.registry, CONFIRM);
    const { token } = await w.registry.create(ref('a'), { currentGen: 0 });
    expect(tokenParts(token).counter).toBe(0); // over nothing: a new incarnation from 0
  });

  it('a re-create whose own read saw the envelope loses to the delete with WriteConflictError, and a retry succeeds', async () => {
    const w = world();
    legacy(w.store, ref('a'), { deleted: true, token: '12' });
    const creator = new ObjectStoreRegistry(w.store, PREFIX, clock());
    // the creator reads the envelope; the reaper removes it before the creator's write over it lands
    const realWrite = w.store.write.bind(w.store);
    let first = true;
    w.store.write = async (key, body, expect) => {
      if (first) {
        first = false;
        await reapRegistryTombstones(w.registry, CONFIRM);
      }
      return realWrite(key, body, expect);
    };
    await expect(creator.create(ref('a'), { currentGen: 0 })).rejects.toBeInstanceOf(
      WriteConflictError,
    );
    expect(w.store.text(keyOf(ref('a')))).toBeUndefined();
    // the caller's to retry: with no row there, a create is create-only and lands
    const { token } = await creator.create(ref('a'), { currentGen: 0 });
    expect(tokenParts(token).counter).toBe(0); // over nothing: a new incarnation from 0
  });
});

describe('namespace and limit', () => {
  it('a namespace scopes the run to that namespace', async () => {
    const w = world();
    legacy(w.store, ref('a', 'one'), { deleted: true });
    legacy(w.store, ref('b', 'two'), { deleted: true });
    const result = await reapRegistryTombstones(w.registry, { ...CONFIRM, namespace: 'one' });
    expect(result).toMatchObject({ examined: 1, reaped: 1 });
    expect(w.store.text(keyOf(ref('a', 'one')))).toBeUndefined();
    expect(w.store.text(keyOf(ref('b', 'two')))).toBeDefined();
  });

  it('without a namespace it covers every namespace, the due index’s included', async () => {
    const w = world();
    legacy(w.store, ref('a', 'one'), { deleted: true });
    legacy(w.store, ref('20356.0', 'cbm.due.20356'), { deleted: true });
    legacy(w.store, ref('d'), { deleted: true });
    const result = await reapRegistryTombstones(w.registry, CONFIRM);
    expect(result).toMatchObject({ examined: 3, reaped: 3 });
  });

  it('a live due-index pointer is never touched', async () => {
    const w = world();
    await w.registry.create(ref('20356.0', 'cbm.due.20356'), { currentGen: null });
    const result = await reapRegistryTombstones(w.registry, CONFIRM);
    expect(result).toMatchObject({ reaped: 0, skipped: { live: 1 } });
  });

  it('a reserved namespace as the scope is a ValidationError, as it is for every scan', async () => {
    const w = world();
    await expect(
      reapRegistryTombstones(w.registry, { ...CONFIRM, namespace: 'cbm.due.20356' }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('a limit stops the run after that many removals, says so, and a second run finishes', async () => {
    const w = world();
    for (let i = 0; i < 10; i++) legacy(w.store, ref(`e${i}`), { deleted: true });
    const first = await reapRegistryTombstones(w.registry, { ...CONFIRM, limit: 4 });
    expect(first).toMatchObject({ reaped: 4, limited: true });
    expect(w.store.deletes).toBe(4);
    const second = await reapRegistryTombstones(w.registry, { ...CONFIRM, limit: 100 });
    expect(second).toMatchObject({ reaped: 6, limited: false });
  });

  it('a dry run with a limit counts the same rows a real one would remove', async () => {
    const w = world();
    for (let i = 0; i < 10; i++) legacy(w.store, ref(`e${i}`), { deleted: true });
    const dry = await reapRegistryTombstones(w.registry, { dryRun: true, limit: 4 });
    expect(dry).toMatchObject({ wouldReap: 4, limited: true });
  });

  it('a limit that is not a positive integer is a ValidationError', async () => {
    const w = world();
    for (const limit of [0, -1, 1.5, Number.NaN]) {
      await expect(
        reapRegistryTombstones(w.registry, { ...CONFIRM, limit }),
      ).rejects.toBeInstanceOf(ValidationError);
    }
  });
});

describe('requests', () => {
  it('R rows cost ceil(R/1000) LIST + R GET + E DELETE, a dry run the same without the DELETEs', async () => {
    const w = world();
    const R = 120;
    const E = 70;
    for (let i = 0; i < R; i++) {
      if (i < E) legacy(w.store, ref(`e${i}`), { deleted: true });
      else legacy(w.store, ref(`l${i}`), { deleted: false, status: 'active', token: '7' });
    }
    await reapRegistryTombstones(w.registry, { dryRun: true });
    expect(w.counts()).toEqual({ lists: 1, reads: R, deletes: 0, writes: 0 });

    const before = w.counts();
    await reapRegistryTombstones(w.registry, CONFIRM);
    const after = w.counts();
    expect({
      lists: after.lists - before.lists,
      reads: after.reads - before.reads,
      deletes: after.deletes - before.deletes,
      writes: after.writes,
    }).toEqual({
      lists: 1,
      reads: R,
      deletes: E,
      writes: 0,
    });
  });
});

describe('the store method', () => {
  it('is the same call over the store’s registry, and reaps', async () => {
    const w = world();
    legacy(w.store, ref('a'), { deleted: true });
    const store = new CloudRoaring({
      storage: brandAsBackend({ storage: new MemoryStorageDriver(), registry: w.registry }),
    });
    expect(await store.reapRegistryTombstones({ dryRun: true })).toMatchObject({ wouldReap: 1 });
    expect(await store.reapRegistryTombstones(CONFIRM)).toMatchObject({ reaped: 1 });
  });
});
