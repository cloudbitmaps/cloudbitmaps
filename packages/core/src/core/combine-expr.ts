/**
 * The expression of a batch combine and the algebra over its chunk keys. Pure: no I/O, time or randomness.
 *
 * An expression is a name (an operand) or a node holding exactly one of `and`, `or` or `andNot`. {@link compileExpr}
 * checks one and lowers it to a tree of operand indexes; {@link planKeys} computes, bottom up, the chunk keys at which
 * each node can be non-empty and an upper bound on the ids it holds at each; {@link collectFetch} pushes the keys an
 * output needs down the tree, so an operand is fetched only where it can change a result.
 *
 * ```
 * S(x)             = keys of operand x          (its index: no payload)
 * S(and(c1..cn))   = S(c1) ∩ … ∩ S(cn)
 * S(or(c1..cn))    = S(c1) ∪ … ∪ S(cn)
 * S(andNot(L, R…)) = S(L)                       a subtrahend clears ids, it never adds a chunk
 * ```
 *
 * `S` over-approximates (two operands can both hold a key and not overlap), which costs one read and never a wrong
 * result; it never under-approximates, so a key outside `S(root)` is provably empty and is never requested.
 *
 * A fed operand's keys arrive with the feed, so the plan cannot know them: it is {@link ANY_KEYS}, every key. An `and`
 * ignores such a child, an `or` over one is `ANY_KEYS` itself, and an `andNot` is its left side's. {@link canHold} is the
 * exact per-key rule once a key's operands are known.
 */
import { ValidationError } from './errors';

/** A string names an operand; a node holds exactly one operator over a non-empty list of expressions. */
export type CombineExpr =
  string | { and: CombineExpr[] } | { or: CombineExpr[] } | { andNot: CombineExpr[] };

/** The most operator nodes one expression may nest. A literal that contains itself is refused by it. */
export const MAX_EXPR_DEPTH = 64;
/** The most nodes (operators and names) one expression may hold, so a shared sub-object cannot expand without bound. */
export const MAX_EXPR_NODES = 4096;

const OPERATORS = ['and', 'or', 'andNot'] as const;
type Operator = (typeof OPERATORS)[number];

/** A checked expression: operand indexes at the leaves, operators inside. */
export type ExprNode =
  | { readonly kind: 'leaf'; readonly operand: number }
  | { readonly kind: Operator; readonly kids: readonly ExprNode[] };

/** How many nodes one {@link compileExpr} call may still allocate; shared across the expressions of one output. */
export interface NodeBudget {
  remaining: number;
}

/**
 * Check `expr` and lower it. `path` names where it sits (`outputs[2].expr`), and every failure is a
 * {@link ValidationError} that carries it plus the path inside the expression.
 */
export function compileExpr(
  expr: unknown,
  path: string,
  operands: ReadonlyMap<string, number>,
  budget: NodeBudget = { remaining: MAX_EXPR_NODES },
  depth = 0,
): ExprNode {
  if (--budget.remaining < 0) {
    throw new ValidationError(
      `${path}: more than ${MAX_EXPR_NODES} nodes in one output's expression`,
    );
  }
  if (typeof expr === 'string') {
    const index = operands.get(expr);
    if (index === undefined) {
      throw new ValidationError(`${path}: "${expr}" does not name an operand`);
    }
    return { kind: 'leaf', operand: index };
  }
  if (typeof expr !== 'object' || expr === null || Array.isArray(expr)) {
    throw new ValidationError(
      `${path}: an expression is an operand name or an object with exactly one of and, or, andNot; got ${
        expr === null ? 'null' : Array.isArray(expr) ? 'an array' : typeof expr
      }`,
    );
  }
  const keys = Object.keys(expr);
  const operator = keys.length === 1 ? OPERATORS.find((op) => op === keys[0]) : undefined;
  if (operator === undefined) {
    throw new ValidationError(
      `${path}: an expression node holds exactly one of and, or, andNot; got ${
        keys.length === 0 ? 'no key' : keys.map((k) => `"${k}"`).join(', ')
      }`,
    );
  }
  if (depth >= MAX_EXPR_DEPTH) {
    throw new ValidationError(
      `${path}: expression nests more than ${MAX_EXPR_DEPTH} operators deep (an object that contains itself is refused here too)`,
    );
  }
  // Read once: a getter or a proxy answering twice would otherwise be checked as one list and run as another.
  const list: unknown = (expr as Record<string, unknown>)[operator];
  if (!Array.isArray(list) || list.length === 0) {
    throw new ValidationError(`${path}.${operator}: must be a non-empty array of expressions`);
  }
  if (operator === 'andNot' && list.length < 2) {
    throw new ValidationError(
      `${path}.andNot: needs at least two expressions, the one subtracted from and one to subtract`,
    );
  }
  const kids: ExprNode[] = [];
  for (let i = 0; i < list.length; i++) {
    kids.push(compileExpr(list[i], `${path}.${operator}[${i}]`, operands, budget, depth + 1));
  }
  return { kind: operator, kids };
}

/** The deepest operator nesting in `node`: 0 for a name. */
export function depthOf(node: ExprNode): number {
  if (node.kind === 'leaf') return 0;
  let deepest = 0;
  for (const kid of node.kids) deepest = Math.max(deepest, depthOf(kid));
  return deepest + 1;
}

/** The operand indexes `node` names, each once, ascending. */
export function operandsOf(node: ExprNode, into: Set<number> = new Set()): number[] {
  if (node.kind === 'leaf') into.add(node.operand);
  else for (const kid of node.kids) operandsOf(kid, into);
  return [...into].sort((a, b) => a - b);
}

/** Ascending chunk keys, and an upper bound on the ids each holds. */
export interface KeyBounds {
  readonly keys: Uint16Array;
  readonly card: Uint32Array;
}

const CHUNK_IDS = 65_536;

/** The keys of an operand the plan cannot know (a fed one): every key. Compared by identity, never by content. */
export const ANY_KEYS: Uint16Array = new Uint16Array(0);
/** The bounds of an operand the plan cannot know. */
export const ANY_BOUNDS: KeyBounds = { keys: ANY_KEYS, card: new Uint32Array(0) };

const EMPTY_BOUNDS: KeyBounds = { keys: new Uint16Array(0), card: new Uint32Array(0) };

/** `a ∩ b`, the smaller bound at each key. */
function intersectBounds(a: KeyBounds, b: KeyBounds): KeyBounds {
  const keys = new Uint16Array(Math.min(a.keys.length, b.keys.length));
  const card = new Uint32Array(keys.length);
  let i = 0;
  let j = 0;
  let n = 0;
  while (i < a.keys.length && j < b.keys.length) {
    const x = a.keys[i]!;
    const y = b.keys[j]!;
    if (x < y) i++;
    else if (y < x) j++;
    else {
      keys[n] = x;
      card[n] = Math.min(a.card[i]!, b.card[j]!);
      n++;
      i++;
      j++;
    }
  }
  return n === keys.length ? { keys, card } : { keys: keys.slice(0, n), card: card.slice(0, n) };
}

/** `a ∪ b`, the bounds summed at a shared key and capped at the ids one chunk can hold. */
function unionBounds(a: KeyBounds, b: KeyBounds): KeyBounds {
  const keys = new Uint16Array(a.keys.length + b.keys.length);
  const card = new Uint32Array(keys.length);
  let i = 0;
  let j = 0;
  let n = 0;
  while (i < a.keys.length || j < b.keys.length) {
    const x = i < a.keys.length ? a.keys[i]! : Infinity;
    const y = j < b.keys.length ? b.keys[j]! : Infinity;
    if (x < y) {
      keys[n] = x;
      card[n++] = a.card[i++]!;
    } else if (y < x) {
      keys[n] = y;
      card[n++] = b.card[j++]!;
    } else {
      keys[n] = x;
      card[n++] = Math.min(CHUNK_IDS, a.card[i++]! + b.card[j++]!);
    }
  }
  return { keys: keys.slice(0, n), card: card.slice(0, n) };
}

/** The keys of `a` that `b` holds. */
function intersectKeys(a: Uint16Array, b: Uint16Array): Uint16Array {
  if (a === ANY_KEYS) return b;
  if (b === ANY_KEYS) return a;
  const out = new Uint16Array(Math.min(a.length, b.length));
  let i = 0;
  let j = 0;
  let n = 0;
  while (i < a.length && j < b.length) {
    const x = a[i]!;
    const y = b[j]!;
    if (x < y) i++;
    else if (y < x) j++;
    else {
      out[n++] = x;
      i++;
      j++;
    }
  }
  return n === out.length ? out : out.slice(0, n);
}

/** What {@link planKeys} keeps of each operator node: the keys it can be non-empty at. */
export type NodeKeys = Map<ExprNode, Uint16Array>;

/**
 * Bottom up: the keys at which each node of `node` can be non-empty, with an upper bound on its ids at each. The
 * keys of every operator node are kept in `into` for {@link collectFetch}; the bounds are returned for the root alone,
 * so memory is the keys of one expression, not their bounds.
 */
export function planKeys(
  node: ExprNode,
  operands: readonly KeyBounds[],
  into: NodeKeys = new Map(),
): KeyBounds {
  if (node.kind === 'leaf') return operands[node.operand] ?? EMPTY_BOUNDS;
  let result: KeyBounds;
  if (node.kind === 'andNot') {
    result = planKeys(node.kids[0]!, operands, into);
    // The subtrahends clear ids and add no key, but their own nodes still need their keys for the demand pass.
    for (let i = 1; i < node.kids.length; i++) planKeys(node.kids[i]!, operands, into);
  } else {
    const kids = node.kids.map((kid) => planKeys(kid, operands, into));
    if (node.kind === 'and') {
      // A child that can hold any key adds no constraint. Smallest first: the running intersection can only shrink.
      const known = kids.filter((kid) => kid.keys !== ANY_KEYS);
      known.sort((a, b) => a.keys.length - b.keys.length);
      result = known[0] ?? ANY_BOUNDS;
      for (let i = 1; i < known.length && result.keys.length > 0; i++) {
        result = intersectBounds(result, known[i]!);
      }
    } else if (kids.some((kid) => kid.keys === ANY_KEYS)) {
      result = ANY_BOUNDS;
    } else {
      result = kids[0]!;
      for (let i = 1; i < kids.length; i++) result = unionBounds(result, kids[i]!);
    }
  }
  into.set(node, result.keys);
  return result;
}

/** The keys `node` can be non-empty at, from a {@link planKeys} pass over the expression it belongs to. */
function keysOf(node: ExprNode, operands: readonly KeyBounds[], planned: NodeKeys): Uint16Array {
  if (node.kind === 'leaf') return (operands[node.operand] ?? EMPTY_BOUNDS).keys;
  return planned.get(node) ?? new Uint16Array(0);
}

/**
 * Top down: the keys of each operand an output needs, given the keys `demanded` of its root. A leaf is fetched where
 * it is demanded and holds a chunk; `and` and `or` pass down what they can be non-empty at; `andNot` passes its left
 * child the demand it can meet and each subtrahend that, so an exclude is read only where the left side can overlap it.
 * `fetch(operand, keys)` is called once per operand occurrence.
 */
export function collectFetch(
  node: ExprNode,
  demanded: Uint16Array,
  operands: readonly KeyBounds[],
  planned: NodeKeys,
  fetch: (operand: number, keys: Uint16Array) => void,
): void {
  if (demanded.length === 0 && demanded !== ANY_KEYS) return;
  const own = keysOf(node, operands, planned);
  const here = intersectKeys(demanded, own);
  if (here.length === 0 && here !== ANY_KEYS) return;
  if (node.kind === 'leaf') {
    // A leaf that can hold any key is a fed operand: there is nothing stored to fetch.
    if (own !== ANY_KEYS) fetch(node.operand, here);
    return;
  }
  for (const kid of node.kids) collectFetch(kid, here, operands, planned, fetch);
}

/**
 * Whether `node` can be non-empty at one key, given which operands hold it: an `and` needs every child, an `or` any,
 * and an `andNot` its left child. Exact for the key, where {@link planKeys} is a bound over all of them.
 */
export function canHold(node: ExprNode, holds: (operand: number) => boolean): boolean {
  switch (node.kind) {
    case 'leaf':
      return holds(node.operand);
    case 'and':
      return node.kids.every((kid) => canHold(kid, holds));
    case 'or':
      return node.kids.some((kid) => canHold(kid, holds));
    case 'andNot':
      return canHold(node.kids[0]!, holds);
  }
}

/** A set of chunk keys as bits, for the keys an operand is fetched at across the outputs of a group. */
export class KeyBits {
  private readonly words = new Uint32Array(CHUNK_IDS / 32);
  private count = 0;

  add(keys: Uint16Array): void {
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i]!;
      const word = key >>> 5;
      const bit = 1 << (key & 31);
      if ((this.words[word]! & bit) === 0) {
        this.words[word] = this.words[word]! | bit;
        this.count++;
      }
    }
  }

  get size(): number {
    return this.count;
  }

  has(key: number): boolean {
    return (this.words[key >>> 5]! & (1 << (key & 31))) !== 0;
  }

  /** The keys, ascending. */
  toKeys(): number[] {
    const out: number[] = [];
    for (let w = 0; w < this.words.length; w++) {
      let bits = this.words[w]!;
      while (bits !== 0) {
        const low = bits & -bits;
        out.push((w << 5) | (31 - Math.clz32(low)));
        bits ^= low;
      }
    }
    return out;
  }
}
