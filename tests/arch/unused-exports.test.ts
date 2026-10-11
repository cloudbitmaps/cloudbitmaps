import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

/*
 * Architectural lint, part 3: no module under packages/core/src exports a name that nothing else imports.
 *
 * An `export` is a promise to a reader that something else uses the name. One that nothing uses widens what a
 * reader must understand and what a refactor must keep, and the lint config has no unused-exports rule to catch
 * it. The package entry points (the files `exports` and `bin` in each manifest name) are the public surface and
 * are not checked: whether a name belongs there is the api-surface gate's question. Every other file's exports are
 * checked, and a name is used when any file under packages/*\/src or tests/ imports it, re-exports it, names
 * it in an `import('…')` type, or reads it off a namespace import.
 *
 * What it reads, and what it does not. It matches by NAME, not by resolved file, so a name imported from one module
 * counts as used for a same-named export in another: that can hide an unused export, never invent one. It does not
 * see a name used only through a dynamic key (`ns[name]`), or a use inside a string or a comment. A name that is
 * used only inside its own file loses its `export` (or is deleted when nothing uses it at all).
 *
 * Known blind spots. Each makes the gate flag an export that is in use, so it fails loudly rather than passing
 * quietly: a dynamic `import()` (destructured or read by member), `vi.importActual`, the keys of a `vi.mock`
 * factory, `export * from`, `typeof ns.X` in a type position, destructuring a namespace (`const { A } = ns`),
 * `export { A as default }` read through a default import, and `import x = require()`. An unused overloaded
 * function is reported once per signature. A name flagged for one of these is read by a shape the gate cannot
 * follow: import it by name, or rename the collision, rather than loosening the detector.
 *
 * The detector is a pure function so the test can plant a violation and watch it fire, and plant the look-alikes
 * that must not: a gate that fires on everything teaches people to route around it.
 */
const ROOT = path.resolve(__dirname, '..', '..');
const CORE_DIR = `packages${path.sep}core${path.sep}src${path.sep}`;

export interface Source {
  readonly path: string;
  readonly text: string;
}

/** The names a file exports under its own declarations, which a re-export `export { a } from` is not. */
function exportedNames(sf: ts.SourceFile): string[] {
  const names: string[] = [];
  for (const stmt of sf.statements) {
    if (ts.isExportDeclaration(stmt)) {
      if (
        stmt.moduleSpecifier === undefined &&
        stmt.exportClause !== undefined &&
        ts.isNamedExports(stmt.exportClause)
      ) {
        for (const el of stmt.exportClause.elements) names.push(el.name.text);
      }
      continue;
    }
    const mods = ts.canHaveModifiers(stmt) ? ts.getModifiers(stmt) : undefined;
    if (!mods?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) continue;
    if (mods.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)) continue;
    if (ts.isVariableStatement(stmt)) {
      for (const d of stmt.declarationList.declarations)
        if (ts.isIdentifier(d.name)) names.push(d.name.text);
    } else if (
      (ts.isFunctionDeclaration(stmt) ||
        ts.isClassDeclaration(stmt) ||
        ts.isInterfaceDeclaration(stmt) ||
        ts.isTypeAliasDeclaration(stmt) ||
        ts.isEnumDeclaration(stmt)) &&
      stmt.name !== undefined
    ) {
      names.push(stmt.name.text);
    }
  }
  return names;
}

/** Every name a file takes from another module: imports, re-exports, `import('…').X` types, `ns.X` reads. */
function usedNames(sf: ts.SourceFile): Set<string> {
  const used = new Set<string>();
  const namespaces = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && node.importClause?.namedBindings !== undefined) {
      const nb = node.importClause.namedBindings;
      if (ts.isNamedImports(nb))
        for (const el of nb.elements) used.add((el.propertyName ?? el.name).text);
      else namespaces.add(nb.name.text);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined) {
      const clause = node.exportClause;
      if (clause !== undefined && ts.isNamedExports(clause)) {
        for (const el of clause.elements) used.add((el.propertyName ?? el.name).text);
      } else if (clause !== undefined && ts.isNamespaceExport(clause)) {
        // `export * as ns from`: reads go through the new namespace, which this file's importers name.
      }
    } else if (ts.isImportTypeNode(node) && node.qualifier !== undefined) {
      let q: ts.EntityName = node.qualifier;
      while (ts.isQualifiedName(q)) q = q.left;
      used.add(q.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  if (namespaces.size > 0) {
    const reads = (node: ts.Node): void => {
      if (
        ts.isPropertyAccessExpression(node) &&
        ts.isIdentifier(node.expression) &&
        namespaces.has(node.expression.text)
      ) {
        used.add(node.name.text);
      } else if (
        ts.isTypeReferenceNode(node) &&
        ts.isQualifiedName(node.typeName) &&
        ts.isIdentifier(node.typeName.left) &&
        namespaces.has(node.typeName.left.text)
      ) {
        used.add(node.typeName.right.text);
      }
      ts.forEachChild(node, reads);
    };
    reads(sf);
  }
  return used;
}

/**
 * The exports of `checked` that no other file in `all` takes: `file: name` for each. `entries` are the files whose
 * exports are the public surface; they are read for what they take and never reported.
 */
export function unusedExports(
  all: readonly Source[],
  entries: ReadonlySet<string>,
  checked: (file: string) => boolean = () => true,
): string[] {
  const parsed = all.map((s) => ({
    path: s.path,
    sf: ts.createSourceFile(s.path, s.text, ts.ScriptTarget.ES2022, true),
  }));
  const usedBy = new Map<string, Set<string>>();
  for (const { path: p, sf } of parsed) usedBy.set(p, usedNames(sf));
  const out: string[] = [];
  for (const { path: p, sf } of parsed) {
    if (entries.has(p) || !checked(p)) continue;
    for (const name of exportedNames(sf)) {
      const used = [...usedBy].some(([other, names]) => other !== p && names.has(name));
      if (!used) out.push(`${p}: ${name}`);
    }
  }
  return out.sort();
}

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue;
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith('.ts') && !p.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

/** The source file behind each `dist/…` path a manifest's `exports` and `bin` name. */
function entryFiles(): Set<string> {
  const out = new Set<string>();
  for (const e of readdirSync(path.join(ROOT, 'packages'), { withFileTypes: true })) {
    const manifest = path.join(ROOT, 'packages', e.name, 'package.json');
    if (!e.isDirectory() || !existsSync(manifest)) continue;
    const text = readFileSync(manifest, 'utf8');
    for (const m of text.matchAll(/"\.\/dist\/([^"]+?)\.(?:d\.ts|js)"/g)) {
      out.add(path.join(ROOT, 'packages', e.name, 'src', `${m[1]}.ts`));
    }
  }
  return out;
}

// Parsing every source and test file takes seconds, and longer when other whole-repo scans run beside it.
const LIMIT = { timeout: 30_000 };

describe('no export of packages/core/src goes unused', () => {
  it('every checked export is imported by another file', LIMIT, () => {
    const packages = readdirSync(path.join(ROOT, 'packages'), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => path.join(ROOT, 'packages', e.name, 'src'));
    const files = [...packages.flatMap(walk), ...walk(path.join(ROOT, 'tests'))];
    const all = files.map((p) => ({ path: path.relative(ROOT, p), text: readFileSync(p, 'utf8') }));
    const entries = entryFiles();
    expect([...entries].filter((p) => !existsSync(p))).toEqual([]);
    const entryPaths = new Set([...entries].map((p) => path.relative(ROOT, p)));
    // A missing directory or an empty match would pass with nothing checked. Core has about 76 source files, so a
    // floor of 50 fails a rename or a wrong prefix while leaving room for files to be merged.
    expect(existsSync(path.join(ROOT, CORE_DIR))).toBe(true);
    expect(all.filter((f) => f.path.startsWith(CORE_DIR)).length).toBeGreaterThan(50);
    expect(unusedExports(all, entryPaths, (file) => file.startsWith(CORE_DIR))).toEqual([]);
  });
});

describe('the unused-exports detector fires on a planted unused export and spares the look-alikes', () => {
  const lib = (text: string): Source => ({ path: '/lib.ts', text });
  const use = (text: string): Source => ({ path: '/use.ts', text });
  const none = new Set<string>();

  it.each([
    ['const', 'export const A = 1;'],
    ['function', 'export function A() {}'],
    ['class', 'export class A {}'],
    ['interface', 'export interface A { x: number }'],
    ['type alias', 'export type A = number;'],
    ['enum', 'export enum A { X }'],
    ['export list', 'const A = 1;\nexport { A };'],
    ['renamed in a list', 'const B = 1;\nexport { B as A };'],
  ])('flags an unused %s', (_label, code) => {
    expect(unusedExports([lib(code), use('const Z = 1;')], none)).toEqual(['/lib.ts: A']);
  });

  it('flags a name used only inside its own file', () => {
    expect(
      unusedExports(
        [lib('export const A = 1;\nexport const B = A + 1;'), use('import { B } from "./lib";')],
        none,
      ),
    ).toEqual(['/lib.ts: A']);
  });

  it.each([
    ['a named import', 'import { A } from "./lib";'],
    ['a type-only import', 'import type { A } from "./lib";'],
    ['an aliased import', 'import { A as Other } from "./lib";'],
    ['a re-export', 'export { A } from "./lib";'],
    ['a renamed re-export', 'export { A as Other } from "./lib";'],
    ['an import type query', 'type T = import("./lib").A;'],
    ['a namespace read', 'import * as lib from "./lib";\nlib.A;'],
    ['a namespace type read', 'import * as lib from "./lib";\nlet x: lib.A;'],
  ])('spares a name taken by %s', (_label, code) => {
    expect(unusedExports([lib('export const A = 1;'), use(code)], none)).toEqual([]);
  });

  it('spares an entry point, a default export, a non-exported name and a re-export', () => {
    expect(
      unusedExports([lib('export const A = 1;'), use('const Z = 1;')], new Set(['/lib.ts'])),
    ).toEqual([]);
    expect(
      unusedExports(
        [lib('export default function A() {}\nconst B = 1;\nexport { C } from "./x";')],
        none,
      ),
    ).toEqual([]);
  });

  it('does not count a name the file itself imports from another module as a use of its own export', () => {
    const own = { path: '/lib.ts', text: 'import { A } from "./other";\nexport const A2 = A;' };
    expect(unusedExports([own, use('const Z = 1;')], none)).toEqual(['/lib.ts: A2']);
  });
});
