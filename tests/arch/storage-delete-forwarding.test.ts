import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

/**
 * A storage driver that wraps another must hand `delete` its options on: `delete(key, { ifVersion })` is what keeps
 * a delete decided from one read from removing an object stored under the number since, and a wrapper that takes or
 * forwards only the key turns it back into a delete of whatever is there, silently, while it still reports the inner
 * driver's `conditionalDelete`. That happened twice: the store's own budget wrapper for `eraseSubject` dropped the
 * options, and so did some forty test wrappers, which left the conditional path unexercised wherever they stood.
 *
 * So every `.ts` file under `tests/` and `packages/<package>/src/` is parsed, and each implementation of a storage
 * driver's `delete` that forwards to another `delete` is held to forwarding the options:
 *
 *   WHAT IS AN IMPLEMENTATION   a function given as `delete` in an object literal, a `delete` method of an object
 *                               literal or a class, a function assigned to `<x>.delete`, or one a Proxy's `get` trap
 *                               returns for the property `'delete'`: under `if (p === 'delete')`, or after an
 *                               `if (p !== 'delete') return …` in the same block.
 *   WHAT MAKES IT A STORAGE ONE  its object literal or class also has `getTail`, `putImmutable` or `getRange`, or the
 *                               literal is typed as a `...StorageDriver` where it is written (a variable's annotation,
 *                               `as`, `satisfies`, or the declared return type of the function that returns it), or a
 *                               class says it implements one; for an assignment, the variable's declaration names a
 *                               `...Storage...` type; for a Proxy trap, the Proxy is cast to one, or proxies something
 *                               named like a storage driver.
 *   WHAT IT FORWARDS            a call of `<something>.delete(...)` whose first argument is the implementation's own
 *                               first parameter. One with no such call implements the delete itself (a fake, the
 *                               memory and local-filesystem drivers), and is not a wrapper.
 *   WHAT FAILS                  a wrapper that declares fewer than two parameters, or forwards fewer than two
 *                               arguments; a rest parameter (`...args`) or a spread argument passes.
 *
 * It checks `delete` alone. Whether a wrapper hands on the `version` a tail read reports, the other half of a wrapper's
 * obligation, is not checked here.
 *
 * Known limits, because the check reads syntax and not types. Not seen:
 *
 *   - a wrapper built by a helper that returns its `delete` from elsewhere, or that forwards through a variable it
 *     renamed the key to;
 *   - an object literal that is a storage driver but neither has one of the three reads beside its `delete` nor is
 *     typed as a storage driver where it is written, such as one built only by a spread and passed straight on;
 *   - a Proxy trap written as a `switch` or a ternary, and one over a target that is not named like a storage driver,
 *     typed only on the variable the Proxy is assigned to;
 *   - `Object.assign(Object.create(inner), { delete })`, whose literal has no storage read and no storage type.
 *
 * Known false positive: a fake driver whose own `delete` calls `this.live.delete(key)` on a `Set` or a `Map`, beside a
 * storage read, reads as a wrapper that forwards only the key; rename the argument, as the store's own drivers do. A
 * registry wrapper, whose `delete(ref, expected)` the same shape describes, is checked only when it sits beside a
 * storage read or is typed as a storage driver. A wrapper that means to drop the version must report
 * `conditionalDelete: false` instead, and no wrapper here does, so the gate has no exemption for one.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export interface DroppedCondition {
  readonly file: string;
  readonly line: number;
  readonly why: string;
}

type FunctionLike = ts.ArrowFunction | ts.FunctionExpression | ts.MethodDeclaration;

const STORAGE_READS = new Set(['getTail', 'putImmutable', 'getRange']);

const nameOf = (name: ts.PropertyName | undefined): string | undefined =>
  name === undefined
    ? undefined
    : ts.isIdentifier(name) || ts.isStringLiteral(name)
      ? name.text
      : undefined;

const isFunctionLike = (node: ts.Node | undefined): node is FunctionLike =>
  node !== undefined &&
  (ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isMethodDeclaration(node));

/** Whether an object literal or a class has a member named like one of a storage driver's reads. */
function hasStorageRead(members: readonly ts.Node[]): boolean {
  return members.some((m) => {
    const name =
      ts.isPropertyAssignment(m) || ts.isMethodDeclaration(m) || ts.isPropertyDeclaration(m)
        ? nameOf(m.name)
        : ts.isShorthandPropertyAssignment(m)
          ? m.name.text
          : undefined;
    return name !== undefined && STORAGE_READS.has(name);
  });
}

/** The declaration of `name` in `source`, as written, or `undefined`. */
function declarationText(source: ts.SourceFile, name: string): string | undefined {
  let found: string | undefined;
  const walk = (node: ts.Node): void => {
    if (found !== undefined) return;
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) {
      found = node.getText(source);
      return;
    }
    if (ts.isParameter(node) && ts.isIdentifier(node.name) && node.name.text === name) {
      found = node.getText(source);
      return;
    }
    ts.forEachChild(node, walk);
  };
  walk(source);
  return found;
}

/** A type written in the source that names a storage driver: `IStorageDriver`, `MemoryStorageDriver`, and the rest. */
const STORAGE_TYPE = /StorageDriver\b/;

/**
 * Whether an object literal is typed as a storage driver where it is written: the variable it initialises is annotated
 * with one, it is cast to one with `as` or checked with `satisfies` (through any parentheses and further casts), or it
 * is what an arrow function or a function that declares a storage-driver return type returns.
 */
function typedAsStorage(source: ts.SourceFile, literal: ts.ObjectLiteralExpression): boolean {
  let node: ts.Node = literal;
  for (;;) {
    const parent: ts.Node = node.parent;
    if (ts.isParenthesizedExpression(parent)) {
      node = parent;
      continue;
    }
    if (ts.isAsExpression(parent) || ts.isSatisfiesExpression(parent)) {
      if (STORAGE_TYPE.test(parent.type.getText(source))) return true;
      node = parent;
      continue;
    }
    if (ts.isVariableDeclaration(parent)) {
      return parent.type !== undefined && STORAGE_TYPE.test(parent.type.getText(source));
    }
    if (ts.isArrowFunction(parent)) {
      return parent.type !== undefined && STORAGE_TYPE.test(parent.type.getText(source));
    }
    if (ts.isReturnStatement(parent)) {
      for (let up: ts.Node | undefined = parent.parent; up !== undefined; up = up.parent) {
        if (
          ts.isArrowFunction(up) ||
          ts.isFunctionExpression(up) ||
          ts.isFunctionDeclaration(up) ||
          ts.isMethodDeclaration(up)
        ) {
          return up.type !== undefined && STORAGE_TYPE.test(up.type.getText(source));
        }
      }
    }
    return false;
  }
}

/** Whether the Proxy expression a `get` trap belongs to wraps a storage driver. */
function proxiesStorage(source: ts.SourceFile, trap: ts.Node): boolean {
  for (let node: ts.Node | undefined = trap; node !== undefined; node = node.parent) {
    if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'Proxy'
    ) {
      const cast = ts.isAsExpression(node.parent) ? node.parent.type.getText(source) : '';
      const target = node.arguments?.[0]?.getText(source) ?? '';
      return /Storage/.test(cast) || /storage|driver/i.test(target);
    }
  }
  return false;
}

/** Each storage `delete` implementation in `source`, with the node it hangs off for the storage test. */
function storageDeletes(source: ts.SourceFile): FunctionLike[] {
  const out: FunctionLike[] = [];
  const walk = (node: ts.Node): void => {
    // `{ delete: (k) => … }` and `{ delete(k) { … } }` beside a storage read, or in a literal typed as a storage driver.
    if (
      ts.isObjectLiteralExpression(node) &&
      (hasStorageRead(node.properties) || typedAsStorage(source, node))
    ) {
      for (const p of node.properties) {
        if (
          ts.isPropertyAssignment(p) &&
          nameOf(p.name) === 'delete' &&
          isFunctionLike(p.initializer)
        )
          out.push(p.initializer);
        if (ts.isMethodDeclaration(p) && nameOf(p.name) === 'delete') out.push(p);
      }
    }
    // A class with a storage read, or one that says it implements a storage driver.
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      const implementsStorage = (node.heritageClauses ?? []).some((h) =>
        /StorageDriver/.test(h.getText(source)),
      );
      if (implementsStorage || hasStorageRead(node.members)) {
        for (const m of node.members) {
          if (ts.isMethodDeclaration(m) && nameOf(m.name) === 'delete') out.push(m);
        }
      }
    }
    // `x.delete = (k) => …`, where `x` is declared as a storage driver.
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(node.left) &&
      node.left.name.text === 'delete' &&
      isFunctionLike(node.right)
    ) {
      const target = node.left.expression;
      const declared = ts.isIdentifier(target) ? declarationText(source, target.text) : undefined;
      if (declared !== undefined && /Storage/.test(declared)) out.push(node.right);
    }
    // A Proxy `get` trap that answers `'delete'` with a function of its own: `if (p === 'delete') return fn`, or
    // `if (p !== 'delete') return …;` followed in the same block by `return fn`.
    const comparesDelete = (
      test: ts.Expression,
      operator: ts.SyntaxKind,
    ): test is ts.BinaryExpression =>
      ts.isBinaryExpression(test) &&
      test.operatorToken.kind === operator &&
      [test.left, test.right].some((side) => ts.isStringLiteral(side) && side.text === 'delete');
    if (
      ts.isIfStatement(node) &&
      comparesDelete(node.expression, ts.SyntaxKind.EqualsEqualsEqualsToken)
    ) {
      const answer = ts.isReturnStatement(node.thenStatement)
        ? node.thenStatement.expression
        : ts.isBlock(node.thenStatement)
          ? node.thenStatement.statements.find(ts.isReturnStatement)?.expression
          : undefined;
      if (isFunctionLike(answer) && proxiesStorage(source, node)) out.push(answer);
    }
    if (ts.isBlock(node)) {
      node.statements.forEach((statement, i) => {
        if (
          !ts.isIfStatement(statement) ||
          !comparesDelete(statement.expression, ts.SyntaxKind.ExclamationEqualsEqualsToken)
        )
          return;
        const next = node.statements.slice(i + 1).find(ts.isReturnStatement)?.expression;
        if (isFunctionLike(next) && proxiesStorage(source, statement)) out.push(next);
      });
    }
    ts.forEachChild(node, walk);
  };
  walk(source);
  return out;
}

/** The `.delete(…)` calls in `fn` that hand on its first parameter: what makes it a wrapper. */
function forwardingCalls(fn: FunctionLike): ts.CallExpression[] {
  const first = fn.parameters[0];
  if (first === undefined || !ts.isIdentifier(first.name)) return [];
  const key = first.name.text;
  const calls: ts.CallExpression[] = [];
  const walk = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'delete' &&
      node.arguments[0] !== undefined &&
      ts.isIdentifier(node.arguments[0]) &&
      node.arguments[0].text === key
    ) {
      calls.push(node);
    }
    ts.forEachChild(node, walk);
  };
  if (fn.body !== undefined) walk(fn.body);
  return calls;
}

/** The storage `delete` wrappers in one file's text that take or forward only the key. */
export function droppedConditions(file: string, text: string): DroppedCondition[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const out: DroppedCondition[] = [];
  for (const fn of storageDeletes(source)) {
    if (fn.parameters.some((p) => p.dotDotDotToken !== undefined)) continue;
    const calls = forwardingCalls(fn);
    if (calls.length === 0) continue; // implements its own delete: not a wrapper
    const line = source.getLineAndCharacterOfPosition(fn.getStart(source)).line + 1;
    if (fn.parameters.length < 2) {
      out.push({ file, line, why: 'takes only the key, so it cannot hand on `ifVersion`' });
      continue;
    }
    for (const call of calls) {
      const spread = call.arguments.some(ts.isSpreadElement);
      if (!spread && call.arguments.length < 2) {
        const at = source.getLineAndCharacterOfPosition(call.getStart(source)).line + 1;
        out.push({ file, line: at, why: 'forwards only the key, dropping `ifVersion`' });
      }
    }
  }
  return out;
}

/** Every `.ts` file under `tests/` and each package's `src/`, relative to the root. */
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
  for (const pkg of readdirSync(join(ROOT, 'packages'), { withFileTypes: true })) {
    if (pkg.isDirectory()) walk(join(ROOT, 'packages', pkg.name, 'src'));
  }
  return out;
}

describe('a storage driver that wraps another hands delete its options on', () => {
  it('no storage delete wrapper in tests/ or packages/*/src takes or forwards only the key', () => {
    const files = scannedFiles();
    expect(files).toContain('packages/roaring/src/open-charging-storage.ts');
    const found = files.flatMap((file) =>
      droppedConditions(file, readFileSync(join(ROOT, file), 'utf8')).map(
        (d) => `${d.file}:${d.line} ${d.why}`,
      ),
    );
    expect(found).toEqual([]);
  });

  // The detector, both ways, on planted inputs: each dropping shape it is written for fails, and each look-alike passes.
  const flagged = (text: string): number => droppedConditions('planted.ts', text).length;

  it.each([
    [
      'an object literal arrow',
      `const s = { getTail: (k, n) => b.getTail(k, n), delete: (k) => b.delete(k) };`,
    ],
    [
      'an async arrow that forwards in a block',
      `const s = { putImmutable: p, delete: async (k) => { await gate; return b.delete(k); } };`,
    ],
    ['two parameters, one forwarded', `const s = { getRange: r, delete: (k, o) => b.delete(k) };`],
    ['a method of a literal', `const s = { getTail: t, delete(k) { return b.delete(k); } };`],
    [
      'a method of a class that implements a storage driver',
      `class W implements IStorageDriver { delete(key: GenKey): Promise<void> { return this.inner.delete(key); } }`,
    ],
    [
      'an assignment to a storage driver made with Object.create',
      `const d = Object.create(storage) as MemoryStorageDriver; d.delete = async (k) => storage.delete(k);`,
    ],
    [
      'a literal typed as a storage driver that gets its reads by spread',
      `const racing: IStorageDriver = { ...denied, delete: async (k) => { await w.storage.delete(k); } };`,
    ],
    [
      'a literal cast to a storage driver',
      `const s = { ...base, delete: (k) => base.delete(k) } as unknown as MemoryStorageDriver;`,
    ],
    [
      'a literal checked with satisfies',
      `const s = { ...base, delete: (k) => base.delete(k) } satisfies IStorageDriver;`,
    ],
    [
      'a literal an arrow with a storage return type returns',
      `const wrap = (b: IStorageDriver): IStorageDriver => ({ ...b, delete: (k) => b.delete(k) });`,
    ],
    [
      'a Proxy trap',
      `const d = new Proxy(storage, { get(t, p) { if (p === 'delete') return (k) => t.delete(k); return t[p]; } }) as IStorageDriver;`,
    ],
    [
      'a Proxy trap that answers every other property first',
      `const d = new Proxy(racing, { get(t, p, r) { if (p !== 'delete') return Reflect.get(t, p, r); return async (key) => storage.delete(key); } }) as IStorageDriver;`,
    ],
  ])('fails on %s', (_, text) => {
    expect(flagged(text)).toBe(1);
  });

  it.each([
    [
      'a wrapper that forwards the options',
      `const s = { getTail: t, delete: (k, o) => b.delete(k, o) };`,
    ],
    [
      'a method that forwards the options',
      `class W implements IStorageDriver { delete(key, options) { return this.inner.delete(key, options); } }`,
    ],
    ['a rest parameter', `const s = { getTail: t, delete: (...args) => b.delete(...args) };`],
    [
      'a Proxy trap that answers every other property first, and forwards the options',
      `const d = new Proxy(racing, { get(t, p, r) { if (p !== 'delete') return Reflect.get(t, p, r); return async (key, options) => storage.delete(key, options); } }) as IStorageDriver;`,
    ],
    [
      'a Proxy that hands every argument on',
      `const d = new Proxy(storage, { get(t, p) { if (p === 'delete') return (...a) => t.delete(...a); return t[p]; } }) as IStorageDriver;`,
    ],
    [
      'a driver that implements its own delete (the memory driver)',
      `class M implements IStorageDriver { async delete(key, options) { const k = genObjectKey(key); this.objects.delete(k); } }`,
    ],
    [
      'a driver that implements its own delete and takes no options (the local-filesystem driver)',
      `class L implements IStorageDriver { async delete(key: GenKey): Promise<void> { const path = p(key); await unlink(path); } }`,
    ],
    [
      'a literal typed as a storage driver that forwards the options',
      `const racing: IStorageDriver = { ...denied, delete: async (k, o) => { await w.storage.delete(k, o); } };`,
    ],
    [
      'a literal typed as a registry',
      `const r: IRegistryDriver = { ...reg, delete: (ref) => reg.delete(ref) };`,
    ],
    [
      'a registry wrapper, which is not beside a storage read',
      `const r = { get: (ref) => reg.get(ref), delete: (ref) => reg.delete(ref) };`,
    ],
    ['a Map wrapper', `const cache = { get: (k) => m.get(k), delete: (k) => m.delete(k) };`],
    [
      'an assignment to a registry made with Object.create',
      `const g = Object.create(registry) as IRegistryDriver; g.delete = async (ref) => registry.delete(ref);`,
    ],
  ])('passes %s', (_, text) => {
    expect(flagged(text)).toBe(0);
  });
});
