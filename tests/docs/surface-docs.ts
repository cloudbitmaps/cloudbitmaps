import { existsSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import ts from 'typescript';

// Resolves every key of `api-surface/surface.json` to its declaration in source and reports the ones whose hover text
// would be empty. The rule, per key:
//
//   - a declared top-level entry (class, interface, type, function, const) passes when that declaration carries its
//     own doc block;
//   - an overload key (`#2`, `#3`) checks that overload's own declaration, so an undocumented overload cannot hide
//     behind a documented first one;
//   - a member (a method, property, accessor or interface field) passes when its declaration carries its own doc
//     block, or inherits one from the member it implements or overrides;
//   - a constructor passes when it carries its own doc block; a class with no declared constructor passes when the
//     class itself is documented;
//   - a key that cannot be resolved to a declaration FAILS, named: a gate that skips what it cannot find says nothing
//     about it.
//
// Known limits: a doc block counts when it has text or a tag, so a comment that says nothing true passes; a `@param`
// or `@returns` tag is not required; an entry that names a type only by reference (a `(referenced)` key) is looked up
// by name in its package's source and the first declaration found is the one checked.

/** The entry module of each published package, by the specifier the surface file uses. */
const ENTRIES: Readonly<Record<string, string>> = {
  '@cloudbitmaps/core': 'packages/core/src/index.ts',
  '@cloudbitmaps/core/driver-kit': 'packages/core/src/driver-kit.ts',
  '@cloudbitmaps/roaring': 'packages/roaring/src/index.ts',
  '@cloudbitmaps/s3': 'packages/s3/src/index.ts',
  '@cloudbitmaps/gcs': 'packages/gcs/src/index.ts',
  '@cloudbitmaps/azure-blob': 'packages/azure-blob/src/index.ts',
  '@cloudbitmaps/tools': 'packages/tools/src/index.ts',
};

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

/** Whether a node's own doc block has text or a tag. A variable's block sits on its statement. */
function hasOwnDoc(decl: ts.Node): boolean {
  let node = decl;
  if (ts.isBindingElement(node)) {
    // `const { A } = x;` : the block is on the statement that holds the pattern.
    let up: ts.Node | undefined = node;
    while (up !== undefined && !ts.isVariableDeclaration(up)) up = up.parent;
    if (up !== undefined) node = up;
  }
  if (
    ts.isVariableDeclaration(node) &&
    ts.isVariableDeclarationList(node.parent) &&
    ts.isVariableStatement(node.parent.parent)
  ) {
    node = node.parent.parent;
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

/** The surface keys whose declaration has no doc block of its own and inherits none. */
export function undocumentedSurfaceEntries(
  root: string,
  keys: readonly string[],
): SurfaceDocFinding[] {
  const entryFile = (spec: string): string | undefined => {
    const rel = ENTRIES[spec];
    return rel === undefined ? undefined : join(root, rel);
  };
  const options: ts.CompilerOptions = {
    baseUrl: root,
    // The packages import one another by name; read each from its source, not from a build.
    paths: Object.fromEntries(Object.entries(ENTRIES).map(([spec, rel]) => [spec, [rel]])),
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
  const files = Object.keys(ENTRIES)
    .map((spec) => entryFile(spec))
    .filter((f): f is string => f !== undefined);
  const program = ts.createProgram(files, options, host);
  const checker = program.getTypeChecker();
  const unalias = (s: ts.Symbol): ts.Symbol =>
    s.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(s) : s;

  const exportsOf = new Map<string, Map<string, ts.Symbol>>();
  for (const spec of Object.keys(ENTRIES)) {
    const file = entryFile(spec);
    const sf = file === undefined ? undefined : program.getSourceFile(file);
    const mod = sf === undefined ? undefined : checker.getSymbolAtLocation(sf);
    if (mod !== undefined) {
      exportsOf.set(spec, new Map(checker.getExportsOfModule(mod).map((s) => [s.name, s])));
    }
  }

  /** Top-level declarations named `name` anywhere in a package's source, for a `(referenced)` entry. */
  const findNamed = (spec: string, name: string): ts.Declaration[] => {
    const pkg = spec.startsWith('@cloudbitmaps/core') ? 'core' : spec.split('/')[1];
    const dir = join(root, 'packages', pkg ?? '', 'src') + sep;
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

  const out: SurfaceDocFinding[] = [];
  for (const key of keys) {
    const fail = (reason: string): number => out.push({ key, reason });
    const m = KEY.exec(key);
    if (m === null) {
      fail('the key does not parse');
      continue;
    }
    const spec = m[1] ?? '';
    const referenced = m[2] !== undefined;
    let rest = (m[3] ?? '').replace(/ \(value\)$/, '');
    const wantValue = / \(value\)$/.test(m[3] ?? '');
    const ov = / #(\d+)$/.exec(rest);
    if (ov !== null) rest = rest.slice(0, -ov[0].length);
    const overload = ov === null ? 0 : Number(ov[1]) - 1;
    const dot = rest.indexOf('.', 1);
    const name = dot < 0 ? rest : rest.slice(0, dot);
    const member = dot < 0 ? undefined : rest.slice(dot + 1);

    let decls: readonly ts.Declaration[];
    let sym: ts.Symbol | undefined;
    const exported = referenced ? undefined : exportsOf.get(spec)?.get(name);
    if (exported !== undefined) {
      sym = unalias(exported);
      decls = sym.declarations ?? [];
    } else {
      decls = findNamed(spec, name);
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
    const top = decls.find((d) => (wantValue ? isValueDecl(d) : !isValueDecl(d))) ?? decls[0];
    if (top === undefined) {
      fail('no declaration found for the export');
      continue;
    }

    if (member === undefined) {
      const same = decls.filter((d) => kindOf(d) === kindOf(top));
      const decl = (ov === null ? same[0] : same[overload]) ?? same[0];
      if (decl === undefined || !hasOwnDoc(decl)) fail('the declaration has no doc block');
      continue;
    }

    if (sym === undefined) {
      fail('the symbol did not resolve');
      continue;
    }
    if (member === 'constructor') {
      const ctors = sym.members?.get(ts.InternalSymbolName.Constructor)?.declarations ?? [];
      if (ctors.length === 0) {
        if (!decls.some((d) => hasOwnDoc(d))) fail('implicit constructor of an undocumented class');
        continue;
      }
      const ctor = (ov === null ? ctors[0] : ctors[overload]) ?? ctors[0];
      if (ctor === undefined || !hasOwnDoc(ctor)) fail('the constructor has no doc block');
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
    const decl = (ov === null ? mdecls[0] : mdecls[overload]) ?? mdecls[0];
    if (decl === undefined) {
      fail('the member was not found on its declaration');
      continue;
    }
    if (hasOwnDoc(decl)) continue;
    // A parameter property takes its text from the constructor's `@param` tag.
    if (ts.isParameter(decl) && ts.getJSDocParameterTags(decl).some((t) => Boolean(t.comment)))
      continue;
    // An overload is judged on its own declaration; other members may inherit.
    const inherited =
      ov === null && ts.displayPartsToString(ms.getDocumentationComment(checker)).length > 0;
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
