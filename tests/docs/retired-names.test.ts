import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as core from '@cloudbitmaps/core';
import * as roaring from '@/index';

/**
 * Names the library does not export stay out of it: out of both packages' runtime surface, and out of every
 * page a reader follows, prose and code samples alike. A doc that names a removed export reads as API that
 * exists, and a sample that calls one fails on the first line a reader copies.
 *
 * The API reference's export index is already held to the barrels in both directions; this covers every other
 * page, where nothing compared a name to the surface. The loader `store.load()` is built on keeps its name inside
 * `packages/core/src/core/`, and the tests call it through a helper, so the code is not read here, while the pages
 * under `tests/` are. The changelog and the changesets are not read either: their entries name a removal to
 * announce it.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** Each removed name, and what a reader uses instead. */
const RETIRED: ReadonlyArray<{ name: string; instead: string }> = [
  {
    name: 'bulkLoadCrbmGeneration',
    instead: '`store.load()`, or `loadSegment()` with your own drivers',
  },
  { name: 'BulkLoadResult', instead: '`LoadResult`' },
  { name: 'becameCurrent', instead: "`LoadResult`'s `published`" },
];

const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage', '.git', '.worktrees', '.changeset']);
/** A page is anything a reader opens: markdown, HTML, and the plain-text pages the site serves. */
const PAGE_EXTS = ['.md', '.html', '.txt'];
const SKIP_FILES = new Set(['CHANGELOG.md']);

function pages(): string[] {
  const out: string[] = [];
  const walk = (rel: string): void => {
    for (const entry of readdirSync(join(ROOT, rel))) {
      if (SKIP_DIRS.has(entry) || SKIP_FILES.has(entry)) continue;
      const childRel = rel === '.' ? entry : join(rel, entry);
      if (statSync(join(ROOT, childRel)).isDirectory()) walk(childRel);
      else if (PAGE_EXTS.some((e) => entry.endsWith(e))) out.push(childRel);
    }
  };
  walk('.');
  return out.sort();
}

/** Every retired name in `text`, as a whole word, with its line. */
export function retiredNames(text: string): Array<{ line: number; name: string }> {
  const found: Array<{ line: number; name: string }> = [];
  text.split('\n').forEach((line, i) => {
    for (const { name } of RETIRED) {
      if (new RegExp(`(?<![\\w$])${name}(?![\\w$])`).test(line)) found.push({ line: i + 1, name });
    }
  });
  return found;
}

describe('a removed export is named nowhere a reader looks', () => {
  it('neither package exports one at runtime', () => {
    for (const { name } of RETIRED) {
      expect(name in core, `@cloudbitmaps/core exports ${name}`).toBe(false);
      expect(name in roaring, `@cloudbitmaps/roaring exports ${name}`).toBe(false);
    }
    // What replaces them is there, so the check above cannot pass on a barrel that failed to load.
    expect(typeof core.loadSegment).toBe('function');
    expect(typeof roaring.loadSegment).toBe('function');
  });

  it('reads the pages, so the check below cannot pass vacuously', () => {
    const read = pages();
    for (const page of [
      'README.md',
      join('docs', 'guide', 'getting-started.md'),
      join('docs', 'guide', 'api-reference.md'),
    ]) {
      expect(existsSync(join(ROOT, page))).toBe(true);
      expect(read).toContain(page);
    }
  });

  it('no page names one', () => {
    const offenders: string[] = [];
    for (const page of pages()) {
      for (const { line, name } of retiredNames(readFileSync(join(ROOT, page), 'utf8'))) {
        const instead = RETIRED.find((r) => r.name === name)?.instead ?? '';
        offenders.push(`${page}:${line} names ${name}; use ${instead}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('finds a name in prose and in a sample, and passes a longer name that contains one', () => {
    expect(retiredNames('call `bulkLoadCrbmGeneration(driver, key, ids)`')).toHaveLength(1);
    expect(retiredNames('const r: BulkLoadResult = await load();')).toHaveLength(1);
    expect(retiredNames('if (r.becameCurrent) publish();')).toHaveLength(1);
    expect(retiredNames('myBulkLoadResultShape and becameCurrentGen')).toEqual([]);
    expect(retiredNames('`store.load()` returns a `LoadResult`')).toEqual([]);
  });
});
