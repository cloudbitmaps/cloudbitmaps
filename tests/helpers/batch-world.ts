/**
 * A store over in-memory storage whose driver calls are counted and can be intercepted, for the tests of
 * `store.materializeMany`: operands loaded as generations, a hook before each range read and each registry
 * compare-and-swap, and the bytes of any generation.
 */
import roaring from 'roaring';
import { CloudRoaring, MemoryStorage } from '@/index';
import type { CloudRoaringOptions, MaterializeManyOutput } from '@/index';
import { brandAsBackend } from '@/core/ports';
import type { IRegistryDriver, IStorageDriver, SegmentRef } from '@/core/ports';

const { RoaringBitmap32 } = roaring;
export type Bitmap = InstanceType<typeof RoaringBitmap32>;

export const bitmapOf = (ids: Iterable<number>): Bitmap =>
  RoaringBitmap32.from(Uint32Array.from(ids));
export const range = (lo: number, hi: number, step = 1): number[] => {
  const out: number[] = [];
  for (let v = lo; v < hi; v += step) out.push(v);
  return out;
};

export interface BatchWorld {
  store: CloudRoaring;
  /** A second store over the same backend: another process. */
  other: CloudRoaring;
  backend: MemoryStorage;
  calls: { storage: number; registry: number; ranges: number; casBySegment: Map<string, number> };
  hooks: {
    beforeRange?: (segment: string) => Promise<void> | void;
    beforeCas?: (segment: string) => Promise<void> | void;
  };
  load(name: string, ids: Iterable<number>, store?: CloudRoaring): Promise<void>;
  hex(ref: SegmentRef | string, generation: number): Promise<string>;
  ids(name: string, store?: CloudRoaring): Promise<number[]>;
}

export async function batchWorld(
  data: Record<string, Iterable<number>> = {},
  options: Omit<CloudRoaringOptions, 'storage'> = {},
): Promise<BatchWorld> {
  const backend = new MemoryStorage();
  const calls: BatchWorld['calls'] = {
    storage: 0,
    registry: 0,
    ranges: 0,
    casBySegment: new Map(),
  };
  const hooks: BatchWorld['hooks'] = {};
  const ASYNC_CALLS = new Set([
    'getRange',
    'getTail',
    'putImmutable',
    'delete',
    'get',
    'create',
    'compareAndSwap',
  ]);
  const wrap = <T extends object>(
    target: T,
    onCall: (m: string, args: unknown[]) => Promise<void> | void,
  ): T =>
    new Proxy(target, {
      get(t, prop, receiver) {
        const value: unknown = Reflect.get(t, prop, receiver);
        if (typeof value !== 'function' || !ASYNC_CALLS.has(String(prop))) return value;
        return async (...args: unknown[]) => {
          await onCall(String(prop), args);
          return (value as (...a: unknown[]) => unknown).apply(t, args);
        };
      },
    });
  const segmentOf = (a: unknown): string => (a as { segment?: string } | undefined)?.segment ?? '';
  const storage = wrap<IStorageDriver>(backend.storage, async (m, args) => {
    calls.storage++;
    if (m === 'getRange') {
      calls.ranges++;
      await hooks.beforeRange?.(segmentOf(args[0]));
    }
  });
  const registry = wrap<IRegistryDriver>(backend.registry, async (m, args) => {
    calls.registry++;
    if (m === 'compareAndSwap') {
      const seg = segmentOf(args[0]);
      calls.casBySegment.set(seg, (calls.casBySegment.get(seg) ?? 0) + 1);
      await hooks.beforeCas?.(seg);
    }
  });
  const open = (): CloudRoaring =>
    new CloudRoaring({
      cache: { genTtlMs: 0 },
      ...options,
      storage: brandAsBackend({ storage, registry }),
    });
  const store = open();
  const other = open();
  const world: BatchWorld = {
    store,
    other,
    backend,
    calls,
    hooks,
    async load(name, ids, s = store) {
      await s.load({ segment: name }, { bitmap: bitmapOf(ids) });
    },
    async hex(ref, generation) {
      const r = typeof ref === 'string' ? { segment: ref } : ref;
      const tail = await backend.storage.getTail({ ...r, generation }, 1 << 30);
      return Buffer.from(tail.bytes).toString('hex');
    },
    async ids(name, s = store) {
      const out: number[] = [];
      for await (const id of s.segment(name).iterate()) out.push(id);
      return out;
    },
  };
  for (const [name, ids] of Object.entries(data)) await world.load(name, ids);
  calls.storage = calls.registry = calls.ranges = 0;
  calls.casBySegment.clear();
  return world;
}

export type OutputInit = Omit<MaterializeManyOutput, 'dest'> & { dest: string };
