'use strict';
/*
 * Package smoke test — the built library must import cleanly under BOTH module systems, on real Node,
 * through the paths a consumer actually resolves.
 *
 * Guards the `roaring` CJS→ESM interop: `roaring` is a CommonJS native addon, and a *named* ESM import of
 * it crashes Node's ESM loader (its static lexer can't see the CJS exports). We load the package **by name**
 * — so the package.json `exports` map and its `import`/`require` conditions are exercised too, not just the
 * dist files — via dynamic `import()` (ESM) and `require()` (CJS) for every entry of every package, then run
 * the roaring-backed load/read path. The roaring interop is exercised specifically by the flavor's main `.`
 * entry (only it pulls in the SafeBitmap); the three driver packages additionally guard their own exports
 * maps and their cloud-SDK interop. The bin is a separate build with its own `roaring` import, so it's loaded
 * too. Any regression fails the build. Run via `pnpm smoke` (builds first) or `node scripts/smoke.cjs`.
 */
const path = require('node:path');
const { pathToFileURL } = require('node:url');

// Self-reference by name → resolves through the package `exports` map. `PKG` is the flavor and `S3` one of
// the driver packages a user installs beside it; naming them separately is what lets the checks below cross
// a real package boundary rather than staying inside one bundle.
const PKG = '@cloudbitmaps/roaring';
const CORE = '@cloudbitmaps/core';
const S3 = '@cloudbitmaps/s3';
const TOOLS = '@cloudbitmaps/tools';
const DRIVER_KIT = '@cloudbitmaps/core/driver-kit';
/**
 * The packages whose whole job is to name a cloud SDK. Everything else must not.
 *
 * The boundary is a package name, not a path prefix: the SDK-free sweep skips these packages whole.
 */
/**
 * Which packages are storage-driver packages — DERIVED, like every other topology list in this repo.
 *
 * A driver package is one that depends on a cloud SDK; that is the same definition the packaging uses, so
 * the two cannot disagree. With the three hardcoded, a fourth service package would have `assertEntrySdkFree`
 * run against it and fail for naming the SDK it exists to wrap.
 */
const DRIVER_PACKAGES = (() => {
  const { readdirSync, readFileSync, existsSync } = require('node:fs');
  const dir = path.join(__dirname, '..', 'packages');
  const CLOUD_SDK = /^(?:@aws-sdk\/|aws-sdk$|@google-cloud\/|@azure\/)/;
  // `core` can NEVER be a driver package, whatever its manifest says. This list decides who is EXEMPT from
  // `assertEntrySdkFree`, so a derivation able to classify core would let core exempt itself from the check
  // enforcing "the main entry stays SDK-free" — hard invariant 7. An innocuous `@aws-sdk/types` or
  // `@azure/core-*` utility is enough to trigger it, and the check would then stop running rather than
  // fail. eslint still catches a direct import in source, but only smoke walks the BUILT entry graph.
  const NEVER_A_DRIVER = new Set(['core']);
  const found = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(path.join(dir, e.name, 'package.json')))
    .filter((e) => !NEVER_A_DRIVER.has(e.name))
    .filter((e) => {
      const m = JSON.parse(readFileSync(path.join(dir, e.name, 'package.json'), 'utf8'));
      return Object.keys(m.dependencies ?? {}).some((d) => CLOUD_SDK.test(d));
    })
    .map((e) => e.name);
  if (found.length === 0)
    throw new Error('smoke: no driver package found — the derivation is broken');
  return found;
})();

/**
 * Every relative specifier in an emitted `.d.ts` must carry an explicit extension, and must resolve.
 *
 * Runs for EVERY package, including the driver packages the SDK sweep deliberately skips. It is a function of
 * its own so that skipping the SDK sweep for a driver package cannot skip this as well: the driver packages
 * publish `.d.ts` like any other, so they need it just as much.
 */
function assertDtsSpecifiers(pkgDir) {
  const { readFileSync, existsSync } = require('node:fs');
  const dist = path.join(__dirname, '..', 'packages', pkgDir, 'dist');
  const read = (f) => readFileSync(path.join(dist, f), 'utf8');
  //
  // Without an extension, `moduleResolution: node16`/`nodenext` cannot resolve it (TS2834) — and the failure
  // is SILENT for almost everyone, because the near-universal `skipLibCheck: true` suppresses the error and
  // TypeScript then types everything reached through that specifier as `any`. Since an entry re-exports
  // nearly everything, that is nearly the whole published surface — and a consumer gets no diagnostic at
  // all; they just lose it, including compile-time guards meant to refuse a bad wiring.
  //
  // The scanner is the same module `scripts/build.mjs` rewrites with, so the gate cannot check something
  // other than what the build fixes, and neither one touches a relative path inside a doc-comment.
  //
  // The second half checks the build's own work: a specifier the rewrite produced that points at no file
  // would be just as unresolvable, and is the one remaining way to ship a broken `.d.ts` quietly.
  const bad = [];
  const unresolvable = [];
  const allDts = declarationFiles(dist);
  // A package that emits NO declarations at all would sail through both loops below with an empty list and
  // report "0 file(s)" as a pass — while its `types` entry points at nothing and every consumer silently
  // gets `any`. Every package here declares types, so zero is always a build regression, never a valid state.
  if (allDts.length === 0) {
    throw new Error(
      `${pkgDir}: dist/ contains no .d.ts files at all. The exports map promises types, so this is a build ` +
        `regression — and every check over the declaration tree would otherwise pass vacuously.`,
    );
  }
  for (const file of allDts) {
    const source = read(file);
    for (const spec of findSpecifiers(source)) bad.push(`${file} → ${spec}`);
    for (const spec of allSpecifiers(source)) {
      if (!EXTENSIONED.test(spec)) continue; // already reported above
      const abs = path.resolve(path.dirname(path.join(dist, file)), spec);
      const candidates = [
        abs, // .json, and anything already naming a real file
        abs.replace(/\.js$/, '.d.ts'),
        abs.replace(/\.mjs$/, '.d.mts'),
        abs.replace(/\.cjs$/, '.d.cts'),
      ];
      if (!candidates.some((c) => existsSync(c))) unresolvable.push(`${file} → ${spec}`);
    }
  }
  const report = (list, what) => {
    const shown = list.slice(0, 5).join('\n  ');
    const rest = list.length > 5 ? `\n  … and ${list.length - 5} more` : '';
    return `${list.length} ${what}\n  ${shown}${rest}`;
  };
  if (bad.length > 0) {
    throw new Error(
      `@cloudbitmaps/${pkgDir}: ` +
        report(bad, 'extensionless relative specifier(s) in emitted .d.ts — ') +
        `\n  node16/nodenext consumers would silently get \`any\` for everything behind it.`,
    );
  }
  if (unresolvable.length > 0) {
    throw new Error(
      `@cloudbitmaps/${pkgDir}: ` +
        report(unresolvable, 'relative specifier(s) in emitted .d.ts pointing at no file — ') +
        `\n  The extension pass in scripts/build.mjs produced a path that does not resolve.`,
    );
  }
  console.log(
    `  .d.ts specifiers all extensioned and resolvable: @cloudbitmaps/${pkgDir} ` +
      `(${allDts.length} file(s))`,
  );
}

/**
 * A declared subpath must also be reachable by a resolver that cannot read `exports`.
 *
 * `moduleResolution: node`/`node10` ignores `exports` entirely and looks at `types`/`typesVersions`. So a
 * subpath like `@cloudbitmaps/core/driver-kit` resolves for a modern consumer and is INVISIBLE to a node10
 * one — and because the driver packages name it in their shipped `.d.ts` files, everything behind it would
 * silently become `any` there, which `skipLibCheck: true` then hides completely.
 *
 * That is the same silent-`any` failure `scripts/build.mjs` documents at length for extensionless relative
 * specifiers, arriving by a different route: a bare cross-package specifier. So this asserts the
 * manifest-level invariant rather than re-deriving resolution — every subpath in `exports` has a
 * `typesVersions` entry pointing at a real declaration file.
 */
function assertSubpathsResolveWithoutExports(pkgDir) {
  const { readFileSync, existsSync } = require('node:fs');
  const root = path.join(__dirname, '..', 'packages', pkgDir);
  const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  const subpaths = Object.keys(manifest.exports ?? {}).filter((k) => k !== '.');
  if (subpaths.length === 0) return;
  const tv = manifest.typesVersions?.['*'] ?? {};
  const missing = [];
  for (const key of subpaths) {
    const name = key.replace(/^\.\//, '');
    const target = tv[name]?.[0];
    if (target === undefined || !existsSync(path.join(root, target))) {
      missing.push(
        `${manifest.name}/${name}${target === undefined ? '' : ` -> ${target} (no such file)`}`,
      );
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `${manifest.name}: ${missing.length} declared subpath(s) have no usable \`typesVersions\` entry, so a ` +
        `\`moduleResolution: node\` consumer cannot resolve their types and everything behind them becomes ` +
        `\`any\` — silently, because skipLibCheck hides the diagnostic.\n  ` +
        missing.join('\n  '),
    );
  }
  console.log(`  subpaths resolve without exports: @cloudbitmaps/${pkgDir} (${subpaths.length})`);
}

/**
 * A package ships only the declarations the TypeScript compiler loads for a consumer, and every one it loads is
 * there.
 *
 * `scripts/build.mjs` prunes with its own walk (`scripts/lib/reachable-declarations.cjs`), and a walk cannot catch
 * its own bug, so this does not reuse it. It builds one program that imports every `exports` entry of every
 * package by name, under NodeNext, Bundler and Node10 resolution with `skipLibCheck` off, and fails on
 *   (a) any diagnostic inside a package's `dist/` — a reachable declaration deleted by mistake shows as TS2307;
 *   (b) any diagnostic in the probe itself — a lost entry shows there, as TS7016 or TS2307 on its import;
 *   (c) any shipped `.d.ts` that no resolution mode loaded — a stray the prune missed;
 *   (d) any loaded file outside this checkout. A worktree nested in another checkout can resolve a package
 *       through the outer `node_modules`, so a lost entry would load the outer build's file and raise no
 *       diagnostic; this rule turns that silent pass into a failure.
 * It checks only the `typesVersions` range its own TypeScript version selects; the walk reads every range.
 * It lives here, after the build, because it reads `dist/`; the test suite runs before the build in CI.
 */
function assertDeclarationsMatchWhatTscLoads() {
  const fs = require('node:fs');
  const ts = require('typescript');
  const root = path.join(__dirname, '..');
  const dists = packageDirs().map((d) => path.join(root, 'packages', d, 'dist'));
  for (const dist of dists) {
    if (!fs.existsSync(dist))
      throw new Error(`${dist}: dist/ is missing, so its declarations cannot be checked.`);
  }
  const specs = packageDirs().flatMap((d) => entriesOf(d));
  const probeText = specs.map((spec, i) => `export * as m${i} from '${spec}';`).join('\n');
  // One key per file for every comparison: the compiler names files in its own form (forward slashes, and on
  // Windows a drive letter in either case), the filesystem walk in the platform's, so both go through the canonical
  // real path, lower-cased where the filesystem ignores case.
  const key = (f) => {
    let p;
    try {
      p = fs.realpathSync.native(f);
    } catch {
      p = path.resolve(f);
    }
    return process.platform === 'win32' ? p.toLowerCase() : p;
  };
  const distKeys = dists.map((d) => key(d) + path.sep);
  const inDist = (f) => distKeys.some((d) => key(f).startsWith(d));
  const modes = consumerModes(ts);
  const loadedAnywhere = new Map(); // key -> the file name tsc gave
  const rootKey = key(root) + path.sep;
  const problems = [];
  for (const [mode, [module, moduleResolution, ext]] of Object.entries(modes)) {
    const probe = path.join(root, `__declarations_probe__${ext}`);
    // tsc hands the host its own spelling of the probe's name (forward slashes on Windows): compare keys.
    const probeKey = key(probe);
    const isProbe = (f) => key(f) === probeKey;
    const options = consumerOptions(ts, root, module, moduleResolution);
    const host = ts.createCompilerHost(options, true);
    const { fileExists, readFile, getSourceFile } = host;
    host.fileExists = (f) => isProbe(f) || fileExists.call(host, f);
    host.readFile = (f) => (isProbe(f) ? probeText : readFile.call(host, f));
    host.getSourceFile = (f, ...rest) =>
      isProbe(f)
        ? ts.createSourceFile(f, probeText, rest[0], true)
        : getSourceFile.call(host, f, ...rest);
    const program = ts.createProgram([probe], options, host);
    for (const sf of program.getSourceFiles()) {
      if (isProbe(sf.fileName)) continue;
      const k = key(sf.fileName);
      loadedAnywhere.set(k, sf.fileName);
      // A worktree nested in another checkout can resolve a missing entry through the outer checkout's node_modules,
      // into ITS dist/, and then no diagnostic appears: a file from outside this checkout is a failure in itself.
      if (!k.startsWith(rootKey))
        problems.push(`[${mode}] loaded from outside this checkout: ${sf.fileName}`);
    }
    const diagnostics = [
      ...program.getOptionsDiagnostics(),
      ...program.getGlobalDiagnostics(),
      ...program.getSyntacticDiagnostics(),
      ...program.getSemanticDiagnostics(),
    ].filter((d) => !d.file || isProbe(d.file.fileName) || inDist(d.file.fileName));
    for (const d of diagnostics) {
      const where = d.file ? path.relative(root, d.file.fileName) : '(program)';
      problems.push(
        `[${mode}] TS${d.code} ${where}: ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`,
      );
    }
  }
  const shipped = dists.flatMap((dist) => declarationFiles(dist).map((f) => path.join(dist, f)));
  // A key that no longer matches would make the diagnostics filter above keep nothing from dist/, a silent pass.
  const outside = shipped.filter((f) => !inDist(f));
  if (outside.length > 0) {
    throw new Error(
      `smoke: path keys disagree; ${outside.length} shipped declaration(s) not seen inside a dist/`,
    );
  }
  for (const file of shipped.filter((f) => !loadedAnywhere.has(key(f))).sort()) {
    problems.push(`stray, loaded by no resolution mode: ${path.relative(root, file)}`);
  }
  if (problems.length > 0) {
    throw new Error(
      `shipped declarations differ from what a consumer's compiler loads (${problems.length}):\n  ` +
        problems.join('\n  '),
    );
  }
  console.log(
    `  shipped declarations == what tsc loads (nodenext, bundler, node10): ${shipped.length} file(s), ` +
      `${specs.length} entries`,
  );
}

/** The three ways a consumer's compiler resolves a package: `[module, moduleResolution, the probe's extension]`. */
function consumerModes(ts) {
  return {
    nodenext: [ts.ModuleKind.NodeNext, ts.ModuleResolutionKind.NodeNext, '.mts'],
    bundler: [ts.ModuleKind.ESNext, ts.ModuleResolutionKind.Bundler, '.mts'],
    node10: [ts.ModuleKind.CommonJS, ts.ModuleResolutionKind.Node10, '.ts'],
  };
}

/** A strict consumer's compiler options, `skipLibCheck` off, for one of `consumerModes`. */
function consumerOptions(ts, root, module, moduleResolution) {
  return {
    noEmit: true,
    strict: true,
    skipLibCheck: false,
    module,
    moduleResolution,
    target: ts.ScriptTarget.ES2022,
    lib: ['lib.es2022.d.ts'],
    types: ['node'],
    typeRoots: [path.join(root, 'node_modules', '@types')],
  };
}

/** Where the typed fixture lives, relative to the repository root. */
const TYPED_SURFACE = path.join('tests', 'smoke', 'typed-surface.ts');

/** The names `@cloudbitmaps/roaring` stopped exporting, which `tests/docs/retired-names.test.ts` holds to its own list. */
const LEFT_THE_FLAVOR = path.join('tests', 'docs', 'left-the-flavor.json');

/** The page whose block of derived port types is compiled whole, and the alias that marks the block. */
const DERIVED_FORMS_PAGE = path.join('docs', 'guide', 'api-reference.md');
const DERIVED_FORMS_MARK = "type Storage = CloudRoaringOptions['storage'];";

/**
 * The API reference's block of derived port types, as a probe that compiles it whole and holds each alias to the port
 * its trailing comment names: `type Storage = CloudRoaringOptions['storage']; // StorageBackend | …` must be exactly that
 * union of `@cloudbitmaps/core/driver-kit`'s types. `{ text, where(line) }`, or a problem when the block is not there.
 */
function derivedFormsProbe(root) {
  const { derivedForms, pageText } = require('./doc-imports.cjs');
  const blocks = derivedForms(pageText(root, DERIVED_FORMS_PAGE), DERIVED_FORMS_MARK);
  if (blocks.length !== 1)
    return {
      problem: `${DERIVED_FORMS_PAGE}: ${blocks.length} blocks declare \`${DERIVED_FORMS_MARK}\`, not one`,
    };
  const { body, firstLine, aliases } = blocks[0];
  const lines = body.split('\n');
  if (aliases.length < 4)
    return {
      problem: `${DERIVED_FORMS_PAGE}:${firstLine}: the block holds ${aliases.length} aliases with their port, fewer than 4`,
    };
  const ports = [...new Set(aliases.flatMap((a) => a.port.match(/[A-Z][\w$]*/g) ?? []))].sort();
  const checks = [
    `import type { ${ports.join(', ')} } from '${DRIVER_KIT}';`,
    'type Same<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;',
    ...aliases.map((a, i) => `export const __port_${i}: Same<${a.name}, ${a.port}> = true;`),
  ];
  // A diagnostic in the block is at its own line; one in a check at the line of the alias it checks.
  const where = (line) =>
    `${DERIVED_FORMS_PAGE}:${firstLine + (line < lines.length ? line : (aliases[line - lines.length - 1]?.line ?? 0))}`;
  return { text: `${body}${checks.join('\n')}\n`, where };
}

/**
 * What a reader copies compiles against the built packages, and the flavor's types are the ones the typed fixture
 * names.
 *
 * Every import from a workspace package on the pages a reader copies samples from (the README, the guides, the package
 * READMEs and the site; `scripts/doc-imports.cjs` finds them) is compiled on its own, and so are
 * `tests/smoke/typed-surface.ts` and the API reference's block of derived port types, under NodeNext, Bundler and
 * Node10 resolution with `skipLibCheck` off, as one program per mode resolving the packages by name, as a consumer
 * does. It fails on
 *   (a) any diagnostic in a page's import: a name the package does not export is TS2305 or TS2724, a specifier no
 *       package declares TS2307; each is reported at the page and line the import starts on, and a name the flavor
 *       stopped exporting is said to be one;
 *   (b) a line that starts an import of a workspace package which does not parse, at its page and line;
 *   (c) any diagnostic in the fixture: a kept type the flavor stops exporting, or a typed field that changes type;
 *   (d) any diagnostic in the derived-forms block, an alias that is not exactly the port its comment names among them;
 *   (e) a type `@cloudbitmaps/roaring` exports that the fixture does not name, so the fixture stays a list of all of
 *       them, unless it is a name the flavor stopped exporting, which is reported as one to remove;
 *   (f) fewer imports than a floor, so a scanner that stops matching fails rather than compiling nothing.
 * The imports are compiled alone, not the samples around them. It lives here because it reads `dist/`.
 */
function assertDocImportsCompile() {
  const fs = require('node:fs');
  const ts = require('typescript');
  const { docImportPages, docImports, pageText, unparsedImports } = require('./doc-imports.cjs');
  const root = path.join(__dirname, '..');
  const retired = new Set(JSON.parse(fs.readFileSync(path.join(root, LEFT_THE_FLAVOR), 'utf8')));
  const pages = docImportPages(root).map((page) => ({ page, text: pageText(root, page) }));
  const imports = pages.flatMap(({ page, text }) => docImports(text).map((i) => ({ page, ...i })));
  const FLOOR = 50;
  if (imports.length < FLOOR) {
    throw new Error(
      `smoke: found ${imports.length} imports in the docs, fewer than ${FLOOR}: the scan in scripts/doc-imports.cjs ` +
        'stopped matching, or samples were removed; if they were removed on purpose, lower FLOOR in scripts/smoke.cjs',
    );
  }
  const problems = pages.flatMap(({ page, text }) =>
    unparsedImports(text).map(
      (u) =>
        `${page}:${u.line} starts an import of a workspace package that does not parse: ${u.text}`,
    ),
  );
  const derived = derivedFormsProbe(root);
  if (derived.problem !== undefined) problems.push(derived.problem);
  const fixture = fs.readFileSync(path.join(root, TYPED_SURFACE), 'utf8');
  /** A compiler message, and what to do when it names a name the flavor stopped exporting. */
  const say = (message) => {
    const name = [...message.matchAll(/'([A-Za-z_$][\w$]*)'/g)]
      .map((m) => m[1])
      .find((n) => retired.has(n));
    return name === undefined
      ? message
      : `${message} (${name} left ${PKG}; ${LEFT_THE_FLAVOR} lists it, and tests/docs/retired-names.test.ts says what to use instead)`;
  };
  for (const [mode, [module, moduleResolution, ext]] of Object.entries(consumerModes(ts))) {
    // One virtual file per import, so two pages importing one name do not collide, one for the fixture and one for the
    // derived forms, each at the root so a package resolves by name through the root `node_modules`.
    const virtual = new Map(); // path.resolve(file) -> { text, where(line) }
    imports.forEach((imp, i) => {
      virtual.set(path.resolve(root, `__doc_import_${i}__${ext}`), {
        text: `${imp.statement}\n`,
        where: (line) => `${imp.page}:${imp.line + line}`,
      });
    });
    const fixtureFile = path.resolve(root, `__typed_surface__${ext}`);
    virtual.set(fixtureFile, { text: fixture, where: (line) => `${TYPED_SURFACE}:${line + 1}` });
    if (derived.text !== undefined)
      virtual.set(path.resolve(root, `__derived_forms__${ext}`), {
        text: derived.text,
        where: derived.where,
      });
    const options = consumerOptions(ts, root, module, moduleResolution);
    const host = ts.createCompilerHost(options, true);
    const { fileExists, readFile, getSourceFile } = host;
    const own = (f) => virtual.get(path.resolve(f));
    host.fileExists = (f) => own(f) !== undefined || fileExists.call(host, f);
    host.readFile = (f) => own(f)?.text ?? readFile.call(host, f);
    host.getSourceFile = (f, ...rest) => {
      const v = own(f);
      return v !== undefined
        ? ts.createSourceFile(f, v.text, rest[0], true)
        : getSourceFile.call(host, f, ...rest);
    };
    const program = ts.createProgram([...virtual.keys()], options, host);
    const diagnostics = [
      ...program.getOptionsDiagnostics(),
      ...program.getGlobalDiagnostics(),
      ...program.getSyntacticDiagnostics(),
      ...program.getSemanticDiagnostics(),
    ].filter((d) => !d.file || own(d.file.fileName) !== undefined);
    for (const d of diagnostics) {
      const where = d.file
        ? own(d.file.fileName).where(d.file.getLineAndCharacterOfPosition(d.start ?? 0).line)
        : '(program)';
      problems.push(
        `[${mode}] ${where} TS${d.code}: ${say(ts.flattenDiagnosticMessageText(d.messageText, ' '))}`,
      );
    }
    if (mode === 'nodenext')
      problems.push(...typesTheFixtureLeavesOut(ts, program, fixtureFile, retired));
  }
  if (problems.length > 0) {
    throw new Error(
      `the docs' imports, the derived forms or the typed fixture do not compile against the built packages (${problems.length}):\n  ` +
        problems.join('\n  '),
    );
  }
  console.log(
    `  docs' imports + derived forms + typed fixture compile (nodenext, bundler, node10): ${imports.length} import(s)`,
  );
}

/**
 * Each type `@cloudbitmaps/roaring` exports that the fixture's imports from it do not name: one to add to the fixture,
 * or, when it is a name the flavor stopped exporting (`retired`), an export to remove.
 */
function typesTheFixtureLeavesOut(ts, program, fixtureFile, retired) {
  const checker = program.getTypeChecker();
  const sf = program.getSourceFile(fixtureFile);
  const named = new Set();
  let flavor;
  for (const st of sf?.statements ?? []) {
    if (!ts.isImportDeclaration(st) || st.moduleSpecifier.text !== PKG) continue;
    flavor ??= checker.getSymbolAtLocation(st.moduleSpecifier);
    const bindings = st.importClause?.namedBindings;
    if (bindings !== undefined && ts.isNamedImports(bindings))
      for (const el of bindings.elements) named.add((el.propertyName ?? el.name).text);
  }
  if (flavor === undefined) return [`${TYPED_SURFACE}: imports nothing from ${PKG}`];
  const typesOnly = checker
    .getExportsOfModule(flavor)
    .filter((e) => {
      const target = e.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(e) : e;
      return (
        (target.flags & ts.SymbolFlags.Type) !== 0 && (target.flags & ts.SymbolFlags.Value) === 0
      );
    })
    .map((e) => e.name);
  if (typesOnly.length < 50)
    return [`${PKG}: only ${typesOnly.length} type exports read; the read is broken`];
  return typesOnly
    .filter((name) => !named.has(name))
    .sort()
    .map((name) =>
      retired.has(name)
        ? `${PKG} exports ${name}, a name it stopped exporting (${LEFT_THE_FLAVOR}); remove the export, and do not add it to ${TYPED_SURFACE}`
        : `${TYPED_SURFACE}: does not name ${name}, a type ${PKG} exports; add it to the list`,
    );
}

/** Every package directory in the workspace. */
function packageDirs() {
  return require('node:fs')
    .readdirSync(path.join(__dirname, '..', 'packages'), { withFileTypes: true })
    .filter(
      (e) =>
        e.isDirectory() &&
        require('node:fs').existsSync(
          path.join(__dirname, '..', 'packages', e.name, 'package.json'),
        ),
    )
    .map((e) => e.name)
    .sort();
}

/** Every entry a package declares, as a specifier — derived from its own `exports`, never a written list. */
function entriesOf(pkgDir) {
  const manifest = JSON.parse(
    require('node:fs').readFileSync(
      path.join(__dirname, '..', 'packages', pkgDir, 'package.json'),
      'utf8',
    ),
  );
  const name = manifest.name;
  return Object.keys(manifest.exports ?? { '.': null }).map((k) =>
    k === '.' ? name : `${name}/${k.replace(/^\.\//, '')}`,
  );
}

// The loaded store's whole write path in one call: `store.load()` encodes the ids into one immutable
// `.crbm` generation and publishes it forward-only, and only then can a read see them. So this is also the
// narrowest round-trip that actually exercises the native codec through the built bundle — the ids span two
// 16-bit chunks, so chunk routing and the roaring encode/decode both run rather than a single-container no-op.
async function exerciseCore(label, m) {
  for (const name of ['CloudRoaring', 'MemoryStorage']) {
    if (m[name] == null) throw new Error(`${label}: missing export ${name}`);
  }
  // A BACKEND, which is what the docs tell users to build, so the round-trip goes through the pointer. A raw
  // driver with no registry would leave the pointer path silently dead: a store with one generation
  // list-scans to the same answer, so the round-trip would keep passing. This file is plain CJS, so no
  // compiler would say.
  const store = new m.CloudRoaring({ storage: new m.MemoryStorage({ now: () => 0 }) });
  await store.load({ segment: 'smoke' }, [42, 70_000]);
  const seg = store.segment('smoke');
  const ok = (await seg.has(42)) && (await seg.has(70_000)) && (await seg.count()) === 2;
  if (!ok) throw new Error(`${label}: load/read round-trip returned a wrong result`);
  const { sizeBytes } = await seg.stat();
  if (!(Number.isSafeInteger(sizeBytes) && sizeBytes > 0))
    throw new Error(`${label}: stat() reported no size for a generation it holds: ${sizeBytes}`);
}

/**
 * The tools package loads beside the flavor and prices a report from the size a built `stat()` reports, and its
 * refusal is the `ValidationError` core exports: it takes core's public entry, external like every package's, so one
 * copy of core serves both.
 */
function exerciseTools(label, tools, core, flavor, storageBytes) {
  for (const name of ['estimateCost', 'groundedReport', 'AWS_US_EAST_1_ONDEMAND']) {
    if (tools[name] == null) throw new Error(`${label}: ${TOOLS} is missing export ${name}`);
  }
  const report = tools.groundedReport({ storageBytes, workload: { readsPerSec: 1 } });
  if (!(report.monthlyUSD.total > 0) || report.assumptions.grounded !== true)
    throw new Error(`${label}: ${TOOLS} priced a measured segment wrong`);
  let caught;
  try {
    tools.estimateCost({ segments: [{ sizeBytes: -1 }] });
  } catch (e) {
    caught = e;
  }
  if (!(caught instanceof core.ValidationError) || flavor.errorKind(caught) !== 'ValidationError')
    throw new Error(
      `${label}: ${TOOLS}'s refusal is not core's ValidationError, so it carries its own copy of core`,
    );
  console.log(
    `  ${label}: ${TOOLS} prices a stat().sizeBytes and refuses with core's ValidationError`,
  );
}

/** The size of a one-segment store's generation, through the built flavor's `stat()`. */
async function sizeThroughStat(m) {
  const store = new m.CloudRoaring({ storage: new m.MemoryStorage({ now: () => 0 }) });
  await store.load({ segment: 'priced' }, [1, 2, 3]);
  return (await store.segment('priced').stat()).sizeBytes;
}

/*
 * Cross-COPY error and backend identity — the reason the brands are registered `Symbol.for`s.
 *
 * When two copies of the error classes are in play, a driver throws a *different* class object than the code
 * catching it would `instanceof`-check, and the check silently stops matching — defeating transient-retry
 * and publish-race handling with no error of its own. The brand-based `errorKind` must classify the error
 * anyway. This asserts that against the BUILT packages, where the whole test suite — one source graph —
 * cannot see it. Trigger: the S3 backend validates its `prefix` synchronously in the constructor and
 * throws a ValidationError from its own copy.
 *
 * WHICH BOUNDARY IS LOAD-BEARING. Not the module format: the packages are ESM-only, and `require()` resolves to
 * the same ESM files through `require(esm)`, so BOTH legs load one shared chunk and neither can observe a
 * mismatch — replacing every `Symbol.for(…)` with `Symbol(…)` in the built chunk leaves a format check green.
 *
 * Nor the PACKAGE boundary: the build marks `@cloudbitmaps/*` external, and `assertPackagesShareOneCopy`
 * asserts one copy of core across the packages, so `instanceof` holds and the identity `errorKind`
 * defends is the one a normal install already has.
 *
 * So what these checks pin is that `errorKind` is WIRED UP across a real package boundary — that the
 * built `@cloudbitmaps/s3` throws something `errorKind` classifies, from the flavor and from driver-kit. They do NOT pin
 * the brand's registration: switching a `Symbol.for(…)` to a plain `Symbol(…)` does not turn them red. With one
 * shared copy of core the brand is a single module-level constant that the throwing class and `errorKind`
 * both close over, so symbol identity holds whether or not the symbol is registered, and every
 * assertion below stays green. That property is asserted directly, against the global registry, in
 * `tests/core/error-kind.test.ts` — which is where a claim a build cannot reproduce belongs.
 *
 * Keep both legs running anyway: a future build change that stops sharing the ESM chunk is then covered
 * without anyone remembering to add it.
 */
function exerciseCrossBundleErrors(
  label,
  { core: coreMod, driver: driverMod, flavor: storeMod, driverKit },
) {
  let caught;
  try {
    new driverMod.S3Storage({ bucket: 'b', region: 'us-east-1', prefix: '..' });
  } catch (e) {
    caught = e;
  }
  if (caught === undefined)
    throw new Error(`${label}: expected a ValidationError from the /s3 bundle`);
  // `errorKind` as the flavor exports it and as the driver kit does, the two a consumer and a driver author call.
  for (const [from, errorKind] of [
    ['the flavor', storeMod.errorKind],
    ['driver-kit', driverKit.errorKind],
  ]) {
    if (errorKind(caught) !== 'ValidationError') {
      throw new Error(
        `${label}: errorKind from ${from} failed to classify a driver-bundle error — cross-bundle brand broken`,
      );
    }
  }
  console.log(`  cross-bundle errorKind OK: ${label}`);

  // A registry driver's marked conflict is still a conflict to the flavor, and carries the registered mark a publish
  // built from another copy of core reads.
  const unsettled = driverKit.unsettledConflict('smoke');
  if (
    storeMod.errorKind(unsettled) !== 'WriteConflictError' ||
    unsettled[Symbol.for('cloudbitmaps.error.unsettled-conflict')] !== true
  ) {
    throw new Error(
      `${label}: unsettledConflict from driver-kit is not a marked WriteConflictError`,
    );
  }
  console.log(`  cross-bundle unsettledConflict OK: ${label}`);

  // Same boundary, second brand. A backend built in the driver bundle must be recognised by the store —
  // the whole reason the brand is a registered `Symbol.for` and not a class check or a module-local symbol.
  // Nothing else pins it: switching it to a plain `Symbol()` leaves lint, typecheck and the full suite green
  // while every user of a driver package gets `storage must be a backend` for a backend they just built.
  const s3Backend = new driverMod.S3Storage({ bucket: 'smoke', region: 'us-east-1' });
  if (!coreMod.isStorageBackend(s3Backend)) {
    throw new Error(
      `${label}: a backend from the /s3 bundle is not recognised — cross-copy brand broken`,
    );
  }
  let backendErr;
  try {
    new storeMod.CloudRoaring({ storage: s3Backend });
  } catch (e) {
    backendErr = e;
  }
  if (backendErr !== undefined)
    throw new Error(`${label}: the store rejected an /s3 backend: ${backendErr.message}`);
  console.log(`  cross-bundle backend brand OK: ${label}`);
}

/**
 * Prove our packages share ONE copy of core — the property that makes `instanceof` work across them.
 *
 * The one copy rests on a single line. Each tsconfig maps `@cloudbitmaps/core` through `paths` to core's
 * source and esbuild applies `paths` before deciding externals, so it is `scripts/build.mjs` marking
 * `@cloudbitmaps/*` external that keeps core out of every dependent's bundle. Drop that `external` and every
 * dependent silently inlines core, `instanceof` silently stops matching, and the
 * published `.d.ts` asserts an `extends` that is false at runtime. Nothing else notices —
 * lint, typecheck and the whole suite compile one source graph and cannot see it.
 *
 * `errorKind`, which reads the `Symbol.for` brands, stays the documented way to classify an error even so, because a consumer can
 * still end up with two copies through version skew between our packages, and there `instanceof` fails.
 */
function assertPackagesShareOneCopy(coreMod, flavorMod, driverMod) {
  if (coreMod.ValidationError !== flavorMod.ValidationError) {
    throw new Error(
      'core and the flavor no longer share one copy of the error classes — `@cloudbitmaps/*` has stopped ' +
        'being external in scripts/build.mjs, so each package inlined its own core again. `instanceof` ' +
        'across our packages is now silently false for every consumer.',
    );
  }
  let caught;
  try {
    new driverMod.S3Storage({ bucket: 'b', region: 'us-east-1', prefix: '..' });
  } catch (e) {
    caught = e;
  }
  if (!(caught instanceof coreMod.ValidationError)) {
    throw new Error(
      'an error thrown by the S3 backend is not `instanceof` the class core exports, so the driver ' +
        'package is carrying its own copy of core.',
    );
  }
  console.log('  one shared copy of core: instanceof holds across packages');
}

/*
 * Hard invariant 7, checked against the BUILT files — because that is the only place it is true or false.
 *
 * The eslint rule that enforces "the main entry stays SDK-free" reads STATIC imports. It cannot see
 * `await import('@cloudbitmaps/s3')` (eslint exits 0 on exactly that), and nothing else in the gate reads
 * `dist/` at all. A feature that resolves a driver from a runtime string can put
 * `require("@aws-sdk/client-s3")` into the entry every consumer loads — shipping driver code to people who
 * never touch S3 while the docs say the entry is SDK-free, and the rest of the gate stays green. Under esbuild
 * and webpack, a consumer without the SDKs installed then cannot build at all, including one who never calls
 * the feature: a bundler resolves specifiers before it tree-shakes.
 *
 * WHAT IS CHECKED. For `@cloudbitmaps/core` and `@cloudbitmaps/roaring`: the ESM entry, every module
 * reachable from it (transitively, lazy `import()` included), and the published `.d.ts` tree. A type-only
 * `import('@aws-sdk/client-s3')` in `index.d.ts` is invisible to eslint (it is a `TSImportType`) and is a
 * hard `Cannot find module` for any consumer building with `skipLibCheck: false`.
 *
 * The same sweep runs over every other package that is not a driver, `@cloudbitmaps/tools` among them.
 *
 * THE BUILTIN HALF. Core's main entry names no cloud SDK AND imports no `node:*` builtin, so it loads where no builtin
 * exists (a V8 isolate); `assertEntryBuiltinFree` holds that for core's main entry, `driver-kit` and the tools, by a
 * specifier scan of every reachable built file and a load of the entry bundled for a platform with no builtin, in a
 * context with web globals only. `@cloudbitmaps/core/node` is the one core entry that may reach a builtin.
 *
 * WHAT IS NOT. The three driver packages, which name an SDK because that is what they are for. The boundary is
 * a package name, so this is a list of packages to skip rather than a path prefix to avoid, and core is
 * SDK-free unconditionally.
 */
const { findSdkSpecifiers } = require('./sdk-specifiers.cjs');
const { findSpecifiers, allSpecifiers, EXTENSIONED } = require('./dts-specifiers.cjs');

/**
 * Every `.d.ts` under `dist/`, as a path relative to `dist`. Both sweeps take the whole tree; which
 * PACKAGES each one runs over is decided by the caller, since the SDK sweep skips the driver packages while
 * the specifier sweep covers every package.
 */
function declarationFiles(dist) {
  const { readdirSync } = require('node:fs');
  const out = [];
  const walk = (dir, rel) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const childRel = rel ? path.join(rel, entry.name) : entry.name;
      if (entry.isDirectory()) walk(path.join(dir, entry.name), childRel);
      else if (entry.name.endsWith('.d.ts')) out.push(childRel);
    }
  };
  walk(dist, '');
  return out;
}

/**
 * Everything `entryFile` (a path relative to `dist`) can reach, followed TRANSITIVELY and through lazy `import()` as
 * well as static `from`.
 *
 * One level of static imports would miss a chunk imported by a chunk, or a lazy `import()`; this walk keeps holding
 * if either ever appears.
 */
function reachableFrom(dist, entryFile) {
  const { readFileSync, statSync } = require('node:fs');
  const read = (f) => readFileSync(path.join(dist, f), 'utf8');
  const seen = new Set();
  const queue = [entryFile];
  while (queue.length > 0) {
    const rel = queue.shift();
    if (seen.has(rel)) continue;
    seen.add(rel);
    for (const spec of allSpecifiers(read(rel))) {
      const next = path.normalize(path.join(path.dirname(rel), spec));
      // Stay inside dist/, and only follow real files. Without the first check a stray `../package.json`
      // would be read and reported as a leak, naming the SDKs in `peerDependencies` — an accusation about
      // a file that is not even shipped. Without the second, a directory specifier passes `existsSync`
      // and then throws EISDIR out of `readFileSync`, which names no gate and no cause.
      if (next.startsWith('..')) continue;
      if (!statSync(path.join(dist, next), { throwIfNoEntry: false })?.isFile()) continue;
      queue.push(next);
    }
  }
  return [...seen];
}

/** The built file of each `exports` entry of a package, relative to `dist` and with forward slashes. */
function distEntryFilesOf(pkgDir) {
  const manifest = JSON.parse(
    require('node:fs').readFileSync(
      path.join(__dirname, '..', 'packages', pkgDir, 'package.json'),
      'utf8',
    ),
  );
  return Object.entries(manifest.exports ?? {}).map(([key, target]) => ({
    key,
    file: path.posix.normalize(target.default).replace(/^dist\//, ''),
  }));
}

function assertEntrySdkFree(pkgDir) {
  const { readFileSync } = require('node:fs');
  const dist = path.join(__dirname, '..', 'packages', pkgDir, 'dist');
  const read = (f) => readFileSync(path.join(dist, f), 'utf8');

  // Scoping is a package boundary rather than a chunk boundary: an SDK lives in a driver PACKAGE, which this
  // walk never enters, so there is no driver-only chunk inside core or the flavor for it to have to avoid.
  const indexGraph = reachableFrom(dist, 'index.js');
  // Every entry, not `index.js` alone: a subpath such as core's `/node` holds code the flavor loads at run time.
  const entryGraph = [
    ...new Set([
      ...indexGraph,
      ...distEntryFilesOf(pkgDir).flatMap((e) => reachableFrom(dist, e.file)),
    ]),
  ];

  // `chunkNames: 'chunk-[hash]'` in scripts/build.mjs is an undocumented contract with the literal below.
  // Rename it there and this walk would quietly cover less, so make that loud instead.
  //
  // Only for a package with MORE THAN ONE entry, because only then is there anything to code-split. A
  // single-entry package legitimately emits no chunk — everything lands in `index.js`, so walking that one
  // file already covers the whole reachable graph. Requiring a chunk unconditionally would turn every
  // single-entry package — the flavor is one — into a false alarm saying the build had stopped splitting.
  const entryCount = entriesOf(pkgDir).length;
  if (entryCount > 1 && !indexGraph.some((f) => path.basename(f).startsWith('chunk-'))) {
    throw new Error(
      `@cloudbitmaps/${pkgDir}: dist/index.js reaches no ./chunk-* file although the package declares ` +
        `${entryCount} entries, so the chunk walk covers nothing. Either the build stopped splitting, or ` +
        `\`chunkNames\` in scripts/build.mjs no longer emits \`chunk-\` — update the pattern here to match.`,
    );
  }

  for (const file of [...entryGraph, ...declarationFiles(dist)]) {
    const hits = findSdkSpecifiers(read(file));
    if (hits.length > 0) {
      throw new Error(
        `@cloudbitmaps/${pkgDir}: dist/${file} names a cloud SDK (${hits.join(', ')}).\n` +
          `  An entry outside a driver package must stay SDK-free so \`npm i\` pulls only the backends a consumer actually uses.\n` +
          `  A driver is reached ONLY through its own package (@cloudbitmaps/s3, /gcs, /azure-blob), and the\n` +
          `  no such entry may name the SDK at all — not statically, not via \`import()\`, not in a type.\n` +
          `  If a module of such an entry needs driver behaviour, put the behaviour behind a port in core/ports and\n` +
          `  let the caller inject a driver they imported themselves.`,
      );
    }
  }
  console.log(
    `  entries SDK-free: @cloudbitmaps/${pkgDir} ` +
      `(${entryGraph.length} reachable module(s), ${declarationFiles(dist).length} .d.ts)`,
  );
}

/**
 * The built entries that must load where no Node builtin exists (a V8 isolate): core's main entry and `driver-kit`, and
 * the offline tools. `@cloudbitmaps/core/node` is the one core entry that may reach a builtin, and is not listed.
 */
const RUNTIME_NEUTRAL_ENTRIES = [
  ['core', 'index.js'],
  ['core', 'driver-kit.js'],
  ['tools', 'index.js'],
];

/** The import specifier of a built entry file: `index.js` is the package, any other is a subpath of it. */
function specifierOfEntry(pkgDir, entryFile) {
  const name = `@cloudbitmaps/${pkgDir}`;
  return entryFile === 'index.js' ? name : `${name}/${entryFile.replace(/\.js$/, '')}`;
}

/**
 * Hard invariant 7, the builtin half, against the BUILT files: no module `entryFile` reaches names a `node:*`
 * specifier, and the entry, bundled for a platform with no builtin, loads in a context holding web globals only and
 * exposes exactly the names the real entry does. Each layer catches what the other cannot; see `builtin-free.cjs`.
 */
async function assertEntryBuiltinFree(pkgDir, entryFile) {
  const { readFileSync } = require('node:fs');
  const { findBuiltinSpecifiers, loadWithoutNode } = require('./builtin-free.cjs');
  const dist = path.join(__dirname, '..', 'packages', pkgDir, 'dist');
  const specifier = specifierOfEntry(pkgDir, entryFile);
  const graph = reachableFrom(dist, entryFile);
  for (const file of graph) {
    const hits = findBuiltinSpecifiers(readFileSync(path.join(dist, file), 'utf8'));
    if (hits.length > 0) {
      throw new Error(
        `${specifier}: dist/${file} imports a Node builtin (${hits.join(', ')}).\n` +
          `  A module ${specifier} reaches imports a Node builtin, so it does not load where no builtin exists.\n` +
          (pkgDir === 'core'
            ? `  Export it from @cloudbitmaps/core/node (or put it behind a port), never from this entry.`
            : `  Use an injected seam instead; @cloudbitmaps/${pkgDir} may not import a builtin or core's /node.`),
      );
    }
  }
  const { exports: loaded } = await loadWithoutNode(path.join(dist, entryFile));
  const real = Object.keys(await import(specifier)).sort();
  if (JSON.stringify([...loaded].sort()) !== JSON.stringify(real)) {
    throw new Error(
      `${specifier}: the bundle loaded with no Node builtin exposes ${loaded.length} export(s), the real entry ` +
        `${real.length}, so the neutral load did not cover the whole entry.`,
    );
  }
  console.log(
    `  entry builtin-free: ${specifier} (${graph.length} reachable module(s), ` +
      `loads with no Node builtin, ${loaded.length} exports)`,
  );
}

/**
 * Every `exports` entry of a gated package is on the list, but core's `./node`, so a new subpath cannot skip the gate
 * unnoticed.
 */
function assertRuntimeNeutralCoversGatedPackages() {
  for (const pkgDir of [...new Set(RUNTIME_NEUTRAL_ENTRIES.map(([pkg]) => pkg))]) {
    const wanted = distEntryFilesOf(pkgDir)
      .filter(({ key }) => !(pkgDir === 'core' && key === './node'))
      .map(({ file }) => file)
      .sort();
    const listed = RUNTIME_NEUTRAL_ENTRIES.filter(([pkg]) => pkg === pkgDir)
      .map(([, file]) => file)
      .sort();
    if (JSON.stringify(wanted) !== JSON.stringify(listed)) {
      throw new Error(
        `RUNTIME_NEUTRAL_ENTRIES lists @cloudbitmaps/${pkgDir} entries [${listed.join(', ')}] but its manifest ` +
          `exports [${wanted.join(', ')}] (core's ./node aside). Add the new entry to the list, so it is checked to ` +
          `load with no Node builtin.`,
      );
    }
  }
}

/**
 * No declaration the flavor ships imports the `roaring` package, so no public signature can name one of its types.
 * `deserializePortable` returns the library's own `ReadonlyBitmap`; a signature that named `roaring`'s class again
 * would put `import ... from 'roaring'`, or a `/// <reference types="roaring" />` directive, back into the emitted
 * `.d.ts`, and a consumer without that package's types would see `any`.
 */
function assertNoRoaringTypesInDeclarations(pkgDir) {
  const { readFileSync } = require('node:fs');
  const { namesPackage } = require('./dts-specifiers.cjs');
  const dist = path.join(__dirname, '..', 'packages', pkgDir, 'dist');
  const files = declarationFiles(dist);
  for (const file of files) {
    if (namesPackage(readFileSync(path.join(dist, file), 'utf8'), 'roaring')) {
      throw new Error(
        `@cloudbitmaps/${pkgDir}: dist/${file} imports the \`roaring\` package. No public signature may name one ` +
          `of its types: return the library's own type (see \`ReadonlyBitmap\`).`,
      );
    }
  }
  console.log(
    `  no roaring import in the shipped declarations: @cloudbitmaps/${pkgDir} (${files.length} .d.ts)`,
  );
}

/**
 * The bin must still run when it is reached through a SYMLINK, because that is how it is always reached.
 *
 * Every normal install puts a symlink at `node_modules/.bin/<name>`, and `npx` and every npm script invoke
 * that path. Node resolves a module's `import.meta.url` through symlinks but leaves `process.argv[1]` as
 * typed, so a run-guard comparing the two disagrees with itself and the CLI exits 0 having done nothing.
 * Nothing else would catch that: the guard is module-level, so no unit test reaches it; importing the module
 * (the check above) deliberately must NOT run it; and pnpm writes shell shims that exec the real path, so this
 * repo's own package manager hides the failure while npm and yarn-classic users get silence.
 *
 * Invoked with no configuration, so the CLI's own required-variable error is the signal that it ran at all.
 * Both halves are asserted: a non-zero exit AND the message. Exit code alone would pass if the process died
 * for some unrelated reason, and the message alone would not distinguish running from printing usage.
 */
function assertBinRunsThroughSymlink(bin, binPath) {
  const { symlinkSync, rmSync } = require('node:fs');
  const { spawnSync } = require('node:child_process');
  // The link goes NEXT TO the real file, not in a temp dir. Under `--preserve-symlinks-main` Node resolves
  // the module's own imports relative to the LINK, so a link anywhere else cannot find `roaring` or
  // `@cloudbitmaps/core` and dies with ERR_MODULE_NOT_FOUND before the run-guard is ever consulted — which
  // looks like a failure but tests nothing. `dist/` is generated and gitignored, so writing here is safe.
  const link = path.join(path.dirname(binPath), `.smoke-${bin}-link`);
  rmSync(link, { force: true });
  try {
    symlinkSync(path.basename(binPath), link);
    const run = (args) => spawnSync(process.execPath, args, { encoding: 'utf8' });
    const out = (r) => `${r.stdout ?? ''}${r.stderr ?? ''}`;
    const direct = run([binPath]);
    // Both invocations a real install produces. `--preserve-symlinks-main` is the second because it INVERTS
    // which comparison in the run-guard holds — it stops Node resolving the main entry, so the guard has to
    // accept the unresolved path too. Some monorepo and bundler setups set it in NODE_OPTIONS globally.
    for (const [how, viaLink] of [
      ['a symlink', run([link])],
      ['a symlink under --preserve-symlinks-main', run(['--preserve-symlinks-main', link])],
    ]) {
      assertRanLikeDirect(bin, how, viaLink, direct, out);
    }
    console.log(
      `  cli runs through a symlink (plain + --preserve-symlinks-main): bin/${bin} (exit ${direct.status})`,
    );
  } finally {
    rmSync(link, { force: true });
  }
}

function assertRanLikeDirect(bin, how, viaLink, direct, out) {
  const side = `  via ${how}: ${JSON.stringify(out(viaLink).trim().slice(0, 140))}\n  direct: ${JSON.stringify(out(direct).trim().slice(0, 140))}`;
  if (viaLink.status === 0 || !/CR_EXPORT_ROOT/.test(out(viaLink))) {
    throw new Error(
      `bin/${bin} did not run when invoked through ${how} (exit ${viaLink.status}). The run-guard decides ` +
        `whether this module is the CLI by comparing process.argv[1] with import.meta.url; Node resolves ` +
        `symlinks in one of them and not the other, and which one depends on --preserve-symlinks-main. ` +
        `That is the path npx and every npm script use, so a mismatch means the command silently does ` +
        `nothing.\n${side}`,
    );
  }
  if (viaLink.status !== direct.status || out(viaLink) !== out(direct)) {
    throw new Error(
      `bin/${bin} behaves differently through ${how} (exit ${viaLink.status}) than directly ` +
        `(exit ${direct.status}); they must be identical.\n${side}`,
    );
  }
}

async function main() {
  // First, so a lost or stray declaration is reported by the compiler, not by the narrower checks below.
  assertDeclarationsMatchWhatTscLoads();
  assertDocImportsCompile();
  for (const pkgDir of packageDirs()) {
    for (const specifier of entriesOf(pkgDir)) {
      await import(specifier); // ESM `import` condition
      require(specifier); // CJS `require` condition, which on >=22.12 is `require(esm)`
      console.log(`  import + require OK: ${specifier}`);
    }
  }
  // The bin is built by scripts/build.mjs into dist/bin (its own bundle) and isn't in `exports`,
  // so load it by path. Safe: its run-guard only invokes main() when executed as the CLI, not on import.
  for (const bin of ['export-segments']) {
    const binPath = path.join(__dirname, '..', 'packages', 'roaring', 'dist', 'bin', `${bin}.js`);
    await import(pathToFileURL(binPath).href);
    console.log(`  esm import OK: bin/${bin}.js`);
    assertBinRunsThroughSymlink(bin, binPath);
  }

  await exerciseCore('esm', await import(PKG));
  await exerciseCore('cjs', require(PKG));
  exerciseTools(
    'esm',
    await import(TOOLS),
    await import(CORE),
    await import(PKG),
    await sizeThroughStat(await import(PKG)),
  );
  exerciseTools(
    'cjs',
    require(TOOLS),
    require(CORE),
    require(PKG),
    await sizeThroughStat(require(PKG)),
  );

  // Same-package legs: cheap consistency, and cover for a future build that stops sharing the ESM chunk.
  exerciseCrossBundleErrors('esm', {
    core: await import(CORE),
    driver: await import(S3),
    flavor: await import(PKG),
    driverKit: await import(DRIVER_KIT),
  });
  exerciseCrossBundleErrors('cjs', {
    core: require(CORE),
    driver: require(S3),
    flavor: require(PKG),
    driverKit: require(DRIVER_KIT),
  });
  // The leg that can actually fail: two separately bundled packages, each with its own class copy.
  assertPackagesShareOneCopy(require(CORE), require(PKG), require(S3));
  for (const pkgDir of packageDirs()) {
    // The SDK sweep skips the driver packages — naming an SDK is what they exist for. The specifier check
    // does not: they publish `.d.ts` like everything else.
    if (!DRIVER_PACKAGES.includes(pkgDir)) assertEntrySdkFree(pkgDir);
    if (pkgDir === 'roaring') assertNoRoaringTypesInDeclarations(pkgDir);
    assertDtsSpecifiers(pkgDir);
    assertSubpathsResolveWithoutExports(pkgDir);
  }
  assertRuntimeNeutralCoversGatedPackages();
  for (const [pkgDir, entryFile] of RUNTIME_NEUTRAL_ENTRIES) {
    await assertEntryBuiltinFree(pkgDir, entryFile);
  }

  console.log(
    'smoke: ESM + CJS import (via exports map) + roaring round-trip + cross-bundle errors + SDK-free and builtin-free entries OK',
  );
}

main().catch((e) => {
  console.error('smoke FAILED:', e && e.message ? e.message : e);
  process.exit(1);
});
