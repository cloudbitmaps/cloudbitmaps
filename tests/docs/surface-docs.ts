import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import ts from 'typescript';

// Resolves every key of `api-surface/surface.json` to its declaration in source and reports the ones whose hover text
// would be empty. The rule, per key:
//
//   - a declared top-level entry (class, interface, type, function, const) passes when that declaration carries its
//     own doc block;
//   - an overloaded member, function or constructor is judged form by form: the overload the key with no `#` names, and
//     each `#n` key check that form's own declaration, so an undocumented form cannot hide behind a documented
//     sibling or behind the implementation. The forms are the bodiless signatures when there are any; the
//     implementation is not a form, so a `#n` key that names it, or a form that does not exist, FAILS;
//   - a member (a method, property, accessor or interface field) with ONE declaration passes when that declaration
//     carries its own doc block, or inherits one from the member it implements or overrides. A member with several
//     declarations never inherits;
//   - a parameter property (`constructor(readonly root: string)`) needs its own block on the parameter: the emitted
//     `.d.ts` keeps a constructor's `@param` text on the constructor only, so it never reaches the property;
//   - a constructor passes when it carries its own doc block; a class with no declared constructor passes when the
//     class itself is documented;
//   - a statement's doc block counts for the first name that statement declares (`export const a = 1, b = 2;` and
//     `const { A, B } = x;` document `a` and `A`), as the emitted `.d.ts` shows it;
//   - a `(value)` key needs a variable declaration of that name; a key whose specifier is not an entry point of a
//     package (read from the packages' `exports` maps) FAILS;
//   - a `(referenced)` key names a type no entry exports, so it is found by name in its package's source: it FAILS
//     when more than one file of the package declares that name (the gate cannot tell which one is meant), and
//     is judged on the one declaration otherwise;
//   - every other key that cannot be resolved to a declaration FAILS, named: a gate that skips what it cannot find says
//     nothing about it.
//
// Known limits: a doc block counts when it has text or a tag, so a comment that says nothing true passes, and a
// deliberately empty-looking one (`/** x */`) passes; a `@param` or `@returns` tag is not required; a getter and
// setter pair is two forms of one member, so the setter needs its own block though the hover shows the getter's (no
// such pair is public today); a name found by name inside one file is taken to be the file's top-level declaration, not
// a nested one of the same name.

/** One published entry point: the package directory and the source module its `exports` entry builds from. */
export interface EntryPoint {
  readonly pkg: string;
  readonly file: string;
}

/**
 * The entry points of every package under `packages/`, by the specifier a user imports, read from each package's
 * `exports` map: `./dist/<name>.d.ts` is built from `src/<name>.ts`. A package without an `exports` map has none.
 */
export function entryPoints(root: string): Record<string, EntryPoint> {
  const out: Record<string, EntryPoint> = {};
  const packages = join(root, 'packages');
  for (const dir of readdirSync(packages, { withFileTypes: true })) {
    const manifest = join(packages, dir.name, 'package.json');
    if (!dir.isDirectory() || !existsSync(manifest)) continue;
    const pkg = JSON.parse(readFileSync(manifest, 'utf8')) as {
      name?: string;
      exports?: Record<string, { types?: string } | string>;
    };
    for (const [sub, target] of Object.entries(pkg.exports ?? {})) {
      const types = typeof target === 'string' ? target : target.types;
      const built = types === undefined ? null : /^\.\/dist\/(.+)\.d\.ts$/.exec(types);
      if (pkg.name === undefined || built === null) continue;
      const spec = sub === '.' ? pkg.name : `${pkg.name}/${sub.replace(/^\.\//, '')}`;
      out[spec] = { pkg: dir.name, file: join(packages, dir.name, 'src', `${built[1]}.ts`) };
    }
  }
  return out;
}

export interface SurfaceDocFinding {
  readonly key: string;
  readonly reason: string;
}

const KEY = /^(@cloudbitmaps\/\S+?)( \(referenced\))? (.+)$/;

type Named =
  | ts.ClassDeclaration
  | ts.InterfaceDeclaration
  | ts.TypeAliasDeclaration
  | ts.FunctionDeclaration
  | ts.EnumDeclaration
  | ts.VariableDeclaration
  | ts.BindingElement;

/** The first identifier a binding name declares, in source order. */
function firstName(name: ts.BindingName): ts.Identifier | undefined {
  if (ts.isIdentifier(name)) return name;
  for (const el of name.elements) {
    if (ts.isOmittedExpression(el)) continue;
    const first = firstName(el.name);
    if (first !== undefined) return first;
  }
  return undefined;
}

/**
 * Whether a node's own doc block has text or a tag. A variable's block sits on its statement and counts for the first
 * name the statement declares only.
 */
function hasOwnDoc(decl: ts.Node): boolean {
  let node = decl;
  if (ts.isBindingElement(node) || ts.isVariableDeclaration(node)) {
    let up: ts.Node | undefined = node;
    while (up !== undefined && !ts.isVariableDeclaration(up)) up = up.parent;
    const list = up?.parent;
    const statement = list?.parent;
    if (
      up === undefined ||
      list === undefined ||
      !ts.isVariableDeclarationList(list) ||
      statement === undefined ||
      !ts.isVariableStatement(statement)
    ) {
      return false;
    }
    const own = ts.isBindingElement(node) ? node.name : (node as ts.VariableDeclaration).name;
    const firstDecl = list.declarations[0];
    const first = firstDecl === undefined ? undefined : firstName(firstDecl.name);
    if (!ts.isIdentifier(own) || own !== first) return false;
    node = statement;
  }
  const docs = (node as { jsDoc?: readonly ts.JSDoc[] }).jsDoc ?? [];
  return docs.some((d) => {
    const text = typeof d.comment === 'string' ? d.comment.trim() : (d.comment ?? []).length > 0;
    return Boolean(text) || (d.tags ?? []).length > 0;
  });
}

function kindOf(decl: ts.Node): string {
  if (ts.isClassDeclaration(decl)) return 'class';
  if (ts.isInterfaceDeclaration(decl)) return 'interface';
  if (ts.isTypeAliasDeclaration(decl)) return 'type';
  if (ts.isFunctionDeclaration(decl)) return 'function';
  if (ts.isEnumDeclaration(decl)) return 'enum';
  if (ts.isVariableDeclaration(decl) || ts.isBindingElement(decl)) return 'const';
  return ts.SyntaxKind[decl.kind] ?? 'unknown';
}

/**
 * The declarations a published key numbers: the bodiless signatures of an overloaded set, in source order (the
 * implementation is not published), or every declaration when none is an overload.
 */
function formsOf<T extends ts.Node>(decls: readonly T[]): readonly T[] {
  const sigs = decls.filter(
    (d) => ts.isFunctionLike(d) && (d as { body?: ts.Node }).body === undefined,
  );
  return sigs.length > 0 && sigs.length < decls.length ? sigs : decls;
}

/** A package's source as a program: built once, then asked about any number of keys. */
export interface Surface {
  readonly root: string;
  readonly entries: Readonly<Record<string, EntryPoint>>;
  readonly checker: ts.TypeChecker;
  readonly exportsOf: ReadonlyMap<string, ReadonlyMap<string, ts.Symbol>>;
  /** Top-level declarations named `name` anywhere in a package's source. */
  readonly findNamed: (spec: string, name: string) => ts.Declaration[];
}

/** Builds the program over every entry point of `root`'s packages, reading each package from its source. */
export function openSurface(root: string): Surface {
  const entries = entryPoints(root);
  const options: ts.CompilerOptions = {
    baseUrl: root,
    // The packages import one another by name; read each from its source, not from a build.
    paths: Object.fromEntries(Object.entries(entries).map(([spec, e]) => [spec, [e.file]])),
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    skipLibCheck: true,
    noEmit: true,
    types: [],
  };
  const host = ts.createCompilerHost(options);
  // Each package imports its own source through `@/`; map it per package, as the build does.
  host.resolveModuleNames = (names, containing) =>
    names.map((name) => {
      if (name.startsWith('@/')) {
        const pkg = relative(join(root, 'packages'), containing).split(sep)[0] ?? '';
        const base = join(root, 'packages', pkg, 'src', name.slice(2));
        for (const suffix of ['.ts', '/index.ts']) {
          if (existsSync(base + suffix))
            return { resolvedFileName: base + suffix, extension: '.ts' };
        }
      }
      return ts.resolveModuleName(name, containing, options, host).resolvedModule;
    });
  const files = Object.values(entries)
    .map((e) => e.file)
    .filter((f) => existsSync(f));
  const program = ts.createProgram(files, options, host);
  const checker = program.getTypeChecker();

  const exportsOf = new Map<string, Map<string, ts.Symbol>>();
  for (const [spec, e] of Object.entries(entries)) {
    const sf = program.getSourceFile(e.file);
    const mod = sf === undefined ? undefined : checker.getSymbolAtLocation(sf);
    if (mod !== undefined) {
      exportsOf.set(spec, new Map(checker.getExportsOfModule(mod).map((s) => [s.name, s])));
    }
  }

  const findNamed = (spec: string, name: string): ts.Declaration[] => {
    const dir = join(root, 'packages', entries[spec]?.pkg ?? '', 'src') + sep;
    const hits: ts.Declaration[] = [];
    for (const sf of program.getSourceFiles()) {
      if (!sf.fileName.startsWith(dir)) continue;
      for (const stmt of sf.statements) {
        if (
          (ts.isClassDeclaration(stmt) ||
            ts.isInterfaceDeclaration(stmt) ||
            ts.isTypeAliasDeclaration(stmt) ||
            ts.isFunctionDeclaration(stmt) ||
            ts.isEnumDeclaration(stmt)) &&
          stmt.name?.text === name
        ) {
          hits.push(stmt);
        } else if (ts.isVariableStatement(stmt)) {
          for (const d of stmt.declarationList.declarations) {
            if (ts.isIdentifier(d.name) && d.name.text === name) hits.push(d);
            else if (ts.isObjectBindingPattern(d.name)) {
              for (const el of d.name.elements) {
                if (ts.isIdentifier(el.name) && el.name.text === name) hits.push(el);
              }
            }
          }
        }
      }
    }
    return hits;
  };
  return { root, entries, checker, exportsOf, findNamed };
}

/** The surface keys whose declaration has no doc block of its own and inherits none. */
export function undocumentedSurfaceEntries(
  root: string,
  keys: readonly string[],
  surface: Surface = openSurface(root),
): SurfaceDocFinding[] {
  const { checker, exportsOf, findNamed, entries } = surface;
  const unalias = (s: ts.Symbol): ts.Symbol =>
    s.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(s) : s;

  const out: SurfaceDocFinding[] = [];
  for (const key of keys) {
    const fail = (reason: string): number => out.push({ key, reason });
    const m = KEY.exec(key);
    if (m === null) {
      fail('the key does not parse');
      continue;
    }
    const spec = m[1] ?? '';
    if (entries[spec] === undefined) {
      fail(`${spec} is not an entry point of any package`);
      continue;
    }
    const referenced = m[2] !== undefined;
    let rest = (m[3] ?? '').replace(/ \(value\)$/, '');
    const wantValue = / \(value\)$/.test(m[3] ?? '');
    const ov = / #(\d+)$/.exec(rest);
    if (ov !== null) rest = rest.slice(0, -ov[0].length);
    const overload = ov === null ? 0 : Number(ov[1]) - 1;
    const dot = rest.indexOf('.', 1);
    const name = dot < 0 ? rest : rest.slice(0, dot);
    const member = dot < 0 ? undefined : rest.slice(dot + 1);
    const noForm = (have: number): string =>
      `form ${overload + 1} not found: it has ${have} form(s)`;

    let decls: readonly ts.Declaration[];
    let sym: ts.Symbol | undefined;
    const exported = referenced ? undefined : exportsOf.get(spec)?.get(name);
    if (exported !== undefined) {
      sym = unalias(exported);
      decls = sym.declarations ?? [];
    } else {
      decls = findNamed(spec, name);
      const files = [...new Set(decls.map((d) => relative(root, d.getSourceFile().fileName)))];
      if (files.length > 1) {
        fail(
          `${name} is declared in more than one file, so which one is meant is unknown: ${files.join(', ')}`,
        );
        continue;
      }
      const first = decls[0] as Named | undefined;
      if (first !== undefined) {
        sym = checker.getSymbolAtLocation((first as { name?: ts.Node }).name ?? first);
      }
    }
    if (decls.length === 0) {
      fail('no declaration found for the export');
      continue;
    }
    const isValueDecl = (d: ts.Node): boolean =>
      ts.isVariableDeclaration(d) || ts.isBindingElement(d);
    const valueHalf = decls.find(isValueDecl);
    if (wantValue && valueHalf === undefined) {
      fail('the (value) half was not found: no variable declaration of that name');
      continue;
    }
    const top = wantValue ? valueHalf : (decls.find((d) => !isValueDecl(d)) ?? decls[0]);
    if (top === undefined) {
      fail('no declaration found for the export');
      continue;
    }

    if (member === undefined) {
      const forms = formsOf(decls.filter((d) => kindOf(d) === kindOf(top)));
      const decl = forms[overload];
      if (decl === undefined) fail(noForm(forms.length));
      else if (!hasOwnDoc(decl)) fail('the declaration has no doc block');
      continue;
    }

    if (sym === undefined) {
      fail('the symbol did not resolve');
      continue;
    }
    if (member === 'constructor') {
      const ctors = sym.members?.get(ts.InternalSymbolName.Constructor)?.declarations ?? [];
      if (ctors.length === 0) {
        if (ov !== null) fail(noForm(0));
        else if (!decls.some((d) => hasOwnDoc(d)))
          fail('implicit constructor of an undocumented class');
        continue;
      }
      const forms = formsOf(ctors);
      const ctor = forms[overload];
      if (ctor === undefined) fail(noForm(forms.length));
      else if (!hasOwnDoc(ctor)) fail('the constructor has no doc block');
      continue;
    }

    // A member: look it up on the class or interface, by computed key (`[Name]`) too.
    const declared = checker.getDeclaredTypeOfSymbol(sym);
    let ms: ts.Symbol | undefined;
    if (member.startsWith('[')) {
      const want = member.slice(1, -1);
      const hasKey = (v: ts.Symbol): boolean =>
        (v.declarations ?? []).some((d) => {
          const n = (d as { name?: ts.Node }).name;
          return n !== undefined && ts.isComputedPropertyName(n) && n.expression.getText() === want;
        });
      for (const v of [
        ...(sym.members?.values() ?? []),
        ...checker.getPropertiesOfType(declared),
      ]) {
        if (ms === undefined && hasKey(v)) ms = v;
      }
    } else {
      ms =
        sym.members?.get(member as ts.__String) ??
        sym.exports?.get(member as ts.__String) ??
        checker.getPropertyOfType(declared, member) ??
        checker.getPropertyOfType(checker.getTypeOfSymbol(sym), member);
    }
    const mdecls = ms?.declarations ?? [];
    if (ms === undefined || mdecls.length === 0) {
      fail('the member was not found on its declaration');
      continue;
    }
    const forms = formsOf(mdecls);
    const decl = forms[overload];
    if (decl === undefined) {
      fail(noForm(forms.length));
      continue;
    }
    if (hasOwnDoc(decl)) continue;
    // The checker's text for a parameter property is the constructor's `@param` tag, which the emitted `.d.ts` keeps
    // on the constructor, so a parameter is never judged on it.
    if (ts.isParameter(decl)) {
      fail('the parameter property has no doc block of its own');
      continue;
    }
    // Only a member with one declaration inherits: with several, the symbol's text is the forms' and the
    // implementation's together, and none of it is the hover of this form.
    const inherited =
      ov === null &&
      mdecls.length === 1 &&
      ts.displayPartsToString(ms.getDocumentationComment(checker)).length > 0;
    if (!inherited) fail('the member has no doc block, own or inherited');
  }
  return out;
}

/** The keys of the surface file. */
export function surfaceKeys(root: string): string[] {
  const surface = JSON.parse(readFileSync(join(root, 'api-surface/surface.json'), 'utf8')) as {
    entries: Record<string, string>;
  };
  return Object.keys(surface.entries);
}
