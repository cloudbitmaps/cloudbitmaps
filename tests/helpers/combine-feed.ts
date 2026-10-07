/**
 * Fixtures for the chunk-ordered feed: records cut from id lists, an async feed that counts what was pulled, and a run
 * that feeds some operands and stores the rest.
 */
import { compileCombineMany, runCombineMany } from '@/core/combine-many';
import type {
  CombineManyFeed,
  CombineManyFeedRecord,
  CombineManyRequest,
  CombineManyRun,
} from '@/core/combine-many';
import { roaringCodec } from '@/roaring-codec';
import { collecting, request, seed } from './combine-many';
import type { OutputSpec, Published, Setup } from './combine-many';

export type Rec = CombineManyFeedRecord;

/** A small deterministic generator, so a failing case replays. */
export function lcg(seed0: number): () => number {
  let x = seed0 >>> 0 || 1;
  return () => {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    return x / 2 ** 32;
  };
}

/**
 * The records of `sets` in key order. With `rng`, a key's operands are cut into consecutive records at random
 * boundaries (an operand is still named once per key); without it, one record per key.
 */
export function recordsOf(sets: Record<string, readonly number[]>, rng?: () => number): Rec[] {
  const byKey = new Map<number, Array<[string, number[]]>>();
  for (const [name, ids] of Object.entries(sets)) {
    const perKey = new Map<number, number[]>();
    for (const id of [...new Set(ids)].sort((a, b) => a - b)) {
      const key = id >>> 16;
      const list = perKey.get(key);
      if (list === undefined) perKey.set(key, [id]);
      else list.push(id);
    }
    for (const [key, list] of perKey) {
      const at = byKey.get(key);
      if (at === undefined) byKey.set(key, [[name, list]]);
      else at.push([name, list]);
    }
  }
  const out: Rec[] = [];
  for (const key of [...byKey.keys()].sort((a, b) => a - b)) {
    const entries = byKey.get(key)!;
    let current: Record<string, Uint32Array> = {};
    let n = 0;
    for (const [name, list] of entries) {
      current[name] = Uint32Array.from(list);
      n++;
      if (rng !== undefined && rng() < 0.5) {
        out.push({ key, operands: current });
        current = {};
        n = 0;
      }
    }
    if (n > 0 || entries.length === 0) out.push({ key, operands: current });
  }
  return out;
}

export function countsOf(sets: Record<string, readonly number[]>): Record<string, number> {
  return Object.fromEntries(Object.entries(sets).map(([k, v]) => [k, new Set(v).size]));
}

export interface Pulled {
  /** Records the consumer took. */
  taken: number;
  /** Whether the iterator was told to stop (its `return` ran) before it was exhausted. */
  returnedEarly: boolean;
  finished: boolean;
}

/** An async feed over `records` that records how far it was read. */
export function feedOf(
  records: Iterable<unknown>,
  pulled: Pulled = { taken: 0, returnedEarly: false, finished: false },
  between?: (index: number) => Promise<void> | void,
): AsyncIterable<Rec> & { pulled: Pulled } {
  return {
    pulled,
    async *[Symbol.asyncIterator]() {
      let finished = false;
      try {
        let i = 0;
        for (const record of records) {
          await between?.(i);
          pulled.taken++;
          yield record as Rec;
          i++;
        }
        finished = true;
        pulled.finished = true;
      } finally {
        if (!finished) pulled.returnedEarly = true;
      }
    },
  };
}

export interface FedRun {
  run: CombineManyRun<Published>;
  setup: Setup;
}

export interface FedOptions {
  stored?: Record<string, number[]>;
  fed?: Record<string, number[]>;
  /** Replaces the records cut from `fed`. */
  records?: Iterable<unknown>;
  counts?: CombineManyFeed['counts'];
  mayBeEmpty?: string[];
  names?: string[];
  rng?: () => number;
  extra?: Partial<CombineManyRequest<Published>>;
  feed?: Partial<CombineManyFeed>;
  pulled?: Pulled;
  source?: Parameters<typeof seed>[1];
  clock?: {
    now: () => number;
    sleep: (ms: number) => Promise<void>;
    yieldNow?: () => Promise<void>;
  };
  /** Called instead of collecting, to see publishes happen. */
  onPublish?: (index: number) => void;
}

export async function runFed(
  specs: OutputSpec[],
  o: FedOptions,
): Promise<FedRun & { pulled: Pulled }> {
  const fed = o.fed ?? {};
  const setup = seed(o.stored ?? {}, o.source);
  const pulled = o.pulled ?? { taken: 0, returnedEarly: false, finished: false };
  const feed: CombineManyFeed = {
    names: o.names ?? Object.keys(fed),
    records: feedOf(o.records ?? recordsOf(fed, o.rng), pulled),
    counts: o.counts ?? countsOf(fed),
    ...(o.mayBeEmpty === undefined ? {} : { mayBeEmpty: o.mayBeEmpty }),
    ...o.feed,
  };
  const run = await runCombineMany(
    compileCombineMany(
      request(
        setup,
        specs.map((spec, i) => {
          const out = collecting(spec);
          return {
            ...out,
            publish: (chunks, write) => {
              o.onPublish?.(i);
              return out.publish(chunks, write);
            },
          };
        }),
        { feed, ...o.extra },
      ),
    ),
    {
      source: setup.source,
      codec: roaringCodec,
      clock: o.clock ?? { now: () => 0, sleep: async () => {} },
    },
  );
  return { run, setup, pulled };
}
