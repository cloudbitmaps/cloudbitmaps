/**
 * The chunk-ordered feed of a batch combine: operands that arrive as records, one chunk key at a time, and are checked
 * and converted as they arrive. Pure: it reads through the iterable it is given and knows no store, clock or storage.
 *
 * ```
 * record { key, operands: { name: Uint32Array } }
 *   check    key in range and not below the last; every name declared; every value a real Uint32Array; ids strictly
 *            ascending and inside the key; each operand at most once per key        (a refusal, never a repair)
 *   convert  each operand's ids into one compressed bitmap, charged to the ledger as it is built
 *   group    the records of one key, held until a record with a higher key arrives or the feed ends
 * end of feed   counts equal what was seen; a declared operand that never appeared is refused unless allowed
 * ```
 *
 * Nothing here ever reads a bad feed as fewer members: every check is a refusal, and a refusal ends the feed.
 */
import type { CodecBitmap, CodecInterface } from './codec';
import { residentBound } from './combine-ledger';
import { ValidationError } from './errors';

/** One record of a feed: the ids each named operand holds at one chunk key. */
export interface CombineManyFeedRecord {
  /** The chunk key, `id >>> 16`, from 0 to 65,535. Non-decreasing over the feed; a key may arrive as several records. */
  readonly key: number;
  /** Ids by operand name: ascending, unique, every one inside `key`. An operand is named at most once per key. */
  readonly operands: Readonly<Record<string, Uint32Array>>;
}

/** The fed operands of a batch combine. */
export interface CombineManyFeed {
  /** The fed operand names, declared up front. */
  readonly names: readonly string[];
  /** The records, read once, in key order. */
  readonly records: AsyncIterable<CombineManyFeedRecord>;
  /**
   * The ids each fed operand holds over the whole feed, keyed by exactly `names`: an object, or a function called once
   * after the last record. A count that differs from what the feed held refuses every fed output.
   */
  readonly counts:
    | Readonly<Record<string, number>>
    | (() => Readonly<Record<string, number>> | Promise<Readonly<Record<string, number>>>);
  /** Fed names allowed to hold no id anywhere in the feed. */
  readonly mayBeEmpty?: readonly string[];
  /** Whether an erasure ran in the store since the call began, or is running: read at every record and before each fed publish. */
  readonly epoch?: { readonly moved: () => boolean };
}

/** A feed that passed {@link checkFeed}: read once, so what was checked is what runs. */
export interface CheckedFeed {
  readonly names: readonly string[];
  readonly records: AsyncIterable<unknown>;
  readonly counts: CombineManyFeed['counts'];
  readonly mayBeEmpty: ReadonlySet<string>;
  readonly epoch: CombineManyFeed['epoch'];
}

/** The ids one chunk key can hold. */
const KEY_IDS = 65_536;

/** Check a feed's shape, before any record is read. `stored` are the stored operand names, which a fed one may not repeat. */
export function checkFeed(feed: unknown, stored: ReadonlySet<string>): CheckedFeed {
  if (typeof feed !== 'object' || feed === null || Array.isArray(feed)) {
    throw new ValidationError('feed must be an object with names, records and counts');
  }
  // Read once: a getter or a proxy answering twice would be checked as one value and used as another.
  const f = feed as Record<string, unknown>;
  const names: unknown = f.names;
  const records: unknown = f.records;
  const counts: unknown = f.counts;
  const mayBeEmpty: unknown = f.mayBeEmpty;
  const epoch: unknown = f.epoch;
  if (!Array.isArray(names) || names.length === 0) {
    throw new ValidationError('feed.names must be a non-empty array of the fed operand names');
  }
  const declared = new Set<string>();
  for (const name of names as unknown[]) {
    if (typeof name !== 'string' || name === '') {
      throw new ValidationError('feed.names must hold non-empty strings');
    }
    if (declared.has(name)) throw new ValidationError(`feed.names lists "${name}" twice`);
    if (stored.has(name)) {
      throw new ValidationError(
        `"${name}" is both a stored operand and a fed one: a name is one or the other`,
      );
    }
    declared.add(name);
  }
  const iterable = records as { [Symbol.asyncIterator]?: unknown } | null | undefined;
  if (
    (typeof iterable !== 'object' && typeof iterable !== 'function') ||
    iterable === null ||
    typeof iterable[Symbol.asyncIterator] !== 'function'
  ) {
    throw new ValidationError(
      'feed.records must be an async iterable (an async generator, for one): wrap an array in `async function*`',
    );
  }
  if (
    typeof counts !== 'function' &&
    (typeof counts !== 'object' || counts === null || Array.isArray(counts))
  ) {
    throw new ValidationError(
      'feed.counts is required: an object of ids per fed operand, or a function returning one',
    );
  }
  const allowed = new Set<string>();
  if (mayBeEmpty !== undefined) {
    if (!Array.isArray(mayBeEmpty)) {
      throw new ValidationError('mayBeEmpty must be an array of fed operand names');
    }
    for (const name of mayBeEmpty as unknown[]) {
      if (typeof name !== 'string' || !declared.has(name)) {
        throw new ValidationError(
          `mayBeEmpty names ${typeof name === 'string' ? `"${name}"` : 'something that is not a name'}, which is not a fed operand`,
        );
      }
      allowed.add(name);
    }
  }
  let checkedEpoch: CombineManyFeed['epoch'];
  if (epoch !== undefined) {
    const e = epoch as { moved?: unknown };
    if (typeof e !== 'object' || e === null || typeof e.moved !== 'function') {
      throw new ValidationError('feed.epoch must be { moved }');
    }
    checkedEpoch = { moved: e.moved as () => boolean };
  }
  return {
    names: [...declared],
    records: records as AsyncIterable<unknown>,
    counts: counts as CheckedFeed['counts'],
    mayBeEmpty: allowed,
    epoch: checkedEpoch,
  };
}

/** The typed arrays' own accessors: they read the view itself, whatever a subclass, a proxy or another realm defines. */
const TYPED = Object.getPrototypeOf(Uint8Array.prototype) as object;
const typedGetter = (name: string | symbol): ((this: unknown) => unknown) =>
  Object.getOwnPropertyDescriptor(TYPED, name)?.get as (this: unknown) => unknown;
const brandOf = typedGetter(Symbol.toStringTag);
const bufferOf = typedGetter('buffer');
const byteOffsetOf = typedGetter('byteOffset');
const byteLengthOf = typedGetter('byteLength');
const detachedOf = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'detached')?.get as
  ((this: unknown) => unknown) | undefined;
/** `%TypedArray%.prototype.values`: it throws for a view that is out of bounds or detached, and changes nothing. */
const valuesOf = (TYPED as { values: (this: unknown) => unknown }).values;

/**
 * The view a real `Uint32Array` holds, as a plain `Uint32Array` over the same bytes, or `undefined` for anything else.
 * The brand is the `%TypedArray%` `@@toStringTag` getter, which reads the internal slot: it names only a real typed array
 * of that kind (a subclass or another realm's included) and throws for a spoof, a proxy or any other object. The view's
 * extent is then read through the intrinsic getters, so a subclass that overrides `length` or the iterator is never asked.
 */
export function plainUint32(
  value: unknown,
): Uint32Array | 'detached' | 'out of bounds' | undefined {
  let tag: unknown;
  try {
    tag = brandOf.call(value);
  } catch {
    return undefined;
  }
  if (tag !== 'Uint32Array') return undefined;
  const buffer = bufferOf.call(value) as ArrayBufferLike;
  const length = byteLengthOf.call(value) as number;
  if (length === 0) {
    try {
      // A detached buffer reports no bytes, which would read as an empty operand.
      if (detachedOf?.call(buffer) === true) return 'detached';
    } catch {
      // A SharedArrayBuffer is never detached.
    }
    try {
      // A view on a resizable buffer that shrank past it also reports no bytes: its own iterator refuses it.
      valuesOf.call(value);
    } catch {
      return 'out of bounds';
    }
    return new Uint32Array(0);
  }
  return new Uint32Array(buffer, byteOffsetOf.call(value) as number, length >>> 2);
}

/**
 * Whether `value` is a plain object: its prototype is `null`, or a root of a prototype chain that has `Object.prototype`'s
 * own methods (so another realm's plain object passes). An inherited name or a `Map`'s entries are never read as operands.
 */
function isPlainObject(value: object): boolean {
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto === null) return true;
  return Object.getPrototypeOf(proto) === null && Object.hasOwn(proto as object, 'hasOwnProperty');
}

/** What a group of one key holds: each operand's bitmap, by operand index, and what it is charged. */
interface Held {
  readonly bitmap: CodecBitmap;
  readonly charge: number;
}

interface Group {
  readonly key: number;
  readonly ops: Map<number, Held>;
}

/** Thrown inside the cursor when it was closed under an operation in flight; never reaches a caller. */
export class FeedClosed extends Error {}
/** Thrown when the store's erasure counter moved: the run turns it into one typed error per output. */
export class FeedStale extends Error {}

/** What a {@link FeedCursor} needs from the pass that runs it. */
export interface FeedCursorDeps {
  readonly feed: CheckedFeed;
  readonly codec: CodecInterface;
  /** The index the first fed operand has among the call's operands. */
  readonly base: number;
  /** Charge `bytes` to the ledger, making room as the pass does, or throw when they do not fit. */
  readonly charge: (bytes: number) => void;
  readonly release: (bytes: number) => void;
  /** One call per operand converted: the pass's cooperative yield. */
  readonly tick: () => Promise<void> | null;
  /** Whether a record at `key` is inside the call's id range; one outside is checked and counted but not kept. */
  readonly inWindow: (key: number) => boolean;
}

/**
 * Reads a feed one record at a time: checks it, converts it, and hands the records of one key to the pass as a group.
 * At most two records are resident, the group being built and the one that proved it complete.
 */
export class FeedCursor {
  private iterator: AsyncIterator<unknown> | undefined;
  private group: Group | undefined;
  private look: Group | undefined;
  private current: Group | undefined;
  private ended = false;
  private closed = false;
  private finished = false;
  private held = 0;
  private returned: Promise<void> | undefined;
  private prevKey = -1;
  private readonly index: Map<string, number>;
  private readonly seen: Uint8Array;
  private readonly touched: number[] = [];
  private readonly counts: number[];
  private readonly scratch = new Uint32Array(KEY_IDS);
  private recordCount = 0;
  private keyCount = 0;
  private idCount = 0;

  constructor(private readonly deps: FeedCursorDeps) {
    this.index = new Map(deps.feed.names.map((name, i) => [name, i]));
    this.seen = new Uint8Array(deps.feed.names.length);
    this.counts = deps.feed.names.map(() => 0);
  }

  /** Whether the feed can still yield a key: not closed, and neither ended nor drained. */
  get active(): boolean {
    return !this.closed && (!this.ended || this.group !== undefined || this.look !== undefined);
  }

  /** Whether the whole feed was read and every end-of-feed check passed. */
  get complete(): boolean {
    return this.finished;
  }

  /** The ledger bytes the cursor holds. */
  get heldBytes(): number {
    return this.held;
  }

  get stats(): { readonly records: number; readonly keys: number; readonly ids: number } {
    return { records: this.recordCount, keys: this.keyCount, ids: this.idCount };
  }

  /** The key the feed holds next, pulling the first record of it if none is held; `undefined` once nothing is left. */
  async nextKey(): Promise<number | undefined> {
    if (this.closed) return undefined;
    if (this.group === undefined) {
      if (this.look !== undefined) {
        this.group = this.look;
        this.look = undefined;
      } else {
        await this.fill();
      }
    }
    return this.group?.key;
  }

  /** Read until a record with a higher key arrives, or the feed ends: the group of {@link nextKey} is then whole. */
  async completeKey(): Promise<void> {
    const group = this.group;
    if (group === undefined) return;
    while (this.look === undefined && !this.ended) {
      const record = await this.pull();
      if (record === undefined) {
        await this.end();
        break;
      }
      if (record.ops === null) continue;
      if (record.key === group.key) for (const [i, h] of record.ops) group.ops.set(i, h);
      else this.look = { key: record.key, ops: record.ops };
    }
  }

  /** Take the whole group of {@link nextKey}: its bitmaps by operand index, held until {@link release}. */
  take(): ReadonlyMap<number, CodecBitmap> {
    const group = this.group!;
    this.current = group;
    this.group = undefined;
    this.keyCount++;
    return new BitmapView(group.ops);
  }

  /** Give back what the taken group holds. */
  release(): void {
    const group = this.current;
    this.current = undefined;
    if (group === undefined) return;
    for (const h of group.ops.values()) this.giveBack(h.charge);
  }

  /** Stop reading: release everything held and return the iterator. Safe to call at any time, and again. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.deps.release(this.held);
    this.held = 0;
    this.group = this.look = this.current = undefined;
    const iterator = this.iterator;
    if (iterator !== undefined && !this.ended && iterator.return !== undefined) {
      this.returned = Promise.resolve()
        .then(() => iterator.return!())
        .then(
          () => undefined,
          () => undefined,
        );
    }
  }

  /** Resolves once the iterator's `return` has settled. */
  async drained(): Promise<void> {
    await this.returned;
  }

  // ---- reading ----------------------------------------------------------------------------------------------

  private async fill(): Promise<void> {
    while (this.group === undefined && !this.ended) {
      const record = await this.pull();
      if (record === undefined) {
        await this.end();
        return;
      }
      if (record.ops !== null) this.group = { key: record.key, ops: record.ops };
    }
  }

  /** The next record, checked and converted (`ops` is `null` when its key is outside the range); `undefined` at the end. */
  private async pull(): Promise<{ key: number; ops: Map<number, Held> | null } | undefined> {
    const epoch = this.deps.feed.epoch;
    if (epoch?.moved() === true) throw new FeedStale();
    this.iterator ??= this.deps.feed.records[Symbol.asyncIterator]();
    const step = await this.iterator.next();
    if (this.closed) throw new FeedClosed();
    if (step.done === true) return undefined;
    this.recordCount++;
    return this.convert(step.value);
  }

  private async end(): Promise<void> {
    this.ended = true;
    await this.finish();
    this.finished = true;
  }

  // ---- the checks -------------------------------------------------------------------------------------------

  private refuse(key: number | string, operand: string | undefined, why: string): never {
    throw new ValidationError(
      `materializeMany feed: record at key ${String(key)}${operand === undefined ? '' : `, operand "${operand}"`}: ${why}`,
    );
  }

  private charge(bytes: number): void {
    this.deps.charge(bytes);
    if (this.closed) {
      this.deps.release(bytes);
      throw new FeedClosed();
    }
    this.held += bytes;
  }

  private giveBack(bytes: number): void {
    if (this.closed) return;
    this.held -= bytes;
    this.deps.release(bytes);
  }

  private async convert(record: unknown): Promise<{ key: number; ops: Map<number, Held> | null }> {
    if (typeof record !== 'object' || record === null) {
      this.refuse('?', undefined, 'a record is an object with a key and operands');
    }
    // Read once: a getter or a proxy answering twice would be checked as one value and used as another.
    const key: unknown = (record as { key?: unknown }).key;
    const operands: unknown = (record as { operands?: unknown }).operands;
    if (typeof key !== 'number' || !Number.isInteger(key) || key < 0 || key >= KEY_IDS) {
      this.refuse(
        typeof key === 'number' ? key : '?',
        undefined,
        'the key must be an integer from 0 to 65535',
      );
    }
    if (key < this.prevKey) {
      this.refuse(
        key,
        undefined,
        `the key is below the previous record's (${this.prevKey}): keys never go back`,
      );
    }
    if (key !== this.prevKey) {
      for (const i of this.touched) this.seen[i] = 0;
      this.touched.length = 0;
      this.prevKey = key;
    }
    if (typeof operands !== 'object' || operands === null || !isPlainObject(operands)) {
      this.refuse(
        key,
        undefined,
        'operands must be a plain object of fed operand name to Uint32Array (not a Map, an array or a class instance)',
      );
    }
    const keep = this.deps.inWindow(key);
    const ops = keep ? new Map<number, Held>() : null;
    const charged: number[] = [];
    try {
      for (const name of Reflect.ownKeys(operands)) {
        if (typeof name !== 'string') this.refuse(key, undefined, 'operands has a symbol key');
        const at = this.index.get(name);
        if (at === undefined) {
          this.refuse(key, name, 'not a declared fed operand (it is not in feed.names)');
        }
        const value: unknown = (operands as Record<string, unknown>)[name];
        const view = plainUint32(value);
        if (view === undefined) {
          this.refuse(
            key,
            name,
            'the ids must be a Uint32Array (any other typed array, array or look-alike is refused)',
          );
        }
        if (view === 'detached') this.refuse(key, name, "the array's buffer is detached");
        if (view === 'out of bounds') {
          this.refuse(
            key,
            name,
            'the array is out of bounds of its resizable buffer, which shrank under it',
          );
        }
        if (view.length === 0) continue;
        if (this.seen[at] === 1) {
          this.refuse(key, name, 'named twice at one key: an operand appears at most once per key');
        }
        const n = this.scan(view, key, name);
        this.seen[at] = 1;
        this.touched.push(at);
        this.counts[at]! += n;
        this.idCount += n;
        if (ops !== null) {
          const bytes = residentBound(n);
          this.charge(bytes);
          charged.push(bytes);
          ops.set(this.deps.base + at, {
            bitmap: this.deps.codec.fromValues(this.scratch.subarray(0, n)),
            charge: bytes,
          });
        }
        const pause = this.deps.tick();
        if (pause !== null) {
          await pause;
          if (this.closed) throw new FeedClosed();
        }
      }
    } catch (error) {
      for (const bytes of charged) this.giveBack(bytes);
      throw error;
    }
    return { key, ops };
  }

  /**
   * Check `view` and copy its low 16 bits into the scratch array in one pass, each id read once: a buffer that changes
   * under the check (a shared one) cannot make the checked value differ from the converted one.
   */
  private scan(view: Uint32Array, key: number, name: string): number {
    const n = view.length;
    if (n > KEY_IDS) this.refuse(key, name, `${n} ids, more than one chunk key holds`);
    const scratch = this.scratch;
    let prev = -1;
    for (let i = 0; i < n; i++) {
      const id = view[i]!;
      if (id >>> 16 !== key) {
        this.refuse(key, name, `the id at position ${i} is not inside the key`);
      }
      if (id <= prev) {
        this.refuse(
          key,
          name,
          `the id at position ${i} is not above the one before it: ids are ascending and unique`,
        );
      }
      scratch[i] = id & 0xffff;
      prev = id;
    }
    return n;
  }

  // ---- the end of the feed ----------------------------------------------------------------------------------

  /** The counts and the empty rule, run once, after the iterator has ended and before anything is published. */
  private async finish(): Promise<void> {
    const { names, mayBeEmpty, counts } = this.deps.feed;
    let given: unknown;
    try {
      given = typeof counts === 'function' ? await counts() : counts;
    } catch (cause) {
      throw new ValidationError(
        `materializeMany feed: feed.counts ${typeof counts === 'function' ? 'threw' : 'could not be read'}: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
      );
    }
    if (typeof given !== 'object' || given === null || Array.isArray(given)) {
      throw new ValidationError(
        'materializeMany feed: feed.counts must give an object of ids per fed operand',
      );
    }
    const own = new Set(Object.keys(given));
    for (const name of names) {
      if (!own.has(name)) {
        throw new ValidationError(`materializeMany feed: feed.counts has no count for "${name}"`);
      }
    }
    for (const name of own) {
      if (!this.index.has(name)) {
        throw new ValidationError(
          `materializeMany feed: feed.counts names "${name}", which is not in feed.names`,
        );
      }
    }
    names.forEach((name, i) => {
      const said = (given as Record<string, unknown>)[name];
      if (typeof said !== 'number' || !Number.isSafeInteger(said) || said < 0) {
        throw new ValidationError(
          `materializeMany feed: feed.counts["${name}"] must be a non-negative integer`,
        );
      }
      if (said !== this.counts[i]) {
        throw new ValidationError(
          `materializeMany feed: operand "${name}" was counted at ${said} ids and the feed held ${this.counts[i]}: ` +
            'the feed is short, long or skipped a key, and is refused',
        );
      }
    });
    names.forEach((name, i) => {
      if (this.counts[i] === 0 && !mayBeEmpty.has(name)) {
        throw new ValidationError(
          `materializeMany feed: operand "${name}" holds no id anywhere in the feed, so it would contribute nothing — ` +
            'an exclude would suppress no ids. If that is expected, list it in mayBeEmpty.',
        );
      }
    });
  }
}

/** A group's bitmaps by operand index, read-only: the pass looks fed operands up here without copying them. */
class BitmapView implements ReadonlyMap<number, CodecBitmap> {
  constructor(private readonly ops: ReadonlyMap<number, Held>) {}

  get size(): number {
    return this.ops.size;
  }

  get(key: number): CodecBitmap | undefined {
    return this.ops.get(key)?.bitmap;
  }

  has(key: number): boolean {
    return this.ops.has(key);
  }

  forEach(
    fn: (value: CodecBitmap, key: number, map: ReadonlyMap<number, CodecBitmap>) => void,
  ): void {
    for (const [k, h] of this.ops) fn(h.bitmap, k, this);
  }

  *entries(): MapIterator<[number, CodecBitmap]> {
    for (const [k, h] of this.ops) yield [k, h.bitmap];
  }

  *keys(): MapIterator<number> {
    yield* this.ops.keys();
  }

  *values(): MapIterator<CodecBitmap> {
    for (const h of this.ops.values()) yield h.bitmap;
  }

  [Symbol.iterator](): MapIterator<[number, CodecBitmap]> {
    return this.entries();
  }
}
