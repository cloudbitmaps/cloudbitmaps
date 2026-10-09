import { randomBytes } from 'node:crypto';
import fc from 'fast-check';
import { openGenerationReader } from '@/core/crbm-storage-source';
import { aadFor } from '@/core/crypto';
import { eraseIdFromSegment, type EraseIdResult } from '@/core/erase-id';
import { WriteConflictError } from '@/core/errors';
import { loadSegment, type LoadResult } from '@/core/load';
import type { IRegistryDriver, IStorageDriver, SegmentRef } from '@/core/ports';
import { setSegmentRetention } from '@/core/retention';
import { InProcessKeystore } from '@/drivers/crypto';
import { MemoryRegistryDriver, MemoryStorageDriver } from '@/drivers/memory';
import { roaringCodec } from '@/roaring-codec';
import { bulkLoadCrbmGeneration } from '../helpers/bulk-load';

/**
 * An erasure and first loads onto a segment whose row has no pointer, in an order fast-check chooses.
 *
 * A segment's row is made with no pointer, as `setRetention` makes it before the first load: up front, or by a
 * `setRetention` racing the loads, which then may find no row. Its bucket holds zero to two objects of first loads that
 * crashed before their publish, and one to three first loads run, each guarded or not. One erasure runs too, of an id
 * one of those objects or loads holds: at once, once every load has read the row, or once a load's object has landed
 * (then of an id that object holds). In half the runs the segment is
 * encrypted, so no first load's object can be searched while the row has no pointer, and each is a holder whatever the
 * id. Every registry read and write, object write, read, listing and delete waits until the scheduler lets it through.
 *
 * Before every one of those calls goes through, and after the run:
 *
 *  1. a row with a pointer names an object in the bucket. The row is read before and after the bucket is listed, and
 *     only a row that did not change in between is judged, so a write between the reads is never taken for a tear.
 *
 * After the run:
 *
 *  2. when every load had read the row before the erasure began, and it answered `erased: true`, the generation the row
 *     names does not hold the erased id. A load that read the row after the erasure began can publish the id again,
 *     which is why the guide says not to load an id while erasing it, so such a run is not held to this. Nor is any
 *     object in the bucket: a load that read the row before the erasure renewed it, and writes its object after the
 *     erasure's last look at the bucket, is refused at its publish and keeps its object, above no pointer;
 *  3. every load published, or was refused `superseded`; the erasure answered, or threw `WriteConflictError` (a holder
 *     left at its last look, or a number another writer took first).
 *
 * The floors at the end hold the runs to what they are for: erasures that renewed a row with no pointer and deleted a
 * first load's object, and loads refused because their object was deleted.
 */

const SEG: SegmentRef = { namespace: 'ns', segment: 's' };

interface LoadSpec {
  readonly ids: readonly number[];
  readonly guarded: boolean;
}

/** When the erasure begins: at once, once every load has read the row, or once a load's object has landed. */
type Start = 'now' | 'reads' | 'write';

const IDS = fc.uniqueArray(fc.integer({ min: 0, max: 12 }), { minLength: 1, maxLength: 4 });
const LOAD: fc.Arbitrary<LoadSpec> = fc.record({ ids: IDS, guarded: fc.boolean() });

const REGISTRY_CALLS = ['get', 'create', 'compareAndSwap', 'delete'] as const;
const STORAGE_CALLS = ['putImmutable', 'getTail', 'getRange', 'list', 'delete'] as const;

/**
 * `target`, with each call of `methods` waiting its turn, and `before` run once the turn is given and before the call.
 * A listing is an async iterable, not a promise: it waits its turn before its first entry. `after` sees each call that
 * returned, with its arguments.
 */
function scheduled<T extends object>(
  s: fc.Scheduler,
  target: T,
  methods: readonly string[],
  who: string,
  before: () => Promise<void>,
  after: (method: string, args: unknown[]) => void = () => undefined,
): T {
  const turn = async (label: string): Promise<void> => {
    await s.schedule(Promise.resolve(), label);
    await before();
  };
  return new Proxy(target, {
    get(t, p, rx) {
      const value: unknown = Reflect.get(t, p, rx);
      if (typeof value !== 'function') return value;
      const fn = value as (...a: unknown[]) => unknown;
      if (!methods.includes(String(p))) return (...a: unknown[]) => fn.apply(t, a);
      if (p === 'list') {
        return (...a: unknown[]) =>
          (async function* () {
            await turn(`${who} list`);
            yield* fn.apply(t, a) as AsyncIterable<unknown>;
          })();
      }
      return async (...a: unknown[]) => {
        await turn(`${who} ${String(p)}`);
        const out = await (fn.apply(t, a) as Promise<unknown>);
        after(String(p), a);
        return out;
      };
    },
  });
}

/** `registry`, telling `read` once its first row read has answered. */
function firstRead(registry: IRegistryDriver, read: () => void): IRegistryDriver {
  let first = true;
  return new Proxy(registry, {
    get(t, p, rx) {
      const value: unknown = Reflect.get(t, p, rx);
      if (typeof value !== 'function') return value;
      const fn = value as (...a: unknown[]) => unknown;
      if (p !== 'get') return (...a: unknown[]) => fn.apply(t, a);
      return async (...a: unknown[]) => {
        const row = await (fn.apply(t, a) as Promise<unknown>);
        if (first) {
          first = false;
          read();
        }
        return row;
      };
    },
  });
}

async function generations(storage: IStorageDriver): Promise<number[]> {
  const out: number[] = [];
  for await (const k of storage.list(SEG)) out.push(k.generation);
  return out.sort((a, b) => a - b);
}

/** The ids of the generation the row names, read with the row's key when it has one; `null` with no pointer. */
async function idsServed(
  storage: IStorageDriver,
  registry: IRegistryDriver,
  keystore: InProcessKeystore | undefined,
): Promise<number[] | null> {
  const row = await registry.get(SEG);
  if (row === null || row.status !== 'active' || row.currentGen === null) return null;
  const generation = row.currentGen;
  const keyed = row.wrappedDeks !== undefined && row.wrappedDeks.length > 0;
  const aead = keyed ? await keystore!.openDek(row.wrappedDeks!) : undefined;
  const reader = await openGenerationReader(
    storage,
    { ...SEG, generation },
    aead === undefined ? undefined : { aead, aadFor: (scope) => aadFor(SEG, generation, scope) },
  );
  const out: number[] = [];
  for (const chunkKey of reader.chunkKeys()) {
    const bytes = await reader.getChunk(chunkKey);
    if (bytes === null) continue;
    for (const r of roaringCodec.safeDeserialize(bytes, 1 << 20).toArray()) {
      out.push((chunkKey << 16) + r);
    }
  }
  return out.sort((a, b) => a - b);
}

describe('an erasure racing first loads onto a row with no pointer (property)', () => {
  it('no pointer names a missing object, and an id it reports erased is not served after it', async () => {
    let renewed = 0;
    let refusedAndDeleted = 0;
    await fc.assert(
      fc.asyncProperty(
        fc.scheduler(),
        fc.constantFrom(true, true, false), // the row is made up front, or by a setRetention racing the loads
        fc.array(IDS, { minLength: 0, maxLength: 2 }), // objects of first loads that crashed
        fc.array(LOAD, { minLength: 1, maxLength: 3 }),
        fc.constantFrom<Start>('now', 'reads', 'write', 'write'), // when the erasure begins
        fc.boolean(), // encrypted
        fc.nat(),
        async (s, rowFirst, crashed, specs, start, encrypted, pick) => {
          const storage = new MemoryStorageDriver();
          const registry = new MemoryRegistryDriver();
          const keystore = encrypted
            ? new InProcessKeystore({ keys: { A: randomBytes(32) }, activeKeyId: 'A' })
            : undefined;
          const keyed = keystore === undefined ? {} : { keystore };
          if (rowFirst) {
            await setSegmentRetention(SEG, { registry }, { expiresAt: Date.now() + 86_400_000 });
          }
          for (const [generation, ids] of crashed.entries()) {
            await bulkLoadCrbmGeneration(storage, { ...SEG, generation }, [...ids], {
              registry,
              publish: false,
              ...keyed,
            });
          }
          // An id a crashed object holds, where there is one, in half the runs; otherwise one any of them holds.
          const fromCrashed = crashed.flat();
          const held = [...new Set([...fromCrashed, ...specs.flatMap((l) => [...l.ids])])];
          const pool = fromCrashed.length > 0 && pick % 2 === 0 ? fromCrashed : held;
          const id = pool[Math.floor(pick / 2) % pool.length]!;

          // 1, checked before each call goes through: a row unchanged across a listing of the bucket names an object in it.
          const torn: string[] = [];
          const check = async (): Promise<void> => {
            const before = await registry.get(SEG);
            const present = await generations(storage);
            const after = await registry.get(SEG);
            if (
              before !== null &&
              after !== null &&
              before.token === after.token &&
              before.status === 'active' &&
              before.currentGen !== null &&
              !present.includes(before.currentGen)
            ) {
              torn.push(`the row names ${before.currentGen}; the bucket holds [${present.join()}]`);
            }
          };

          // The erasure begins at its start, with the id to erase: one a load's landed object holds, for `write`.
          let reads = 0;
          let begin!: (id: number) => void;
          const begun = new Promise<number>((resolve) => (begin = resolve));
          if (start === 'now') begin(id);
          const loads = specs.map((spec, i) =>
            loadSegment(
              SEG,
              [...spec.ids],
              {
                storage: scheduled(s, storage, STORAGE_CALLS, `load ${i}`, check, (method) => {
                  if (method === 'putImmutable' && start === 'write') {
                    begin(spec.ids[pick % spec.ids.length]!);
                  }
                }),
                registry: firstRead(
                  scheduled(s, registry, REGISTRY_CALLS, `load ${i}`, check),
                  () => {
                    if (++reads === specs.length && start === 'reads') begin(id);
                  },
                ),
                codec: roaringCodec,
                ...keyed,
              },
              spec.guarded ? {} : { allowEmpty: true },
            ).then(
              (r): { r: LoadResult } | { err: unknown } => ({ r }),
              (err: unknown) => ({ err }),
            ),
          );
          const settled = Promise.all(loads);
          const retention = rowFirst
            ? Promise.resolve()
            : setSegmentRetention(
                SEG,
                { registry: scheduled(s, registry, REGISTRY_CALLS, 'setRetention', check) },
                { expiresAt: Date.now() + 86_400_000 },
              ).then(
                () => undefined,
                () => undefined,
              );
          // What the erasure did: whether a renewal of a row with no pointer landed, and the generations it deleted.
          const did = { renewed: false, deleted: new Set<number>() };
          const at: { id?: number; everyLoadRead?: boolean } = {};
          // A load that never writes an object leaves the erasure to begin once every load has answered.
          const erasure = Promise.race([begun, settled.then(() => id)]).then((chosen) => {
            at.id = chosen;
            at.everyLoadRead = reads === specs.length;
            return eraseIdFromSegment(SEG, chosen, {
              storage: scheduled(s, storage, STORAGE_CALLS, 'erasure', check, (method, a) => {
                if (method === 'delete')
                  did.deleted.add((a[0] as { generation: number }).generation);
              }),
              registry: scheduled(s, registry, REGISTRY_CALLS, 'erasure', check, (method, a) => {
                const patch = a[2] as { currentGen?: number | null } | undefined;
                if (method === 'compareAndSwap' && patch?.currentGen === null) did.renewed = true;
              }),
              codec: roaringCodec,
              ...keyed,
            }).then(
              (r): { r: EraseIdResult } | { err: unknown } => ({ r }),
              (err: unknown) => ({ err }),
            );
          });

          const outcomes = await s.waitFor(settled);
          await s.waitFor(retention);
          const erased = await s.waitFor(erasure);
          await check();

          // 1.
          expect(torn).toEqual([]);

          // 3. Each load published or was refused as superseded; the erasure answered, or threw a write conflict.
          outcomes.forEach((o, i) => {
            if ('err' in o) throw new Error(`load ${i} threw: ${String(o.err)}`);
            if (!o.r.published) expect(o.r.reason).toBe('superseded');
          });
          if ('err' in erased) {
            // A holder left at its last look asks for a re-run; a number another writer took first is write-once.
            expect(erased.err).toBeInstanceOf(WriteConflictError);
          }

          // 2. An id the erasure reported erased is not served, when every load read the row before it began.
          const result = 'r' in erased ? erased.r : undefined;
          if (at.everyLoadRead === true && result?.erased === true) {
            const served = await idsServed(storage, registry, keystore);
            if (served !== null) expect(served).not.toContain(at.id);
          }

          if (did.renewed && did.deleted.size > 0) renewed += 1;
          refusedAndDeleted += outcomes.filter(
            (o) => 'r' in o && !o.r.published && did.renewed && did.deleted.has(o.r.generation),
          ).length;
        },
      ),
      { numRuns: 150 },
    );
    // Each well below what 200 seeds gave at their lowest: 9 and 6 (means 19.6 and 20.3).
    expect(renewed).toBeGreaterThan(3);
    expect(refusedAndDeleted).toBeGreaterThan(1);
  }, 120_000);
});
