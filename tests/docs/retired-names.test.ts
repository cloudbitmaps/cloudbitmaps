import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as core from '@cloudbitmaps/core';
import * as roaring from '@/index';

/**
 * Names the library does not export stay out of it: out of both packages' runtime surface, and out of every
 * page a reader follows, prose and code samples alike. A doc that names a removed export reads as API that
 * exists, and a sample that calls one fails on the first line a reader copies.
 *
 * The API reference's export index is already held to the barrels in both directions; this covers every other
 * page, where nothing compared a name to the surface. A name with no use left in any code (`code: true`) is refused
 * in the code as well, comments included: a doc-comment ships in the published `.d.ts` and reaches a reader on
 * hover. The loader `store.load()` is built on keeps its name inside `packages/core/src/core/`, and the tests call
 * it through a helper, so its names are read only in the pages, where the pages under `tests/` are read too. The
 * changelog and the changesets are not read: their entries name a removal to announce it. Nor is this file, whose
 * list and fixtures are the names it refuses.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SELF = relative(ROOT, fileURLToPath(import.meta.url));

/** What a reader who wanted the retrying driver wrappers uses instead. */
const RETRY_INSTEAD =
  "the store's `retry` option, which retries every read of segment data; to retry a write, re-run the call, " +
  'and compare `store.generations(ref)` with what it listed before to learn whether a failed one landed, rather ' +
  'than replaying it';

/** Each removed name, what a reader uses instead, and whether any code may still name it. */
const RETIRED: ReadonlyArray<{ name: string; instead: string; code?: true }> = [
  {
    name: 'bulkLoadCrbmGeneration',
    instead: '`store.load()`, or `loadSegment()` with your own drivers',
  },
  { name: 'BulkLoadResult', instead: '`LoadResult`' },
  { name: 'becameCurrent', instead: "`LoadResult`'s `published`" },
  { name: 'RetryingStorageDriver', instead: RETRY_INSTEAD, code: true },
  { name: 'RetryingRegistryDriver', instead: RETRY_INSTEAD, code: true },
];

const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage', '.git', '.worktrees', '.changeset']);
/** A page is anything a reader opens: markdown, HTML, and the plain-text pages the site serves. */
const PAGE_EXTS = ['.md', '.html', '.txt'];
/** Code: the sources, the tests, the scripts and the benches, whose comments and strings are read with it. */
const CODE_EXTS = ['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs'];
const SKIP_FILES = new Set(['CHANGELOG.md']);

function files(exts: readonly string[]): string[] {
  const out: string[] = [];
  const walk = (rel: string): void => {
    for (const entry of readdirSync(join(ROOT, rel))) {
      if (SKIP_DIRS.has(entry) || SKIP_FILES.has(entry)) continue;
      const childRel = rel === '.' ? entry : join(rel, entry);
      if (statSync(join(ROOT, childRel)).isDirectory()) walk(childRel);
      else if (exts.some((e) => entry.endsWith(e)) && childRel !== SELF) out.push(childRel);
    }
  };
  walk('.');
  return out.sort();
}
const pages = (): string[] => files(PAGE_EXTS);
const codeFiles = (): string[] => files(CODE_EXTS);

/** Every name from `names` (all of them by default) in `text`, as a whole word, with its line. */
export function retiredNames(
  text: string,
  names: ReadonlyArray<{ name: string }> = RETIRED,
): Array<{ line: number; name: string }> {
  const found: Array<{ line: number; name: string }> = [];
  text.split('\n').forEach((line, i) => {
    for (const { name } of names) {
      if (new RegExp(`(?<![\\w$])${name}(?![\\w$])`).test(line)) found.push({ line: i + 1, name });
    }
  });
  return found;
}

/** `file:line names X; use Y` for every name from `names` that `paths` contain. */
function offenders(paths: readonly string[], names: ReadonlyArray<{ name: string }>): string[] {
  const out: string[] = [];
  for (const path of paths) {
    for (const { line, name } of retiredNames(readFileSync(join(ROOT, path), 'utf8'), names)) {
      const instead = RETIRED.find((r) => r.name === name)?.instead ?? '';
      out.push(`${path}:${line} names ${name}; use ${instead}`);
    }
  }
  return out;
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
    expect(typeof core.RetryingStorageChunkSource).toBe('function');
    expect(typeof roaring.RetryingStorageChunkSource).toBe('function');
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
    expect(offenders(pages(), RETIRED)).toEqual([]);
  });

  it('reads the code, so the check below cannot pass vacuously', () => {
    const read = codeFiles();
    for (const file of [
      join('packages', 'core', 'src', 'index.ts'),
      join('packages', 'roaring', 'src', 'index.ts'),
      join('packages', 'core', 'src', 'drivers', 'retry', 'retrying-chunk-source.ts'),
      join('tests', 'drivers', 'retry', 'retrying-chunk-source.test.ts'),
    ]) {
      expect(read).toContain(file);
    }
    expect(read).not.toContain(SELF);
  });

  it('no code names one that has no use left in code, comments included', () => {
    expect(
      offenders(
        codeFiles(),
        RETIRED.filter((r) => r.code === true),
      ),
    ).toEqual([]);
  });

  it('finds a name in prose and in a sample, and passes a longer name that contains one', () => {
    expect(retiredNames('call `bulkLoadCrbmGeneration(driver, key, ids)`')).toHaveLength(1);
    expect(retiredNames('const r: BulkLoadResult = await load();')).toHaveLength(1);
    expect(retiredNames('if (r.becameCurrent) publish();')).toHaveLength(1);
    expect(retiredNames('myBulkLoadResultShape and becameCurrentGen')).toEqual([]);
    expect(retiredNames('`store.load()` returns a `LoadResult`')).toEqual([]);
    expect(retiredNames('new RetryingStorageDriver(inner, opts)')).toHaveLength(1);
    expect(retiredNames('wrap it in `RetryingRegistryDriver`')).toHaveLength(1);
    expect(
      retiredNames(' * wrapped in a {@link RetryingRegistryDriver}, the scan buffers'),
    ).toHaveLength(1);
    // The read wrapper the store builds shares their prefix and stays, and so do longer names containing one.
    expect(retiredNames('new RetryingStorageChunkSource(source, opts)')).toEqual([]);
    expect(retiredNames('MyRetryingRegistryDriver or RetryingStorageDriverOptions')).toEqual([]);
  });
});
