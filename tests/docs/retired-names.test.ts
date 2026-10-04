import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as core from '@cloudbitmaps/core';
import * as driverKit from '@cloudbitmaps/core/driver-kit';
import * as roaring from '@/index';
import * as s3 from '@cloudbitmaps/s3';
import * as gcs from '@cloudbitmaps/gcs';
import * as azureBlob from '@cloudbitmaps/azure-blob';

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

/** What a reader who wanted the generation write and collection primitives uses instead. */
const GENERATION_INSTEAD =
  '`store.load()` (or `loadSegment()` with your own drivers), which numbers, writes, publishes and collects; ' +
  '`keep` on it and on the `*Into` verbs for the collection; `store.dropSegment()` or the retention sweep to retire a segment';

/** What a reader who wanted a driver's internal helper uses instead: there is none, the drivers own them. */
const DRIVER_INTERNAL_INSTEAD = 'nothing: it is internal to the driver packages';

/**
 * What a reader who wanted a half of a backend uses instead. The halves are internal: an application gets both from
 * one backend class, with the size settings as that class's options, and a driver author pairs halves of their own
 * with `brandAsBackend`.
 */
const HALVES_INSTEAD =
  'a backend class (`MemoryStorage`, `LocalFsStorage`, `S3Storage`, `GcsStorage`, `AzureBlobStorage`), which builds ' +
  'both halves and takes the size settings as its own options; a driver author pairs halves of their own with `brandAsBackend` from `@cloudbitmaps/core/driver-kit`';

/** The halves and their options types, by package. */
const HALVES: Readonly<Record<string, readonly string[]>> = {
  '@cloudbitmaps/core': [
    'MemoryStorageDriver',
    'MemoryRegistryDriver',
    'MemoryRegistryDriverOptions',
    'LocalFsStorageDriver',
    'LocalFsRegistryDriver',
    'LocalFsRegistryDriverOptions',
    'createBackend',
  ],
  '@cloudbitmaps/s3': [
    'S3StorageDriver',
    'S3StorageDriverOptions',
    'S3RegistryDriver',
    'S3RegistryDriverOptions',
  ],
  '@cloudbitmaps/gcs': [
    'GcsStorageDriver',
    'GcsStorageDriverOptions',
    'GcsRegistryDriver',
    'GcsRegistryDriverOptions',
  ],
  '@cloudbitmaps/azure-blob': [
    'AzureBlobStorageDriver',
    'AzureBlobStorageDriverOptions',
    'AzureBlobRegistryDriver',
    'AzureBlobRegistryDriverOptions',
  ],
};

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
  { name: 'TimeoutError', instead: '`TransientError`' },
  { name: 'AuditEventKind', instead: "`AuditEvent['kind']`", code: true },
  { name: 'DEFAULT_PRICING', instead: '`AWS_US_EAST_1_ONDEMAND`', code: true },
  { name: 'MemoryStorageChunkSource', instead: '`MemoryStorage`' },
  { name: 'writeCrbmGeneration', instead: GENERATION_INSTEAD },
  { name: 'publishGeneration', instead: GENERATION_INSTEAD },
  { name: 'nextGeneration', instead: GENERATION_INSTEAD },
  { name: 'gcOrphanGenerations', instead: GENERATION_INSTEAD },
  { name: 'GenerationDeps', instead: GENERATION_INSTEAD },
  { name: 'SafeBitmap', instead: 'nothing: the flavor binds its codec for you' },
  { name: 'roaringCodec', instead: 'nothing: the flavor binds its codec for you' },
  { name: 'registryPrefix', instead: DRIVER_INTERNAL_INSTEAD },
  { name: 'registryObjectKey', instead: DRIVER_INTERNAL_INSTEAD },
  { name: 'registryListPrefix', instead: DRIVER_INTERNAL_INSTEAD },
  { name: 'parseRegistryKey', instead: DRIVER_INTERNAL_INSTEAD },
  { name: 'isSdkRetryable', instead: DRIVER_INTERNAL_INSTEAD },
  { name: 'isNetworkOrTimeout', instead: DRIVER_INTERNAL_INSTEAD },
  { name: 'isServerSide', instead: DRIVER_INTERNAL_INSTEAD },
  ...Object.values(HALVES)
    .flat()
    .map((name) => ({ name, instead: HALVES_INSTEAD })),
];

/**
 * Names that left a public entry but are still what a page or a sample legitimately names: `VERSION` is a word
 * the release docs use for other things, and these three live on the `driver-kit` subpath now, where the API
 * reference lists them. They are held to the runtime surface only: off both main entries.
 */
const OFF_THE_MAIN_ENTRIES = [
  'VERSION',
  'validateSegmentRef',
  'encodeNameForPath',
  'namespacePathPart',
];

/** Names that left the `driver-kit` subpath. The five error helpers live in `@cloudbitmaps/s3` now. */
const OFF_THE_DRIVER_KIT = [
  'registryPrefix',
  'registryObjectKey',
  'registryListPrefix',
  'parseRegistryKey',
  'errorName',
  'httpStatus',
  'isNetworkOrTimeout',
  'isSdkRetryable',
  'isServerSide',
];

/**
 * Names that left `@cloudbitmaps/roaring` and stay on `@cloudbitmaps/core`, where a flavor or driver author gets
 * them. Pages and samples legitimately name most of these (the free-function forms, the retry internals), so they
 * are held to the runtime surface of the flavor only.
 */
const OFF_THE_FLAVOR = [
  'SegmentEngine',
  'BoundedLru',
  'safeMetrics',
  'NOOP_METRICS',
  'resolveBudget',
  'resolvePerOpBudget',
  'collectWithinBudget',
  'DEFAULT_BUDGET',
  'checkBudget',
  'withRetry',
  'RetryingStorageChunkSource',
  'groundedReport',
  'splitId',
  'mapWithConcurrency',
  'segmentKey',
  'isStorageBackend',
  'PinnedStorageChunkSource',
  'listGenerations',
  'rollbackSegment',
  'segmentExists',
  'listSegments',
  'setSegmentRetention',
  'getSegmentRetention',
  'clearSegmentRetention',
  'runConsistencyCheck',
  'runExport',
  'dropSegment',
  'retireExpired',
  'estimateCost',
  'loadSegment',
  'eraseIdFromSegment',
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
    for (const name of OFF_THE_MAIN_ENTRIES) {
      expect(name in core, `@cloudbitmaps/core exports ${name}`).toBe(false);
      expect(name in roaring, `@cloudbitmaps/roaring exports ${name}`).toBe(false);
    }
    // The halves left every package that had exported them, and `createBackend` with them.
    const packages: Record<string, object> = {
      '@cloudbitmaps/core': core,
      '@cloudbitmaps/s3': s3,
      '@cloudbitmaps/gcs': gcs,
      '@cloudbitmaps/azure-blob': azureBlob,
    };
    for (const [pkg, names] of Object.entries(HALVES)) {
      for (const name of names)
        expect(name in (packages[pkg] ?? {}), `${pkg} exports ${name}`).toBe(false);
    }
    // What replaces them is there, so the check above cannot pass on a barrel that failed to load.
    expect(typeof core.loadSegment).toBe('function');
    expect(typeof core.MemoryStorage).toBe('function');
    expect(typeof s3.S3Storage).toBe('function');
    expect(typeof driverKit.brandAsBackend).toBe('function');
    expect(typeof core.RetryingStorageChunkSource).toBe('function');
  });

  it('the flavor exports none of the names that stay on core, and core still exports each', () => {
    for (const name of OFF_THE_FLAVOR) {
      expect(name in roaring, `@cloudbitmaps/roaring exports ${name}`).toBe(false);
      expect(name in core, `@cloudbitmaps/core no longer exports ${name}`).toBe(true);
    }
  });

  it('the driver-kit subpath exports none of the names that left it, and still exports the ones that moved onto it', () => {
    for (const name of OFF_THE_DRIVER_KIT) {
      expect(name in driverKit, `@cloudbitmaps/core/driver-kit exports ${name}`).toBe(false);
    }
    for (const name of ['validateSegmentRef', 'encodeNameForPath', 'namespacePathPart']) {
      expect(typeof (driverKit as Record<string, unknown>)[name], name).toBe('function');
    }
  });

  // A runtime check cannot see a type, and an options type is one: read each entry's declared exports from its
  // barrel, so a half's options type cannot come back through `export type` unnoticed.
  it('no barrel declares one of the halves, their options types, or createBackend', () => {
    const barrels: Record<string, string> = {
      '@cloudbitmaps/core': 'core',
      '@cloudbitmaps/roaring': 'roaring',
      '@cloudbitmaps/s3': 's3',
      '@cloudbitmaps/gcs': 'gcs',
      '@cloudbitmaps/azure-blob': 'azure-blob',
    };
    const all = Object.values(HALVES).flat();
    for (const [entry, dir] of Object.entries(barrels)) {
      const src = readFileSync(join(ROOT, 'packages', dir, 'src', 'index.ts'), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');
      expect(
        retiredNames(
          src,
          all.map((name) => ({ name })),
        ),
        `${entry} declares one`,
      ).toEqual([]);
    }
    const kit = readFileSync(
      join(ROOT, 'packages', 'core', 'src', 'driver-kit.ts'),
      'utf8',
    ).replace(/\/\/.*$/gm, '');
    expect(retiredNames(kit, [{ name: 'createBackend' }])).toEqual([]);
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
    expect(retiredNames('throw new TimeoutError(msg)')).toHaveLength(1);
    expect(retiredNames('await gcOrphanGenerations(ref, deps, { keep: 1 })')).toHaveLength(1);
    expect(retiredNames('SafeBitmap.fromValues(ids) and roaringCodec')).toHaveLength(2);
    // A longer name that contains one, and the SDK error a driver reads by name, are not the removed exports.
    expect(retiredNames('nextGenerationNumber and MyDEFAULT_PRICING_TABLE')).toEqual([]);
  });
});
