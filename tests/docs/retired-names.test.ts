import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import * as core from '@cloudbitmaps/core';
import * as driverKit from '@cloudbitmaps/core/driver-kit';
import * as coreNode from '@cloudbitmaps/core/node';
import * as roaring from '@/index';
import * as s3 from '@cloudbitmaps/s3';
import * as gcs from '@cloudbitmaps/gcs';
import * as azureBlob from '@cloudbitmaps/azure-blob';
import * as tools from '@cloudbitmaps/tools';

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

/** What a reader who wanted to hold a set in memory as an operand uses instead. */
const HELD_INSTEAD =
  "a feed: `store.materializeMany`'s `feed`, which the loading guide's recipe uses for a set you hold";

/** What a reader who wanted the tombstone reaper uses instead. */
const REAPER_INSTEAD =
  'nothing: this release refuses every row a release before 0.20 wrote, deleted ones included, and the upgrade the ' +
  'changelog gives moves the segments to a new prefix and deletes the old prefix, its rows with it';

/** What a reader who wanted a segment's cost report uses instead. */
const COST_REPORT_INSTEAD =
  '`groundedReport` from `@cloudbitmaps/tools`, given the size `seg.stat()` reports: `groundedReport({ storageBytes: (await seg.stat()).sizeBytes })`';

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
  {
    name: 'DEFAULT_PRICING',
    instead: '`AWS_US_EAST_1_ONDEMAND` from `@cloudbitmaps/tools`',
    code: true,
  },
  { name: 'costReport', instead: COST_REPORT_INSTEAD, code: true },
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
  { name: 'MemoryOperand', instead: HELD_INSTEAD, code: true },
  { name: 'prepareHeld', instead: HELD_INSTEAD, code: true },
  { name: 'CombineManyHeld', instead: HELD_INSTEAD, code: true },
  { name: 'HeldChunks', instead: HELD_INSTEAD, code: true },
  { name: 'reapRegistryTombstones', instead: REAPER_INSTEAD },
  { name: 'reapLegacyTombstones', instead: REAPER_INSTEAD, code: true },
  { name: 'ReapRegistryTombstonesOptions', instead: REAPER_INSTEAD, code: true },
  { name: 'ReapRegistryTombstonesResult', instead: REAPER_INSTEAD, code: true },
  { name: 'ReapLegacyTombstonesOptions', instead: REAPER_INSTEAD, code: true },
  { name: 'ReapLegacyTombstonesResult', instead: REAPER_INSTEAD, code: true },
  ...Object.values(HALVES)
    .flat()
    .map((name) => ({ name, instead: HALVES_INSTEAD })),
];

/**
 * Names that left a public entry but are still what a page or a sample legitimately names: `VERSION` is a word
 * the release docs use for other things, and the other three live on the `driver-kit` subpath now, where the API
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
  'loadSegment',
  'eraseIdFromSegment',
];

/**
 * The cost model's names, which left both core and the flavor for `@cloudbitmaps/tools`. Pages name them, from that
 * package, so they are held to the runtime surface: off core and the flavor, on tools.
 */
const MOVED_TO_TOOLS = [
  'estimateCost',
  'groundedReport',
  'AWS_US_EAST_1_ONDEMAND',
  'ELASTICACHE_REDIS_US_EAST_1_ONDEMAND',
  'ONE_REDIS_HA_CLUSTER',
];

/** What a reader who wanted a driver contract from the flavor uses instead. */
const DRIVER_KIT_INSTEAD =
  '`@cloudbitmaps/core/driver-kit`, the one home of the driver contracts (a dependency of yours at the version of ' +
  "`@cloudbitmaps/roaring` you install), or the type derived from the flavor's own: `CloudRoaringOptions['storage']`, " +
  "`MemoryStorage['registry']`, `NonNullable<EncryptionOptions['keystore']>`";

/** What a reader who wanted the `.crbm` reader or its crypto pair uses instead. */
const READER_INSTEAD =
  'nothing: the `.crbm` reader is internal; read a segment through the store or `exportSegments`, or read the ' +
  'bytes as `docs/format.md` specifies them';

/** What a reader who wanted to build the store's read source by hand uses instead. */
const SOURCE_INSTEAD =
  "a backend as `storage`, with the store's `cache`, `encryption` and `seams` options for the source's settings";

/** What a reader who wanted a predicate uses instead. */
const predicate = (kind: string): { name: string; instead: string; anyPage: true } => ({
  name: `is${kind}`,
  instead: `\`errorKind(err) === '${kind}'\`, or \`instanceof\` on an ordinary install`,
  anyPage: true,
});

/**
 * Every name `@cloudbitmaps/roaring` stopped exporting in this release, with what a reader uses instead: the 13
 * predicates `errorKind` replaced; the option types `CombineOptions` merged, and core's names for the five types the
 * flavor now declares under its own; and every name outside its keep list: the driver contracts, which
 * `@cloudbitmaps/core/driver-kit` alone exports now, and the engine's internals and constants that no public
 * signature needs.
 *
 * The flavor's barrel declares none of them, re-exports nothing with a star, and no page imports one from it.
 * `anyPage` marks a name with no public home and no page that describes it, which no page may name at all. `onlyOn`
 * lists the pages that name one legitimately, and no other page may: an internal of core's where a page describes the
 * engine (`BlobReader` and `CodecInterface` in the contributor guides, `CrbmReader` in the fuzz guide,
 * `CrbmStorageChunkSource` in core's README), and `isTransientError`, which is also the AWS SDK's classifier, in the
 * bench guide. A driver contract has neither: driver-kit's pages name it. `code` marks a name that no code names
 * either, comments included. `tests/docs/left-the-flavor.json` lists the same names for `scripts/smoke.cjs`, which says
 * a name is one of them when it meets it.
 */
const LEFT_THE_FLAVOR: ReadonlyArray<{
  name: string;
  instead: string;
  anyPage?: true;
  onlyOn?: readonly string[];
  code?: true;
}> = [
  { name: 'isCloudRoaringError', instead: '`errorKind(err) !== undefined`', anyPage: true },
  ...[
    'ValidationError',
    'WriteConflictError',
    'IntegrityError',
    'NotFoundError',
    'UnsupportedError',
    'CapabilityError',
    'KeyUnavailableError',
    'BudgetExceededError',
    'LeaseExpiredError',
    'LeaseLimitError',
    'StaleOperandError',
  ].map(predicate),
  {
    name: 'isTransientError',
    instead: "`errorKind(err) === 'TransientError'`",
    onlyOn: [join('bench', 'README.md')],
  },
  { name: 'IdRange', instead: "`Pick<CombineOptions, 'after' | 'through'>`", anyPage: true },
  ...['BaseCombineOptions', 'MaterializeOptions', 'AndNotIntoOptions'].map((name) => ({
    name,
    instead: '`CombineOptions`',
    anyPage: true as const,
    code: true as const,
  })),
  ...[
    ['CombineExpr', 'Expr'],
    ['CombineManyStats', 'MaterializeManyStats'],
    ['CombineManyOperandStats', 'MaterializeManyOperandStats'],
    ['CombineManyOutputStats', 'MaterializeManyOutputStats'],
    ['CombineManyFeedRecord', 'MaterializeManyFeedRecord'],
  ].map(([name, now]) => ({
    name: name ?? '',
    instead: `\`${now ?? ''}\``,
    anyPage: true as const,
    code: true as const,
  })),
  ...[
    'Aead',
    'AeadSealed',
    'BlobSink',
    'ChunkRef',
    'ClearRegistrySummary',
    'GenKey',
    'GovernanceMeta',
    'IKeystore',
    'IRegistryDriver',
    'IStorageDriver',
    'KnownGeneration',
    'LeaseEntry',
    'NewRegistryRecord',
    'RegCaps',
    'RegistryPatch',
    'RegistryRecord',
    'RegistryStatus',
    'RegistrySummary',
    'RegistryWriteOptions',
    'SealedRegistrySummary',
    'SegmentSize',
    'StorageBackend',
    'StorageCaps',
    'StorageChunkSource',
    'StorageDeleteOptions',
    'TailRead',
    'Token',
    'WrappedDek',
  ].map((name) => ({ name, instead: DRIVER_KIT_INSTEAD })),
  { name: 'CrbmReader', instead: READER_INSTEAD, onlyOn: [join('fuzz', 'README.md')] },
  {
    name: 'BlobReader',
    instead: READER_INSTEAD,
    onlyOn: ['AGENTS.md', 'CONTRIBUTING.md'],
  },
  ...['BufferReader', 'CrbmReaderOptions', 'CrbmCrypto', 'NodeAead', 'aadFor'].map((name) => ({
    name,
    instead: READER_INSTEAD,
    anyPage: true as const,
  })),
  {
    name: 'CrbmStorageChunkSource',
    instead: SOURCE_INSTEAD,
    onlyOn: [join('packages', 'core', 'README.md')],
  },
  { name: 'CrbmStorageChunkSourceOptions', instead: SOURCE_INSTEAD, anyPage: true },
  {
    name: 'PinnedObject',
    instead:
      '`seg.pin()` or `seg.pinAt({ generation, fingerprint })`, whose handle records it as `PinnedAt`',
    anyPage: true,
  },
  {
    name: 'CodecInterface',
    instead: 'nothing: the flavor binds its codec for you',
    onlyOn: ['CONTRIBUTING.md'],
  },
  ...['CodecBitmap', 'EncodedChunk'].map((name) => ({
    name,
    instead: 'nothing: the flavor binds its codec for you',
    anyPage: true as const,
  })),
  {
    name: 'DEFAULT_RETRY_POLICY',
    instead:
      "the store's `retry` option, which keeps each default it does not set: 4 attempts, a 50 ms base delay, ×2, a " +
      '2 s cap and full jitter',
    anyPage: true,
  },
  {
    name: 'MIN_EXPIRES_AT_MS',
    instead:
      'the literal `1_000_000_000_000` (epoch milliseconds, 2001-09-09), the floor the retention guide states',
    anyPage: true,
  },
  {
    name: 'LEASE_SKEW_MS',
    instead: 'the value, 60 seconds, which the reading guide states',
    anyPage: true,
  },
  {
    name: 'MAX_LEASE_MS',
    instead:
      'the value, 14 days (1,209,600,000 ms), which the reading guide states; `pin` refuses a longer lease',
    anyPage: true,
  },
  {
    name: 'MAX_LEASES_PER_SEGMENT',
    instead:
      'the value, 64, which the reading guide states; the 65th lease throws `LeaseLimitError`',
    anyPage: true,
  },
];

/** Each export declaration in `text` that names no bindings (`export *`, `export type *`, `export * as ns`), as written. */
export function starExportsIn(text: string): string[] {
  const sf = ts.createSourceFile('barrel.ts', text, ts.ScriptTarget.Latest, true);
  return sf.statements
    .filter(
      (st) =>
        ts.isExportDeclaration(st) &&
        (st.exportClause === undefined || !ts.isNamedExports(st.exportClause)),
    )
    .map((st) => st.getText(sf));
}

/** The star exports of a barrel, by its path from the root. */
const starExports = (rel: string): string[] => starExportsIn(readFileSync(join(ROOT, rel), 'utf8'));

/** The names a barrel declares as exports, read with the compiler's parser, so a type counts as a value does. */
function barrelExports(rel: string): Set<string> {
  const sf = ts.createSourceFile(
    rel,
    readFileSync(join(ROOT, rel), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const names = new Set<string>();
  for (const st of sf.statements) {
    if (ts.isExportDeclaration(st)) {
      if (st.exportClause !== undefined && ts.isNamedExports(st.exportClause))
        for (const el of st.exportClause.elements) names.add(el.name.text);
      continue;
    }
    const exported =
      ts.canHaveModifiers(st) &&
      (ts.getModifiers(st) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    if (!exported) continue;
    if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations)
        if (ts.isIdentifier(d.name)) names.add(d.name.text);
    } else if (
      (ts.isInterfaceDeclaration(st) ||
        ts.isClassDeclaration(st) ||
        ts.isTypeAliasDeclaration(st) ||
        ts.isFunctionDeclaration(st) ||
        ts.isEnumDeclaration(st)) &&
      st.name !== undefined
    ) {
      names.add(st.name.text);
    }
  }
  return names;
}

/** An HTML page's text as a reader sees it, read by the same function the smoke test's scanner uses. */
export const { stripMarkup } = createRequire(import.meta.url)('../../scripts/doc-imports.cjs') as {
  stripMarkup: (html: string) => string;
};

/** A page's text, through `stripMarkup` when it is HTML. */
function readerText(path: string): string {
  const raw = readFileSync(join(ROOT, path), 'utf8');
  return path.endsWith('.html') ? stripMarkup(raw) : raw;
}

/**
 * Every name `text` imports from `@cloudbitmaps/roaring`, with the line its statement starts on: `import { … }` and
 * `import type { … }`, on one line or many, and a destructured `require(…)` or `await import(…)`.
 */
export function flavorImports(text: string): Array<{ line: number; name: string }> {
  const forms = [
    /\bimport\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"]@cloudbitmaps\/roaring['"]/g,
    /\{([^}]*)\}\s*=\s*(?:require|await\s+import)\(\s*['"]@cloudbitmaps\/roaring['"]\s*\)/g,
  ];
  const found: Array<{ line: number; name: string }> = [];
  for (const form of forms) {
    for (const m of text.matchAll(form)) {
      const line = text.slice(0, m.index).split('\n').length;
      for (const part of (m[1] ?? '').split(',')) {
        const name = part
          .replace(/\/\/.*$/gm, '')
          .trim()
          .replace(/^type\s+/, '')
          .split(/\s+as\s+|\s*:\s*/)[0]
          ?.trim();
        if (name) found.push({ line, name });
      }
    }
  }
  return found;
}

/** The public entries' barrels, by specifier. The hover docs of the first two are read; the rest are where a link may point. */
const PUBLIC_BARRELS: ReadonlyArray<readonly [string, string]> = [
  ['@cloudbitmaps/roaring', 'packages/roaring/src/index.ts'],
  ['@cloudbitmaps/core/driver-kit', 'packages/core/src/driver-kit.ts'],
  ['@cloudbitmaps/s3', 'packages/s3/src/index.ts'],
  ['@cloudbitmaps/gcs', 'packages/gcs/src/index.ts'],
  ['@cloudbitmaps/azure-blob', 'packages/azure-blob/src/index.ts'],
  ['@cloudbitmaps/tools', 'packages/tools/src/index.ts'],
];

/** One doc comment a reader's editor shows: on an export of the flavor or driver-kit, or on a public member of one. */
interface HoverDoc {
  readonly where: string;
  readonly text: string;
  /** The names of the declaration's own members, which a link may name without a qualifier. */
  readonly members: ReadonlySet<string>;
  readonly node: ts.Node;
}

/**
 * Every doc comment on an export of `@cloudbitmaps/roaring` or `@cloudbitmaps/core/driver-kit` and on its public members,
 * read from the sources with the compiler (the declarations the build ships carry the same comments), and every name any
 * public entry exports. A private or protected member is skipped: an editor shows its doc to no caller.
 */
function hoverDocs(): {
  exported: Set<string>;
  docs: HoverDoc[];
  checker: ts.TypeChecker;
  program: ts.Program;
} {
  const config = ts.readConfigFile(join(ROOT, 'tsconfig.json'), ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, ROOT);
  const files = PUBLIC_BARRELS.map(([, rel]) => join(ROOT, rel));
  const program = ts.createProgram(files, { ...parsed.options, noEmit: true });
  const checker = program.getTypeChecker();
  const modules = files.map((f) => {
    const sf = program.getSourceFile(f);
    const mod = sf === undefined ? undefined : checker.getSymbolAtLocation(sf);
    if (mod === undefined) throw new Error(`no module for ${f}`);
    return mod;
  });
  const exported = new Set(
    modules.flatMap((m) => checker.getExportsOfModule(m).map((e) => e.name)),
  );
  const hidden = (node: ts.Node): boolean =>
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node) ?? []).some(
      (m) => m.kind === ts.SyntaxKind.PrivateKeyword || m.kind === ts.SyntaxKind.ProtectedKeyword,
    );
  const docs: HoverDoc[] = [];
  PUBLIC_BARRELS.slice(0, 2).forEach(([entry], i) => {
    for (const exp of checker.getExportsOfModule(modules[i] as ts.Symbol)) {
      const target = exp.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exp) : exp;
      for (const decl of target.declarations ?? []) {
        const members = new Set<string>();
        ts.forEachChild(decl, (c) => {
          const name = (c as { name?: ts.Node }).name;
          if (name !== undefined && ts.isIdentifier(name)) members.add(name.text);
        });
        const visit = (node: ts.Node, owner: string): void => {
          if (hidden(node)) return;
          for (const d of ts.getJSDocCommentsAndTags(node))
            docs.push({ where: `${entry} ${exp.name}${owner}`, text: d.getText(), members, node });
          if (
            node === decl ||
            ts.isClassDeclaration(node) ||
            ts.isInterfaceDeclaration(node) ||
            ts.isTypeLiteralNode(node)
          ) {
            ts.forEachChild(node, (c) => {
              const name = (c as { name?: ts.Node }).name;
              visit(
                c,
                name !== undefined && ts.isIdentifier(name) ? `${owner}.${name.text}` : owner,
              );
            });
          } else if (
            (ts.isPropertySignature(node) ||
              ts.isPropertyDeclaration(node) ||
              ts.isTypeAliasDeclaration(node)) &&
            node.type !== undefined
          ) {
            visit(node.type, owner);
          }
        };
        visit(decl, '');
      }
    }
  });
  return { exported, docs, checker, program };
}

/** The name each `{@link …}` in `text` starts with: `Segment` of `{@link Segment.pin}`, `x` of `{@link x | text}`. */
export function linkTargets(text: string): string[] {
  // A link to a URL (`{@link https://… | text}`) names no symbol.
  return [
    ...text.matchAll(/\{@link(?:code|plain)?\s+(?![A-Za-z][\w+.-]*:\/\/)([A-Za-z_$][\w$]*)/g),
  ].map((m) => m[1] ?? '');
}

const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage', '.git', '.worktrees', '.changeset']);
/** A page is anything a reader opens: markdown, HTML, and the plain-text pages the site serves. */
const PAGE_EXTS = ['.md', '.html', '.txt'];
/** Code: the sources, the tests, the scripts and the benches, whose comments and strings are read with it. */
const CODE_EXTS = ['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs'];
const SKIP_FILES = new Set(['CHANGELOG.md']);

/**
 * Every file under `root` with one of `exts`, by its path from `root`, sorted. A symbolic link is skipped: it is another
 * name for a file read under its own (`CLAUDE.md` is `AGENTS.md`), and a checkout that cannot make links holds a file of
 * a few bytes in its place.
 */
function files(exts: readonly string[], root: string = ROOT): string[] {
  const out: string[] = [];
  const walk = (rel: string): void => {
    for (const entry of readdirSync(join(root, rel))) {
      if (SKIP_DIRS.has(entry) || SKIP_FILES.has(entry)) continue;
      const childRel = rel === '.' ? entry : join(rel, entry);
      const stat = lstatSync(join(root, childRel));
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) walk(childRel);
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

/** `file:line names X; use Y` for every name from `names` that `paths` contain, with that name's `instead`. */
function offenders(
  paths: readonly string[],
  names: ReadonlyArray<{ name: string; instead: string }>,
): string[] {
  const out: string[] = [];
  for (const path of paths) {
    for (const { line, name } of retiredNames(readFileSync(join(ROOT, path), 'utf8'), names)) {
      const instead = names.find((r) => r.name === name)?.instead ?? '';
      out.push(`${path}:${line} names ${name}; use ${instead}`);
    }
  }
  return out;
}

describe('a removed export is named nowhere a reader looks', () => {
  it('neither package exports one at runtime', () => {
    for (const { name } of RETIRED) {
      expect(name in core, `@cloudbitmaps/core exports ${name}`).toBe(false);
      expect(name in coreNode, `@cloudbitmaps/core/node exports ${name}`).toBe(false);
      expect(name in roaring, `@cloudbitmaps/roaring exports ${name}`).toBe(false);
    }
    for (const name of OFF_THE_MAIN_ENTRIES) {
      expect(name in core, `@cloudbitmaps/core exports ${name}`).toBe(false);
      expect(name in roaring, `@cloudbitmaps/roaring exports ${name}`).toBe(false);
    }
    // The halves left every package that had exported them, and `createBackend` with them.
    const packages: Record<string, object> = {
      '@cloudbitmaps/core': core,
      '@cloudbitmaps/core/node': coreNode,
      '@cloudbitmaps/s3': s3,
      '@cloudbitmaps/gcs': gcs,
      '@cloudbitmaps/azure-blob': azureBlob,
    };
    for (const [pkg, names] of Object.entries(HALVES)) {
      // The `/node` barrel is held to the same list as the main entry it was split from.
      const barrels = pkg === '@cloudbitmaps/core' ? [pkg, `${pkg}/node`] : [pkg];
      for (const barrel of barrels)
        for (const name of names)
          expect(name in (packages[barrel] ?? {}), `${barrel} exports ${name}`).toBe(false);
    }
    // What replaces them is there, so the check above cannot pass on a barrel that failed to load.
    expect(typeof core.loadSegment).toBe('function');
    expect(typeof coreNode.MemoryStorage).toBe('function');
    expect(typeof coreNode.LocalFsStorage).toBe('function');
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

  it('the cost model is on the tools package alone: off core, off the flavor and off its store class', () => {
    for (const name of MOVED_TO_TOOLS) {
      expect(name in core, `@cloudbitmaps/core exports ${name}`).toBe(false);
      expect(name in roaring, `@cloudbitmaps/roaring exports ${name}`).toBe(false);
      expect(name in tools, `@cloudbitmaps/tools does not export ${name}`).toBe(true);
    }
    expect('estimateCost' in roaring.CloudRoaring).toBe(false);
    const seg = new roaring.CloudRoaring({ storage: new coreNode.MemoryStorage() }).segment('s');
    expect('costReport' in seg).toBe(false);
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

  it('skips a symbolic link, which is another name for a file it reads under its own', () => {
    const dir = mkdtempSync(join(tmpdir(), 'retired-names-'));
    try {
      writeFileSync(join(dir, 'AGENTS.md'), 'names BlobReader\n');
      symlinkSync('AGENTS.md', join(dir, 'CLAUDE.md'));
      writeFileSync(join(dir, 'GUIDE.md'), 'a page\n');
      expect(files(['.md'], dir)).toEqual(['AGENTS.md', 'GUIDE.md']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    // In this tree `CLAUDE.md` is a link to `AGENTS.md`, unless the checkout could not make one.
    expect(pages()).toContain('AGENTS.md');
    if (lstatSync(join(ROOT, 'CLAUDE.md')).isSymbolicLink())
      expect(pages()).not.toContain('CLAUDE.md');
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
    expect(retiredNames('const r = await seg.costReport({ workload });')).toHaveLength(1);
    expect(retiredNames('a costReportCard or myCostReport')).toEqual([]);
  });
});

describe('a name the flavor stopped exporting stays off it', () => {
  const FLAVOR = join('packages', 'roaring', 'src', 'index.ts');
  const KIT = join('packages', 'core', 'src', 'driver-kit.ts');

  it('reads the flavor barrel, so the checks below cannot pass vacuously', () => {
    const names = barrelExports(FLAVOR);
    // A class, a declared interface, a re-exported type, a re-exported value and a local re-export.
    for (const kept of [
      'CloudRoaring',
      'CombineOptions',
      'SegmentRef',
      'errorKind',
      'deserializePortable',
    ]) {
      expect(names.has(kept), kept).toBe(true);
    }
    expect(new Set(LEFT_THE_FLAVOR.map((r) => r.name)).size).toBe(LEFT_THE_FLAVOR.length);
  });

  it('the flavor neither declares one nor exports one at runtime', () => {
    const names = barrelExports(FLAVOR);
    expect(
      LEFT_THE_FLAVOR.filter((r) => names.has(r.name)).map((r) => `${r.name}; use ${r.instead}`),
    ).toEqual([]);
    for (const { name } of LEFT_THE_FLAVOR) {
      expect(name in roaring, `@cloudbitmaps/roaring exports ${name}`).toBe(false);
    }
  });

  it('neither the flavor nor driver-kit re-exports with a star, which a list of names cannot see', () => {
    expect(starExports(FLAVOR)).toEqual([]);
    expect(starExports(KIT)).toEqual([]);
  });

  it('finds a star export in each spelling, and passes a named one', () => {
    expect(
      starExportsIn(
        "export * from 'a';\nexport type * from 'b';\nexport * as ns from 'c';\nexport type { X } from 'd';\nexport { y };",
      ),
    ).toEqual(["export * from 'a';", "export type * from 'b';", "export * as ns from 'c';"]);
  });

  it('lists the same names as the file the smoke test reads', () => {
    const shared = JSON.parse(
      readFileSync(join(ROOT, 'tests', 'docs', 'left-the-flavor.json'), 'utf8'),
    ) as string[];
    expect([...shared].sort()).toEqual(LEFT_THE_FLAVOR.map((r) => r.name).sort());
  });

  it('driver-kit exports every driver contract the flavor sends a reader to it for', () => {
    const kit = barrelExports(KIT);
    const contracts = LEFT_THE_FLAVOR.filter((r) => r.instead === DRIVER_KIT_INSTEAD);
    expect(contracts).toHaveLength(28);
    expect(contracts.filter((r) => !kit.has(r.name)).map((r) => r.name)).toEqual([]);
  });

  it('no page imports one from the flavor', () => {
    const out: string[] = [];
    for (const page of pages()) {
      for (const { line, name } of flavorImports(readerText(page))) {
        const row = LEFT_THE_FLAVOR.find((r) => r.name === name);
        if (row !== undefined)
          out.push(
            `${page}:${line} imports ${name} from @cloudbitmaps/roaring; use ${row.instead}`,
          );
      }
    }
    expect(out).toEqual([]);
  });

  it("reads the pages' imports, an HTML page's through its markup, so the check above cannot pass vacuously", () => {
    const names = (page: string): string[] => flavorImports(readerText(page)).map((i) => i.name);
    expect(names('README.md')).toContain('CloudRoaring');
    expect(names(join('docs', 'guide', 'getting-started.md'))).toContain('MemoryStorage');
    expect(names(join('site', 'usage.html'))).toContain('CloudRoaring');
  });

  it('a name some pages may name is on no other page, and on each page its row lists', () => {
    const scoped = LEFT_THE_FLAVOR.filter((r) => r.onlyOn !== undefined);
    expect(scoped.map((r) => r.name).sort()).toEqual(
      [
        'BlobReader',
        'CodecInterface',
        'CrbmReader',
        'CrbmStorageChunkSource',
        'isTransientError',
      ].sort(),
    );
    const all = pages();
    for (const row of scoped) {
      const allowed = row.onlyOn ?? [];
      expect(
        offenders(
          all.filter((p) => !allowed.includes(p)),
          [row],
        ),
      ).toEqual([]);
      for (const page of allowed) {
        expect(all, page).toContain(page);
        expect(
          retiredNames(readFileSync(join(ROOT, page), 'utf8'), [row]).length,
          `${page} names ${row.name}`,
        ).toBeGreaterThan(0);
      }
    }
  });

  it('no page names one that has no public home', () => {
    expect(
      offenders(
        pages(),
        LEFT_THE_FLAVOR.filter((r) => r.anyPage === true),
      ),
    ).toEqual([]);
  });

  it('no code names one that has no use left in code, comments included', () => {
    expect(
      offenders(
        codeFiles(),
        LEFT_THE_FLAVOR.filter((r) => r.code === true),
      ),
    ).toEqual([]);
  });

  it('finds an import of one in every form, and passes the same name from driver-kit, in prose, or a longer specifier', () => {
    const names = (text: string): string[] => flavorImports(text).map((i) => i.name);
    expect(names("import { CloudRoaring, IStorageDriver } from '@cloudbitmaps/roaring';")).toEqual([
      'CloudRoaring',
      'IStorageDriver',
    ]);
    expect(
      names(
        'import type {\n  CloudRoaringOptions,\n  RegistryRecord,\n} from "@cloudbitmaps/roaring";',
      ),
    ).toEqual(['CloudRoaringOptions', 'RegistryRecord']);
    expect(names("import { type Token as T } from '@cloudbitmaps/roaring';")).toEqual(['Token']);
    expect(names("const { MIN_EXPIRES_AT_MS: floor } = require('@cloudbitmaps/roaring');")).toEqual(
      ['MIN_EXPIRES_AT_MS'],
    );
    expect(names("const { CrbmReader } = await import('@cloudbitmaps/roaring');")).toEqual([
      'CrbmReader',
    ]);
    expect(
      names(
        stripMarkup(
          '<span class="k">import</span> { NodeAead } <span class="k">from</span> <span class="s">&#39;@cloudbitmaps/roaring&#39;</span>;',
        ),
      ),
    ).toEqual(['NodeAead']);
    expect(flavorImports("a\n\nimport { Token } from '@cloudbitmaps/roaring';")).toEqual([
      { line: 3, name: 'Token' },
    ]);
    expect(
      flavorImports(
        stripMarkup(
          "<!-- a\ncomment -->\n<p>\n<code>import { Token } from '@cloudbitmaps/roaring';</code>",
        ),
      ),
    ).toEqual([{ line: 4, name: 'Token' }]);
    expect(names("import type { IStorageDriver } from '@cloudbitmaps/core/driver-kit';")).toEqual(
      [],
    );
    expect(names('`IStorageDriver` is no longer imported from `@cloudbitmaps/roaring`')).toEqual(
      [],
    );
    expect(names("import { CloudRoaring } from '@cloudbitmaps/roaring-extra';")).toEqual([]);
    expect(
      names(
        "import { CloudRoaring } from '@cloudbitmaps/core';\nimport { MemoryStorage } from '@cloudbitmaps/roaring';",
      ),
    ).toEqual(['MemoryStorage']);
  });
});

describe("the flavor's and driver-kit's hover docs name only what a reader can import", () => {
  const { exported, docs, checker, program } = hoverDocs();

  it('reads the hover docs of both entries, so the checks below cannot pass vacuously', () => {
    expect(docs.length).toBeGreaterThan(500);
    for (const where of [
      '@cloudbitmaps/roaring CloudRoaring.load',
      '@cloudbitmaps/core/driver-kit IStorageDriver.putImmutable',
    ]) {
      expect(
        docs.some((d) => d.where === where),
        where,
      ).toBe(true);
    }
    for (const name of ['CloudRoaring', 'IStorageDriver', 'S3Storage', 'estimateCost'])
      expect(exported.has(name), name).toBe(true);
  });

  it('none names a name the flavor stopped exporting that no public entry exports', () => {
    const gone = LEFT_THE_FLAVOR.filter((r) => !exported.has(r.name));
    const out = docs.flatMap((d) =>
      retiredNames(d.text, gone).map(
        ({ name }) =>
          `${d.where} names ${name}; use ${gone.find((r) => r.name === name)?.instead ?? ''}`,
      ),
    );
    expect([...new Set(out)]).toEqual([]);
  });

  it('every `{@link …}` names a public export, a member of its own declaration, or a name of the language or a package', () => {
    const external = (name: string, node: ts.Node): boolean => {
      const symbol = checker.resolveName(
        name,
        node,
        ts.SymbolFlags.Type | ts.SymbolFlags.Value,
        false,
      );
      const decls = symbol?.declarations ?? [];
      return (
        decls.length > 0 &&
        decls.every((x) => {
          const sf = x.getSourceFile();
          return program.isSourceFileDefaultLibrary(sf) || sf.fileName.includes('/node_modules/');
        })
      );
    };
    const out = docs.flatMap((d) =>
      linkTargets(d.text)
        .filter((n) => !exported.has(n) && !d.members.has(n) && !external(n, d.node))
        .map((n) => `${d.where}: {@link ${n}} names nothing a reader can import`),
    );
    expect([...new Set(out)]).toEqual([]);
  });

  it('reads a link the way the compiler does, and passes a name from the language', () => {
    expect(
      linkTargets(
        'see {@link Segment.pin} and {@link errorKind | the classifier}, or {@linkcode Uint8Array}',
      ),
    ).toEqual(['Segment', 'errorKind', 'Uint8Array']);
    expect(linkTargets('a `{ link }` or @link without braces')).toEqual([]);
    // a link to a URL names no symbol; one to a name beside it is still read
    expect(
      linkTargets(
        '({@link https://www.rfc-editor.org/rfc/rfc5116 | RFC 5116}, {@link http://x.test}) and {@link DEFAULT_RETRY_POLICY}',
      ),
    ).toEqual(['DEFAULT_RETRY_POLICY']);
  });
});
