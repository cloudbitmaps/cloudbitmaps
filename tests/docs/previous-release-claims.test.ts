import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Every identifier a page presents as the OLD form must actually exist in the old release.
 *
 * WHY THIS FILE EXISTS. The migration guide's entire "before" side described a state that was never
 * published. Checked against the `v0.9.0` tag, it told a reader upgrading from `0.9.x` to:
 *
 *   - `import { CloudRoaring, S3Storage } from '@cloudbitmaps/roaring/s3'` — neither symbol was on that
 *     subpath; the class was `S3ColdDriver`, and `S3Storage` did not exist anywhere in `0.9.0`;
 *   - rename `storageGenTtlMs` / `storageReaderCacheMax` / `storageReaderCacheMaxBytes` — none of which ever
 *     shipped; in `0.9.0` they were `coldGenTtlMs` / `coldReaderCacheMax` / `coldReaderCacheMaxBytes`;
 *   - change `new CloudRoaring({ storage, registry })`, a constructor call `0.9.x` could not make, because
 *     `cold` and `warm` were both REQUIRED.
 *
 * None of it was caught, because a migration guide is the one document no other test can check: every other
 * docs guard here compares prose against HEAD, and HEAD is precisely what a "before" column is not about. So
 * this one reads the tag.
 *
 * TWO THINGS THIS FILE GOT WRONG ITSELF, both recorded because they are the interesting part:
 *
 *   1. It read only `MIGRATING.md`. The identical false "before" column was ALSO on the getting-started
 *      page; one copy was fixed and the guard was pointed at the copy that was fixed, so the falsehood sat
 *      on the main onboarding page with the whole suite green. Gating one copy of a repeated claim is not a
 *      fix, so the page list below is plural and pinned by name.
 *   2. Its ground truth was raw source text, so any name appearing in a JSDoc comment at the tag counted as
 *      an export — 200+ tokens that would have waved a fabricated name through. It now reads declarations.
 *
 * A wrong migration guide is the most expensive documentation this repo can ship: it is read exactly once,
 * by someone with a working system, who has no way to tell our account of their code from their code.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PREVIOUS_TAG = 'v0.9.0';

/**
 * Pages that tell a reader what `0.9.x` looked like.
 *
 * `CHANGELOG.md` is deliberately absent: its entries record what was true when each change landed, including
 * intermediate spellings that never shipped, and it labels those as mid-cycle where a reader could be misled.
 */
const CLAIMS_ABOUT_THE_OLD_RELEASE = [
  'MIGRATING.md',
  join('docs', 'guide', 'getting-started.md'),
  join('docs', 'guide', 'api-reference.md'),
  'README.md',
] as const;

/** Every subpath the previous release published, from its own `exports` map. */
const OLD_SUBPATHS = [
  's3',
  'dynamodb',
  'gcs',
  'azure',
  'postgres',
  'redis',
  'mongodb',
  'cassandra',
  'mysql',
] as const;

/** Source of the previous release, by path, or `null` when the path did not exist then. */
function atTag(path: string): string | null {
  try {
    return execFileSync('git', ['show', `${PREVIOUS_TAG}:${path}`], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
}

/**
 * Every identifier the old API exposed: exported names AND interface members.
 *
 * Option keys are the half that is easy to forget. `coldGenTtlMs` is not an export — it is a field on
 * `CloudRoaringOptions` — but it is exactly the kind of name a migration table names, so a ground truth of
 * exports alone accuses every correct option row of being fabricated.
 */
function apiNames(src: string): Set<string> {
  const out = exportedNames(src);
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  for (const m of code.matchAll(/readonly\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*[?:]/g))
    if (m[1]) out.add(m[1]);
  // ANY indentation, not just two spaces. A two-space rule sees only the top level of an interface, so every
  // field of a nested option group (`retry: { onRetry?: … }`) and every member of an inline object type read
  // as fabricated — which is what put `expectFrom`, `expectToken`, `allowForward` and `confirmSegment` on the
  // accused list the first time the API reference was scanned. Widening this widens the ALLOWLIST, so it can
  // only forgive; the names it must still catch (`storageGenTtlMs` and the other never-shipped spellings)
  // appear in our source only as string literals inside the rejection table, never as declarations.
  for (const m of code.matchAll(/^\s+([A-Za-z_$][A-Za-z0-9_$]*)\??:/gm)) if (m[1]) out.add(m[1]);
  // Fields of an INLINE object type — `options: { audit?: IAuditSink; allowForward?: boolean } = {}`. These
  // sit on one line, so no line-anchored pattern above can see them, and `allowForward` (a real, current,
  // documented option on `rollbackSegment`) was accused of being fabricated. Anchoring on `{` or `;` keeps
  // this to type/object positions: the never-shipped spellings this gate exists to catch live in our source
  // only as quoted strings inside an array literal, which is preceded by `[` or `,` and so never matches.
  for (const m of code.matchAll(/[{;]\s*([A-Za-z_$][A-Za-z0-9_$]*)\??\s*:/g))
    if (m[1]) out.add(m[1]);
  // Class methods. `count`, `iterate` and the `*Into` verbs are as much a part of the old API as any export,
  // and a table row naming one is a true claim.
  for (const m of code.matchAll(/^\s{2,4}(?:async\s+)?([A-Za-z_$][A-Za-z0-9_$]*)\s*[(<]/gm))
    if (m[1]) out.add(m[1]);
  return out;
}

/** Names a barrel actually EXPORTS, comments stripped first — the same rule `api-reference-sync` uses. */
function exportedNames(src: string): Set<string> {
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const out = new Set<string>();
  for (const block of code.matchAll(/export\s+(?:type\s+)?\{([^}]*)\}/g))
    for (const entry of (block[1] ?? '').split(',')) {
      const name = entry
        .trim()
        .split(/\s+as\s+/)
        .pop()
        ?.trim();
      if (name) out.add(name);
    }
  for (const decl of code.matchAll(
    /export\s+(?:abstract\s+)?(?:interface|class|type|function|const)\s+([A-Za-z0-9_$]+)/g,
  ))
    if (decl[1]) out.add(decl[1]);
  return out;
}

/**
 * Headers that mark a table's LEFT column as the old form.
 *
 * Opt-IN, but with the vocabulary people actually use — the first version whitelisted exactly three spellings
 * (`0.9`, `before`, `gone`), so `old`, `was` and `previously` walked straight past it. Opt-OUT was tried and
 * is worse here: these pages are full of ordinary feature tables whose left column is prose or a method name,
 * and a guard that flags those is a guard people learn to ignore.
 */
const OLD_FORM_HEADER = /^(`?0\.9|before|gone|old|was|previously|removed|from|gone in)\b/i;

/** Identifiers a page attributes to the old release. */
function claimedOldIdentifiers(text: string): Array<{ name: string; where: string }> {
  const out: Array<{ name: string; where: string }> = [];
  const add = (s: string, where: string): void => {
    for (const m of s.matchAll(/`([A-Za-z_$][A-Za-z0-9_$]{1,})`/g))
      out.push({ name: m[1] as string, where });
  };

  for (const fence of text.matchAll(/```diff\n([\s\S]*?)```/g))
    for (const line of (fence[1] ?? '').split('\n'))
      if (line.startsWith('- ')) add(line.slice(2), 'a diff fence');

  // The left column of every two-column table, unless its header opts out. Whitelisting the three headers
  // that happened to exist let `old` / `was` / `previously` through, so the polarity is inverted.
  // `seenHeader` is separate from `isOldColumn`: without it, a table whose header OPTED OUT had every
  // later row re-read as a header, so an ordinary prose cell became a claim.
  let seenHeader = false;
  let isOldColumn = false;
  for (const line of text.split('\n')) {
    const cells = line.split('|').map((c) => c.trim());
    if (!(line.trimStart().startsWith('|') && cells.length >= 4)) {
      seenHeader = false;
      isOldColumn = false;
      continue;
    }
    const left = cells[1] ?? '';
    if (/^-+$/.test(left.replace(/[\s:]/g, ''))) continue;
    if (!seenHeader) {
      seenHeader = true;
      isOldColumn = OLD_FORM_HEADER.test(left.replace(/`/g, ''));
      continue; // the header row's own cells are labels
    }
    if (isOldColumn) add(left, 'the old-form column of a table');
  }

  // ALL prose, judged against BOTH releases by the caller: a backticked identifier that exists in neither
  // the old release nor the current one is fabricated, whatever the surrounding sentence claims. Selecting
  // only paragraphs mentioning `0.9` missed the one naming removed options, because its paragraph said
  // `0.10.0` — which does not contain `0.9`.
  // Paragraphs that are ABOUT the old release — named by version, or by the language of removal. Keying on
  // `0.9` alone missed the sentence listing the removed options, whose paragraph says `0.10.0`; scanning all
  // prose instead drowned the signal in keywords, SDK error names and nested option fields.
  const ABOUT_THE_OLD_RELEASE =
    /0\.9|\bused to\b|\bno longer\b|\bremoved\b|\bare all gone\b|\bbefore\b/i;
  for (const para of text.split(/\n\s*\n/))
    if (ABOUT_THE_OLD_RELEASE.test(para) && !para.includes('```')) add(para, 'prose');

  return out;
}

/** Names that are not ours to check — prose words and third-party types that happen to be backticked. */
const NOT_OURS = new Set([
  // Sample variable names the API reference uses to explain pinning (`snap.intersect([other])`), and the
  // standard `Error.cause` every typed error preserves an SDK error in. None of the three is ours to own.
  'snap',
  'other',
  'cause',
  'npm',
  'pnpm',
  'yarn',
  'i',
  'add',
  'install',
  'true',
  'false',
  'null',
  'undefined',
  'string',
  'number',
  'boolean',
  'import',
  'require',
  'export',
  'from',
  'const',
  'new',
  'await',
  'async',
  'return',
  'if',
  'else',
  'type',
  'interface',
  'cold',
  'warm',
  'storage',
  'registry',
  'cache',
  'encryption',
  'retry',
  'metrics',
  'budget',
  'seams',
  'keystore',
  'requireEncryption',
  'onRetry',
  'clock',
  'rng',
  'maxAttempts',
  'expiresAt',
  'allowEmpty',
  'guard',
  'keep',
  'audit',
  'published',
  'reason',
  'cardinality',
  'cardinalityBefore',
  'chunkCount',
  'size',
  'collected',
  'generation',
  'bucket',
  'prefix',
  'region',
  'ids',
  'ref',
  'options',
  'dryRun',
  'limit',
  'namespace',
  'scan',
  'shards',
  'now',
  'module',
  'nodenext',
  'node16',
  'node18',
  'node20',
  'bundler',
  'main',
  'latest',
  'dist',
  'src',
  'exports',
  'types',
  'CHANGELOG',
  'MIGRATING',
  'README',
  'ROADMAP',
  'SECURITY',
  'PRIVACY',
  'CONTRIBUTING',
  'RELEASING',
  // Not code of ours in any release: a cloud provider's vocabulary, a wire/format literal, an HTTP verb,
  // a Node diagnostic. Each appeared in backticks in real prose. Kept short on purpose — an allowlist
  // is the part of a guard that rots, so anything plausibly ours belongs in the ground truth instead.
  'AbortIncompleteMultipartUpload',
  'active',
  'LIST',
  'GET',
  'PUT',
  'roaring',
  'ndjson',
  'ERR_REQUIRE_ESM',
  'ERR_PACKAGE_PATH_NOT_EXPORTED',
  'ExperimentalWarning',
  'TS1479',
]);

describe(`public pages' account of ${PREVIOUS_TAG} matches ${PREVIOUS_TAG}`, () => {
  const oldFlavor = atTag('packages/roaring/src/index.ts');
  const oldCore = atTag('packages/core/src/index.ts');
  const oldSubpaths = OLD_SUBPATHS.map((s) => atTag(`packages/core/src/${s}/index.ts`) ?? '');
  const exported = apiNames([oldFlavor ?? '', oldCore ?? '', ...oldSubpaths].join('\n'));
  /** Today's names, so a paragraph about 0.9.x may legitimately name the replacement alongside the old one. */
  // Every source file, not five barrels: "fabricated" means the name exists NOWHERE in our code, and a
  // barrel-only view called `currentGen`, `maxScanSegments` and `tombstoneGraceMs` inventions when they are
  // ordinary fields a page may legitimately name.
  const current = apiNames(
    execFileSync('git', ['ls-files', 'packages/*/src/**/*.ts', 'packages/*/src/*.ts'], {
      cwd: ROOT,
      encoding: 'utf8',
    })
      .split('\n')
      .filter(Boolean)
      .map((f) => readFileSync(join(ROOT, f), 'utf8'))
      .join('\n'),
  );

  it(`can read ${PREVIOUS_TAG} at all (a guard that cannot see the tag proves nothing)`, () => {
    expect(
      oldFlavor,
      `could not read packages/roaring/src/index.ts at ${PREVIOUS_TAG} — is the tag fetched? CI needs ` +
        `fetch-depth: 0, because a shallow checkout carries no tags.`,
    ).not.toBeNull();
    expect(exported.size).toBeGreaterThan(80);
  });

  it('checks the pages that actually carried the false account', () => {
    // Both of these held the same wrong "before" column. A guard scoped to one of them is how that shipped.
    expect(CLAIMS_ABOUT_THE_OLD_RELEASE).toContain('MIGRATING.md');
    expect(CLAIMS_ABOUT_THE_OLD_RELEASE).toContain(join('docs', 'guide', 'getting-started.md'));
    // Added after the reference's own migration paragraph was found naming three `storage*` option keys that
    // no release ever had. The page was outside this list purely because it reads as reference rather than as
    // a migration note — but any page that says "this used to be called X" is making a claim about the tag.
    expect(CLAIMS_ABOUT_THE_OLD_RELEASE).toContain(join('docs', 'guide', 'api-reference.md'));
  });

  it.each(CLAIMS_ABOUT_THE_OLD_RELEASE)('%s', (page) => {
    const missing = claimedOldIdentifiers(readFileSync(join(ROOT, page), 'utf8'))
      .filter(({ name }) => !NOT_OURS.has(name) && !/^[a-z]{1,3}$/.test(name))
      // In a diff or an old-form column the name must be OLD. In prose it may be either, so only a name that
      // exists in neither release is a fabrication.
      .filter(({ name, where }) =>
        where === 'prose' ? !exported.has(name) && !current.has(name) : !exported.has(name),
      )
      .map(
        ({ name, where }) => `${name} (in ${where}, as the ${PREVIOUS_TAG} form — absent there)`,
      );
    expect([...new Set(missing)]).toEqual([]);
  });

  it(`names the options a ${PREVIOUS_TAG} store actually had to pass`, () => {
    const guide = readFileSync(join(ROOT, 'MIGRATING.md'), 'utf8');
    const tagOptions = atTag('packages/roaring/src/index.ts') ?? '';
    for (const required of ['cold', 'warm']) {
      // Pin the FACT, not just the word: it was required at the tag, so `readonly <name>:` with no `?`.
      expect(
        new RegExp(`readonly ${required}:`).test(tagOptions),
        `${required} is no longer a required option at ${PREVIOUS_TAG} — re-derive this test.`,
      ).toBe(true);
      expect(
        new RegExp(`\\b${required}\\b`).test(guide),
        `MIGRATING.md never mentions \`${required}\`, which was a REQUIRED option at ${PREVIOUS_TAG} — so ` +
          `every reader upgrading from it passed one and will not find it in this guide.`,
      ).toBe(true);
    }
  });
});
