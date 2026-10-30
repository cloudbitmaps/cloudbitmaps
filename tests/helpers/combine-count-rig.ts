/**
 * The rig the tests of an engine's combine counts share: segments loaded as generation 0 into an in-memory backend
 * (or any later generation, written by another party), and engines over fresh sources on it, so each read is cold and
 * the driver's calls can be counted. An engine is built the way a store builds its own, over a `.crbm` source, with a
 * clock the test moves.
 */
import { CrbmStorageChunkSource } from '@/core/crbm-storage-source';
import { SegmentEngine } from '@/core/engine';
import type { CountOptions } from '@/core/engine';
import { MemoryStorage } from '@/index';
import type { SegmentRef } from '@/index';
import type { IRegistryDriver, IStorageDriver, StorageChunkSource } from '@/core/ports';
import { bulkLoadCrbmGeneration } from './bulk-load';
import { counting } from './counting';
import { storeCodec } from './store-codec';
import { sorted } from './running-read-world';

export const C = 65_536;
export const TTL = 10;
export const ref = (segment: string): SegmentRef => ({ namespace: 'ns', segment });

/** The ids of one chunk: `n` ids from `start` in chunk `key`. */
export const chunk = (key: number, n: number, start = 0): number[] =>
  Array.from({ length: n }, (_, i) => key * C + start + i);

/** The distinct ids of `lists`, ascending. */
export const setOf = (...lists: ReadonlyArray<readonly number[]>): number[] => sorted(lists.flat());

/** What each combine means as sets: the oracle every count is held to. */
export const OPS = {
  intersect: (lists: ReadonlyArray<readonly number[]>): number[] =>
    sorted(lists[0]!).filter((id) => lists.every((l) => l.includes(id))),
  union: (lists: ReadonlyArray<readonly number[]>): number[] => setOf(...lists),
  andNot: (lists: ReadonlyArray<readonly number[]>): number[] =>
    sorted(lists[0]!).filter((id) => !lists.slice(1).some((l) => l.includes(id))),
} as const;
export type Op = keyof typeof OPS;
const MODE = { intersect: 'all', union: 'any', andNot: 'all' } as const;

export interface Counts {
  [method: string]: number;
}

export interface Rig {
  readonly backend: MemoryStorage;
  readonly storage: IStorageDriver;
  readonly registry: IRegistryDriver;
  /** Driver calls of the engines built since the last `reset`, by method name. */
  readonly calls: Counts;
  readonly clock: { now(): number; advance(ms: number): void };
  /** Load `ids` as the next generation of `segment`, as another party's publish: the engines are not told. */
  load(segment: string, ids: readonly number[]): Promise<number>;
  /** A fresh engine over a fresh source (cold), its driver calls counted in `calls`. */
  engine(options?: {
    source?: (inner: CrbmStorageChunkSource) => StorageChunkSource;
  }): SegmentEngine;
  reset(): void;
}

export function rig(): Rig {
  const backend = new MemoryStorage();
  const calls: Counts = {};
  let now = 0;
  const clock = {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
  const metered = new Proxy(backend.storage, {
    get(t, prop, receiver) {
      const value: unknown = Reflect.get(t, prop, receiver);
      if (prop !== 'getRange') return value;
      return (key: unknown, offset: number, length: number) => {
        calls.rangeBytes = (calls.rangeBytes ?? 0) + length;
        return (value as (...a: unknown[]) => unknown).call(t, key, offset, length);
      };
    },
  });
  const storage = counting(metered, calls);
  const registry = counting(backend.registry, calls);
  return {
    backend,
    storage: backend.storage,
    registry: backend.registry,
    calls,
    clock,
    async load(segment, ids) {
      const r = ref(segment);
      const generation = ((await backend.registry.get(r))?.currentGen ?? -1) + 1;
      await bulkLoadCrbmGeneration(backend.storage, { ...r, generation }, sorted(ids), {
        registry: backend.registry,
      });
      return generation;
    },
    engine(options) {
      const crbm = new CrbmStorageChunkSource(storage, {
        registry,
        clock,
        currentGenTtlMs: TTL,
      });
      return new SegmentEngine({
        storage: options?.source ? options.source(crbm) : crbm,
        codec: storeCodec,
        clock,
      });
    },
    reset() {
      for (const k of Object.keys(calls)) delete calls[k];
    },
  };
}

/** The count of `op` over `segs` (the first is `this`), by the engine's function. */
export function countOf(
  engine: SegmentEngine,
  op: Op,
  segs: readonly SegmentRef[],
  options: Omit<CountOptions, 'exclude'> = {},
  exclude: readonly SegmentRef[] = [],
): Promise<number> {
  return op === 'andNot'
    ? engine.combineCount([segs[0]!], segs.slice(1), 'all', op, options)
    : engine.combineCount(segs, exclude, MODE[op], op, options);
}

/** The stream of `op`, which a count is held to the size of. */
export function streamOf(
  engine: SegmentEngine,
  op: Op,
  segs: readonly SegmentRef[],
  options: Omit<CountOptions, 'exclude' | 'guard'> = {},
  exclude: readonly SegmentRef[] = [],
): AsyncGenerator<number> {
  if (op === 'andNot') return engine.andNot(segs[0]!, segs.slice(1), options);
  return engine[op](segs, { ...options, exclude });
}

/** The driver requests (object reads and registry reads) in `calls`. */
export const requests = (calls: Counts): number =>
  (calls.getRange ?? 0) + (calls.getTail ?? 0) + (calls.get ?? 0);
