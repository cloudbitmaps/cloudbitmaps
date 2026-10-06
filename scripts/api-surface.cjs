'use strict';
/*
 * A snapshot of every public type signature, and the gate that holds later changes to it.
 *
 * `tests/docs/api-reference-sync.test.ts` guards the NAMES a package exports. A name survives a changed parameter
 * type, a narrowed return type, a removed overload or a member that went `readonly`, and each of those breaks a
 * caller that compiled yesterday. So this reads the emitted declarations of every public entry point (each package's
 * `exports` map, subpaths included) with the TypeScript compiler and writes one line per exported symbol, and one per
 * member of a class, interface or enum, with its full signature text and each overload of a function or method
 * separately. The text comes from the printed declaration with comments dropped, so it carries no path and no
 * ordering noise beyond the declared order of overloads, which is part of a signature.
 *
 * Run `pnpm build` first: the declarations are the built ones, the files a consumer's compiler reads.
 *
 *   node scripts/api-surface.cjs --write            regenerate api-surface/surface.json
 *   node scripts/api-surface.cjs --check            fail if the built surface differs from the committed snapshot
 *   node scripts/api-surface.cjs --against <ref>    fail if an entry in the snapshot committed at <ref> is removed or
 *                                                   changed in the committed snapshot, unless api-surface/allowed.json
 *                                                   lists it with a reason. Additions always pass. Compares committed
 *                                                   files, so it needs no build.
 *
 * Known limits: a type reached only by reference and exported by no entry point (an internal helper type named in a
 * signature) is not an entry, so a change inside it is not seen; its name in the signature is. Overload order is
 * compared as declared. Only declarations are read: a change in behaviour behind an unchanged signature is for tests.
 */
const { execFileSync } = require('node:child_process');
const { existsSync, readFileSync, readdirSync, writeFileSync } = require('node:fs');
const { join, resolve } = require('node:path');

const ROOT = resolve(__dirname, '..');
const SNAPSHOT_PATH = 'api-surface/surface.json';
const ALLOWED_PATH = 'api-surface/allowed.json';

const collapse = (s) => s.replace(/\s+/g, ' ').trim();
const stripModifiers = (s) => s.replace(/^(?:export\s+)?(?:default\s+)?(?:declare\s+)?/, '');
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/** The public entry points: `{ specifier, dts }` for every `exports` key of every package that names a `types` file. */
function entryPoints(root = ROOT) {
  const out = [];
  const packages = readdirSync(join(root, 'packages'), { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  for (const dir of packages) {
    const manifest = JSON.parse(readFileSync(join(root, 'packages', dir, 'package.json'), 'utf8'));
    for (const [key, target] of Object.entries(manifest.exports ?? {})) {
      const types = target && typeof target === 'object' ? target.types : undefined;
      if (typeof types !== 'string') continue;
      out.push({
        specifier: manifest.name + (key === '.' ? '' : key.slice(1)),
        dts: join(root, 'packages', dir, types),
      });
    }
  }
  return out;
}

/** The surface of `entries` (`{ specifier, dts }`) as a sorted `{ key: text }` object. */
function buildSurface(entries) {
  const ts = require('typescript');
  for (const e of entries) {
    if (!existsSync(e.dts)) {
      throw new Error(`${e.specifier}: ${e.dts} does not exist; run \`pnpm build\` first`);
    }
  }
  const program = ts.createProgram(
    entries.map((e) => e.dts),
    {
      noEmit: true,
      skipLibCheck: true,
      types: [],
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
    },
  );
  const checker = program.getTypeChecker();
  const printer = ts.createPrinter({ removeComments: true });
  const out = new Map();

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

  function memberKey(m, sf) {
    if (ts.isConstructorDeclaration(m)) return 'constructor';
    if (ts.isConstructSignatureDeclaration(m)) return '[new]';
    if (ts.isCallSignatureDeclaration(m)) return '[call]';
    if (ts.isIndexSignatureDeclaration(m)) {
      return `[index:${collapse(m.parameters.map((p) => p.type?.getText(sf) ?? '').join(','))}]`;
    }
    return m.name ? m.name.getText(sf) : null;
  }

  function members(key, nodes) {
    const groups = new Map();
    for (const m of nodes) {
      if (ts.isSemicolonClassElement(m)) continue;
      const name = memberKey(m, m.getSourceFile());
      if (name === null) throw new Error(`api-surface: a member of ${key} has no name`);
      groups.set(name, [...(groups.get(name) ?? []), m]);
    }
    for (const [name, group] of groups) {
      group.forEach((m, i) => add(numbered(`${key}.${name}`, i), print(m)));
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
      else if (ts.isTypeAliasDeclaration(d)) add(key, stripModifiers(print(d)));
      else if (ts.isVariableDeclaration(d)) {
        const kind = d.parent.flags & ts.NodeFlags.Const ? 'const' : 'let';
        const type = d.type
          ? print(d.type)
          : checker.typeToString(checker.getTypeAtLocation(d), d, ts.TypeFormatFlags.NoTruncation);
        add(key, `${kind} ${symbol.name}: ${type}`);
      } else if (ts.isModuleDeclaration(d) || ts.isSourceFile(d)) {
        if (!described) add(key, ts.isSourceFile(d) ? 'namespace' : header2(d));
        for (const exported of checker.getExportsOfModule(symbol)) {
          describe(`${key}.${exported.name}`, resolveAlias(exported));
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
      );
    }
  }
  const header2 = (d) => `namespace ${d.name.getText()}`;
  const resolveAlias = (s) => (s.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(s) : s);

  for (const { specifier, dts } of entries) {
    const file = program.getSourceFile(dts);
    const moduleSymbol = file && checker.getSymbolAtLocation(file);
    if (!moduleSymbol) throw new Error(`${specifier}: ${dts} is not a module`);
    for (const exported of checker.getExportsOfModule(moduleSymbol)) {
      describe(`${specifier} ${exported.name}`, resolveAlias(exported));
    }
  }
  return Object.fromEntries([...out].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

const serialize = (surface) =>
  JSON.stringify({ version: 1, entries: surface }, null, 2).replace(
    /^ {2}"entries": \{/m,
    '  "entries": {',
  ) + '\n';

function parseSnapshot(text, where) {
  const parsed = JSON.parse(text);
  if (parsed.version !== 1 || typeof parsed.entries !== 'object' || parsed.entries === null) {
    throw new Error(`${where}: not an api-surface snapshot (version 1)`);
  }
  return parsed.entries;
}

/** What differs between two surfaces: keys only in `was` (removed), only in `now` (added), and with other text. */
function diffSurfaces(was, now) {
  const removed = Object.keys(was).filter((k) => !(k in now));
  const added = Object.keys(now).filter((k) => !(k in was));
  const changed = Object.keys(was).filter((k) => k in now && was[k] !== now[k]);
  return { removed, added, changed };
}

/** Problems with the allowlist itself: a row needs an entry and a reason. */
function allowlistProblems(rows) {
  if (!Array.isArray(rows)) return [`${ALLOWED_PATH} must be a JSON array`];
  const problems = [];
  rows.forEach((r, i) => {
    if (typeof r?.entry !== 'string' || r.entry === '') {
      problems.push(`${ALLOWED_PATH} row ${i} has no entry`);
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

/**
 * The entries of `was` that `now` removes or changes without a row of `allowed` excusing them, and the problems with
 * the rows. Additions are never a problem.
 */
function breakingChanges(was, now, allowed) {
  const rowProblems = allowlistProblems(allowed);
  const { removed, changed } = diffSurfaces(was, now);
  const usable = Array.isArray(allowed)
    ? allowed.filter(
        (r) =>
          typeof r?.entry === 'string' && typeof r?.reason === 'string' && r.reason.trim() !== '',
      )
    : [];
  const lines = [
    ...removed.map((k) => `removed: ${k}\n    was: ${was[k]}`),
    ...changed.map((k) => `changed: ${k}\n    was: ${was[k]}\n    now: ${now[k]}`),
  ].filter((_, i) => {
    const key = i < removed.length ? removed[i] : changed[i - removed.length];
    return !usable.some((r) => excuses(r, key));
  });
  return { problems: [...rowProblems, ...lines] };
}

const git = (...args) =>
  execFileSync('git', args, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

function main(argv) {
  const mode = argv[0];
  const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');
  if (mode === '--write') {
    const surface = buildSurface(entryPoints());
    writeFileSync(join(ROOT, SNAPSHOT_PATH), serialize(surface));
    console.log(`api-surface: wrote ${Object.keys(surface).length} entries to ${SNAPSHOT_PATH}`);
    return 0;
  }
  if (mode === '--check') {
    const now = buildSurface(entryPoints());
    const was = parseSnapshot(read(SNAPSHOT_PATH), SNAPSHOT_PATH);
    const { removed, added, changed } = diffSurfaces(was, now);
    if (removed.length + added.length + changed.length === 0) {
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
      'If the change is intended, run `pnpm build && pnpm api:surface` and commit the snapshot.',
    );
    return 1;
  }
  if (mode === '--against') {
    const ref = argv[1];
    if (!ref) throw new Error('--against needs a git ref');
    try {
      git('rev-parse', '--verify', '--quiet', `${ref}^{commit}`);
    } catch {
      throw new Error(
        `api-surface: ${ref} is not a commit here; fetch it first (git fetch origin <branch> --depth=50)`,
      );
    }
    let wasText;
    try {
      git('cat-file', '-e', `${ref}:${SNAPSHOT_PATH}`);
      wasText = git('show', `${ref}:${SNAPSHOT_PATH}`);
    } catch {
      console.log(`api-surface: ${ref} has no ${SNAPSHOT_PATH}; nothing to compare against`);
      return 0;
    }
    const was = parseSnapshot(wasText, `${ref}:${SNAPSHOT_PATH}`);
    const now = parseSnapshot(read(SNAPSHOT_PATH), SNAPSHOT_PATH);
    const { problems } = breakingChanges(was, now, JSON.parse(read(ALLOWED_PATH)));
    if (problems.length === 0) {
      console.log(`api-surface: no entry present at ${ref} is removed or changed`);
      return 0;
    }
    console.error(`api-surface: the public surface changed against ${ref}:`);
    for (const p of problems) console.error(`  ${p}`);
    console.error(
      `A removed or changed entry is a public-contract change. If it is agreed, add a row {"entry", "reason"} to ${ALLOWED_PATH}.`,
    );
    return 1;
  }
  console.error('usage: node scripts/api-surface.cjs --write | --check | --against <git-ref>');
  return 2;
}

module.exports = {
  entryPoints,
  buildSurface,
  diffSurfaces,
  breakingChanges,
  allowlistProblems,
  serialize,
};

if (require.main === module) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  }
}
