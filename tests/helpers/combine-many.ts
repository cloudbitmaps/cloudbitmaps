/**
 * Fixtures for the batch combine's core tests: operands seeded chunk by chunk into a recording source, a request
 * that publishes each output's ids into a map, and an oracle that evaluates an expression with native Roaring.
 */
import roaring from 'roaring';
import { compileCombineMany, runCombineMany } from '@/core/combine-many';
import type {
  CombineExpr,
  CombineManyOperand,
  CombineManyOutput,
  CombineManyRequest,
  CombineManyRun,
} from '@/core/combine-many';
import { joinId } from '@/core/bit-route';
import { roaringCodec } from '@/roaring-codec';
import { StreamChunkSource } from './stream-chunk-source';
import { seedSegment } from './loaded';

const { RoaringBitmap32 } = roaring;
type Native = InstanceType<typeof RoaringBitmap32>;

export interface OutputSpec {
  expr: CombineExpr;
  exclude?: CombineExpr[];
  keep?: number;
  beforePublish?: () => void;
}

/** What a test's publish returns: the ids written, ascending, and the chunk keys they came in. */
export interface Published {
  ids: number[];
  keys: number[];
}

export function nativeOf(expr: CombineExpr, sets: Record<string, Native>): Native {
  if (typeof expr === 'string') return RoaringBitmap32.from(sets[expr]!.toArray());
  if ('and' in expr) {
    const [first, ...rest] = expr.and.map((e) => nativeOf(e, sets));
    for (const r of rest) first!.andInPlace(r);
    return first!;
  }
  if ('or' in expr) {
    const out = new RoaringBitmap32();
    for (const e of expr.or) out.orInPlace(nativeOf(e, sets));
    return out;
  }
  const [first, ...rest] = expr.andNot.map((e) => nativeOf(e, sets));
  for (const r of rest) first!.andNotInPlace(r);
  return first!;
}

export function nativeOutput(spec: OutputSpec, sets: Record<string, Native>): Native {
  const base = nativeOf(spec.expr, sets);
  for (const e of spec.exclude ?? []) base.andNotInPlace(nativeOf(e, sets));
  return base;
}

export function toNative(ids: Iterable<number>): Native {
  return RoaringBitmap32.from(Uint32Array.from(ids));
}

export interface Setup {
  source: StreamChunkSource;
  operands: CombineManyOperand[];
}

export function seed(sets: Record<string, number[]>, source = new StreamChunkSource()): Setup {
  for (const [name, ids] of Object.entries(sets)) seedSegment(source, name, ids);
  return {
    source,
    operands: Object.keys(sets).map((name) => ({ name, ref: { segment: name } })),
  };
}

/** Publish into a map: what an output wrote is its outcome. */
export function collecting(spec: OutputSpec): CombineManyOutput<Published> {
  return {
    expr: spec.expr,
    ...(spec.exclude === undefined ? {} : { exclude: spec.exclude }),
    ...(spec.keep === undefined ? {} : { keep: spec.keep }),
    ...(spec.beforePublish === undefined ? {} : { beforePublish: spec.beforePublish }),
    publish: async (chunks) => {
      const ids: number[] = [];
      const keys: number[] = [];
      for await (const { chunkKey, bitmap } of chunks) {
        keys.push(chunkKey);
        for (const r of bitmap) ids.push(joinId(chunkKey, r));
      }
      return { ids, keys };
    },
  };
}

export function request(
  setup: Setup,
  outputs: CombineManyOutput<Published>[],
  extra: Partial<CombineManyRequest<Published>> = {},
): CombineManyRequest<Published> {
  return {
    operands: setup.operands,
    outputs,
    keep: 1,
    maxBufferedBytes: 256 * 1024 * 1024,
    publishConcurrency: 8,
    concurrency: 1,
    ...extra,
  };
}

export async function runBatch(
  sets: Record<string, number[]>,
  specs: OutputSpec[],
  extra: Partial<CombineManyRequest<Published>> = {},
  source?: StreamChunkSource,
): Promise<{ run: CombineManyRun<Published>; setup: Setup }> {
  const setup = seed(sets, source);
  const run = await runCombineMany(
    compileCombineMany(request(setup, specs.map(collecting), extra)),
    { source: setup.source, codec: roaringCodec, clock: { now: () => 0, sleep: async () => {} } },
  );
  return { run, setup };
}
