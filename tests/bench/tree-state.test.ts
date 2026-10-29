import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * How a bench decides `tree` (`bench/lib/tree-state.cjs`): the bench's own results file alone leaves the tree clean, any
 * other change leaves it dirty and is named in the pass, and the pass's tree fields are read back by the gates.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const lib = createRequire(join(ROOT, 'bench', 'sizing.cjs'))('./lib/tree-state.cjs') as {
  PATH_CAP: number;
  pathsOfPorcelain: (out: string) => string[];
  treeState: (a: { root: string; record: string }) => {
    tree: string;
    dirtyPaths?: string[];
    dirtyTotal?: number;
  };
  treeProblems: (label: string, environment: unknown) => string[];
};

const RECORD = 'bench/ts-codec-paired-results.json';
const made: string[] = [];
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

const git = (root: string, ...args: string[]) =>
  execFileSync(
    'git',
    ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args],
    {
      encoding: 'utf8',
    },
  );

/** A committed repo holding the record, a source file under `packages/`, another bench file and a lockfile. */
function repo(): string {
  const root = mkdtempSync(join(tmpdir(), 'tree-state-'));
  made.push(root);
  git(root, 'init', '-q');
  const files: [string, string][] = [
    [RECORD, '{"passes":[]}\n'],
    ['packages/roaring/src/a.ts', 'export const a = 1;\n'],
    ['bench/other.cjs', '// other\n'],
    ['pnpm-lock.yaml', 'lock: 1\n'],
  ];
  for (const [file, text] of files) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  }
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'base');
  return root;
}

const state = (root: string) => lib.treeState({ root, record: join(root, RECORD) });

describe('a bench’s own record is not a dirty tree', () => {
  it('is clean on a fresh checkout', () => {
    expect(state(repo())).toEqual({ tree: 'clean' });
  });

  it('stays clean when only the bench’s own results file changed (edited, staged, or not yet tracked)', () => {
    const root = repo();
    writeFileSync(join(root, RECORD), '{"passes":[1]}\n');
    expect(state(root)).toEqual({ tree: 'clean' });
    git(root, 'add', RECORD);
    expect(state(root)).toEqual({ tree: 'clean' });
    git(root, 'rm', '-q', '--cached', RECORD);
    expect(state(root)).toEqual({ tree: 'clean' });
  });

  it('takes the record as a path relative to the root or absolute alike', () => {
    const root = repo();
    writeFileSync(join(root, RECORD), 'x\n');
    expect(lib.treeState({ root, record: RECORD })).toEqual({ tree: 'clean' });
    expect(lib.treeState({ root, record: join(root, RECORD) })).toEqual({ tree: 'clean' });
  });

  it('is dirty, and names both paths, when the record changed together with a file under packages/', () => {
    const root = repo();
    writeFileSync(join(root, RECORD), '{"passes":[1]}\n');
    writeFileSync(join(root, 'packages/roaring/src/a.ts'), 'export const a = 2;\n');
    expect(state(root)).toEqual({
      tree: 'dirty',
      dirtyPaths: [RECORD, 'packages/roaring/src/a.ts'].sort(),
      dirtyTotal: 2,
    });
  });

  it.each([
    ['a tracked source', 'packages/roaring/src/a.ts', 'export const a = 3;\n'],
    ['another bench file', 'bench/other.cjs', '// changed\n'],
    ['the lockfile', 'pnpm-lock.yaml', 'lock: 2\n'],
    ['an untracked file', 'scratch.txt', 'x\n'],
    ['an untracked file under packages/', 'packages/roaring/src/new.ts', 'x\n'],
    ['a different results file', 'bench/bitmap-api-results.json', '{}\n'],
  ])('is dirty for %s alone', (_n, file, text) => {
    const root = repo();
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
    expect(state(root)).toEqual({ tree: 'dirty', dirtyPaths: [file], dirtyTotal: 1 });
  });

  it('is dirty for a deleted file and names both ends of a rename', () => {
    const root = repo();
    rmSync(join(root, 'bench/other.cjs'));
    expect(state(root).dirtyPaths).toEqual(['bench/other.cjs']);
    git(root, 'checkout', '-q', '--', 'bench/other.cjs');
    renameSync(join(root, 'bench/other.cjs'), join(root, 'bench/moved.cjs'));
    git(root, 'add', '-A');
    expect(state(root)).toEqual({
      tree: 'dirty',
      dirtyPaths: ['bench/moved.cjs', 'bench/other.cjs'],
      dirtyTotal: 2,
    });
  });

  it('names paths with spaces whole, and every file of an untracked folder', () => {
    const root = repo();
    mkdirSync(join(root, 'new dir'));
    writeFileSync(join(root, 'new dir/a b.txt'), 'x\n');
    writeFileSync(join(root, 'new dir/c.txt'), 'x\n');
    expect(state(root).dirtyPaths).toEqual(['new dir/a b.txt', 'new dir/c.txt']);
  });

  it('caps the named paths, sorted, and records the total', () => {
    const root = repo();
    for (let i = 0; i < lib.PATH_CAP + 5; i++) {
      writeFileSync(join(root, `stray-${String(i).padStart(3, '0')}.txt`), 'x\n');
    }
    const s = state(root);
    expect(s.dirtyTotal).toBe(lib.PATH_CAP + 5);
    expect(s.dirtyPaths).toHaveLength(lib.PATH_CAP);
    expect(s.dirtyPaths).toEqual([...s.dirtyPaths!].sort());
    expect(s.dirtyPaths![0]).toBe('stray-000.txt');
  });

  it('says unknown where git cannot say', () => {
    const outside = mkdtempSync(join(tmpdir(), 'tree-state-nogit-'));
    made.push(outside);
    expect(lib.treeState({ root: outside, record: RECORD })).toEqual({ tree: 'unknown' });
  });
});

describe('the gates read the tree fields of a pass', () => {
  const problems = (environment: unknown) => lib.treeProblems('pass 1', environment);

  it('accepts a clean pass, a dirty pass of an earlier record (no paths), and a dirty pass that names its paths', () => {
    expect(problems({ tree: 'clean' })).toEqual([]);
    expect(problems({ tree: 'dirty' })).toEqual([]);
    expect(problems({ tree: 'unknown' })).toEqual([]);
    expect(problems({ tree: 'dirty', dirtyPaths: ['a', 'b'], dirtyTotal: 2 })).toEqual([]);
    expect(problems(undefined)).toEqual([]);
  });

  it('accepts a capped list with a larger total', () => {
    const paths = Array.from({ length: lib.PATH_CAP }, (_, i) => `f${String(i).padStart(2, '0')}`);
    expect(problems({ tree: 'dirty', dirtyPaths: paths, dirtyTotal: 99 })).toEqual([]);
  });

  it.each([
    ['paths on a clean tree', { tree: 'clean', dirtyPaths: ['a'], dirtyTotal: 1 }],
    ['paths without a total', { tree: 'dirty', dirtyPaths: ['a'] }],
    ['an empty list', { tree: 'dirty', dirtyPaths: [], dirtyTotal: 0 }],
    ['unsorted paths', { tree: 'dirty', dirtyPaths: ['b', 'a'], dirtyTotal: 2 }],
    ['a total below the paths named', { tree: 'dirty', dirtyPaths: ['a', 'b'], dirtyTotal: 1 }],
    ['a short list with a larger total', { tree: 'dirty', dirtyPaths: ['a'], dirtyTotal: 5 }],
    ['a non-string path', { tree: 'dirty', dirtyPaths: [1], dirtyTotal: 1 }],
  ])('refuses %s', (_n, environment) => {
    expect(problems(environment)).toHaveLength(1);
  });
});
