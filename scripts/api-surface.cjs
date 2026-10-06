'use strict';
/*
 * A snapshot of every public type signature, and the gate that holds later changes to it.
 *
 * `tests/docs/api-reference-sync.test.ts` guards the NAMES a package exports. A name survives a changed parameter
 * type, a narrowed return type, a removed overload or a member that went `readonly`, and each of those breaks a
 * caller that compiled yesterday. So this reads the emitted declarations of every public entry point (each package's
 * `exports` map, subpaths included) with the TypeScript compiler and writes one line per exported symbol, and one per
 * public member of a class, interface or enum, with its full signature text and each overload of a function or method
 * separately. The text comes from the printed declaration with comments dropped, so it carries no path and no
 * ordering noise beyond the declared order of overloads, which is part of a signature.
 *
 * A type that a public signature names without any entry point exporting it is part of what a caller can reach, so
 * it is recorded too, with its members and, transitively, the types they name, under a `(referenced)` key. A type
 * from outside the workspace (a dependency, the platform) is recorded by name only: it appears in the signature text.
 *
 * Run `pnpm build` first: the declarations are the built ones, the files a consumer's compiler reads.
 *
 *   node scripts/api-surface.cjs --write            regenerate api-surface/surface.json
 *   node scripts/api-surface.cjs --check            fail if the built surface differs from the committed snapshot
 *   node scripts/api-surface.cjs --against <ref>    fail if an entry in the snapshot committed at <ref> is removed or
 *                                                   changed in the committed snapshot, unless a row of
 *                                                   api-surface/allowed.json that the base does not already have lists it
 *                                                   with a reason. Additions pass, except a required member added to an interface the ref already has. Compares committed files, so it
 *                                                   needs neither a build nor the TypeScript package.
 *   --root <dir>                                    run on another checkout (the tests' fixtures)
 *
 * Known limits: overloads are compared in declared order, so one appended after the last passes as an addition;
 * a parameter rename is a change; only declarations are read, so a change in behaviour behind an unchanged signature
 * is for tests; a TypeScript upgrade that changes how declarations print needs one `--write`.
 */
const { execFileSync } = require('node:child_process');
const { existsSync, readFileSync, readdirSync, realpathSync, writeFileSync } = require('node:fs');
const { dirname, join, resolve, sep } = require('node:path');

const SNAPSHOT_PATH = 'api-surface/surface.json';
const ALLOWED_PATH = 'api-surface/allowed.json';

const collapse = (s) => s.replace(/\s+/g, ' ').trim();
const stripModifiers = (s) => s.replace(/^(?:export\s+)?(?:default\s+)?(?:declare\s+)?/, '');
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const byKey = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** The first `types` string in an `exports` target, however deeply conditions nest it. */
function typesOf(target) {
  if (!target || typeof target !== 'object') return undefined;
  if (typeof target.types === 'string') return target.types;
  for (const value of Object.values(target)) {
    const found = typesOf(value);
    if (found !== undefined) return found;
  }
  return undefined;
}

/**
 * The public entry points: `{ specifier, dts }` for every `exports` key of every package. A key whose target names no
 * declaration file is an error, not a skip, so a new entry cannot go unguarded; a `.json` file is not an entry.
 */
function entryPoints(root) {
  const out = [];
  const packages = readdirSync(join(root, 'packages'), { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  for (const dir of packages) {
    const manifest = JSON.parse(readFileSync(join(root, 'packages', dir, 'package.json'), 'utf8'));
    for (const [key, target] of Object.entries(manifest.exports ?? {})) {
      if (typeof target === 'string' && target.endsWith('.json')) continue;
      const types = typesOf(target);
      if (types === undefined) {
        throw new Error(
          `api-surface: ${manifest.name} exports "${key}" with no resolvable \`types\` file; the gate cannot read it`,
        );
      }
      out.push({
        specifier: manifest.name + (key === '.' ? '' : key.slice(1)),
        dts: join(root, 'packages', dir, types),
      });
    }
  }
  return out;
}

/** The name of the package that holds `file`: the nearest `package.json` above it. */
function packageNameOf(file) {
  for (let dir = dirname(file); dir !== dirname(dir); dir = dirname(dir)) {
    const manifest = join(dir, 'package.json');
    if (existsSync(manifest)) return JSON.parse(readFileSync(manifest, 'utf8')).name ?? dir;
  }
  return 'unknown';
}

/** The surface of `entries` (`{ specifier, dts }`) as a sorted `{ key: text }` object. `root` bounds the workspace. */
function buildSnapshot(entries, root) {
  const ts = require('typescript');
  for (const e of entries) {
    if (!existsSync(e.dts)) {
      throw new Error(`${e.specifier}: ${e.dts} does not exist; run \`pnpm build\` first`);
    }
  }
  const files = entries.map((e) => realpathSync(e.dts));
  const workspace = realpathSync(root ?? dirname(files[0] ?? '.')) + sep;
  const program = ts.createProgram(files, {
    noEmit: true,
    skipLibCheck: true,
    types: [],
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
  });
  const checker = program.getTypeChecker();
  const printer = ts.createPrinter({ removeComments: true });
  const out = new Map();
  const required = new Map(); // member key -> its parent's key, for a member an implementer must provide
  const referenced = new Map(); // symbol -> true once queued
  const queue = [];

  const print = (node) =>
    collapse(printer.printNode(ts.EmitHint.Unspecified, node, node.getSourceFile()));
  const add = (key, text) => {
    if (out.has(key)) throw new Error(`api-surface: two entries for ${key}`);
    out.set(key, collapse(text));
  };
  /** `key` for a symbol's first declaration, `key #n` for the nth (overloads, get/set pairs): dropping the last leaves the rest's keys alone. */
  const numbered = (key, i) => (i === 0 ? key : `${key} #${i + 1}`);
  const header = (node) =>
    collapse(
      stripModifiers(
        stripComments(node.getSourceFile().text.slice(node.getStart(), node.members.pos - 1)),
      ),
    );
  const resolveAlias = (s) => (s.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(s) : s);
  const isPrivate = (m) => (ts.getCombinedModifierFlags(m) & ts.ModifierFlags.Private) !== 0;
  const inWorkspace = (file) =>
    file.startsWith(workspace) && !file.includes(`${sep}node_modules${sep}`);

  const exported = new Set();
  for (const { dts } of entries) {
    const moduleSymbol = checker.getSymbolAtLocation(program.getSourceFile(realpathSync(dts)));
    if (moduleSymbol)
      for (const s of checker.getExportsOfModule(moduleSymbol)) exported.add(resolveAlias(s));
  }

  /** Queue the workspace types a declaration names and no entry exports. Private members are not public. */
  function collectRefs(node) {
    if (ts.isClassElement(node) && isPrivate(node)) return;
    let name;
    if (ts.isTypeReferenceNode(node)) name = node.typeName;
    else if (ts.isExpressionWithTypeArguments(node)) name = node.expression;
    else if (ts.isTypeQueryNode(node)) name = node.exprName;
    else if (ts.isImportTypeNode(node)) name = node.qualifier;
    if (name) {
      const found = checker.getSymbolAtLocation(name);
      const symbol = found && resolveAlias(found);
      const decl = symbol?.declarations?.[0];
      if (
        decl &&
        !exported.has(symbol) &&
        !referenced.has(symbol) &&
        !(symbol.flags & ts.SymbolFlags.TypeParameter) &&
        inWorkspace(decl.getSourceFile().fileName)
      ) {
        referenced.set(symbol, true);
        queue.push(symbol);
      }
    }
    ts.forEachChild(node, collectRefs);
  }

  function memberKey(m, sf) {
    if (ts.isConstructorDeclaration(m)) return 'constructor';
    if (ts.isConstructSignatureDeclaration(m)) return '[new]';
    if (ts.isCallSignatureDeclaration(m)) return '[call]';
    if (ts.isIndexSignatureDeclaration(m)) {
      return `[index:${collapse(m.parameters.map((p) => p.type?.getText(sf) ?? '').join(','))}]`;
    }
    return m.name ? m.name.getText(sf) : null;
  }

  /** Whether `m` is a member an implementer or constructor of its interface must provide: any signature but an optional one. */
  const isRequired = (m) =>
    ts.isCallSignatureDeclaration(m) ||
    ts.isConstructSignatureDeclaration(m) ||
    ts.isIndexSignatureDeclaration(m) ||
    ((ts.isPropertySignature(m) || ts.isMethodSignature(m)) && !m.questionToken);

  /** `forImplementers`: the nodes belong to an interface or an object type, whose required members bind implementers. */
  function members(key, nodes, forImplementers) {
    const groups = new Map();
    for (const m of nodes) {
      if (ts.isSemicolonClassElement(m) || (ts.isClassElement(m) && isPrivate(m))) continue;
      const name = memberKey(m, m.getSourceFile());
      if (name === null) throw new Error(`api-surface: a member of ${key} has no name`);
      groups.set(name, [...(groups.get(name) ?? []), m]);
    }
    for (const [name, group] of groups) {
      group.forEach((m, i) => {
        const memberKeyed = numbered(`${key}.${name}`, i);
        add(memberKeyed, print(m));
        if (forImplementers && isRequired(m)) required.set(memberKeyed, key);
      });
    }
  }

  function describe(key, symbol) {
    const decls = symbol.declarations ?? [];
    if (decls.length === 0) throw new Error(`api-surface: ${key} has no declaration`);
    const functions = decls.filter((d) => ts.isFunctionDeclaration(d));
    functions.forEach((d, i) => add(numbered(key, i), stripModifiers(print(d))));
    const merged = { class: [], interface: [], enum: [] };
    let described = false;
    for (const d of decls) {
      if (ts.isFunctionDeclaration(d)) continue;
      if (ts.isClassDeclaration(d)) merged.class.push(d);
      else if (ts.isInterfaceDeclaration(d)) merged.interface.push(d);
      else if (ts.isEnumDeclaration(d)) merged.enum.push(d);
      else if (ts.isTypeAliasDeclaration(d)) {
        if (ts.isTypeLiteralNode(d.type)) {
          // An object type is its header and its members, like an interface, so a member can be told from the type.
          const head = d.getSourceFile().text.slice(d.getStart(), d.type.getStart());
          add(key, `${stripModifiers(collapse(stripComments(head)))}{ ... }`);
          members(key, [...d.type.members], true);
        } else add(key, stripModifiers(print(d)));
      } else if (ts.isVariableDeclaration(d)) {
        const kind = d.parent.flags & ts.NodeFlags.Const ? 'const' : 'let';
        const type = d.type
          ? print(d.type)
          : checker.typeToString(checker.getTypeAtLocation(d), d, ts.TypeFormatFlags.NoTruncation);
        // A value and a type of one name (`const X` with `type X`) are two entries.
        const both = decls.some(
          (o) => ts.isTypeAliasDeclaration(o) || ts.isInterfaceDeclaration(o),
        );
        add(both ? `${key} (value)` : key, `${kind} ${symbol.name}: ${type}`);
      } else if (ts.isModuleDeclaration(d) || ts.isSourceFile(d)) {
        if (!described)
          add(key, ts.isSourceFile(d) ? 'namespace' : `namespace ${d.name.getText()}`);
        for (const inner of checker.getExportsOfModule(symbol)) {
          describe(`${key}.${inner.name}`, resolveAlias(inner));
        }
      } else {
        throw new Error(
          `api-surface: ${key} has an unhandled declaration (${ts.SyntaxKind[d.kind]})`,
        );
      }
      described = true;
    }
    for (const nodes of Object.values(merged)) {
      if (nodes.length === 0) continue;
      nodes.forEach((d, i) => add(numbered(key, i), header(d)));
      members(
        key,
        nodes.flatMap((d) => [...d.members]),
        nodes.every((d) => ts.isInterfaceDeclaration(d)),
      );
    }
    for (const d of decls) collectRefs(d);
  }

  for (const { specifier, dts } of entries) {
    const moduleSymbol = checker.getSymbolAtLocation(program.getSourceFile(realpathSync(dts)));
    if (!moduleSymbol) throw new Error(`${specifier}: ${dts} is not a module`);
    for (const s of checker.getExportsOfModule(moduleSymbol)) {
      describe(`${specifier} ${s.name}`, resolveAlias(s));
    }
  }

  // The referenced types, with the types they name in turn. A name taken twice in one package is told apart by file.
  const used = new Set(out.keys());
  while (queue.length > 0) {
    const symbol = queue.shift();
    const file = symbol.declarations[0].getSourceFile().fileName;
    const key = `${packageNameOf(file)} (referenced) ${symbol.name}`;
    describe(
      used.has(key) ? `${key} [${file.slice(workspace.length).replace(/\.d\.ts$/, '')}]` : key,
      symbol,
    );
    used.add(key);
  }
  const sorted = (map) => Object.fromEntries([...map].sort(([a], [b]) => byKey(a, b)));
  return { entries: sorted(out), required: sorted(required) };
}

/** The surface of `entries` as a sorted `{ key: text }` object. */
const buildSurface = (entries, root) => buildSnapshot(entries, root).entries;

const serialize = ({ entries, required }) =>
  JSON.stringify({ version: 1, entries, required }, null, 2) + '\n';

function parseSnapshot(text, where) {
  const parsed = JSON.parse(text);
  if (parsed.version !== 1 || typeof parsed.entries !== 'object' || parsed.entries === null) {
    throw new Error(`${where}: not an api-surface snapshot (version 1)`);
  }
  return { entries: parsed.entries, required: parsed.required ?? {} };
}

/** What differs between two surfaces: keys only in `was` (removed), only in `now` (added), and with other text. */
function diffSurfaces(was, now) {
  const removed = Object.keys(was).filter((k) => !(k in now));
  const added = Object.keys(now).filter((k) => !(k in was));
  const changed = Object.keys(was).filter((k) => k in now && was[k] !== now[k]);
  return { removed, added, changed };
}

/** A row's `entry` names a key, or a prefix ending in `*` that holds at least a package and the start of a symbol. */
const wildcardIsNarrow = (entry) => !entry.endsWith('*') || /^\S+ \S/.test(entry.slice(0, -1));

/** Problems with the allowlist itself: a row needs an entry and a reason, and a prefix cannot be wide. */
function allowlistProblems(rows) {
  if (!Array.isArray(rows)) return [`${ALLOWED_PATH} must be a JSON array`];
  const problems = [];
  rows.forEach((r, i) => {
    if (typeof r?.entry !== 'string' || r.entry === '') {
      problems.push(`${ALLOWED_PATH} row ${i} has no entry`);
    } else if (!wildcardIsNarrow(r.entry)) {
      problems.push(
        `${ALLOWED_PATH} row ${i} (${r.entry}) is too wide: a prefix must name a package and at least the start of a symbol`,
      );
    }
    if (typeof r?.reason !== 'string' || r.reason.trim() === '') {
      problems.push(
        `${ALLOWED_PATH} row ${i} (${r?.entry}) has no reason: say why the change is agreed`,
      );
    }
  });
  return problems;
}

/** Whether a row excuses `key`: its entry is the key, or ends in `*` and is a prefix of it. */
const excuses = (row, key) =>
  row.entry.endsWith('*') ? key.startsWith(row.entry.slice(0, -1)) : row.entry === key;

/** The rows of `rows` whose entry the base's rows do not already have: a row left over from an earlier change excuses nothing. */
function newRows(rows, baseRows) {
  const had = new Set((Array.isArray(baseRows) ? baseRows : []).map((r) => r?.entry));
  return Array.isArray(rows) ? rows.filter((r) => !had.has(r?.entry)) : rows;
}

/**
 * The entries of `was` that `now` removes or changes without a usable row of `allowed` excusing them, and the problems
 * with the rows. An addition is a problem only when it is a required member of an interface the base already has
 * (`required` maps such a member's key to its parent's).
 */
function breakingChanges(was, now, allowed, required = {}) {
  const rowProblems = allowlistProblems(allowed);
  const { removed, changed, added } = diffSurfaces(was, now);
  const usable = Array.isArray(allowed)
    ? allowed.filter(
        (r) =>
          typeof r?.entry === 'string' &&
          r.entry !== '' &&
          wildcardIsNarrow(r.entry) &&
          typeof r?.reason === 'string' &&
          r.reason.trim() !== '',
      )
    : [];
  const lines = [
    ...removed.map((k) => ({ k, text: `removed: ${k}\n    was: ${was[k]}` })),
    ...changed.map((k) => ({ k, text: `changed: ${k}\n    was: ${was[k]}\n    now: ${now[k]}` })),
    // A member an implementer must provide, added to an interface the base already has, breaks every implementer.
    ...added
      .filter((k) => k in required && required[k] in was)
      .map((k) => ({
        k,
        text: `added: ${k}\n    a required member added to an existing interface (${required[k]})\n    now: ${now[k]}`,
      })),
  ]
    .filter(({ k }) => !usable.some((r) => excuses(r, k)))
    .map(({ text }) => text);
  return { problems: [...rowProblems, ...lines] };
}

function main(argv, defaultRoot) {
  let root = defaultRoot;
  const args = [...argv];
  const at = args.indexOf('--root');
  if (at !== -1) {
    root = resolve(args[at + 1] ?? '');
    args.splice(at, 2);
  }
  const git = (...a) =>
    execFileSync('git', a, {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  const read = (rel) => readFileSync(join(root, rel), 'utf8');
  const mode = args[0];
  if (mode === '--write') {
    const snapshot = buildSnapshot(entryPoints(root), root);
    writeFileSync(join(root, SNAPSHOT_PATH), serialize(snapshot));
    console.log(
      `api-surface: wrote ${Object.keys(snapshot.entries).length} entries to ${SNAPSHOT_PATH}`,
    );
    return 0;
  }
  if (mode === '--check') {
    const builtSnapshot = buildSnapshot(entryPoints(root), root);
    const now = builtSnapshot.entries;
    const committed = parseSnapshot(read(SNAPSHOT_PATH), SNAPSHOT_PATH);
    const was = committed.entries;
    const { removed, added, changed } = diffSurfaces(was, now);
    if (
      removed.length + added.length + changed.length === 0 &&
      JSON.stringify(committed.required) === JSON.stringify(builtSnapshot.required)
    ) {
      console.log(
        `api-surface: the built surface is the committed snapshot (${Object.keys(now).length} entries)`,
      );
      return 0;
    }
    console.error(`api-surface: the built surface differs from ${SNAPSHOT_PATH}`);
    for (const k of added) console.error(`  added:   ${k}\n    now: ${now[k]}`);
    for (const k of removed) console.error(`  removed: ${k}\n    was: ${was[k]}`);
    for (const k of changed)
      console.error(`  changed: ${k}\n    was: ${was[k]}\n    now: ${now[k]}`);
    console.error(
      'If the change is intended, run `pnpm api:surface` (it builds first) and commit the snapshot.',
    );
    return 1;
  }
  if (mode === '--against') {
    const ref = args[1];
    if (!ref) throw new Error('--against needs a git ref');
    try {
      git('rev-parse', '--verify', '--quiet', `${ref}^{commit}`);
    } catch {
      throw new Error(
        `api-surface: ${ref} is not a commit here; fetch it first (git fetch origin <branch> --depth=50)`,
      );
    }
    /** The file at the ref, or null when the path is not there; any other git failure throws. */
    const atRef = (path) =>
      git('ls-tree', '--name-only', ref, '--', path).trim() === ''
        ? null
        : git('show', `${ref}:${path}`);
    const wasText = atRef(SNAPSHOT_PATH);
    if (wasText === null) {
      console.log(`api-surface: ${ref} has no ${SNAPSHOT_PATH}; nothing to compare against`);
      return 0;
    }
    const baseAllowed = atRef(ALLOWED_PATH);
    const was = parseSnapshot(wasText, `${ref}:${SNAPSHOT_PATH}`).entries;
    const current = parseSnapshot(read(SNAPSHOT_PATH), SNAPSHOT_PATH);
    const now = current.entries;
    const rows = JSON.parse(read(ALLOWED_PATH));
    const { problems } = breakingChanges(
      was,
      now,
      newRows(rows, baseAllowed === null ? [] : JSON.parse(baseAllowed)),
      current.required,
    );
    const rowProblems = allowlistProblems(rows).filter((p) => !problems.includes(p));
    problems.push(...rowProblems);
    if (problems.length === 0) {
      console.log(`api-surface: no entry present at ${ref} is removed or changed`);
      return 0;
    }
    console.error(`api-surface: the public surface changed against ${ref}:`);
    for (const p of problems) console.error(`  ${p}`);
    console.error(
      `A removed or changed entry is a public-contract change. If it is agreed, add a row {"entry", "reason"} to ${ALLOWED_PATH} in this change; a row the base already has excuses nothing.`,
    );
    return 1;
  }
  console.error(
    'usage: node scripts/api-surface.cjs --write | --check | --against <git-ref> [--root <dir>]',
  );
  return 2;
}

module.exports = {
  entryPoints,
  buildSurface,
  buildSnapshot,
  diffSurfaces,
  breakingChanges,
  allowlistProblems,
  newRows,
  serialize,
};

if (require.main === module) {
  try {
    process.exitCode = main(process.argv.slice(2), resolve(__dirname, '..'));
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  }
}
