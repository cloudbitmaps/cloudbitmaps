/**
 * A batch combine: many outputs, each an expression over named stored operands, computed in one chunk-ordered pass.
 *
 * Pure: it reads through the injected {@link StorageChunkSource} and hands each finished output to the `publish` it was
 * given, so it knows no store, no codec and no clock beyond the ones passed in.
 *
 * ```
 * compileCombineMany   check every expression and option, before any request
 * runCombineMany
 *   index    each named operand's chunk keys and cardinalities          (no payload)
 *   plan     per output: the keys it can hold, a bound on its bytes     (key algebra)
 *   groups   outputs in call order while the ledger has room; each group reads its operands once
 *   pass     per group, key by key: read each operand's chunk once, evaluate every output at the key
 *   publish  re-check the pinned excludes, then publish the group's outputs a few at a time
 * ```
 *
 * Every operand chunk is read through the source's `getChunks` and decoded through the checks on untrusted tier data,
 * and the shared chunk cache is never touched, so a batch neither evicts another reader's hot chunks nor serves
 * from them. Every output chunk is built from decoded chunks and handed on, and the write path run-optimizes it, so an
 * output is byte for byte what the same ids would load.
 */
import { MAX_REMAINDER, U32_MAX } from './bit-route';
import { assertChunkCardinalityInRange, checkedChunkKeys, decodeChunkBytes } from './chunk-checks';
import { ChunkStream } from './chunk-stream';
import type { CodecBitmap, CodecInterface } from './codec';
import {
  collectFetch,
  compileExpr,
  depthOf,
  KeyBits,
  MAX_EXPR_NODES,
  operandsOf,
  planKeys,
} from './combine-expr';
import type { CombineExpr, ExprNode, KeyBounds, NodeKeys } from './combine-expr';
import { residentBound, residentBytes, ResidentLedger, serializedBound } from './combine-ledger';
import { mapWithConcurrency } from './concurrency';
import { yieldEvery } from './cooperative';
import { DEFAULT_MAX_BITMAP_BYTES } from './crbm/format';
import type { Clock } from './determinism';
import { BudgetExceededError, IntegrityError, StaleOperandError, ValidationError } from './errors';
import type { Budget } from './budget';
import type { LoadGuard } from './load';
import { copiedMetadata } from './metadata';
import type { ChunkRead, GenerationMetadata, SegmentRef, StorageChunkSource } from './ports';

export type { CombineExpr } from './combine-expr';
export { MAX_EXPR_DEPTH, MAX_EXPR_NODES } from './combine-expr';

/** The range requests a pass keeps in flight at once across all its operands, inside a client's socket pool. */
export const MAX_RANGES_IN_FLIGHT = 64;
/** The largest `publishConcurrency` and `concurrency` a call may ask for. */
export const MAX_BATCH_PARALLELISM = 1024;
/** What a range request can hold: a range is at most a chunk's size cap, and a chunk is 1 MiB at most. */
const RANGE_BYTES = 1 << 20;
/** The most one decoded chunk can be once optimized: used to size the per-key working set. */
const WORKING_CHUNK = residentBytes(8_208);
/** A request budget's headroom over what the plan needs, for a group that has to be re-run. */
const BUDGET_HEADROOM_FACTOR = 2;
const BUDGET_HEADROOM_FLOOR = 1_000;
/** Operands whose index is read at once. */
const INDEX_PARALLELISM = 16;

/** One named stored operand, as the pass reads it. */
export interface CombineManyOperand {
  readonly name: string;
  readonly ref: SegmentRef;
  /**
   * Throws the typed error when this operand's handle can no longer be read: a lease that ended or was released, or a
   * deadline that passed. Called before each chunk key the operand is read at, so a lapse fails the outputs that read
   * it and never reads empty.
   */
  readonly check?: () => void;
  /** The generation the operand is pinned to: `null` when pinned to a segment with none, `undefined` when not pinned. */
  readonly pinnedGeneration?: number | null;
  /** A fresh read of the segment's current generation, for the re-check of a pinned exclude. */
  readonly currentGeneration?: () => Promise<number | null>;
}

/** What one output asks for. */
export interface CombineManyOutput<R> {
  readonly expr: CombineExpr;
  /** Subtracted from the result: a root `andNot`, and the operands a pinned re-check looks at. */
  readonly exclude?: readonly CombineExpr[];
  readonly allowEmpty?: boolean;
  readonly guard?: LoadGuard;
  readonly metadata?: GenerationMetadata;
  /** Overrides the call's `keep`. */
  readonly keep?: number;
  /** Throws to refuse the publish: the destination's lease or deadline, checked again just before it. */
  readonly beforePublish?: () => void;
  /** Publish the finished chunks, ascending by key. What it returns or throws is the output's outcome. */
  readonly publish: (
    chunks: AsyncIterable<{ readonly chunkKey: number; readonly bitmap: CodecBitmap }>,
    write: CombineManyWrite,
  ) => Promise<R>;
}

/** The write options of one output, checked and defaulted: what its publish passes to the load. */
export interface CombineManyWrite {
  readonly keep: number;
  readonly allowEmpty?: boolean;
  readonly guard?: LoadGuard;
  readonly metadata?: GenerationMetadata;
}

export interface CombineManyRequest<R> {
  readonly operands: readonly CombineManyOperand[];
  readonly outputs: readonly CombineManyOutput<R>[];
  /** The call's `keep`; required. */
  readonly keep: number;
  readonly after?: number;
  readonly through?: number;
  readonly maxBufferedBytes: number;
  readonly publishConcurrency: number;
  readonly concurrency: number;
  /** `undefined`: the plan's chunk reads with headroom. `null`: none. */
  readonly budget?: Budget | null;
  readonly allowAbsentOperands?: boolean;
}

export interface CombineManyDeps {
  /** Reads the operands: already pinned where they are, and retrying as the store's reads do. */
  readonly source: StorageChunkSource;
  readonly codec: CodecInterface;
  readonly clock: Clock;
  readonly maxBitmapBytes?: number;
}

/** What one output came to. */
export type CombineManyOutcome<R> =
  { readonly ok: true; readonly value: R } | { readonly ok: false; readonly error: unknown };

/** What the call did to one operand. */
export interface CombineManyOperandStats {
  /** Whether an output of the call read it. An operand no output names is not read. */
  readonly read: boolean;
  /** Whether the operand was read at a pinned generation. */
  readonly pinned: boolean;
  /** The generation pinned, `null` when the pin holds none, `undefined` when not pinned. */
  readonly pinnedGeneration: number | null | undefined;
  /** The generation the call began reading it at: the pin's, or the one live when its index was read. */
  readonly startGeneration: number | null | undefined;
  /**
   * The generation current just before the publishes, from the re-read of a pinned operand an output excludes; `undefined`
   * where it was not re-read.
   */
  readonly endGeneration: number | null | undefined;
  /** Chunk keys in its index, inside the range. */
  readonly keys: number;
  /** Chunk reads made of it, over all groups. */
  readonly chunkReads: number;
}

/** What the call did to one output. */
export interface CombineManyOutputStats {
  /** The names of the operands its expression reads, ascending. */
  readonly operands: readonly string[];
  /** The group that computed it (from 0), or `null` when it never ran. */
  readonly group: number | null;
  /** Clock time the group's pass began and the output's publish settled (or it failed), when it ran. */
  readonly startedAt: number | null;
  readonly endedAt: number | null;
  /** Chunks the output holds. */
  readonly chunks: number;
}

export interface CombineManyStats {
  /** Groups run, the re-runs of outputs a lying index made too big included. */
  readonly groups: number;
  readonly requests: {
    /** Range requests sent for operand chunks (retries of one request count once). */
    readonly rangeReads: number;
    readonly rangeBytes: number;
    /** (operand, key) chunk reads, the unit `budget` is counted in. */
    readonly chunkReads: number;
    /** Registry reads to re-check a pinned exclude. */
    readonly registryReads: number;
    /** Outputs handed to a publish. */
    readonly publishes: number;
  };
  readonly budget: {
    /** The limit used: `null` when lifted. */
    readonly maxRequests: number | null;
    /** Chunk reads the plan needed. */
    readonly planned: number;
    /** Chunk reads made. */
    readonly used: number;
  };
  readonly memory: {
    readonly maxBufferedBytes: number;
    /** The most the ledger held at once. */
    readonly highWaterBytes: number;
  };
  readonly chunks: {
    /** Index keys not read because no output needed them there, summed over groups. */
    readonly pruned: number;
  };
  /** The most range requests in flight at once. */
  readonly maxRangesInFlight: number;
  readonly operands: Readonly<Record<string, CombineManyOperandStats>>;
  readonly outputs: readonly CombineManyOutputStats[];
}

export interface CombineManyRun<R> {
  readonly outputs: readonly CombineManyOutcome<R>[];
  readonly stats: CombineManyStats;
}

interface CompiledOutput {
  readonly node: ExprNode;
  readonly operands: readonly number[];
  readonly excludeOperands: readonly number[];
  readonly depth: number;
  readonly write: CombineManyWrite;
}

/** A request that passed every check that needs no I/O: what {@link runCombineMany} runs. */
export interface CompiledCombineMany<R> {
  readonly request: CombineManyRequest<R>;
  readonly outputs: readonly CompiledOutput[];
}

function integerIn(value: unknown, min: number, max: number, what: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new ValidationError(
      `${what} must be an integer from ${min} to ${max}; got ${
        typeof value === 'number' ? String(value) : `a ${typeof value}`
      }`,
    );
  }
  return value;
}

function checkedKeep(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new ValidationError(
      `${what} must be a non-negative integer; got ${
        value === undefined ? 'nothing (it is required)' : String(value)
      }`,
    );
  }
  return value;
}

/**
 * Check a request: every expression, option and number, before any request is made. Throws {@link ValidationError}
 * naming the output index and the path. Pure.
 */
export function compileCombineMany<R>(request: CombineManyRequest<R>): CompiledCombineMany<R> {
  const { operands, outputs } = request;
  if (!Array.isArray(outputs) || outputs.length === 0) {
    throw new ValidationError('outputs must be a non-empty array');
  }
  checkedKeep(request.keep, 'keep');
  integerIn(request.maxBufferedBytes, 1, Number.MAX_SAFE_INTEGER, 'maxBufferedBytes');
  integerIn(request.publishConcurrency, 1, MAX_BATCH_PARALLELISM, 'publishConcurrency');
  integerIn(request.concurrency, 1, MAX_BATCH_PARALLELISM, 'concurrency');
  for (const [name, bound] of [
    ['after', request.after],
    ['through', request.through],
  ] as const) {
    if (bound !== undefined) integerIn(bound, 0, U32_MAX, name);
  }
  const index = new Map<string, number>();
  operands.forEach((op, i) => index.set(op.name, i));
  const compiled = outputs.map((output, i): CompiledOutput => {
    const where = `outputs[${i}]`;
    const budget = { remaining: MAX_EXPR_NODES };
    const root = compileExpr(output.expr, `${where}.expr`, index, budget);
    let exclude: ExprNode[] = [];
    if (output.exclude !== undefined) {
      const listed: unknown = output.exclude;
      if (!Array.isArray(listed)) {
        throw new ValidationError(`${where}.exclude must be an array of expressions`);
      }
      exclude = (listed as unknown[]).map((e, j) =>
        compileExpr(e, `${where}.exclude[${j}]`, index, budget),
      );
    }
    const node: ExprNode =
      exclude.length === 0 ? root : { kind: 'andNot', kids: [root, ...exclude] };
    const keep =
      output.keep === undefined ? request.keep : checkedKeep(output.keep, `${where}.keep`);
    if (output.allowEmpty !== undefined && typeof output.allowEmpty !== 'boolean') {
      throw new ValidationError(`${where}.allowEmpty must be a boolean`);
    }
    const guard = output.guard;
    if (guard !== undefined) {
      if (typeof guard !== 'object' || guard === null) {
        throw new ValidationError(`${where}.guard must be an object`);
      }
      const min = guard.minCardinality;
      if (min !== undefined && (!Number.isInteger(min) || min < 0)) {
        throw new ValidationError(
          `${where}.guard.minCardinality must be a non-negative integer; got ${String(min)}`,
        );
      }
      const retained = guard.minRetained;
      if (retained !== undefined && (!Number.isFinite(retained) || retained < 0 || retained > 1)) {
        throw new ValidationError(
          `${where}.guard.minRetained must be a fraction in 0..1; got ${String(retained)}`,
        );
      }
    }
    const metadata = copiedMetadata(output.metadata, (message) => {
      throw new ValidationError(`${where}.metadata: ${message}`);
    });
    return {
      node,
      operands: operandsOf(node),
      excludeOperands: [...new Set(exclude.flatMap((e) => operandsOf(e)))].sort((a, b) => a - b),
      depth: depthOf(node),
      write: {
        keep,
        ...(output.allowEmpty === undefined ? {} : { allowEmpty: output.allowEmpty }),
        ...(guard === undefined ? {} : { guard }),
        ...(metadata === undefined ? {} : { metadata }),
      },
    };
  });
  return { request, outputs: compiled };
}

// ---------------------------------------------------------------------------------------------------------------

/** The window a range cuts: inclusive id bounds as chunk keys and remainders, as a combine's range is. */
interface IdWindow {
  readonly loKey: number;
  readonly loRem: number;
  readonly hiKey: number;
  readonly hiRem: number;
}

function windowOf(
  after: number | undefined,
  through: number | undefined,
): IdWindow | 'empty' | null {
  if (after === undefined && through === undefined) return null;
  const lo = after === undefined ? 0 : after + 1;
  const hi = through ?? U32_MAX;
  if (lo > hi) return 'empty';
  return {
    loKey: Math.floor(lo / 0x1_0000),
    loRem: lo % 0x1_0000,
    hiKey: Math.floor(hi / 0x1_0000),
    hiRem: hi % 0x1_0000,
  };
}

const isEdge = (key: number, w: IdWindow): boolean =>
  (key === w.loKey && w.loRem > 0) || (key === w.hiKey && w.hiRem < MAX_REMAINDER);

function firstAbove(sorted: Uint32Array, x: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sorted[mid]! <= x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** An edge chunk cut to the window, as a new bitmap. */
function cutToWindow(
  codec: CodecInterface,
  chunk: CodecBitmap,
  key: number,
  w: IdWindow,
): CodecBitmap {
  const from = key === w.loKey ? w.loRem : 0;
  const to = key === w.hiKey ? w.hiRem : MAX_REMAINDER;
  const rem = chunk.toUint32Array ? chunk.toUint32Array() : Uint32Array.from(chunk);
  return codec.fromValues(rem.subarray(firstAbove(rem, from - 1), firstAbove(rem, to)));
}

/** A first-in first-out limit on how many things run at once. */
class Gate {
  private active = 0;
  private peak = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  get highWater(): number {
    return this.peak;
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) await new Promise<void>((resolve) => this.waiting.push(resolve));
    else this.active++;
    if (this.active > this.peak) this.peak = this.active;
    try {
      return await task();
    } finally {
      const next = this.waiting.shift();
      if (next === undefined) this.active--;
      else next();
    }
  }
}

interface OperandState {
  readonly index: number;
  readonly spec: CombineManyOperand;
  bounds: KeyBounds;
  /** Why its index could not be read or was refused: every output that reads it fails with this. */
  error?: { readonly error: unknown };
  /** The most bytes its stream holds resident at once. */
  bytes: number;
  startGeneration: number | null | undefined;
  endGeneration: number | null | undefined;
  indexKeys: number;
  chunkReads: number;
  read: boolean;
  /** Whether its object holds no chunk at all, whatever the range: what the absent-operand check judges. */
  chunkless: boolean;
}

type OutputStatus = 'waiting' | 'live' | 'deferred' | 'done';

interface OutputState<R> {
  readonly index: number;
  readonly spec: CombineManyOutput<R>;
  readonly compiled: CompiledOutput;
  rootKeys: Uint16Array;
  /** Resident bytes this output's buffer can reach, from the index. */
  bound: number;
  /** Serialized bytes of the buffer when it is whole: what a publish holds beside it. */
  serializedBound: number;
  status: OutputStatus;
  outcome?: CombineManyOutcome<R>;
  chunks: Array<{ chunkKey: number; bitmap: CodecBitmap }>;
  /** Resident bytes the buffer holds in the ledger. */
  charged: number;
  /** Serialized bytes of what is buffered. */
  serialized: number;
  cursor: number;
  group: number | null;
  startedAt: number | null;
  endedAt: number | null;
  solo: boolean;
}

interface GroupPlan {
  readonly outputs: readonly number[];
  readonly fetch: ReadonlyMap<number, readonly number[]>;
  readonly keys: readonly number[];
  readonly reads: number;
  readonly pruned: number;
  readonly fixedBytes: number;
}

/** A bitmap held while an output is evaluated at one key: borrowed from the operand chunks, or owned and charged. */
interface Held {
  readonly bitmap: CodecBitmap;
  readonly owned: boolean;
  charge: number;
}

const budgetError = (limit: number, what: string): BudgetExceededError =>
  new BudgetExceededError(
    `materializeMany: ${what} would hold more than maxBufferedBytes (${limit}) resident — raise maxBufferedBytes, ` +
      'or split the outputs across calls',
  );

/**
 * Run a compiled request: read what its outputs need, evaluate them key by key and publish each. Never throws for a
 * fault of one output or one operand: that is the output's outcome. Throws {@link ValidationError} for an operand that
 * names no segment (unless allowed), and {@link BudgetExceededError} when its own plan needs more chunk reads than the
 * budget, both before any chunk is read.
 */
export async function runCombineMany<R>(
  compiled: CompiledCombineMany<R>,
  deps: CombineManyDeps,
): Promise<CombineManyRun<R>> {
  const run = new Run(compiled, deps);
  return run.execute();
}

class Run<R> {
  private readonly req: CombineManyRequest<R>;
  private readonly source: StorageChunkSource;
  private readonly codec: CodecInterface;
  private readonly clock: Clock;
  private readonly maxBitmapBytes: number;
  private readonly ledger: ResidentLedger;
  private readonly gate = new Gate(MAX_RANGES_IN_FLIGHT);
  private readonly operands: OperandState[];
  private readonly outputs: Array<OutputState<R>>;
  private readonly tick: () => Promise<void> | null;
  private window: IdWindow | 'empty' | null = null;
  private groups = 0;
  private rangeReads = 0;
  private rangeBytes = 0;
  private chunkReads = 0;
  private registryReads = 0;
  private publishes = 0;
  private planned = 0;
  private pruned = 0;
  private limit: number | null = null;

  constructor(compiled: CompiledCombineMany<R>, deps: CombineManyDeps) {
    this.req = compiled.request;
    this.source = deps.source;
    this.codec = deps.codec;
    this.clock = deps.clock;
    this.maxBitmapBytes = deps.maxBitmapBytes ?? DEFAULT_MAX_BITMAP_BYTES;
    this.ledger = new ResidentLedger(this.req.maxBufferedBytes);
    this.tick = yieldEvery(deps.clock, 256);
    this.operands = this.req.operands.map((spec, index) => ({
      index,
      spec,
      bounds: { keys: new Uint16Array(0), card: new Uint32Array(0) },
      bytes: 0,
      startGeneration: undefined,
      endGeneration: undefined,
      indexKeys: 0,
      chunkReads: 0,
      read: false,
      chunkless: false,
    }));
    this.outputs = this.req.outputs.map((spec, index) => ({
      index,
      spec,
      compiled: compiled.outputs[index]!,
      rootKeys: new Uint16Array(0),
      bound: 0,
      serializedBound: 0,
      status: 'waiting',
      chunks: [],
      charged: 0,
      serialized: 0,
      cursor: 0,
      group: null,
      startedAt: null,
      endedAt: null,
      solo: false,
    }));
  }

  async execute(): Promise<CombineManyRun<R>> {
    this.window = windowOf(this.req.after, this.req.through);
    await this.readIndexes();
    await this.refuseAbsent();
    this.planOutputs();
    const groups = this.formGroups(this.outputs.filter((o) => o.status === 'waiting'));
    this.settleBudget(groups);
    for (const group of groups) await this.runGroup(group);
    // Outputs a lying index made too big for their group run alone, one group each, until none is left.
    for (;;) {
      const deferred = this.outputs.filter((o) => o.status === 'deferred');
      if (deferred.length === 0) break;
      for (const output of deferred) {
        output.status = 'waiting';
        output.solo = true;
        await this.runGroup(this.buildGroup([output]));
      }
    }
    return { outputs: this.outputs.map((o) => o.outcome ?? this.neverRan()), stats: this.stats() };
  }

  private neverRan(): CombineManyOutcome<R> {
    return { ok: false, error: new Error('materializeMany: output did not run') };
  }

  // ---- index ------------------------------------------------------------------------------------------------

  private async readIndexes(): Promise<void> {
    const wanted = new Set<number>();
    for (const o of this.outputs) for (const op of o.compiled.operands) wanted.add(op);
    if (this.window === 'empty') return;
    for (const index of wanted) this.operands[index]!.read = true;
    const w = this.window;
    await mapWithConcurrency([...wanted], INDEX_PARALLELISM, async (index) => {
      const op = this.operands[index]!;
      try {
        const listed = checkedChunkKeys(await this.source.listChunkKeys(op.spec.ref));
        const keys = w === null ? listed : within(listed, w);
        const cards = await this.source.cardinalities?.(op.spec.ref);
        const card = new Uint32Array(keys.length);
        let serialized = 0;
        for (let i = 0; i < keys.length; i++) {
          const given = cards?.get(keys[i]!);
          if (given !== undefined) assertChunkCardinalityInRange(given);
          card[i] = given ?? 0x1_0000;
          serialized += serializedBound(card[i]!);
        }
        const size = (await this.source.sizeOf?.(op.spec.ref))?.sizeBytes;
        op.startGeneration = await this.source.currentGeneration?.(op.spec.ref);
        op.bounds = { keys: Uint16Array.from(keys), card };
        op.indexKeys = keys.length;
        // Held at once by its stream: its ranges, never more than its object or than the window it was asked for.
        const window = this.req.concurrency * (RANGE_BYTES + 28);
        op.bytes = Math.min(window, size ?? Infinity, serialized + 64);
        op.chunkless = listed.length === 0;
      } catch (error) {
        op.error = { error };
      }
    });
  }

  /** An operand that names no segment would contribute nothing: refused, as a combine refuses it. */
  private async refuseAbsent(): Promise<void> {
    if (this.req.allowAbsentOperands === true || this.source.exists === undefined) return;
    const chunkless = this.operands.filter(
      (op) => op.read && op.error === undefined && op.chunkless,
    );
    if (chunkless.length === 0) return;
    const checked = await Promise.all(
      chunkless.map(async (op) => ({ op, exists: await this.source.exists!(op.spec.ref) })),
    );
    const absent = checked.filter((c) => !c.exists).map((c) => c.op.spec.name);
    if (absent.length === 0) return;
    throw new ValidationError(
      `materializeMany: operand ${absent.map((n) => `"${n}"`).join(', ')} names a segment that does not exist, so it ` +
        'would contribute nothing — an exclude would suppress no ids and an include would contribute none. Check ' +
        'the name and the namespace (a segment addressed without its `namespace` is a DIFFERENT segment). Pass ' +
        '`allowAbsentOperands: true` if you meant it.',
    );
  }

  // ---- plan -------------------------------------------------------------------------------------------------

  private boundsList(): KeyBounds[] {
    return this.operands.map((op) => op.bounds);
  }

  private planOutputs(): void {
    const bounds = this.boundsList();
    for (const o of this.outputs) {
      const failed = o.compiled.operands.map((i) => this.operands[i]!).find((op) => op.error);
      if (failed?.error !== undefined) {
        this.fail(o, failed.error.error);
        continue;
      }
      if (this.window === 'empty') {
        o.status = 'waiting';
        continue;
      }
      const root = planKeys(o.compiled.node, bounds);
      o.rootKeys = root.keys;
      let resident = 0;
      let serialized = 0;
      for (let i = 0; i < root.keys.length; i++) {
        resident += residentBound(root.card[i]!);
        serialized += serializedBound(root.card[i]!);
      }
      o.bound = resident;
      o.serializedBound = serialized;
      o.status = 'waiting';
    }
  }

  /** What a group of outputs needs resident, from the index: outputs, operand streams, per-key work, publishes. */
  private groupCost(members: readonly OutputState<R>[]): number {
    const operands = new Set<number>();
    let outputs = 0;
    let depth = 0;
    let largest = 0;
    for (const o of members) {
      outputs += o.bound;
      depth = Math.max(depth, o.compiled.depth);
      largest = Math.max(largest, o.serializedBound);
      for (const i of o.compiled.operands) operands.add(i);
    }
    let streams = 0;
    for (const i of operands) streams += this.operands[i]!.bytes;
    const work = (operands.size + depth + 2) * WORKING_CHUNK;
    const publishing = Math.min(this.req.publishConcurrency, members.length) * largest;
    return outputs + streams + work + publishing;
  }

  /** Outputs in call order, a group at a time while the ledger has room for the next. */
  private formGroups(waiting: readonly OutputState<R>[]): GroupPlan[] {
    const groups: GroupPlan[] = [];
    let current: Array<OutputState<R>> = [];
    const flush = (): void => {
      if (current.length > 0) groups.push(this.buildGroup(current));
      current = [];
    };
    for (const o of waiting) {
      const alone = this.groupCost([o]);
      if (alone > this.req.maxBufferedBytes) {
        this.fail(
          o,
          new BudgetExceededError(
            `materializeMany: output ${o.index} needs about ${alone} bytes resident with its operands, over ` +
              `maxBufferedBytes (${this.req.maxBufferedBytes}) — raise maxBufferedBytes to at least ${alone}`,
          ),
        );
        continue;
      }
      if (current.length > 0 && this.groupCost([...current, o]) > this.req.maxBufferedBytes)
        flush();
      current.push(o);
    }
    flush();
    return groups;
  }

  /** The keys each operand is fetched at for `members`, and the keys the pass visits. */
  private buildGroup(members: readonly OutputState<R>[]): GroupPlan {
    const bounds = this.boundsList();
    const bits = new Map<number, KeyBits>();
    const visit = new KeyBits();
    for (const o of members) {
      visit.add(o.rootKeys);
      const planned: NodeKeys = new Map();
      planKeys(o.compiled.node, bounds, planned);
      collectFetch(o.compiled.node, o.rootKeys, bounds, planned, (operand, keys) => {
        let set = bits.get(operand);
        if (set === undefined) bits.set(operand, (set = new KeyBits()));
        set.add(keys);
      });
    }
    const fetch = new Map<number, number[]>();
    let reads = 0;
    let pruned = 0;
    let fixed = 0;
    for (const [operand, set] of [...bits.entries()].sort((a, b) => a[0] - b[0])) {
      fetch.set(operand, set.toKeys());
      reads += set.size;
      pruned += this.operands[operand]!.indexKeys - set.size;
      fixed += this.operands[operand]!.bytes;
    }
    return {
      outputs: members.map((o) => o.index),
      fetch,
      keys: visit.toKeys(),
      reads,
      pruned,
      fixedBytes: fixed,
    };
  }

  private settleBudget(groups: readonly GroupPlan[]): void {
    this.planned = groups.reduce((sum, g) => sum + g.reads, 0);
    const given = this.req.budget;
    if (given === null) {
      this.limit = null;
    } else if (given === undefined) {
      this.limit = this.planned * BUDGET_HEADROOM_FACTOR + BUDGET_HEADROOM_FLOOR;
    } else {
      this.limit = given.maxRequests;
      if (this.planned > this.limit) {
        throw new BudgetExceededError(
          `materializeMany would read ${this.planned} chunks over ${groups.length} group(s), over the budget of ` +
            `${this.limit} — raise \`budget.maxRequests\`, raise maxBufferedBytes so fewer groups re-read the operands, ` +
            'or set `budget: false`',
        );
      }
    }
  }

  // ---- outcomes ---------------------------------------------------------------------------------------------

  private fail(o: OutputState<R>, error: unknown): void {
    this.dropBuffer(o);
    if (o.outcome === undefined) o.outcome = { ok: false, error };
    o.status = 'done';
    o.endedAt ??= o.startedAt === null ? null : this.clock.now();
  }

  private dropBuffer(o: OutputState<R>): void {
    this.ledger.release(o.charged);
    o.chunks = [];
    o.charged = 0;
    o.serialized = 0;
  }

  // ---- one group --------------------------------------------------------------------------------------------

  private async runGroup(plan: GroupPlan): Promise<void> {
    const members = plan.outputs.map((i) => this.outputs[i]!).filter((o) => o.status === 'waiting');
    if (members.length === 0) return;
    const group = this.groups++;
    const budget = this.limit;
    if (budget !== null && this.chunkReads + plan.reads > budget) {
      const error = new BudgetExceededError(
        `materializeMany: re-running outputs would read ${plan.reads} more chunks, past the budget of ${budget} ` +
          `(${this.chunkReads} read)`,
      );
      for (const o of members) this.fail(o, error);
      return;
    }
    const startedAt = this.clock.now();
    for (const o of members) {
      o.status = 'live';
      o.group = group;
      o.startedAt = startedAt;
      o.cursor = 0;
    }
    this.pruned += plan.pruned;
    // The operand streams' ranges are resident for the whole pass; reserved up front, released with the pass.
    const fixed = plan.fixedBytes;
    if (!this.ledger.tryCharge(fixed)) {
      const error = budgetError(this.req.maxBufferedBytes, 'the operand streams');
      for (const o of members) this.fail(o, error);
      return;
    }
    try {
      await this.pass(plan, members);
    } catch (error) {
      for (const o of members) if (o.status === 'live') this.fail(o, error);
    } finally {
      this.ledger.release(fixed);
    }
    const survivors = members.filter((o) => o.status === 'live');
    if (survivors.length > 0) await this.publishWave(survivors);
  }

  /** Evict the biggest buffer of a group still running so another charge can fit; it is re-run alone later. */
  private evictLargest(members: readonly OutputState<R>[]): boolean {
    const live = members.filter((o) => o.status === 'live');
    if (live.length <= 1) return false;
    let biggest: OutputState<R> | undefined;
    for (const o of live) {
      if (o.charged > 0 && (biggest === undefined || o.charged > biggest.charged)) biggest = o;
    }
    if (biggest === undefined) return false;
    this.dropBuffer(biggest);
    biggest.status = 'deferred';
    biggest.group = null;
    biggest.startedAt = null;
    return true;
  }

  /** The chunks of `key` of every operand a group fetches: a stream per operand, read in step, one key at a time. */
  private async pass(plan: GroupPlan, members: readonly OutputState<R>[]): Promise<void> {
    const readers = new Map<number, Array<OutputState<R>>>();
    for (const o of members) {
      for (const op of o.compiled.operands) {
        let list = readers.get(op);
        if (list === undefined) readers.set(op, (list = []));
        list.push(o);
      }
    }
    interface Cursor {
      readonly op: OperandState;
      readonly keys: readonly number[];
      next: number;
      stream: ChunkStream | undefined;
      /** No more is read of this operand: it failed, or no live output reads it any more. */
      done: boolean;
    }
    const cursors: Cursor[] = [];
    for (const [index, keys] of plan.fetch) {
      cursors.push({ op: this.operands[index]!, keys, next: 0, stream: undefined, done: false });
    }
    const retry = <T>(request: () => Promise<T>): Promise<T> => this.gate.run(request);
    const onRequest = (r: { readonly bytes: number }): void => {
      this.rangeReads++;
      this.rangeBytes += r.bytes;
    };
    const streamOf = (c: Cursor): ChunkStream => {
      c.stream ??= new ChunkStream(this.readKeys(c.op.spec.ref, c.keys, retry, onRequest));
      return c.stream;
    };
    const stop = (c: Cursor): void => {
      c.done = true;
      c.stream?.close();
    };
    const failOperand = (c: Cursor, error: unknown): void => {
      stop(c);
      for (const o of readers.get(c.op.index) ?? []) if (o.status === 'live') this.fail(o, error);
    };
    const w = this.window === 'empty' ? null : this.window;
    const makeRoom = (): boolean => this.evictLargest(members);
    try {
      for (const key of plan.keys) {
        if (!members.some((o) => o.status === 'live')) break;
        // The operands read at this key: those whose next fetch key it is and that a live output still reads.
        const needed: Cursor[] = [];
        for (const c of cursors) {
          if (c.done || c.keys[c.next] !== key) continue;
          if (!(readers.get(c.op.index) ?? []).some((o) => o.status === 'live')) {
            stop(c);
            continue;
          }
          try {
            c.op.spec.check?.();
          } catch (error) {
            failOperand(c, error);
            continue;
          }
          needed.push(c);
        }
        // Taken in key order before anything is awaited: concurrent takes of one stream must line up with its keys.
        const settled = await Promise.allSettled(needed.map((c) => streamOf(c).take(key)));
        const decoded = new Map<number, CodecBitmap>();
        let held = 0;
        try {
          for (let i = 0; i < needed.length; i++) {
            const c = needed[i]!;
            const result = settled[i]!;
            c.next++;
            if (c.done) continue;
            if (result.status === 'rejected') {
              failOperand(c, result.reason);
              continue;
            }
            this.chunkReads++;
            c.op.chunkReads++;
            const bytes = result.value.bytes;
            if (bytes === null) {
              // The index lists the key, so the generation must hold its bytes: a hole is a fault, never an empty chunk.
              failOperand(
                c,
                new IntegrityError(
                  `operand "${c.op.spec.name}" lists chunk ${key} but its generation holds no bytes for it`,
                ),
              );
              continue;
            }
            try {
              const resident = residentBytes(bytes.length);
              if (!this.ledger.reserve(resident, makeRoom)) {
                throw budgetError(
                  this.req.maxBufferedBytes,
                  `operand "${c.op.spec.name}" at chunk ${key}`,
                );
              }
              held += resident;
              decoded.set(
                c.op.index,
                decodeChunkBytes(this.codec, bytes, key, this.maxBitmapBytes),
              );
            } catch (error) {
              failOperand(c, error);
            }
          }
          for (const o of members) {
            if (o.status !== 'live') continue;
            const roots = o.rootKeys;
            while (o.cursor < roots.length && roots[o.cursor]! < key) o.cursor++;
            if (o.cursor >= roots.length || roots[o.cursor] !== key) continue;
            o.cursor++;
            const kc = new KeyContext(this.ledger, makeRoom, decoded);
            try {
              this.evaluateInto(o, key, kc, w, makeRoom);
            } catch (error) {
              kc.reset();
              if (o.status === 'live') this.fail(o, error);
            }
            const pause = this.tick();
            if (pause !== null) await pause;
          }
        } finally {
          this.ledger.release(held);
        }
      }
    } finally {
      for (const c of cursors) c.stream?.close();
    }
  }

  /** The operand's chunks at `keys` as a stream: the source's coalesced ranges, or chunk by chunk where it has none. */
  private readKeys(
    ref: SegmentRef,
    keys: readonly number[],
    retry: <T>(request: () => Promise<T>) => Promise<T>,
    onRequest: (r: { readonly bytes: number; readonly ms: number }) => void,
  ): AsyncIterable<ChunkRead> {
    const source = this.source;
    if (source.getChunks !== undefined) {
      return source.getChunks(ref, keys, { concurrency: this.req.concurrency, retry, onRequest });
    }
    return {
      async *[Symbol.asyncIterator]() {
        for (const key of keys) {
          const bytes = await retry(() => source.getChunk({ ...ref, chunkKey: key }));
          onRequest({ bytes: bytes?.length ?? 0, ms: 0 });
          yield { key, bytes, version: null };
        }
      },
    };
  }

  /** Evaluate `o` at `key` and buffer the chunk when it is not empty. */
  private evaluateInto(
    o: OutputState<R>,
    key: number,
    kc: KeyContext,
    w: IdWindow | null,
    makeRoom: () => boolean,
  ): void {
    const result = evaluate(o.compiled.node, kc);
    if (result === null) return;
    let held = kc.owned(result);
    if (held.bitmap.isEmpty) {
      kc.drop(held);
      return;
    }
    if (w !== null && isEdge(key, w)) {
      const cut = cutToWindow(this.codec, held.bitmap, key, w);
      kc.drop(held);
      if (cut.isEmpty) return;
      const charge = residentBound(cut.size);
      kc.take(charge);
      held = { bitmap: cut, owned: true, charge };
    }
    const size = held.bitmap.size;
    const resident = residentBound(size);
    // The chunk now belongs to the buffer: its temporary charge is exchanged for the buffer's.
    kc.drop(held);
    if (!this.ledger.reserve(resident, makeRoom)) {
      throw budgetError(this.req.maxBufferedBytes, `output ${o.index}`);
    }
    if (o.status !== 'live') {
      // This very output was evicted to make room, and its buffer went with it.
      this.ledger.release(resident);
      return;
    }
    o.charged += resident;
    o.serialized += serializedBound(size);
    o.chunks.push({ chunkKey: key, bitmap: held.bitmap });
  }

  // ---- publish ----------------------------------------------------------------------------------------------

  /** Re-check the pinned excludes, then publish what is left, `publishConcurrency` at a time. */
  private async publishWave(survivors: Array<OutputState<R>>): Promise<void> {
    const toCheck = new Set<number>();
    for (const o of survivors) {
      for (const i of o.compiled.excludeOperands) {
        const spec = this.operands[i]!.spec;
        if (spec.pinnedGeneration !== undefined && spec.currentGeneration !== undefined)
          toCheck.add(i);
      }
    }
    const verdict = new Map<number, unknown>();
    await mapWithConcurrency([...toCheck], INDEX_PARALLELISM, async (i) => {
      const op = this.operands[i]!;
      this.registryReads++;
      try {
        const now = await op.spec.currentGeneration!();
        op.endGeneration = now;
        if (now !== op.spec.pinnedGeneration) {
          verdict.set(
            i,
            new StaleOperandError(
              `materializeMany: operand "${op.spec.name}", excluded by an output, moved from generation ` +
                `${String(op.spec.pinnedGeneration)} to ${String(now)} while the call ran, so its outputs were not ` +
                'published. Run the call again to exclude the current one.',
              op.spec.name,
              'moved',
            ),
          );
        }
      } catch (error) {
        // An exclude that cannot be re-checked is not assumed unchanged: the outputs it guards are not published.
        verdict.set(i, error);
      }
    });
    for (const o of survivors) {
      for (const i of o.compiled.excludeOperands) {
        if (verdict.has(i)) {
          this.fail(o, verdict.get(i));
          break;
        }
      }
    }
    const queue = survivors.filter((o) => o.status === 'live');
    let next = 0;
    let inFlight = 0;
    let waiters: Array<() => void> = [];
    const wake = (): void => {
      const now = waiters;
      waiters = [];
      for (const resolve of now) resolve();
    };
    const worker = async (): Promise<void> => {
      for (;;) {
        const o = queue[next++];
        if (o === undefined) return;
        try {
          o.spec.beforePublish?.();
        } catch (error) {
          this.fail(o, error);
          continue;
        }
        // What the write holds beside the buffer: the object's bytes. It waits for room that a settling publish frees.
        const transient = o.serialized;
        let admitted = this.ledger.tryCharge(transient);
        while (!admitted && inFlight > 0) {
          await new Promise<void>((resolve) => waiters.push(resolve));
          admitted = this.ledger.tryCharge(transient);
        }
        if (!admitted) {
          this.fail(o, budgetError(this.req.maxBufferedBytes, `publishing output ${o.index}`));
          wake();
          continue;
        }
        inFlight++;
        this.publishes++;
        const chunks = o.chunks;
        try {
          const value = await o.spec.publish(
            {
              async *[Symbol.asyncIterator]() {
                for (const c of chunks) yield c;
              },
            },
            o.compiled.write,
          );
          o.outcome = { ok: true, value };
        } catch (error) {
          o.outcome = { ok: false, error };
        } finally {
          inFlight--;
          this.ledger.release(transient);
          this.dropBuffer(o);
          o.status = 'done';
          o.endedAt = this.clock.now();
          wake();
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(this.req.publishConcurrency, queue.length) }, () => worker()),
    );
  }

  // ---- stats ------------------------------------------------------------------------------------------------

  private stats(): CombineManyStats {
    const operands: Record<string, CombineManyOperandStats> = {};
    for (const op of this.operands) {
      operands[op.spec.name] = {
        read: op.read,
        pinned: op.spec.pinnedGeneration !== undefined,
        pinnedGeneration: op.spec.pinnedGeneration,
        startGeneration: op.startGeneration,
        endGeneration: op.endGeneration,
        keys: op.indexKeys,
        chunkReads: op.chunkReads,
      };
    }
    return {
      groups: this.groups,
      requests: {
        rangeReads: this.rangeReads,
        rangeBytes: this.rangeBytes,
        chunkReads: this.chunkReads,
        registryReads: this.registryReads,
        publishes: this.publishes,
      },
      budget: { maxRequests: this.limit, planned: this.planned, used: this.chunkReads },
      memory: {
        maxBufferedBytes: this.req.maxBufferedBytes,
        highWaterBytes: this.ledger.highWater,
      },
      chunks: { pruned: this.pruned },
      maxRangesInFlight: this.gate.highWater,
      operands,
      outputs: this.outputs.map((o) => ({
        operands: o.compiled.operands.map((i) => this.operands[i]!.spec.name),
        group: o.group,
        startedAt: o.startedAt,
        endedAt: o.endedAt,
        chunks: o.chunks.length,
      })),
    };
  }
}

/** The ascending `keys` inside the window's chunk span. */
function within(keys: readonly number[], w: IdWindow): number[] {
  return keys.filter((k) => k >= w.loKey && k <= w.hiKey);
}

/**
 * What one key's evaluation holds resident beyond the buffers: the decoded operand chunks of the key, and the clones an
 * output makes. Every charge goes through the ledger, which may evict a buffer to make room, so an output that is
 * evaluating when it runs out of room fails with {@link BudgetExceededError} rather than grow the pass past its limit.
 */
class KeyContext {
  private temp = 0;

  constructor(
    private readonly ledger: ResidentLedger,
    private readonly makeRoom: () => boolean,
    readonly chunks: ReadonlyMap<number, CodecBitmap>,
  ) {}

  /** Charge `bytes` for a bitmap this evaluation made. */
  take(bytes: number): void {
    if (!this.ledger.reserve(bytes, this.makeRoom)) {
      throw budgetError(this.ledger.limit, 'a chunk being evaluated');
    }
    this.temp += bytes;
  }

  drop(held: Held): void {
    if (!held.owned) return;
    this.ledger.release(held.charge);
    this.temp -= held.charge;
    held.charge = 0;
  }

  /** `held` as a bitmap this evaluation owns and may change: a clone of one borrowed from the operand chunks. */
  owned(held: Held): Held {
    if (held.owned) return held;
    const charge = residentBound(held.bitmap.size);
    this.take(charge);
    return { bitmap: held.bitmap.clone(), owned: true, charge };
  }

  /** Re-price an owned bitmap that grew. */
  regrow(held: Held): void {
    const want = residentBound(held.bitmap.size);
    if (want > held.charge) {
      this.take(want - held.charge);
      held.charge = want;
    }
  }

  /** Give back every charge a failed evaluation still holds. */
  reset(): void {
    this.ledger.release(this.temp);
    this.temp = 0;
  }
}

/**
 * The value of `node` at one key, or `null` when it is empty there. A leaf borrows the operand's decoded chunk, which is
 * shared by every output at the key and never changed; an operator works on a clone it owns, in place, and stops as soon
 * as the result cannot change (an `and` at its first empty child, an `andNot` before its subtrahends when its left side
 * is empty). An operand with no chunk at the key is empty.
 */
function evaluate(node: ExprNode, kc: KeyContext): Held | null {
  if (node.kind === 'leaf') {
    const chunk = kc.chunks.get(node.operand);
    return chunk === undefined || chunk.isEmpty ? null : { bitmap: chunk, owned: false, charge: 0 };
  }
  let acc: Held | null = null;
  if (node.kind === 'and') {
    for (const kid of node.kids) {
      const r = evaluate(kid, kc);
      if (r === null || r.bitmap.isEmpty) {
        if (r !== null) kc.drop(r);
        if (acc !== null) kc.drop(acc);
        return null;
      }
      if (acc === null) {
        acc = kc.owned(r);
      } else {
        acc.bitmap.andInPlace(r.bitmap);
        kc.drop(r);
        if (acc.bitmap.isEmpty) {
          kc.drop(acc);
          return null;
        }
      }
    }
    return acc;
  }
  if (node.kind === 'or') {
    for (const kid of node.kids) {
      const r = evaluate(kid, kc);
      if (r === null) continue;
      if (acc === null) {
        acc = kc.owned(r);
      } else {
        acc.bitmap.orInPlace(r.bitmap);
        kc.drop(r);
        kc.regrow(acc);
      }
    }
    return acc === null || acc.bitmap.isEmpty ? null : acc;
  }
  const left = evaluate(node.kids[0]!, kc);
  if (left === null) return null;
  acc = kc.owned(left);
  for (let i = 1; i < node.kids.length; i++) {
    const r = evaluate(node.kids[i]!, kc);
    if (r === null) continue;
    acc.bitmap.andNotInPlace(r.bitmap);
    kc.drop(r);
    if (acc.bitmap.isEmpty) {
      kc.drop(acc);
      return null;
    }
  }
  return acc;
}
