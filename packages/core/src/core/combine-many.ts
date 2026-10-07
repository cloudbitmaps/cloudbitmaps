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
import { incarnationOf } from './token';
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
  /**
   * The pin's version: the generation and the registry row's token it was taken under (`<generation>:<token>`), or just
   * the generation where there is no row. It is what tells a name deleted and created again, which restarts at
   * generation 0, from the one that was pinned.
   */
  readonly pinnedVersion?: string | null;
  /** The fingerprint of the object the pin holds: the identity of the generation's bytes, where a number can be taken again. */
  readonly pinnedFingerprint?: string | null;
  /**
   * A fresh read of the segment's registry row: its current generation and token, or `null` when it has no row. Read
   * for every subtracted pinned operand just before the publishes, and once more at the end of the call for the rest.
   */
  readonly current?: (options?: { readonly fingerprint?: boolean }) => Promise<{
    readonly generation: number | null;
    readonly token: string;
    readonly fingerprint?: string | null;
  } | null>;
}

/** What one output asks for. */
export interface CombineManyOutput<R> {
  readonly expr: CombineExpr;
  /** Subtracted from the result: a root `andNot`. */
  readonly exclude?: readonly CombineExpr[];
  readonly allowEmpty?: boolean;
  readonly guard?: LoadGuard;
  readonly metadata?: GenerationMetadata;
  /** Overrides the call's `keep`. */
  readonly keep?: number;
  /** Throws to refuse the publish: the destination's lease or deadline, checked again just before it. */
  readonly beforePublish?: () => void;
  /**
   * The requests a settled publish made that its value proves, for the call's totals by class; absent, a publish adds
   * none. A publish that threw is not counted: what it sent is unknown.
   */
  readonly requestsOf?: (value: R) => { readonly get: number; readonly put: number };
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
   * The generation current when the call ended, from one registry read of the operand's row: the re-read made before
   * the publishes for an operand an output subtracts, one more at the end of the call for the rest. `undefined` where the
   * operand was not read, or its row could not be.
   */
  readonly endGeneration: number | null | undefined;
  /**
   * Whether the operand was replaced while the call ran: for a pinned operand, its pin no longer names what the
   * registry holds (another generation, the name deleted and created again, or the generation's number taken again by
   * other bytes, which an operand an output subtracts is compared for by the object's fingerprint); for one read live, its
   * generation or its incarnation changed from where the call began. `undefined` where `endGeneration` is, and for a live
   * operand the call never opened, whose start is unknown.
   */
  readonly moved: boolean | undefined;
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
    /** Registry reads of the call itself: the re-checks, the end-of-call reads and the existence checks. */
    readonly registryReads: number;
    /**
     * Operands whose index the call opened. An open is one tail read of the operand's object plus at most one registry
     * row read, made by the store's readers, which a pin taken before the call may already have made.
     */
    readonly opens: number;
    /**
     * Outputs handed to a publish. A publish is one object write and one pointer write where it succeeds, plus the row and
     * tail reads the load makes for its guard, which the call does not see.
     */
    readonly publishes: number;
    /**
     * The requests the call itself issues or can prove, a lower bound on what the drivers saw: `get` is range reads and
     * registry reads, `put` the object write and pointer write of each published output and the object write of each
     * refused one. Add `opens` tail reads (and at most as many row reads) and the load's reads for each publish to
     * reconstruct the total. Unknown to the call: a multipart upload's extra requests, a listing, and what a publish
     * that threw sent.
     */
    readonly attributed: { readonly get: number; readonly put: number };
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
  /** By operand name, an object with no prototype, so any name is a key. */
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
  /** Every operand under a subtracted position: a child of an `andNot` after the first, at any depth. */
  readonly subtracted: readonly number[];
  readonly depth: number;
  /** Nodes in its expression, operators and names. */
  readonly nodes: number;
  readonly write: CombineManyWrite;
}

/** What {@link compileCombineMany} checked, for {@link runCombineMany}: its compiled form is private to this module. */
const COMPILED = new WeakMap<object, readonly CompiledOutput[]>();

/** A request that passed every check that needs no I/O: what {@link runCombineMany} runs. */
export interface CompiledCombineMany<R> {
  readonly request: CombineManyRequest<R>;
}

/** The most nodes the expressions of one call may hold in all, so that a thousand large outputs cannot be planned at once. */
export const MAX_CALL_NODES = 200_000;

/** Every operand under a child of an `andNot` after the first, at any depth. */
function subtractedOperands(node: ExprNode, under: boolean, into: Set<number>): void {
  if (node.kind === 'leaf') {
    if (under) into.add(node.operand);
    return;
  }
  node.kids.forEach((kid, i) =>
    subtractedOperands(kid, under || (node.kind === 'andNot' && i > 0), into),
  );
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
  let totalNodes = 0;
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
    const nodes = MAX_EXPR_NODES - budget.remaining + (exclude.length === 0 ? 0 : 1);
    totalNodes += nodes;
    if (totalNodes > MAX_CALL_NODES) {
      throw new ValidationError(
        `${where}: the expressions of the call hold more than ${MAX_CALL_NODES} nodes in all; split the outputs across calls`,
      );
    }
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
      subtracted: subtractedList(node),
      depth: depthOf(node),
      nodes,
      write: {
        keep,
        ...(output.allowEmpty === undefined ? {} : { allowEmpty: output.allowEmpty }),
        ...(guard === undefined ? {} : { guard }),
        ...(metadata === undefined ? {} : { metadata }),
      },
    };
  });
  const result: CompiledCombineMany<R> = { request };
  COMPILED.set(result, compiled);
  return result;
}

/**
 * `compiled` with its operands replaced, the same names in the same order: what a flavor does once it has pinned them,
 * without checking the expressions again.
 */
export function rebindCombineMany<R>(
  compiled: CompiledCombineMany<R>,
  operands: readonly CombineManyOperand[],
): CompiledCombineMany<R> {
  const outputs = COMPILED.get(compiled);
  const before = compiled.request.operands;
  if (
    outputs === undefined ||
    operands.length !== before.length ||
    operands.some((op, i) => op.name !== before[i]!.name)
  ) {
    throw new ValidationError(
      'rebindCombineMany takes the operands compileCombineMany was given, by name and order',
    );
  }
  const result: CompiledCombineMany<R> = { request: { ...compiled.request, operands } };
  COMPILED.set(result, outputs);
  return result;
}

function subtractedList(node: ExprNode): number[] {
  const into = new Set<number>();
  subtractedOperands(node, false, into);
  return [...into].sort((a, b) => a - b);
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

/** What a read of an operand's registry row found. */
interface EndRow {
  readonly generation: number | null;
  readonly token: string;
  readonly fingerprint?: string | null;
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
  /** The row the last read at the end of the call, or before a publish, found: `undefined` when none was read. */
  endRow: EndRow | null | undefined;
  /** For an operand read live, the version (generation and row token) its index was read under, where the source says. */
  startVersion: string | null | undefined;
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

/** What planning keeps of a group: the outputs, and how many chunk reads it makes and skips. */
interface GroupSummary {
  readonly outputs: readonly number[];
  readonly reads: number;
  readonly pruned: number;
}

/** A group's plan as the pass runs it, built when the group starts and dropped when it ends. */
interface GroupPlan extends GroupSummary {
  /** For each output and each operand it reads, the chunk keys its expression demands of the operand. */
  readonly demand: ReadonlyMap<number, ReadonlyMap<number, Uint16Array>>;
  readonly fetch: ReadonlyMap<number, Uint16Array>;
  readonly keys: Uint16Array;
  /** Resident bytes the operand streams hold for the whole pass. */
  readonly fixedBytes: number;
  /** Bytes the plan's own key lists occupy. */
  readonly planBytes: number;
}

/** What one output's plan state costs beyond its keys: its compiled tree, per node, and its bookkeeping. */
const BYTES_PER_NODE = 96;
const BYTES_PER_OUTPUT = 256;

/**
 * The resident bytes a group needs, kept as outputs are added so that one is priced in work proportional to its own
 * operands, not to the group's size: its buffered outputs, its operand streams, the chunks being evaluated, the objects
 * being published beside the buffers, and the key lists of its own plan.
 */
class GroupCost {
  private outputs = 0;
  private depth = 0;
  private largest = 0;
  private count = 0;
  private streams = 0;
  private planWork = 0;
  private readonly operands = new Set<number>();

  constructor(
    private readonly streamBytes: (operand: number) => number,
    private readonly publishConcurrency: number,
  ) {}

  /** The cost of the group with `o` added. */
  with<R>(o: OutputState<R>): number {
    let streams = this.streams;
    let operands = this.operands.size;
    for (const i of o.compiled.operands) {
      if (!this.operands.has(i)) {
        streams += this.streamBytes(i);
        operands++;
      }
    }
    const depth = Math.max(this.depth, o.compiled.depth);
    const largest = Math.max(this.largest, o.serializedBound);
    const publishing = Math.min(this.publishConcurrency, this.count + 1) * largest;
    return (
      this.outputs +
      o.bound +
      streams +
      (operands + depth + 2) * WORKING_CHUNK +
      publishing +
      this.planWork +
      planWorkOf(o)
    );
  }

  add<R>(o: OutputState<R>): void {
    for (const i of o.compiled.operands) {
      if (!this.operands.has(i)) {
        this.operands.add(i);
        this.streams += this.streamBytes(i);
      }
    }
    this.outputs += o.bound;
    this.depth = Math.max(this.depth, o.compiled.depth);
    this.largest = Math.max(this.largest, o.serializedBound);
    this.count++;
    this.planWork += planWorkOf(o);
  }

  get size(): number {
    return this.count;
  }
}

/** The most key lists a group's plan holds for one output: its root keys, and one demand list for each operand it reads. */
const planWorkOf = <R>(o: OutputState<R>): number =>
  o.rootKeys.byteLength * (1 + o.compiled.operands.length);

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
  private opens = 0;
  private planCharge = 0;
  private attributedGet = 0;
  private attributedPut = 0;
  private planned = 0;
  private pruned = 0;
  private limit: number | null = null;

  constructor(compiled: CompiledCombineMany<R>, deps: CombineManyDeps) {
    const compiledOutputs = COMPILED.get(compiled);
    if (compiledOutputs === undefined) {
      throw new ValidationError('runCombineMany takes the result of compileCombineMany');
    }
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
      endRow: undefined,
      startVersion: undefined,
      indexKeys: 0,
      chunkReads: 0,
      read: false,
      chunkless: false,
    }));
    this.outputs = this.req.outputs.map((spec, index) => ({
      index,
      spec,
      compiled: compiledOutputs[index]!,
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
    for (const group of groups) await this.runGroup(group.outputs);
    // Outputs a lying index made too big for their group run alone, one group each, until none is left.
    for (;;) {
      const deferred = this.outputs.filter((o) => o.status === 'deferred');
      if (deferred.length === 0) break;
      for (const output of deferred) {
        output.status = 'waiting';
        output.solo = true;
        await this.runGroup([output.index]);
      }
    }
    await this.readEnds();
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
        this.opens++;
        const size = (await this.source.sizeOf?.(op.spec.ref))?.sizeBytes;
        op.startGeneration = await this.source.currentGeneration?.(op.spec.ref);
        if (op.spec.pinnedGeneration === undefined) {
          op.startVersion = await this.source.currentVersion?.(op.spec.ref);
        }
        op.bounds = { keys: Uint16Array.from(keys), card };
        op.indexKeys = keys.length;
        // Held at once by its stream: its ranges, never more than its object or than the window it was asked for. The
        // object's size is what bounds it where the source knows it; the index's own cardinalities are not trusted to
        // (a generation can understate them), and are the estimate only for a source that cannot say its size.
        const window = this.req.concurrency * (RANGE_BYTES + 28);
        op.bytes = Math.min(window, size ?? serialized + 64);
        op.chunkless = listed.length === 0;
      } catch (error) {
        op.error = { error };
      }
    });
  }

  /**
   * An operand that names no segment would contribute nothing: refused, as a combine refuses it, for every operand of
   * the call. One whose index was read is judged only if it has no chunk at all; one whose index was not read (no output
   * names it, or the range is empty) is asked outright.
   */
  private async refuseAbsent(): Promise<void> {
    if (this.req.allowAbsentOperands === true || this.source.exists === undefined) return;
    const judged = this.operands.filter(
      (op) => op.error === undefined && (op.read ? op.chunkless : true),
    );
    if (judged.length === 0) return;
    const exists = this.source.exists.bind(this.source);
    const checked = await mapWithConcurrency(judged, INDEX_PARALLELISM, async (op) => {
      this.registryReads++;
      return { op, exists: await exists(op.spec.ref) };
    });
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

  /** Charge plan state that lives for the whole call, refusing a plan that alone passes the budget. */
  private chargePlan(bytes: number, what: string): void {
    if (this.ledger.tryCharge(bytes)) {
      this.planCharge += bytes;
      return;
    }
    throw new BudgetExceededError(
      `materializeMany: the plan alone (${what}) passes maxBufferedBytes (${this.req.maxBufferedBytes}) with ` +
        `${this.planCharge} bytes already held for it, before any chunk is read — raise maxBufferedBytes, or split ` +
        'the outputs across calls',
    );
  }

  private planOutputs(): void {
    for (const op of this.operands) {
      if (op.read && op.error === undefined) {
        this.chargePlan(
          op.bounds.keys.byteLength + op.bounds.card.byteLength,
          'the operand indexes',
        );
      }
    }
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
      this.chargePlan(
        root.keys.byteLength + o.compiled.nodes * BYTES_PER_NODE + BYTES_PER_OUTPUT,
        `${o.index + 1} outputs planned`,
      );
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

  /** The bytes a group may take: the budget less what the plan holds. */
  private get room(): number {
    return this.req.maxBufferedBytes - this.planCharge;
  }

  /** Outputs in call order, a group at a time while the ledger has room for the next. */
  private formGroups(waiting: readonly OutputState<R>[]): GroupSummary[] {
    const groups: GroupSummary[] = [];
    const fresh = (): GroupCost =>
      new GroupCost((i) => this.operands[i]!.bytes, this.req.publishConcurrency);
    let cost = fresh();
    let current: Array<OutputState<R>> = [];
    const flush = (): void => {
      if (current.length > 0) {
        const { reads, pruned } = this.buildGroup(current);
        groups.push({ outputs: current.map((o) => o.index), reads, pruned });
      }
      current = [];
      cost = fresh();
    };
    for (const o of waiting) {
      const alone = fresh().with(o);
      if (alone > this.room) {
        this.fail(
          o,
          new BudgetExceededError(
            `materializeMany: output ${o.index} needs about ${alone} bytes resident with its operands, and the plan holds ` +
              `${this.planCharge}, over maxBufferedBytes (${this.req.maxBufferedBytes}) — raise maxBufferedBytes to at least ` +
              `${alone + this.planCharge}`,
          ),
        );
        continue;
      }
      if (cost.size > 0 && cost.with(o) > this.room) flush();
      current.push(o);
      cost.add(o);
    }
    flush();
    return groups;
  }

  /** The keys each operand is fetched at for `members`, and the keys the pass visits. */
  private buildGroup(members: readonly OutputState<R>[]): GroupPlan {
    const bounds = this.boundsList();
    const bits = new Map<number, KeyBits>();
    const visit = new KeyBits();
    const demand = new Map<number, Map<number, Uint16Array>>();
    let planBytes = 0;
    for (const o of members) {
      visit.add(o.rootKeys);
      const planned: NodeKeys = new Map();
      planKeys(o.compiled.node, bounds, planned);
      const own = new Map<number, KeyBits>();
      collectFetch(o.compiled.node, o.rootKeys, bounds, planned, (operand, keys) => {
        let set = bits.get(operand);
        if (set === undefined) bits.set(operand, (set = new KeyBits()));
        set.add(keys);
        let mine = own.get(operand);
        if (mine === undefined) own.set(operand, (mine = new KeyBits()));
        mine.add(keys);
      });
      const lists = new Map<number, Uint16Array>();
      for (const [operand, set] of own) {
        const keys = Uint16Array.from(set.toKeys());
        lists.set(operand, keys);
        planBytes += keys.byteLength;
      }
      demand.set(o.index, lists);
    }
    const fetch = new Map<number, Uint16Array>();
    let reads = 0;
    let pruned = 0;
    let fixed = 0;
    for (const [operand, set] of [...bits.entries()].sort((a, b) => a[0] - b[0])) {
      const keys = Uint16Array.from(set.toKeys());
      fetch.set(operand, keys);
      planBytes += keys.byteLength;
      reads += set.size;
      pruned += this.operands[operand]!.indexKeys - set.size;
      fixed += this.operands[operand]!.bytes;
    }
    const visited = Uint16Array.from(visit.toKeys());
    return {
      outputs: members.map((o) => o.index),
      demand,
      fetch,
      keys: visited,
      reads,
      pruned,
      fixedBytes: fixed,
      planBytes: planBytes + visited.byteLength,
    };
  }

  private settleBudget(groups: readonly GroupSummary[]): void {
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

  private async runGroup(indices: readonly number[]): Promise<void> {
    const members = indices.map((i) => this.outputs[i]!).filter((o) => o.status === 'waiting');
    if (members.length === 0) return;
    const plan = this.buildGroup(members);
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
    const fixed = plan.fixedBytes + plan.planBytes;
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
      readonly keys: Uint16Array;
      next: number;
      stream: ChunkStream | undefined;
      /** No more is read of this operand: it failed, or no live output reads it any more. */
      done: boolean;
      /** Why it failed, when it did: an output that demands a later key of it fails with this. */
      failure: { readonly error: unknown } | undefined;
    }
    const cursors: Cursor[] = [];
    for (const [index, keys] of plan.fetch) {
      cursors.push({
        op: this.operands[index]!,
        keys,
        next: 0,
        stream: undefined,
        done: false,
        failure: undefined,
      });
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
    /** The live outputs whose expression demands `c`'s operand at `key`. */
    const wanting = (c: Cursor, key: number): Array<OutputState<R>> =>
      (readers.get(c.op.index) ?? []).filter(
        (o) => o.status === 'live' && hasKey(plan.demand.get(o.index)?.get(c.op.index), key),
      );
    const failOperand = (c: Cursor, error: unknown, victims: Array<OutputState<R>>): void => {
      stop(c);
      c.failure = { error };
      for (const o of victims) if (o.status === 'live') this.fail(o, error);
    };
    const w = this.window === 'empty' ? null : this.window;
    const makeRoom = (): boolean => this.evictLargest(members);
    try {
      for (const key of plan.keys) {
        if (!members.some((o) => o.status === 'live')) break;
        // While every output is live, what was fetched is demanded; once one is gone, who still wants a chunk is asked.
        const exact = members.some((o) => o.status !== 'live');
        const at: Array<{ c: Cursor; victims: Array<OutputState<R>> | undefined }> = [];
        for (const c of cursors) {
          if (c.keys[c.next] !== key) continue;
          const victims = exact || c.failure !== undefined ? wanting(c, key) : undefined;
          if (c.failure !== undefined) {
            // The operand failed at an earlier key: an output that needs this key of it fails with the same error.
            c.next++;
            for (const o of victims ?? []) this.fail(o, c.failure.error);
            continue;
          }
          if (c.done) {
            c.next++;
            continue;
          }
          if (!(readers.get(c.op.index) ?? []).some((o) => o.status === 'live')) {
            stop(c);
            c.next++;
            continue;
          }
          if (victims === undefined || victims.length > 0) {
            try {
              c.op.spec.check?.();
            } catch (error) {
              c.next++;
              failOperand(c, error, victims ?? wanting(c, key));
              continue;
            }
          }
          at.push({ c, victims });
        }
        // Taken in key order before anything is awaited: concurrent takes of one stream must line up with its keys.
        const settled = await Promise.allSettled(at.map(({ c }) => streamOf(c).take(key)));
        const decoded = new Map<number, CodecBitmap>();
        let held = 0;
        try {
          for (let i = 0; i < at.length; i++) {
            const { c, victims } = at[i]!;
            const result = settled[i]!;
            c.next++;
            if (c.done) continue;
            if (result.status === 'rejected') {
              failOperand(c, result.reason, victims ?? wanting(c, key));
              continue;
            }
            this.chunkReads++;
            c.op.chunkReads++;
            // A chunk no live output demands any more is taken off the stream and dropped, undecoded.
            if (victims !== undefined && victims.length === 0) continue;
            const bytes = result.value.bytes;
            if (bytes === null) {
              // The index lists the key, so the generation must hold its bytes: a hole is a fault, never an empty chunk.
              failOperand(
                c,
                new IntegrityError(
                  `operand "${c.op.spec.name}" lists chunk ${key} but its generation holds no bytes for it`,
                ),
                victims ?? wanting(c, key),
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
              failOperand(c, error, victims ?? wanting(c, key));
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
    wanted: Uint16Array,
    retry: <T>(request: () => Promise<T>) => Promise<T>,
    onRequest: (r: { readonly bytes: number; readonly ms: number }) => void,
  ): AsyncIterable<ChunkRead> {
    const source = this.source;
    const keys = Array.from(wanted);
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

  /** Re-check the pinned operands the survivors subtract, then publish what is left, `publishConcurrency` at a time. */
  private async publishWave(survivors: Array<OutputState<R>>): Promise<void> {
    const toCheck = new Set<number>();
    for (const o of survivors) {
      for (const i of o.compiled.subtracted) {
        const spec = this.operands[i]!.spec;
        if (spec.pinnedGeneration !== undefined && spec.current !== undefined) toCheck.add(i);
      }
    }
    const verdict = new Map<number, unknown>();
    await mapWithConcurrency([...toCheck], INDEX_PARALLELISM, async (i) => {
      const op = this.operands[i]!;
      try {
        const now = await this.readRow(op, true);
        if (!pinnedStillCurrent(op.spec, now)) {
          verdict.set(
            i,
            new StaleOperandError(
              `materializeMany: operand "${op.spec.name}", subtracted by an output, was replaced while the call ran ` +
                `(pinned at generation ${String(op.spec.pinnedGeneration)}; the registry now holds ` +
                `${now === null ? 'no row' : `generation ${String(now.generation)}, and its row or its object is not the pinned one`}), ` +
                'so its outputs were not published. Run the call again to subtract the current one.',
              op.spec.name,
              'moved',
            ),
          );
        }
      } catch (error) {
        // A subtracted operand that cannot be re-checked is not assumed unchanged: its outputs are not published.
        verdict.set(i, error);
      }
    });
    for (const o of survivors) {
      for (const i of o.compiled.subtracted) {
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
          if (o.solo) {
            this.fail(o, budgetError(this.req.maxBufferedBytes, `publishing output ${o.index}`));
          } else {
            // The buffers filled the budget, so the object it would write has no room beside them: it runs again alone.
            this.dropBuffer(o);
            o.status = 'deferred';
            o.group = null;
            o.startedAt = null;
          }
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
          const proven = o.spec.requestsOf?.(value);
          if (proven !== undefined) {
            this.attributedGet += proven.get;
            this.attributedPut += proven.put;
          }
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

  /** A fresh read of the operand's row, remembered as where the operand stood last. */
  private async readRow(op: OperandState, fingerprint = false): Promise<EndRow | null> {
    this.registryReads++;
    const row = (await op.spec.current!({ fingerprint })) ?? null;
    op.endRow = row;
    op.endGeneration = row?.generation ?? null;
    return row;
  }

  /** Where every operand stands when the call ends: one row read each, the re-checked ones already read. */
  private async readEnds(): Promise<void> {
    const pending = this.operands.filter(
      (op) => op.endRow === undefined && op.spec.current !== undefined,
    );
    await mapWithConcurrency(pending, INDEX_PARALLELISM, async (op) => {
      try {
        await this.readRow(op);
      } catch {
        // Reported as not read: the end of a call is no reason to fail what it already settled.
      }
    });
  }

  // ---- stats ------------------------------------------------------------------------------------------------

  private stats(): CombineManyStats {
    const operands: Record<string, CombineManyOperandStats> = Object.create(null) as Record<
      string,
      CombineManyOperandStats
    >;
    for (const op of this.operands) {
      const pinned = op.spec.pinnedGeneration !== undefined;
      const moved =
        op.endRow === undefined
          ? undefined
          : pinned
            ? !pinnedStillCurrent(op.spec, op.endRow)
            : liveMoved(op);
      operands[op.spec.name] = {
        read: op.read,
        pinned: op.spec.pinnedGeneration !== undefined,
        pinnedGeneration: op.spec.pinnedGeneration,
        startGeneration: op.startGeneration,
        endGeneration: op.endGeneration,
        moved,
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
        opens: this.opens,
        publishes: this.publishes,
        attributed: {
          get: this.rangeReads + this.registryReads + this.attributedGet,
          put: this.attributedPut,
        },
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

/** The token of a version (`<generation>:<token>`), or `undefined` where the version names no row. */
function tokenOfVersion(version: string | null | undefined): string | undefined {
  if (version == null) return undefined;
  const colon = version.indexOf(':');
  return colon < 0 ? undefined : version.slice(colon + 1);
}

/** Whether two row tokens are one row: the same incarnation where they have one, else the same token. */
function sameRow(a: string, b: string): boolean {
  const ia = incarnationOf(a);
  const ib = incarnationOf(b);
  return ia !== undefined || ib !== undefined ? ia === ib : a === b;
}

/**
 * Whether what `spec` was pinned to is still what the registry holds, given the row read now (`null`: no row). The
 * generation number alone is not an identity: a name deleted and created again starts at generation 0, and a number can be
 * taken again once its object is gone. So the incarnation of the row is compared (two tokens of one incarnation are writes
 * of one row: a retention policy or a lease moves the token and not the incarnation), and, where the row read carries
 * the current object's fingerprint, the object's too.
 */
function pinnedStillCurrent(spec: CombineManyOperand, now: EndRow | null): boolean {
  const pinned = spec.pinnedGeneration ?? null;
  if (pinned !== (now?.generation ?? null)) return false;
  if (pinned === null || now === null) return true;
  const was = tokenOfVersion(spec.pinnedVersion);
  if (was !== undefined && !sameRow(was, now.token)) return false;
  const held = spec.pinnedFingerprint;
  return held == null || now.fingerprint == null || held === now.fingerprint;
}

/** Whether an operand read live has changed row or generation since its index was read. */
function liveMoved(op: OperandState): boolean | undefined {
  if (op.endRow === undefined || !op.read) return undefined;
  const was = tokenOfVersion(op.startVersion);
  if (was !== undefined && op.endRow !== null && !sameRow(was, op.endRow.token)) return true;
  return op.startGeneration === undefined ? undefined : op.endGeneration !== op.startGeneration;
}

/** Whether the ascending `keys` hold `key`. */
function hasKey(keys: Uint16Array | undefined, key: number): boolean {
  if (keys === undefined) return false;
  let lo = 0;
  let hi = keys.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (keys[mid]! < key) lo = mid + 1;
    else hi = mid;
  }
  return lo < keys.length && keys[lo] === key;
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
