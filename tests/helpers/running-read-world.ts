/**
 * The world the tests of a running read that meets a move share: a store over the in-memory backend holding `s` and
 * the operands combined with it, the moves that can reach a read already running, and the ways a test takes a read
 * apart around them.
 *
 * Generation 0 of `s` is 50 chunks of one id each; generation 1 drops chunk 40 and adds chunk 200; generation 2 drops
 * chunk 30 from generation 1 and adds chunk 201. Chunk 0 is the same in all three, so a read that takes its first id
 * and then follows a move yields exactly the answer over the generation it moved to.
 */
import { CloudRoaring, MemoryStorage } from '@/index';
import type { Clock, Segment, SegmentRef } from '@/index';
import { brandAsBackend } from '@/core/ports';
import type { GenKey, IRegistryDriver, IStorageDriver } from '@/core/ports';
import { bulkLoadCrbmGeneration } from './bulk-load';

export const C = 65_536;
export const NS = 'ns';
export const TTL = 10;
export const ref = (segment: string): SegmentRef => ({ namespace: NS, segment });
export const S = ref('s');
/** Holds one id, in chunk 0. */
export const O = ref('o');
/** Holds every id of every generation of `s`. */
export const MIRROR = ref('mirror');
export const OPTOUT = ref('optout');

export const GEN0 = Array.from({ length: 50 }, (_, c) => c * C + 1);
export const ADDED = 200 * C + 5;
export const DROPPED = 40 * C + 1;
export const GEN1 = [...GEN0.filter((id) => id !== DROPPED), ADDED];
export const GEN2_DROPPED = 30 * C + 1;
export const GEN2_ADDED = 201 * C + 5;
export const GEN2 = [...GEN1.filter((id) => id !== GEN2_DROPPED), GEN2_ADDED];
export const IN_O = 3;
/** In `s` and in the opt-out list from the start, in chunk 0: a combine reads the opt-out list there and at no key after. */
export const OPTED_OUT = 1;

export const sorted = (ids: Iterable<number>): number[] => [...new Set(ids)].sort((a, b) => a - b);

export function manualClock(): Clock & { advance(ms: number): void } {
  let t = 0;
  return { now: () => t, sleep: async () => {}, advance: (ms) => void (t += ms) };
}

export interface World {
  /** The backend's storage as it is, for another store's publish. */
  readonly storage: IStorageDriver;
  readonly registry: IRegistryDriver;
  readonly clock: ReturnType<typeof manualClock>;
  readonly store: CloudRoaring;
  readonly seg: (r: SegmentRef) => Segment;
}

export interface WorldOptions {
  /** `s` at generation 0; {@link GEN0} by default. */
  readonly s?: readonly number[];
  /** The store's per-op budget. */
  readonly maxRequests?: number;
  /** Runs before each tail read the store makes, with the object it reads. */
  readonly onTail?: (key: GenKey) => Promise<void> | void;
}

export async function world(options: WorldOptions = {}): Promise<World> {
  const backend = new MemoryStorage();
  const { storage, registry } = backend;
  const put = (r: SegmentRef, ids: readonly number[]) =>
    bulkLoadCrbmGeneration(storage, { ...r, generation: 0 }, sorted(ids), { registry });
  await put(S, options.s ?? GEN0);
  await put(O, [IN_O]);
  await put(MIRROR, [...GEN0, ADDED, GEN2_ADDED, 300 * C + 7]);
  await put(OPTOUT, [OPTED_OUT]);
  const onTail = options.onTail;
  const read: IStorageDriver =
    onTail === undefined
      ? storage
      : {
          capabilities: () => storage.capabilities(),
          getRange: (key, offset, length) => storage.getRange(key, offset, length),
          getTail: async (key, maxBytes) => {
            await onTail(key);
            return storage.getTail(key, maxBytes);
          },
          putImmutable: (key, write) => storage.putImmutable(key, write),
          list: (r) => storage.list(r),
          delete: (key, deleteOptions) => storage.delete(key, deleteOptions),
        };
  const clock = manualClock();
  const store = new CloudRoaring({
    storage: brandAsBackend({ storage: read, registry }),
    cache: { genTtlMs: TTL },
    seams: { clock },
    ...(options.maxRequests === undefined ? {} : { budget: { maxRequests: options.maxRequests } }),
  });
  return {
    storage,
    registry,
    clock,
    store,
    seg: (r) => store.segment(r.segment, { namespace: NS }),
  };
}

/** Every chunk of `refs` in the store's chunk cache, so a read of them is served from it. */
export async function warm(w: World, refs: readonly SegmentRef[]): Promise<void> {
  for (const r of refs) for await (const id of w.seg(r).iterate()) void id;
}

export const LOAD = 'this store loads';
export const PUBLISH_CACHED = 'another store publishes, past the TTL, every chunk cached';
export const PUBLISH_COLD = 'another store publishes, past the TTL, nothing cached';
export type Move = typeof LOAD | typeof PUBLISH_CACHED | typeof PUBLISH_COLD;
export const MOVES: readonly Move[] = [LOAD, PUBLISH_CACHED, PUBLISH_COLD];

/** The world a move is met in: every chunk of every segment in the chunk cache before the read, for a cached move. */
export async function worldFor(how: Move, options?: WorldOptions): Promise<World> {
  const w = await world(options);
  if (how === PUBLISH_CACHED) await warm(w, [S, O, MIRROR, OPTOUT]);
  return w;
}

/** Move `r` to `ids`, as `how` says. Another store's publish is a new generation this store is not told of. */
export async function move(
  w: World,
  how: Move,
  r: SegmentRef,
  ids: readonly number[],
): Promise<void> {
  if (how === LOAD) {
    await w.store.load(r, sorted(ids));
    return;
  }
  const generation = ((await w.registry.get(r))?.currentGen ?? -1) + 1;
  await bulkLoadCrbmGeneration(w.storage, { ...r, generation }, sorted(ids), {
    registry: w.registry,
  });
  w.clock.advance(TTL + 1);
}

/** Take the first item of `stream`, run `then`, and gather the rest: everything it yielded, in order. */
export async function across<T>(stream: AsyncIterable<T>, then: () => Promise<void>): Promise<T[]> {
  return acrossMoves(stream, { 1: then });
}

/** Run `moves[i]` once the stream has yielded `i` items (1-based), and gather everything it yields. */
export async function acrossMoves<T>(
  stream: AsyncIterable<T>,
  moves: Readonly<Record<number, () => Promise<void>>>,
): Promise<T[]> {
  const out: T[] = [];
  for await (const item of stream) {
    out.push(item);
    await moves[out.length]?.();
  }
  return out;
}

/** The ids of a stream of batches, one at a time, so a batch read moves at the same point as an id read. */
export async function* flatten(batches: AsyncIterable<Uint32Array>): AsyncGenerator<number> {
  for await (const batch of batches) yield* batch;
}
