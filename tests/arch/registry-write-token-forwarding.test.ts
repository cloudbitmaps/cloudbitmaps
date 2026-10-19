import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

/**
 * A registry wrapper or fake in the tests must keep the token order a publish relies on. A registry that reports write
 * tokens (`reportsWriteTokens`, which every registry here inherits through `Object.create`, a Proxy or a subclass)
 * calls the `onToken` of the options it is handed before it sends a write, and the publish reads a `TransientError`
 * that arrives before any report as a fault before sending, the registry's own read of the row: it throws it at once
 * and sends nothing more. So two shapes silently change what a test proves, and each has needed fixing twice:
 *
 *   - a wrapper that calls the inner `create` or `compareAndSwap` without its options argument, and raises a
 *     `TransientError` of its own, drops the report: the fault reads as one before sending and is never reconciled;
 *   - a fake that stands in for a write it says was sent, and throws a `TransientError` for it without calling
 *     `onToken` first, is read as one that was never sent, so the path the test was written for is never reached,
 *     while its assertions can still hold.
 *
 * So every `.ts` file under `tests/` is parsed, and each implementation of a registry's `create` or `compareAndSwap`
 * that names `TransientError` in its body is held to one of the ways of keeping the order:
 *
 *   WHAT IS AN IMPLEMENTATION   a function given as `create` or `compareAndSwap` in an object literal, a method of an
 *                               object literal or a class, a function assigned to `<x>.create` / `<x>.compareAndSwap`,
 *                               or one a Proxy's `get` trap returns for that property: under an `if` that compares the
 *                               property with the name, or after an `if (p !== name) return ...` in the same block.
 *   WHAT IT FORWARDS            a call in its body that hands its first parameter on: `<x>.create(...)`,
 *                               `<x>.compareAndSwap(...)`, `.apply`/`.call`, or a call of a variable (the original
 *                               function it saved), when that call is not a different method such as `get`.
 *   WHAT PASSES                 the body calls or names `onToken` (it reports for itself); or some forwarding call
 *                               carries the options (a spread, the options parameter itself, or an argument in the
 *                               options position), so the inner registry reports; or the nearest function or class
 *                               around it also names `reportsWriteTokens`: it declares what it reports, as a wrapper
 *                               that sets the flag to `false` does on purpose; or a comment on the function or the two
 *                               lines above it says `never sent`: a fake of a fault before the write was sent.
 *   WHAT FAILS                  every other implementation that names `TransientError`: a forwarder that drops the
 *                               options, and a fake that forwards nothing and reports no token.
 *
 * Known limits, because the check reads syntax and not types or behaviour. Not seen:
 *
 *   - a wrapper or fake that never names `TransientError` (one that only drops the options, or throws a fault it built
 *     elsewhere, such as `blip(...)` or a stored `refusal`): it changes what a publish infers only when a fault or a
 *     conflict follows, and the tree has many that forward only for a test of something else;
 *   - a wrapper that gets its method name from a variable (`hook(registry, 'compareAndSwap', cb)` and helpers like it
 *     build the wrapper from a name they are given), or builds the function elsewhere and assigns it;
 *   - a Proxy trap written as a `switch`, a ternary or a lookup table;
 *   - a fake that reports its token on one path and not on another, or after the throw it sent;
 *   - the order of the report against the send (`onToken` called after the inner write): the registry conformance
 *     suite holds a registry to that, and this gate holds only the tests' own doubles;
 *   - whether the two escapes are true: a `never sent` comment is taken at its word, so a fake that does send and
 *     carries it passes; and a mention of `reportsWriteTokens` anywhere in the nearest enclosing function or class
 *     passes every double inside it, which in a test is often a whole `it` callback. Use either only where it is
 *     true of the double it sits on.
 *
 * Known false positive: a forwarding call whose options reach the inner write only inside a closure, or under a name the
 * gate cannot connect to the parameter. Pass the options as an argument of the call, or add the words above.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export interface TokenDrop {
  readonly file: string;
  readonly line: number;
  readonly why: string;
}

type FunctionLike = ts.ArrowFunction | ts.FunctionExpression | ts.MethodDeclaration;
type Write = 'create' | 'compareAndSwap';

/** Where each write takes its options: `create(ref, record, options)`, `compareAndSwap(ref, token, patch, options)`. */
const OPTIONS_AT: Record<Write, number> = { create: 2, compareAndSwap: 3 };
const WRITES = new Set<string>(['create', 'compareAndSwap']);
const isWrite = (name: string | undefined): name is Write => name !== undefined && WRITES.has(name);

const nameOf = (name: ts.PropertyName | undefined): string | undefined =>
  name === undefined
    ? undefined
    : ts.isIdentifier(name) || ts.isStringLiteral(name)
      ? name.text
      : undefined;

const isFunctionLike = (node: ts.Node | undefined): node is FunctionLike =>
  node !== undefined &&
  (ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isMethodDeclaration(node));

/** `node` without the parentheses and `as`/`satisfies`/`!` casts around it. */
function unwrap(node: ts.Node | undefined): ts.Node | undefined {
  let n = node;
  while (
    n !== undefined &&
    (ts.isParenthesizedExpression(n) ||
      ts.isAsExpression(n) ||
      ts.isSatisfiesExpression(n) ||
      ts.isNonNullExpression(n))
  ) {
    n = n.expression;
  }
  return n;
}

interface Implementation {
  readonly fn: FunctionLike;
  readonly write: Write;
}

/** The string literals a condition compares a property with, as `p === 'create'`, `p !== 'compareAndSwap'`. */
function comparedWrites(test: ts.Expression, operator: ts.SyntaxKind): Write[] {
  const out: Write[] = [];
  const walk = (e: ts.Expression): void => {
    if (ts.isParenthesizedExpression(e)) return walk(e.expression);
    if (!ts.isBinaryExpression(e)) return;
    if (
      e.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
      e.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
    ) {
      walk(e.left);
      walk(e.right);
      return;
    }
    if (e.operatorToken.kind !== operator) return;
    for (const side of [e.left, e.right]) {
      if (ts.isStringLiteral(side) && isWrite(side.text)) out.push(side.text);
    }
  };
  walk(test);
  return out;
}

/** The function a `return` statement (or a block that holds one) hands back, if it is one. */
function returnedFunction(statement: ts.Statement | undefined): FunctionLike | undefined {
  const ret = ts.isReturnStatement(statement as ts.Node)
    ? (statement as ts.ReturnStatement)
    : statement !== undefined && ts.isBlock(statement)
      ? statement.statements.find(ts.isReturnStatement)
      : undefined;
  const e = unwrap(ret?.expression);
  return isFunctionLike(e) ? e : undefined;
}

/** Each registry write implementation in `source`. */
function implementations(source: ts.SourceFile): Implementation[] {
  const out: Implementation[] = [];
  const walk = (node: ts.Node): void => {
    if (ts.isObjectLiteralExpression(node)) {
      for (const p of node.properties) {
        const name =
          ts.isPropertyAssignment(p) || ts.isMethodDeclaration(p) ? nameOf(p.name) : undefined;
        if (!isWrite(name)) continue;
        const f = ts.isPropertyAssignment(p) ? unwrap(p.initializer) : p;
        if (isFunctionLike(f)) out.push({ fn: f, write: name });
      }
    }
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      for (const m of node.members) {
        const name = ts.isMethodDeclaration(m) ? nameOf(m.name) : undefined;
        if (ts.isMethodDeclaration(m) && isWrite(name)) out.push({ fn: m, write: name });
      }
    }
    // `x.compareAndSwap = (…) => …`
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(node.left) &&
      isWrite(node.left.name.text)
    ) {
      const f = unwrap(node.right);
      if (isFunctionLike(f)) out.push({ fn: f, write: node.left.name.text });
    }
    // A Proxy trap: `if (p === 'create') return fn`, and `if (p !== 'create') return …;` then `return fn`.
    if (ts.isIfStatement(node)) {
      for (const w of comparedWrites(node.expression, ts.SyntaxKind.EqualsEqualsEqualsToken)) {
        const f = returnedFunction(node.thenStatement);
        if (f !== undefined) out.push({ fn: f, write: w });
      }
    }
    if (ts.isBlock(node)) {
      node.statements.forEach((statement, i) => {
        if (!ts.isIfStatement(statement)) return;
        const names = comparedWrites(
          statement.expression,
          ts.SyntaxKind.ExclamationEqualsEqualsToken,
        );
        if (names.length === 0) return;
        const next = node.statements.slice(i + 1).find(ts.isReturnStatement);
        const f = unwrap(next?.expression);
        // Compared against both writes, the shared trap takes the options position of the later one.
        if (isFunctionLike(f)) out.push({ fn: f, write: names[names.length - 1]! });
      });
    }
    ts.forEachChild(node, walk);
  };
  walk(source);
  // A function reached twice (an `if` and the block around it) counts once.
  return out.filter((a, i) => out.findIndex((b) => b.fn === a.fn) === i);
}

/** Whether `fn`'s body, apart from nested copies of other implementations, mentions an identifier or property `name`. */
function mentions(node: ts.Node, name: string): boolean {
  let found = false;
  const walk = (n: ts.Node): void => {
    if (found) return;
    if ((ts.isIdentifier(n) || ts.isPrivateIdentifier(n)) && n.text === name) found = true;
    else ts.forEachChild(n, walk);
  };
  walk(node);
  return found;
}

/** The calls in `fn` that hand its first parameter, or its rest parameter, on to another write. */
function forwardingCalls(fn: FunctionLike): ts.CallExpression[] {
  const first = fn.parameters[0];
  const rest = fn.parameters.find((p) => p.dotDotDotToken !== undefined);
  const names = new Set<string>();
  if (first !== undefined && ts.isIdentifier(first.name)) names.add(first.name.text);
  if (rest !== undefined && ts.isIdentifier(rest.name)) names.add(rest.name.text);
  const out: ts.CallExpression[] = [];
  const walk = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) {
      const callee = unwrap(n.expression);
      const method =
        callee !== undefined && ts.isPropertyAccessExpression(callee)
          ? callee.name.text
          : undefined;
      const handsOn = n.arguments.some((a) => {
        const e = ts.isSpreadElement(a) ? a.expression : a;
        return ts.isIdentifier(e) && names.has(e.text);
      });
      // A property call counts as the write itself, or as `apply`/`call`; any other method (`get`, `delete`) does not.
      const isForward =
        method === undefined
          ? callee !== undefined
          : isWrite(method) || method === 'apply' || method === 'call';
      if (handsOn && isForward) out.push(n);
    }
    ts.forEachChild(n, walk);
  };
  if (fn.body !== undefined) walk(fn.body);
  return out;
}

/** Whether one forwarding call carries the options the implementation was handed. */
function carriesOptions(call: ts.CallExpression, fn: FunctionLike, write: Write): boolean {
  const at = OPTIONS_AT[write];
  const callee = unwrap(call.expression);
  const method =
    callee !== undefined && ts.isPropertyAccessExpression(callee) ? callee.name.text : undefined;
  // `fn.apply(target, args)` and `Reflect.apply(fn, target, args)` hand a whole argument list on.
  if (method === 'apply' || method === 'call') return true;
  if (call.arguments.some(ts.isSpreadElement)) return true;
  const named = fn.parameters[at];
  const optionsName =
    named !== undefined && ts.isIdentifier(named.name) ? named.name.text : undefined;
  if (
    optionsName !== undefined &&
    call.arguments.some((a) => ts.isIdentifier(a) && a.text === optionsName)
  ) {
    return true;
  }
  const slot = call.arguments[at];
  return slot !== undefined && !(ts.isIdentifier(slot) && slot.text === 'undefined');
}

/** The nearest function or class around `fn`, which is where the exemption words are looked for. */
function enclosing(fn: ts.Node): ts.Node {
  for (let up = fn.parent as ts.Node | undefined; up !== undefined; up = up.parent) {
    if (
      isFunctionLike(up) ||
      ts.isFunctionDeclaration(up) ||
      ts.isClassDeclaration(up) ||
      ts.isClassExpression(up)
    ) {
      return up;
    }
  }
  return fn.getSourceFile();
}

/** Whether a comment on or just above the function's lines says it models a write that was never sent. */
function saysNeverSent(source: ts.SourceFile, fn: FunctionLike): boolean {
  const start = source.getLineAndCharacterOfPosition(fn.getStart(source)).line;
  const end = source.getLineAndCharacterOfPosition(fn.getEnd()).line;
  const lines = source.text.split('\n');
  const from = Math.max(0, start - 2);
  return lines.slice(from, end + 1).some((l) => /\/\/.*never sent|\/\*.*never sent/i.test(l));
}

/** The registry write doubles in one file's text that drop the token order. */
export function tokenDrops(file: string, text: string): TokenDrop[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const out: TokenDrop[] = [];
  for (const { fn, write } of implementations(source)) {
    if (mentions(fn, 'onToken')) continue;
    if (mentions(enclosing(fn), 'reportsWriteTokens')) continue;
    // Only a double that can raise a transient fault changes what a publish infers from the order of the report.
    if (!mentions(fn, 'TransientError')) continue;
    const line = source.getLineAndCharacterOfPosition(fn.getStart(source)).line + 1;
    const calls = forwardingCalls(fn);
    if (calls.length > 0) {
      if (!calls.some((c) => carriesOptions(c, fn, write))) {
        out.push({
          file,
          line,
          why: `${write} forwards without its options and raises a TransientError`,
        });
      }
    } else if (!saysNeverSent(source, fn)) {
      out.push({
        file,
        line,
        why: `${write} raises a TransientError without reporting a token first`,
      });
    }
  }
  return out;
}

/** Every `.ts` file under `tests/`, relative to the root. */
function scannedFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.ts')) out.push(relative(ROOT, path));
    }
  };
  walk(join(ROOT, 'tests'));
  return out;
}

// Parsing every test file takes seconds, and longer when other whole-repo scans run beside it.
const LIMIT = { timeout: 30_000 };

describe('a registry double in the tests keeps the token order', () => {
  it(
    'no create or compareAndSwap double drops its options or fakes a sent write without a token',
    LIMIT,
    () => {
      const files = scannedFiles();
      expect(files).toContain('tests/helpers/unanswered-registry.ts');
      const found = files.flatMap((file) =>
        tokenDrops(file, readFileSync(join(ROOT, file), 'utf8')).map(
          (d) => `${d.file}:${d.line} ${d.why}`,
        ),
      );
      expect(found).toEqual([]);
    },
  );

  // The detector, both ways, on planted inputs: each shape it is written for fails, and each look-alike passes.
  const flagged = (text: string): number => tokenDrops('planted.ts', text).length;

  it.each([
    [
      'a Proxy trap that fakes a sent write and reports no token (the old slow fake)',
      `const slow = new Proxy(reg, { get(t, p, rx) { const v = Reflect.get(t, p, rx); if (p !== 'compareAndSwap') return v; return (...args) => { late = args; return Promise.reject(new TransientError('timed out')); }; } });`,
    ],
    [
      'an assigned fake that throws without a token',
      `reg.compareAndSwap = async (ref, expected, patch, opts) => { throw new TransientError('timed out'); };`,
    ],
    [
      'a wrapper that lands the write without its options, then throws',
      `reg.compareAndSwap = async (ref, expected, patch) => { await inner.compareAndSwap(ref, expected, patch); throw new TransientError('lost'); };`,
    ],
    [
      'a create wrapper that takes the options and forwards two arguments',
      `const g = { create: async (ref, record, options) => { const r = await inner.create(ref, record); throw new TransientError('lost'); } };`,
    ],
    [
      'a class method that drops the options',
      `class W extends MemoryRegistryDriver { override async compareAndSwap(ref, token, patch) { await super.compareAndSwap(ref, token, patch); throw new TransientError('x'); } }`,
    ],
  ])('fails on %s', (_, text) => {
    expect(flagged(text)).toBe(1);
  });

  it.each([
    [
      'a known limit: a step that throws without a token on one path, beside a path that forwards the options',
      `const out = {}; out.compareAndSwap = async (ref, expected, patch, opts) => { if (step === 'land-then-throw') await registry.compareAndSwap(ref, expected, patch, opts); await between(); throw new TransientError('timed out'); };`,
    ],
    [
      'a fake that reports its token before it throws',
      `reg.compareAndSwap = async (ref, expected, patch, opts) => { opts?.onToken?.('unapplied.0.0'); throw new TransientError('timed out'); };`,
    ],
    [
      'a wrapper that forwards its options, then throws',
      `reg.compareAndSwap = async (ref, expected, patch, opts) => { await inner.compareAndSwap(ref, expected, patch, opts); throw new TransientError('lost'); };`,
    ],
    [
      'a Proxy trap that forwards every argument',
      `const p = new Proxy(reg, { get(t, p, rx) { if (p === 'create') return async (...a) => { await t.create(...a); throw new TransientError('x'); }; return Reflect.get(t, p, rx); } });`,
    ],
    [
      'a trap that applies the saved function to its arguments',
      `const p = new Proxy(reg, { get(t, p, rx) { const v = Reflect.get(t, p, rx); if (p !== 'compareAndSwap') return v; return async (...args) => { await v.apply(t, args); throw new TransientError('x'); }; } });`,
    ],
    [
      'a wrapper that drops the options and sets the flag false in the same function',
      `function tokenless() { const w = Object.create(reg); w.reportsWriteTokens = false; w.compareAndSwap = async (ref, e, patch) => { await reg.compareAndSwap(ref, e, patch); throw new TransientError('x'); }; return w; }`,
    ],
    [
      'a fake of a fault before the write was sent, said so in a comment',
      `// the registry's own read faulted: the write was never sent\nreg.compareAndSwap = async () => { throw new TransientError('EMFILE'); };`,
    ],
    [
      'a wrapper that drops the options and never raises a transient fault',
      `reg.compareAndSwap = async (ref, e, patch) => inner.compareAndSwap(ref, e, patch);`,
    ],
    [
      'a fake that throws a different fault',
      `reg.compareAndSwap = async () => { throw new ValidationError('refused'); };`,
    ],
    [
      'a get that mentions TransientError (not a write)',
      `reg.get = async () => { throw new TransientError('x'); };`,
    ],
    [
      'a different method forwarded with the first parameter (not a write forward)',
      `reg.compareAndSwap = async (ref, e, patch, opts) => { await inner.get(ref); opts?.onToken?.('t'); throw new TransientError('x'); };`,
    ],
  ])('passes %s', (_, text) => {
    expect(flagged(text)).toBe(0);
  });
});
