import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';

/*
 * Architectural lint, part 1: no circular imports anywhere under packages/*\/src.
 *
 * This used to be dependency-cruiser's `no-circular` rule. It is a plain test now: the graph is the set of
 * static `import`/`export … from`/`import()` specifiers in every .ts source file, resolved the way the
 * bundler resolves them (relative paths, the `@/…` core self-alias, and `@cloudbitmaps/core[/…]`), type-only
 * imports included — a type cycle is still a cycle for the declaration emitter.
 *
 * The detector is a pure function so the test can prove it fires on a planted cycle (rule 31: a check whose
 * expected value is the same with the detector broken is not a check).
 */
const ROOT = path.resolve(__dirname, '..', '..');
const CORE = path.join(ROOT, 'packages', 'core', 'src');
/**
 * Every package's `src`, derived — the gate named two while the workspace had five, so 18 files in the
 * driver packages were unchecked and its own `describe` ("no circular imports under packages/*\/src") was
 * describing more than it did. Deriving is also how the split stopped costing edits elsewhere.
 */
const PACKAGE_SRCS = readdirSync(path.join(ROOT, 'packages'), { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => path.join(ROOT, 'packages', e.name, 'src'))
  .filter((p) => existsSync(p))
  .sort();

/** `@cloudbitmaps/<name>` → that package's `src`, read from the manifests rather than listed here. */
const WORKSPACE_SRCS = new Map<string, string>(
  readdirSync(path.join(ROOT, 'packages'), { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .flatMap((e) => {
      const manifest = path.join(ROOT, 'packages', e.name, 'package.json');
      const src = path.join(ROOT, 'packages', e.name, 'src');
      if (!existsSync(manifest) || !existsSync(src)) return [];
      const { name } = JSON.parse(readFileSync(manifest, 'utf8')) as { name: string };
      return [[name, src] as const];
    }),
);

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith('.ts') && !p.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

const SPEC =
  /(?:^|\n)\s*(?:import|export)\b[^'"`]*?\bfrom\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)|(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g;

export function specifiers(source: string): string[] {
  const out: string[] = [];
  for (const m of source.matchAll(SPEC)) out.push((m[1] ?? m[2] ?? m[3]) as string);
  return out;
}

function asFile(base: string): string | null {
  // `.js` is stripped because a `nodenext` migration REQUIRES it on relative specifiers, and on that day
  // every relative edge here would resolve to null — silently, since a dropped edge is just not pushed. The
  // graph would become isolated nodes, `findCycle` would return null, and the only sanity guard
  // (`graph.size > 50`) counts FILES, not edges, so it would still pass. Hence both this and the edge-count
  // assertion in the suite below.
  const withoutJs = base.replace(/\.js$/, '');
  for (const cand of [
    base,
    `${base}.ts`,
    path.join(base, 'index.ts'),
    `${withoutJs}.ts`,
    path.join(withoutJs, 'index.ts'),
  ]) {
    if (existsSync(cand) && statSync(cand).isFile()) return cand;
  }
  return null;
}

export function resolveSpecifier(fromFile: string, spec: string): string | null {
  if (spec.startsWith('.')) return asFile(path.resolve(path.dirname(fromFile), spec));
  if (spec.startsWith('@/')) return asFile(path.join(CORE, spec.slice(2)));
  if (spec === '@cloudbitmaps/core') return asFile(path.join(CORE, 'index.ts'));
  if (spec.startsWith('@cloudbitmaps/core/'))
    return asFile(path.join(CORE, spec.slice('@cloudbitmaps/core/'.length)));
  // Every OTHER workspace package, so a cross-package edge into one is part of the graph rather than
  // invisible. This was a hardcoded ['s3', 'gcs', 'azure-blob'] directly under a comment warning that
  // "a cycle running flavor → driver → core → flavor would simply not be seen" — with `roaring`, the flavor
  // in that very sentence, missing from the list. Deriving the names from the manifests is what makes the
  // comment true, and a sixth package is covered the day it is added.
  const src = WORKSPACE_SRCS.get(spec.split('/').slice(0, 2).join('/'));
  if (src === undefined) return null; // a third-party package or a builtin — not part of the graph
  const rest = spec.split('/').slice(2).join('/');
  return asFile(rest === '' ? path.join(src, 'index.ts') : path.join(src, rest));
}

/** Returns one cycle as a path of node ids (first === last), or null when the graph is acyclic. */
export function findCycle(graph: ReadonlyMap<string, readonly string[]>): string[] | null {
  const WHITE = 0,
    GREY = 1,
    BLACK = 2;
  const color = new Map<string, number>();
  const stack: string[] = [];
  const visit = (n: string): string[] | null => {
    color.set(n, GREY);
    stack.push(n);
    for (const m of graph.get(n) ?? []) {
      const c = color.get(m) ?? WHITE;
      if (c === GREY) return [...stack.slice(stack.indexOf(m)), m];
      if (c === WHITE) {
        const found = visit(m);
        if (found) return found;
      }
    }
    stack.pop();
    color.set(n, BLACK);
    return null;
  };
  for (const n of graph.keys()) {
    if ((color.get(n) ?? WHITE) === WHITE) {
      const found = visit(n);
      if (found) return found;
    }
  }
  return null;
}

function buildGraph(): Map<string, string[]> {
  const graph = new Map<string, string[]>();
  for (const file of PACKAGE_SRCS.flatMap((d) => walk(d))) {
    const deps: string[] = [];
    for (const spec of specifiers(readFileSync(file, 'utf8'))) {
      const target = resolveSpecifier(file, spec);
      if (target) deps.push(target);
    }
    graph.set(file, deps);
  }
  return graph;
}

describe('architecture: no circular imports under packages/*/src', () => {
  it('the detector fires on a planted cycle (so a green run means something)', () => {
    const planted = new Map<string, string[]>([
      ['a', ['b']],
      ['b', ['c']],
      ['c', ['a']],
      ['d', ['a']],
    ]);
    expect(findCycle(planted)).toEqual(['a', 'b', 'c', 'a']);
    expect(
      findCycle(
        new Map([
          ['a', ['b']],
          ['b', []],
        ]),
      ),
    ).toBeNull();
  });

  it('the specifier scanner sees static, type-only, side-effect and dynamic imports', () => {
    const src = [
      "import { x } from './a';",
      "import type { T } from './b';",
      "export * from './c';",
      "export { y } from '@/core/d';",
      "import './e';",
      "const m = await import('./f');",
      "import z from '@cloudbitmaps/s3';",
    ].join('\n');
    expect(specifiers(src)).toEqual([
      './a',
      './b',
      './c',
      '@/core/d',
      './e',
      './f',
      '@cloudbitmaps/s3',
    ]);
  });

  it('resolves the way the bundler does, and treats packages/builtins as outside the graph', () => {
    const from = path.join(CORE, 'core', 'engine.ts');
    expect(resolveSpecifier(from, './ports')).toBe(path.join(CORE, 'core', 'ports.ts'));
    expect(resolveSpecifier(from, '@/core/errors')).toBe(path.join(CORE, 'core', 'errors.ts'));
    expect(resolveSpecifier(from, '@cloudbitmaps/core')).toBe(path.join(CORE, 'index.ts'));
    expect(resolveSpecifier(from, 'node:crypto')).toBeNull();
    // `roaring` the npm addon, NOT `@cloudbitmaps/roaring` — one is outside the graph, the other is in it.
    expect(resolveSpecifier(from, 'roaring')).toBeNull();
    expect(resolveSpecifier(from, '@cloudbitmaps/roaring')).toBe(
      path.join(ROOT, 'packages', 'roaring', 'src', 'index.ts'),
    );
    expect(resolveSpecifier(from, '@cloudbitmaps/s3')).toBe(
      path.join(ROOT, 'packages', 's3', 'src', 'index.ts'),
    );
    expect(resolveSpecifier(from, '@cloudbitmaps/core/driver-kit')).toBe(
      path.join(CORE, 'driver-kit.ts'),
    );
    // A workspace name that does not exist stays outside the graph rather than resolving to something.
    expect(resolveSpecifier(from, '@cloudbitmaps/nope')).toBeNull();
  });

  it('the real source graph is acyclic', () => {
    const graph = buildGraph();
    expect(graph.size).toBeGreaterThan(50); // the walk found the code (guards against a silently empty graph)
    // …and that it found the EDGES. `graph.size` counts files, so a resolver that silently dropped every
    // relative specifier would leave 80 isolated nodes, no cycle, and this test green. Only an edge count
    // can see that.
    const edges = [...graph.values()].reduce((n, deps) => n + deps.length, 0);
    expect(
      edges,
      'the graph has nodes but almost no edges — the resolver is dropping specifiers',
    ).toBeGreaterThan(200);
    const cycle = findCycle(graph);
    expect(
      cycle,
      cycle ? `cycle:\n  ${cycle.map((f) => path.relative(ROOT, f)).join('\n  → ')}` : '',
    ).toBeNull();
  });
});
