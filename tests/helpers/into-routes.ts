/**
 * A harness that runs one `*Into` call twice, on two identical stores: once by the chunk route the verbs take, and
 * once by the id route they would otherwise take (the combine's ids streamed into the load), and records everything
 * the two do that a caller or an operator can see: the requests each makes on the storage and registry drivers, the
 * metric events, the audit events, what the call returns or throws, and the objects the destination holds after.
 */
import { randomBytes } from 'node:crypto';
import roaring from 'roaring';
import { CloudRoaring, MemoryStorage, RecordingAuditSink } from '@/index';
import type { CloudRoaringOptions, MaterializeOptions, MaterializeResult } from '@/index';
import { brandAsBackend } from '@/core/ports';
import type { IRegistryDriver, IStorageDriver, SegmentRef } from '@/core/ports';
import { InProcessKeystore } from '@/drivers/crypto';
import { aadFor } from '@/core/crypto';
import { openGenerationReader } from '@/core/crbm-storage-source';
import type { MetricEvent } from '@/core/metrics';

const { RoaringBitmap32 } = roaring;
export type Bitmap = InstanceType<typeof RoaringBitmap32>;

export type Verb = 'intersect' | 'union' | 'andNot';

/** What `Verb` is called with: operand names, in the order the verb takes them, and the call's options. */
export interface Call {
  verb: Verb;
  /** `intersect` and `union`: the operands beside the receiver; `andNot`: the segments subtracted from it. */
  others: string[];
  options?: Omit<MaterializeOptions, 'exclude' | 'audit'> & { exclude?: string[] };
}

export const DEST: SegmentRef = { segment: 'dest' };

/** A range of ids, `[lo, hi)`, and every `step`-th id of one. */
export function span(lo: number, hi: number, step = 1): Bitmap {
  const b = new RoaringBitmap32();
  if (step === 1) b.addRange(lo, hi);
  else for (let i = lo; i < hi; i += step) b.add(i);
  return b;
}

export function merged(...parts: Bitmap[]): Bitmap {
  const out = new RoaringBitmap32();
  for (const p of parts) out.orInPlace(p);
  return out;
}

/** Three operands over six chunks, in every container shape: dense, sparse, run, and a chunk only one holds. */
export function operands(): Record<string, Bitmap> {
  return {
    a: merged(span(0, 70_000), span(200_000, 330_000, 7), span(500_000, 500_500)),
    b: merged(span(30_000, 140_000), span(250_000, 300_000, 3), span(500_100, 500_200)),
    c: span(0, 400_000, 5),
  };
}

type Logged = string[];

function recording<T extends object>(
  target: T,
  log: Logged,
  describe: (m: string, a: unknown[]) => string,
): T {
  return new Proxy(target, {
    get(t, prop, receiver) {
      const value: unknown = Reflect.get(t, prop, receiver);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        log.push(describe(String(prop), args));
        return (value as (...a: unknown[]) => unknown).apply(t, args);
      };
    },
  });
}

const gk = (a: unknown): string => {
  const k = a as { segment?: string; generation?: number; chunkKey?: number } | undefined;
  return k?.segment === undefined ? '' : `${k.segment}.${k.generation ?? ''}`;
};

export interface World {
  store: CloudRoaring;
  backend: MemoryStorage;
  log: Logged;
  metrics: MetricEvent[];
  audit: RecordingAuditSink;
  keystore?: InProcessKeystore;
  /** Fail the nth range read made from now on (1-based) with this error; 0 turns it off. */
  failRangeRead: { nth: number; seen: number; error: Error };
}

export interface WorldOptions {
  encrypted?: boolean;
  /** Ids the destination holds before the call, as one generation. */
  dest?: Bitmap;
  data?: Record<string, Bitmap>;
  keys?: { k1: Buffer };
  cache?: CloudRoaringOptions['cache'];
}

export async function makeWorld(options: WorldOptions = {}): Promise<World> {
  const backend = new MemoryStorage();
  const log: Logged = [];
  const metrics: MetricEvent[] = [];
  const failRangeRead = { nth: 0, seen: 0, error: new Error('the disk is on fire') };
  const storageProxy = new Proxy(
    recording<IStorageDriver>(backend.storage, log, (m, a) =>
      m === 'getRange'
        ? `storage.getRange ${gk(a[0])} ${String(a[1])}+${String(a[2])}`
        : `storage.${m} ${gk(a[0])}`,
    ),
    {
      get(t, prop, receiver) {
        const value: unknown = Reflect.get(t, prop, receiver);
        if (prop !== 'getRange' || typeof value !== 'function') return value;
        return (...args: unknown[]) => {
          if (failRangeRead.nth > 0 && ++failRangeRead.seen === failRangeRead.nth) {
            return Promise.reject(failRangeRead.error);
          }
          return (value as (...a: unknown[]) => unknown)(...args);
        };
      },
    },
  );
  const registry = recording<IRegistryDriver>(
    backend.registry,
    log,
    (m, a) => `registry.${m} ${gk(a[0])}`,
  );
  const keystore = options.encrypted
    ? new InProcessKeystore({ keys: options.keys ?? { k1: randomBytes(32) }, activeKeyId: 'k1' })
    : undefined;
  const store = new CloudRoaring({
    storage: brandAsBackend({ storage: storageProxy, registry }),
    cache: options.cache ?? { genTtlMs: 0 },
    metrics: { onEvent: (e) => metrics.push(e) },
    ...(keystore === undefined ? {} : { encryption: { keystore } }),
  });
  for (const [name, bitmap] of Object.entries(options.data ?? operands())) {
    await store.load({ segment: name }, { bitmap });
  }
  if (options.dest !== undefined) await store.load(DEST, { bitmap: options.dest });
  log.length = 0;
  metrics.length = 0;
  return { store, backend, log, metrics, audit: new RecordingAuditSink(), keystore, failRangeRead };
}

/** Run `call` by the route the verbs take (`'chunks'`) or by streaming the combine's ids into the load (`'ids'`). */
export function run(w: World, call: Call, route: 'chunks' | 'ids'): Promise<MaterializeResult> {
  const { verb, others, options } = call;
  const { exclude, ...rest } = options ?? {};
  const handles = others.map((n) => w.store.segment(n));
  const opts: MaterializeOptions = {
    ...rest,
    ...(exclude === undefined ? {} : { exclude: exclude.map((n) => w.store.segment(n)) }),
    audit: w.audit,
  };
  const a = w.store.segment('a');
  const dest = w.store.segment(DEST.segment);
  const name = `${verb}Into` as const;
  if (route === 'chunks') {
    if (verb === 'intersect') return a.intersectInto(dest, handles, opts);
    if (verb === 'union') return a.unionInto(dest, handles, opts);
    return a.andNotInto(dest, handles, opts);
  }
  // The id route: the same call, with the ids a combine streams in place of its chunks.
  const internals = a as unknown as {
    timed: (n: string, f: () => Promise<MaterializeResult>) => Promise<MaterializeResult>;
  };
  const materialize = (
    w.store as unknown as {
      materialize: (
        d: SegmentRef,
        ids: AsyncIterable<number>,
        op: string,
        o?: MaterializeOptions,
      ) => Promise<MaterializeResult>;
    }
  ).materialize.bind(w.store);
  // The read takes the read's options only: the write's (`audit`, `allowEmpty`, `guard`, `metadata`, `keep`) go to the
  // load, and a read verb refuses them.
  const readNoExclude = {
    after: opts.after,
    through: opts.through,
    concurrency: opts.concurrency,
    budget: opts.budget,
    allowAbsentOperands: opts.allowAbsentOperands,
  };
  const read = { ...readNoExclude, exclude: opts.exclude };
  const ids =
    verb === 'intersect'
      ? a.intersect(handles, read)
      : verb === 'union'
        ? a.union(handles, read)
        : a.andNot(handles, readNoExclude);
  return internals.timed(name, () => materialize(DEST, ids, name, opts));
}

/** Everything observable about one run, in a form two runs can be compared in. */
export interface Observed {
  outcome: { result: MaterializeResult } | { error: string };
  requests: string[];
  events: string[];
  audit: unknown[];
  objects: Record<number, string>;
  pointer: unknown;
}

/** An event with its timings removed: they are the one thing two runs of the same call cannot share. */
const untimed = (e: MetricEvent): string =>
  JSON.stringify(e, (k, v: unknown) => (k === 'ms' ? 0 : v));

export async function observe(w: World, call: Call, route: 'chunks' | 'ids'): Promise<Observed> {
  let outcome: Observed['outcome'];
  try {
    outcome = { result: await run(w, call, route) };
  } catch (err) {
    outcome = { error: `${(err as Error).constructor.name}: ${(err as Error).message}` };
  }
  const objects: Record<number, string> = {};
  for await (const key of w.backend.storage.list(DEST)) {
    objects[key.generation] =
      w.keystore === undefined
        ? await wholeObject(w, key.generation)
        : await decrypted(w, key.generation);
  }
  const row = await w.backend.registry.get(DEST);
  return {
    outcome,
    requests: [...w.log].sort(),
    events: w.metrics.map(untimed).sort(),
    audit: w.audit.snapshot(),
    objects,
    pointer: row === null ? null : { currentGen: row.currentGen, status: row.status },
  };
}

async function wholeObject(w: World, generation: number): Promise<string> {
  const tail = await w.backend.storage.getTail({ ...DEST, generation }, 1 << 30);
  return Buffer.from(tail.bytes).toString('hex');
}

/**
 * An encrypted object is not byte-identical across two writes: every chunk is sealed under a fresh random nonce. What
 * is the same is what it holds: the chunk keys, each chunk's cardinality and its decrypted payload.
 */
async function decrypted(w: World, generation: number): Promise<string> {
  const row = await w.backend.registry.get(DEST);
  const aead = await w.keystore!.openDek(row!.wrappedDeks!);
  const crypto = { aead, aadFor: (scope: never) => aadFor(DEST, generation, scope) };
  const reader = await openGenerationReader(w.backend.storage, { ...DEST, generation }, crypto);
  const parts: string[] = [JSON.stringify(reader.metadata ?? null)];
  for (const key of reader.chunkKeys()) {
    parts.push(
      `${key}:${reader.cardinalities().get(key)}:${Buffer.from((await reader.getChunk(key))!).toString('hex')}`,
    );
  }
  return parts.join('|');
}

/** Run `call` on two fresh worlds built by `build`, one by each route. */
export async function bothRoutes(
  call: Call,
  build: () => Promise<World> | World,
): Promise<{ chunks: Observed; ids: Observed; world: World }> {
  const wc = await build();
  const chunks = await observe(wc, call, 'chunks');
  const wi = await build();
  const ids = await observe(wi, call, 'ids');
  return { chunks, ids, world: wc };
}
