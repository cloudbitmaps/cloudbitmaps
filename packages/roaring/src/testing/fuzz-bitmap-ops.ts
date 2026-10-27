/**
 * Internal surface for the coverage-guided fuzz harness: the byte-driven operation sequence the `bitmap-ops` target
 * runs, kept here so the committed reproducers are replayed in the normal suite by the very code the target runs.
 *
 * An input is `[u16 n][n bytes of a portable bitmap][operations...]`. The bitmap bytes go through the public door,
 * `RoaringBitmap.deserialize`; what it accepts is the starting set (what it refuses starts an empty one, so the
 * operations still run), so guidance reaches the kernels through the shapes only a decode produces: run containers,
 * a slab of small containers, a bitset read in place. Each operation byte then picks a public method and its
 * arguments, and every answer is held to a plain `Set` model. A decode of more than {@link MODEL_LIMIT} ids is first
 * cut down to its first ids, because a run-heavy bitmap is tiny on disk and can hold billions.
 *
 * Any answer that disagrees with the model, any method that throws what it must not, and any bitmap that changes
 * under a refused call or under an operation on its clone is a finding (a plain `Error`). A typed refusal of bytes is
 * the contract, not a finding.
 */
import { ValidationError } from '@cloudbitmaps/core';
import { RoaringBitmap } from '../bitmap';

const MODEL_LIMIT = 20_000;
const KEEP_ON_CUT = 4_096;
const MAX_OPS = 48;
const EDGES = [0, 1, 4_095, 4_096, 65_535, 65_536, 2 ** 31, 0xffff_fffe, 0xffff_ffff];
/** Values that are not ids, of the kinds a caller passes. */
const NOT_IDS: unknown[] = [-1, 2 ** 32, 1.5, Number.NaN, '5', null, undefined, 5n];

class Bytes {
  #at = 0;
  constructor(private readonly data: Uint8Array) {}
  get more(): boolean {
    return this.#at < this.data.length;
  }
  u8(): number {
    return this.data[this.#at++] ?? 0;
  }
  u16(): number {
    return this.u8() | (this.u8() << 8);
  }
  u32(): number {
    return (this.u8() | (this.u8() << 8) | (this.u8() << 16) | (this.u8() << 24)) >>> 0;
  }
  slice(n: number): Uint8Array {
    const out = this.data.subarray(this.#at, this.#at + n);
    this.#at += n;
    return out;
  }
}

function fail(message: string): never {
  throw new Error(`bitmap-ops: ${message}`);
}

/** A bitmap with the set a plain `Set` says it holds. */
interface Held {
  readonly bitmap: RoaringBitmap;
  readonly model: Set<number>;
}

function sorted(model: Set<number>): number[] {
  return [...model].sort((a, b) => a - b);
}

/** Every answer the bitmap gives, against the model. */
function agree(label: string, held: Held): void {
  const { bitmap, model } = held;
  if (bitmap.size !== model.size) fail(`${label}: size ${bitmap.size}, model ${model.size}`);
  if (bitmap.isEmpty !== (model.size === 0)) fail(`${label}: isEmpty disagrees`);
  const want = sorted(model);
  const got = bitmap.toUint32Array();
  if (got.length !== want.length)
    fail(`${label}: toUint32Array holds ${got.length}, model ${want.length}`);
  let at = 0;
  for (const id of bitmap) {
    if (id !== want[at]) fail(`${label}: iteration disagrees with the model at position ${at}`);
    if (got[at] !== id) fail(`${label}: toUint32Array disagrees with iteration at position ${at}`);
    at++;
  }
  if (at !== want.length) fail(`${label}: iteration ends at ${at}, model ${want.length}`);
  if (bitmap.minimum() !== want[0]) fail(`${label}: minimum ${bitmap.minimum()}, model ${want[0]}`);
  if (bitmap.maximum() !== want.at(-1))
    fail(`${label}: maximum ${bitmap.maximum()}, model ${want.at(-1)}`);
}

/** An id: random, an edge, or a member of the model or one next to it. */
function idFrom(bytes: Bytes, model: Set<number>): number {
  const mode = bytes.u8() % 3;
  if (mode === 0) return bytes.u32();
  if (mode === 1) return EDGES[bytes.u8() % EDGES.length] as number;
  const members = sorted(model);
  if (members.length === 0) return bytes.u32();
  const near = (members[bytes.u16() % members.length] as number) + (bytes.u8() % 3) - 1;
  return Math.min(0xffff_ffff, Math.max(0, near));
}

function idsFrom(bytes: Bytes, model: Set<number>): number[] {
  return Array.from({ length: 1 + (bytes.u8() % 40) }, () => idFrom(bytes, model));
}

/** Throws unless `run` raises `ValidationError`; the caller then checks that nothing changed. */
function refused(label: string, run: () => unknown): void {
  try {
    run();
  } catch (err) {
    if (err instanceof ValidationError) return;
    fail(`${label}: raised ${String(err)}, not a ValidationError`);
  }
  fail(`${label}: was accepted`);
}

/** The first ids of `bitmap`, at most `count`, read through its iterator. */
function firstIds(bitmap: RoaringBitmap, count: number): number[] {
  const out: number[] = [];
  for (const id of bitmap) {
    out.push(id);
    if (out.length === count) break;
  }
  return out;
}

/** The bitmap `bytes` decode to, held to the model of its ids; an empty one when the door refuses them. */
function start(bytes: Uint8Array): Held {
  let bitmap: RoaringBitmap;
  try {
    bitmap = RoaringBitmap.deserialize(bytes);
  } catch (err) {
    if (err instanceof ValidationError) return { bitmap: new RoaringBitmap(), model: new Set() };
    throw err;
  }
  if (bitmap.size > MODEL_LIMIT) {
    bitmap.andInPlace(new RoaringBitmap(firstIds(bitmap, KEEP_ON_CUT)));
  }
  return { bitmap, model: new Set(bitmap) };
}

function mutate(held: Held, op: number, bytes: Bytes): void {
  const { bitmap, model } = held;
  switch (op) {
    case 0: {
      const id = idFrom(bytes, model);
      if (bitmap.add(id) !== bitmap) fail('add does not return this');
      model.add(id);
      return;
    }
    case 1: {
      const id = idFrom(bytes, model);
      if (bitmap.remove(id) !== model.delete(id)) fail('remove answers wrongly');
      return;
    }
    case 2: {
      const ids = idsFrom(bytes, model);
      bitmap.addMany(ids);
      for (const id of ids) model.add(id);
      return;
    }
    case 3: {
      const ids = idsFrom(bytes, model);
      bitmap.removeMany(Uint32Array.from(ids));
      for (const id of ids) model.delete(id);
      return;
    }
    default:
      bitmap.clear();
      model.clear();
  }
}

function combine(held: Held, op: number, bytes: Bytes): void {
  const { bitmap, model } = held;
  const other = op === 8 ? bitmap : new RoaringBitmap(idsFrom(bytes, model));
  const otherIds = new Set(other);
  counts('counts against the combine operand', held, { bitmap: other, model: otherIds });
  const before = [...model];
  const kind = bytes.u8() % 4;
  if (kind === 0) {
    bitmap.andInPlace(other);
    for (const id of before) if (!otherIds.has(id)) model.delete(id);
  } else if (kind === 3) {
    if (bitmap.xorInPlace(other) !== bitmap) fail('xorInPlace does not return this');
    for (const id of otherIds) if (!model.delete(id)) model.add(id);
  } else if (kind === 1) {
    bitmap.orInPlace(other);
    for (const id of otherIds) model.add(id);
  } else {
    bitmap.andNotInPlace(other);
    for (const id of otherIds) model.delete(id);
  }
}

/** The bytes, decoded again, hold the same set; and after `runOptimize` they are a function of the set alone. */
function roundTrip(held: Held, optimize: boolean): void {
  const { bitmap, model } = held;
  if (optimize) bitmap.runOptimize();
  const bytes = bitmap.serialize();
  const back = RoaringBitmap.deserialize(bytes);
  agree('round trip', { bitmap: back, model });
  if (optimize) {
    const again = RoaringBitmap.deserialize(bitmap.serialize());
    again.runOptimize();
    const a = bitmap.serialize();
    const b = again.serialize();
    if (a.length !== b.length || a.some((v, i) => v !== b[i]))
      fail('optimized bytes depend on history');
  }
}

/** A clone and its original change apart: every mutation of one leaves the other as it was. */
function cloneApart(held: Held, bytes: Bytes): void {
  const copy: Held = { bitmap: held.bitmap.clone(), model: new Set(held.model) };
  const frozen: Held = { bitmap: copy.bitmap.clone(), model: new Set(held.model) };
  const op = bytes.u8() % 5;
  mutate(bytes.u8() % 2 === 0 ? held : copy, op, bytes);
  agree('original', held);
  agree('clone', copy);
  agree('clone of the clone, taken before the change', frozen);
}

/**
 * The combines that return a new bitmap, on the held bitmap and one or two more: the result holds what the model says,
 * no operand changed, and a change to the result or to an operand afterwards reaches no other bitmap.
 */
function algebra(held: Held, bytes: Bytes): void {
  const first = held.bitmap;
  const second = new RoaringBitmap(idsFrom(bytes, held.model));
  const third =
    bytes.u8() % 2 === 0 ? first.clone() : new RoaringBitmap(idsFrom(bytes, held.model));
  const [ids2, ids3] = [new Set(second), new Set(third)];
  const secondHeld: Held = { bitmap: second, model: ids2 };
  const thirdHeld: Held = { bitmap: third, model: ids3 };
  counts('first against second', held, secondHeld);
  counts('second against first', secondHeld, held);
  counts('first against third', held, thirdHeld);
  counts('third against second', thirdHeld, secondHeld);
  counts('first against itself', held, held);
  const kind = bytes.u8() % 5;
  const want = new Set<number>();
  let result: RoaringBitmap;
  if (kind === 0) {
    result = RoaringBitmap.and(first, second);
    for (const id of held.model) if (ids2.has(id)) want.add(id);
  } else if (kind === 1) {
    result = RoaringBitmap.or(first, second);
    for (const id of [...held.model, ...ids2]) want.add(id);
  } else if (kind === 2) {
    result = RoaringBitmap.xor(first, second);
    for (const id of held.model) if (!ids2.has(id)) want.add(id);
    for (const id of ids2) if (!held.model.has(id)) want.add(id);
  } else if (kind === 3) {
    result = RoaringBitmap.andNot(first, second);
    for (const id of held.model) if (!ids2.has(id)) want.add(id);
  } else {
    result = RoaringBitmap.orMany([first, second, third]);
    for (const id of [...held.model, ...ids2, ...ids3]) want.add(id);
  }
  if (result === first || result === second || result === third)
    fail('a combine returned an operand');
  const made: Held = { bitmap: result, model: want };
  agree('combine result', made);
  counts('result against first', made, held);
  counts('second against result', secondHeld, made);
  agree('first operand', held);
  agree('second operand', { bitmap: second, model: ids2 });
  agree('third operand', { bitmap: third, model: ids3 });
  mutate(made, bytes.u8() % 5, bytes);
  agree('result after its own change', made);
  agree('first operand after the result changed', held);
  agree('second operand after the result changed', { bitmap: second, model: ids2 });
  mutate(held, bytes.u8() % 5, bytes);
  agree('result after the operand changed', { bitmap: result, model: made.model });
  // A container only the second operand held may have been copied into the result: a change to the second operand must
  // not reach the result, nor the other operands.
  mutate(secondHeld, bytes.u8() % 5, bytes);
  agree('result after the second operand changed', { bitmap: result, model: made.model });
  agree('first operand after the second changed', held);
  agree('second operand after its own change', secondHeld);
  agree('third operand after the others changed', { bitmap: third, model: ids3 });
}

/**
 * Every count and comparison of `x` against `y`, held to the models. No operand changes. It reads no input byte, so a
 * check added here never changes how an earlier input decodes.
 */
function counts(label: string, x: Held, y: Held): void {
  let both = 0;
  for (const id of x.model) if (y.model.has(id)) both++;
  const xs = x.model.size;
  const ys = y.model.size;
  const is = (what: string, got: number | boolean, want: number | boolean): void => {
    if (got !== want) fail(`${label}: ${what} is ${got}, model ${want}`);
  };
  is('andCardinality', x.bitmap.andCardinality(y.bitmap), both);
  is('orCardinality', x.bitmap.orCardinality(y.bitmap), xs + ys - both);
  is('xorCardinality', x.bitmap.xorCardinality(y.bitmap), xs + ys - 2 * both);
  is('andNotCardinality', x.bitmap.andNotCardinality(y.bitmap), xs - both);
  is('intersects', x.bitmap.intersects(y.bitmap), both > 0);
  is('isSubset', x.bitmap.isSubset(y.bitmap), both === xs);
  is('isEqual', x.bitmap.isEqual(y.bitmap), both === xs && xs === ys);
  agree(`${label}: first operand after the counts`, x);
  agree(`${label}: second operand after the counts`, y);
}

function refusals(held: Held, bytes: Bytes): void {
  const { bitmap } = held;
  const bad = NOT_IDS[bytes.u8() % NOT_IDS.length];
  refused('add', () => bitmap.add(bad as number));
  refused('has', () => bitmap.has(bad as number));
  refused('remove', () => bitmap.remove(bad as number));
  refused('addMany', () => bitmap.addMany([1, bad as number]));
  refused('removeMany', () => bitmap.removeMany([1, bad as number]));
  const add = bitmap.add as (...a: unknown[]) => unknown;
  refused('add with two arguments', () => add.call(bitmap, 1, 2));
  refused('andInPlace with a non-bitmap', () => bitmap.andInPlace(bad as unknown as RoaringBitmap));
  refused('xorInPlace with a non-bitmap', () => bitmap.xorInPlace(bad as unknown as RoaringBitmap));
  refused('and with a non-bitmap', () =>
    RoaringBitmap.and(bitmap, bad as unknown as RoaringBitmap),
  );
  refused('xor with a non-bitmap', () =>
    RoaringBitmap.xor(bad as unknown as RoaringBitmap, bitmap),
  );
  for (const method of [
    'andCardinality',
    'orCardinality',
    'xorCardinality',
    'andNotCardinality',
    'intersects',
    'isSubset',
    'isEqual',
  ] as const) {
    refused(`${method} with a non-bitmap`, () => bitmap[method](bad as unknown as RoaringBitmap));
  }
  refused('orMany with a non-bitmap', () => RoaringBitmap.orMany([bitmap, bad as RoaringBitmap]));
}

function step(held: Held, bytes: Bytes): void {
  const op = bytes.u8() % 15;
  if (op < 5) mutate(held, op, bytes);
  else if (op <= 8) combine(held, op, bytes);
  else if (op === 9) roundTrip(held, false);
  else if (op === 10) roundTrip(held, true);
  else if (op === 11) cloneApart(held, bytes);
  else if (op === 12) refusals(held, bytes);
  else if (op === 14) algebra(held, bytes);
  else {
    const id = idFrom(bytes, held.model);
    if (held.bitmap.has(id) !== held.model.has(id)) fail('has answers wrongly');
  }
  agree(`after operation ${op}`, held);
}

/**
 * Run one fuzz input. Returns normally when every answer agreed with the model; throws a plain `Error` for a finding.
 */
export function runBitmapOps(data: Uint8Array): void {
  const bytes = new Bytes(data);
  const length = bytes.u16();
  const held = start(bytes.slice(length));
  agree('the start', held);
  for (let n = 0; n < MAX_OPS && bytes.more; n++) step(held, bytes);
}
