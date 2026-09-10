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
const ROARING = path.join(ROOT, 'packages', 'roaring', 'src');

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
  for (const cand of [base, `${base}.ts`, path.join(base, 'index.ts')]) {
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
  return null; // a package or a builtin — not part of the graph
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
  for (const file of [...walk(CORE), ...walk(ROARING)]) {
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
      "import z from '@cloudbitmaps/core/s3';",
    ].join('\n');
    expect(specifiers(src)).toEqual([
      './a',
      './b',
      './c',
      '@/core/d',
      './e',
      './f',
      '@cloudbitmaps/core/s3',
    ]);
  });

  it('resolves the way the bundler does, and treats packages/builtins as outside the graph', () => {
    const from = path.join(CORE, 'core', 'engine.ts');
    expect(resolveSpecifier(from, './ports')).toBe(path.join(CORE, 'core', 'ports.ts'));
    expect(resolveSpecifier(from, '@/core/errors')).toBe(path.join(CORE, 'core', 'errors.ts'));
    expect(resolveSpecifier(from, '@cloudbitmaps/core')).toBe(path.join(CORE, 'index.ts'));
    expect(resolveSpecifier(from, 'node:crypto')).toBeNull();
    expect(resolveSpecifier(from, 'roaring')).toBeNull();
  });

  it('the real source graph is acyclic', () => {
    const graph = buildGraph();
    expect(graph.size).toBeGreaterThan(50); // the walk found the code (guards against a silently empty graph)
    const cycle = findCycle(graph);
    expect(
      cycle,
      cycle ? `cycle:\n  ${cycle.map((f) => path.relative(ROOT, f)).join('\n  → ')}` : '',
    ).toBeNull();
  });
});
