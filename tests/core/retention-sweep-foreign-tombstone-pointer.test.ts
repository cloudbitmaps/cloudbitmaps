import { randomBytes } from 'node:crypto';
import { destroySegment } from '@/index';
import { dropSegment, retireExpired } from '@cloudbitmaps/core';
import { InProcessKeystore } from '@/drivers/crypto';
import type { SegmentRef } from '@/index';
import type { IRegistryDriver } from '@/core/ports';
import { dueBucket, dueNamespace } from '@/core/due-index';
import { loadedStore } from '../helpers/loaded';

/**
 * A segment destroyed or dropped by hand after it was given a retention policy keeps a tombstone the sweep did not
 * write, so the sweep never retires or purges it. Its due-index pointer names nothing the sweep can act on, and the
 * sweep removes it when a scan reads it. The tombstone itself stays.
 */
const DAY = 86_400_000;
const T0 = 1_754_000_000_000;

async function pointersIn(
  registry: { list(ns?: string): AsyncIterable<{ segment: string }> },
  expiresAt: number,
): Promise<string[]> {
  const found: string[] = [];
  for await (const row of registry.list(dueNamespace(dueBucket(expiresAt))))
    found.push(row.segment);
  return found;
}

for (const scan of ['fleet', 'index'] as const) {
  for (const how of ['dropped', 'destroyed'] as const) {
    it(`removes the due pointer of a segment ${how} by hand (scan: ${scan}) and keeps its tombstone`, async () => {
      const w = await loadedStore(
        {},
        { seams: { clock: { now: () => T0, sleep: () => Promise.resolve() } } },
      );
      const soon = T0 + DAY;
      const ref: SegmentRef = { namespace: 'active', segment: 'a' };
      const other: SegmentRef = { namespace: 'active', segment: 'b' };
      if (how === 'dropped') {
        await w.load(ref, [1, 2, 3]);
      } else {
        const keystore = new InProcessKeystore({
          keys: { k1: randomBytes(32) },
          activeKeyId: 'k1',
        });
        const minted = await keystore.createDek();
        await w.registry.create(ref, { currentGen: 0, wrappedDeks: minted.wrapped });
      }
      await w.load(other, [4]);
      await w.store.setRetention(ref, { expiresAt: soon });
      await w.store.setRetention(other, { expiresAt: soon + 90 * DAY });
      expect(await pointersIn(w.registry, soon)).toHaveLength(1);

      if (how === 'dropped') {
        await dropSegment(
          ref,
          { registry: w.registry, storage: w.storage },
          { confirmSegment: 'a' },
        );
      } else {
        await destroySegment(ref, { registry: w.registry }, { confirmSegment: 'a' });
      }
      expect((await w.registry.get(ref))!.status).toBe('destroyed');

      const swept = await w.store.retireExpired({ scan, now: soon + 1 });

      expect(swept.retired).toBe(0);
      expect(await pointersIn(w.registry, soon)).toEqual([]);
      expect((await w.registry.get(ref))!.status).toBe('destroyed'); // the attestation stays
      expect(await pointersIn(w.registry, soon + 90 * DAY)).toHaveLength(1); // a live segment's pointer stays
    });
  }
}

const AccessDenied = (): Error =>
  Object.assign(new Error('Access Denied'), { name: 'AccessDenied' });

type Hook = (ref: SegmentRef, token: unknown) => Promise<void> | void;

/** The store's registry with a hook ahead of each delete in a due namespace, and a settable `conditionalDelete`. */
function wrapRegistry(
  base: IRegistryDriver,
  opts: { onPointerDelete?: Hook; conditionalDelete?: boolean },
): IRegistryDriver {
  return new Proxy(base, {
    get(target, prop) {
      const v = Reflect.get(target, prop, target) as unknown;
      if (prop === 'capabilities' && opts.conditionalDelete !== undefined) {
        return () => ({ ...target.capabilities(), conditionalDelete: opts.conditionalDelete });
      }
      if (prop === 'delete') {
        return async (ref: SegmentRef, token?: unknown) => {
          if (ref.namespace?.startsWith('cbm.due.') && opts.onPointerDelete) {
            await opts.onPointerDelete(ref, token);
          }
          return (v as (...a: unknown[]) => Promise<void>).call(target, ref, token);
        };
      }
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
}

/** How many due pointers name the foreign tombstone. */
async function pointerCount(registry: IRegistryDriver, expiresAt: number): Promise<number> {
  let n = 0;
  for await (const row of registry.list(dueNamespace(dueBucket(expiresAt)))) {
    if (row.segment.includes('foreign')) n += 1;
  }
  return n;
}

/** A segment given a policy that is then dropped by hand, and a second one due at the same time that the sweep retires. */
async function dueAndForeign(): Promise<{
  w: Awaited<ReturnType<typeof loadedStore>>;
  ref: SegmentRef;
  soon: number;
}> {
  const w = await loadedStore(
    {},
    { seams: { clock: { now: () => T0, sleep: () => Promise.resolve() } } },
  );
  const soon = T0 + DAY;
  const ref: SegmentRef = { namespace: 'active', segment: 'foreign' };
  const mine: SegmentRef = { namespace: 'active', segment: 'mine' };
  await w.load(ref, [1, 2, 3]);
  await w.load(mine, [4]);
  await w.store.setRetention(ref, { expiresAt: soon });
  await w.store.setRetention(mine, { expiresAt: soon });
  await dropSegment(
    ref,
    { registry: w.registry, storage: w.storage },
    { confirmSegment: 'foreign' },
  );
  return { w, ref, soon };
}

for (const scan of ['fleet', 'index'] as const) {
  describe(`foreign-tombstone pointer removal (scan: ${scan})`, () => {
    // Kills: a delete without the token fence (it would remove a pointer that was re-filed after the scan read it).
    it('does not remove a pointer that changed after the scan read it, and counts no fault for the lost race', async () => {
      const { w, soon } = await dueAndForeign();
      let raced = false;
      const registry = wrapRegistry(w.registry, {
        onPointerDelete: async (ref) => {
          if (raced || !ref.segment.includes('foreign')) return;
          raced = true;
          const row = (await w.registry.get(ref))!;
          await w.registry.delete(ref, row.token);
          await w.registry.create(ref, { currentGen: 0 });
        },
      });
      const res = await retireExpired({ registry, storage: w.storage }, { scan, now: soon + 1 });
      expect(raced).toBe(true);
      expect(res.purgeFaults).toBe(0);
      expect(await pointerCount(w.registry, soon)).toBe(1); // the re-filed pointer survived
    });

    // Kills: removal under dryRun.
    it('leaves every pointer in place under dryRun', async () => {
      const { w, soon } = await dueAndForeign();
      const before = await pointerCount(w.registry, soon);
      await retireExpired(
        { registry: w.registry, storage: w.storage },
        { scan, now: soon + 1, dryRun: true },
      );
      expect(await pointerCount(w.registry, soon)).toBe(before);
    });

    // Kills: removal on a registry without a permanent delete (a delete there rewrites the row as a tombstone, so
    // every scan would read one more row).
    it('removes nothing on a registry that cannot delete a row for good', async () => {
      const { w, soon } = await dueAndForeign();
      const before = await pointerCount(w.registry, soon);
      const registry = wrapRegistry(w.registry, { conditionalDelete: false });
      await retireExpired({ registry, storage: w.storage }, { scan, now: soon + 1 });
      expect(await pointerCount(w.registry, soon)).toBe(before);
    });

    // Kills: a cleanup fault that propagates out of the sweep (it would abort the rest of the run), and one that is
    // swallowed without being counted (an operator would never learn the registry refuses deletes).
    it('a refused pointer delete is counted, reported, and does not stop the sweep retiring the rest', async () => {
      const { w, soon } = await dueAndForeign();
      const registry = wrapRegistry(w.registry, {
        onPointerDelete: (ref) => {
          if (ref.segment.includes('foreign')) throw AccessDenied();
        },
      });
      const res = await retireExpired({ registry, storage: w.storage }, { scan, now: soon + 1 });
      expect(res.retired).toBe(1);
      expect(await pointerCount(w.registry, soon)).toBe(1);
      expect(res.purgeFaults).toBe(1);
      expect(res.firstPurgeFault).toBe('failed: Access Denied');
      expect((await w.registry.get({ namespace: 'active', segment: 'foreign' }))!.status).toBe(
        'destroyed',
      );
    });
  });
}
