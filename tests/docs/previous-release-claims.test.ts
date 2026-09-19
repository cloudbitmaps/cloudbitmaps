import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Every identifier `MIGRATING.md` presents as the OLD form must actually exist in the old release.
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
 * It also omitted the single change affecting every `0.9.x` deployment: that required `warm` tier is gone.
 *
 * None of it was caught, because a migration guide is the one document no test can check by construction —
 * it describes code that is deliberately not in the tree. Every other docs guard here compares prose against
 * HEAD, and HEAD is precisely what the "before" column is not about. So this one reads the tag.
 *
 * A wrong migration guide is the most expensive documentation this repo can ship: it is read exactly once,
 * by someone with a working system, who has no way to tell our account of their code from their code.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** The release `MIGRATING.md` says it migrates FROM. Read from the prose, not hardcoded twice. */
const guide = readFileSync(resolve(ROOT, 'MIGRATING.md'), 'utf8');

const PREVIOUS_TAG = 'v0.9.0';

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
 * Identifiers the guide attributes to the old release: the removed side of every ```diff fence, plus the
 * left-hand cell of every two-column table whose header names the old version.
 */
function claimedOldIdentifiers(): Array<{ name: string; where: string }> {
  const out: Array<{ name: string; where: string }> = [];
  const add = (text: string, where: string): void => {
    for (const m of text.matchAll(/`?\b([A-Z][A-Za-z0-9_]{2,})\b`?/g))
      out.push({ name: m[1] as string, where });
    for (const m of text.matchAll(/`([a-z][A-Za-z0-9_]{2,})`/g))
      out.push({ name: m[1] as string, where });
  };

  for (const fence of guide.matchAll(/```diff\n([\s\S]*?)```/g))
    for (const line of (fence[1] ?? '').split('\n'))
      if (line.startsWith('- ')) add(line.slice(2), 'a diff fence');

  // Two-column tables whose LEFT column is the old form. The header names which: `0.9.x`, `before`, `gone`.
  // Everything in that column is something the guide asserts existed in the previous release.
  let inOldTable = false;
  for (const line of guide.split('\n')) {
    const cells = line.split('|').map((c) => c.trim());
    const isRow = line.trimStart().startsWith('|') && cells.length >= 4;
    if (!isRow) {
      inOldTable = false;
      continue;
    }
    const left = cells[1] ?? '';
    if (/^`?0\.9|^before$|^gone$/i.test(left)) {
      inOldTable = true; // this is the header; its own cells are labels, not identifiers
      continue;
    }
    if (/^-+$/.test(left.replace(/[\s:]/g, ''))) continue; // the --- separator row
    if (inOldTable) add(left, 'the old-form column of a table');
  }
  return out;
}

/** Names that are not ours to check — TypeScript keywords, cloud SDK types, prose capitals. */
const NOT_OURS = new Set([
  'SDK',
  'ESM',
  'RAM',
  'CI',
  'GDPR',
  'AEAD',
  'LRU',
  'TTL',
  'API',
  'URL',
  'JSON',
  'HTTP',
  'AWS',
  'GCS',
  'GCP',
  'Node',
  'TypeScript',
  'Jest',
  'Yarn',
  'PnP',
  'CommonJS',
  'Blob',
  'Table',
  'Files',
  'Data',
  'Lake',
  'Azure',
  'The',
  'This',
  'It',
  'If',
  'In',
  'On',
  'So',
  'And',
  'But',
  'Use',
  'Pass',
  'Set',
  'Every',
  'Nothing',
  'One',
  'Both',
  'You',
  'Your',
  'We',
  'What',
  'When',
  'Where',
  'Which',
  'That',
  'There',
  'They',
  'Then',
  'Their',
  'Read',
  'See',
  'Redis',
  'Lambda',
  'Cost',
  'Explorer',
  'MinIO',
  'Windows',
  'NTFS',
  'POSIX',
  'Symbol',
  'Object',
  'Error',
  'Promise',
  'Start',
  'Most',
  'Work',
  'Also',
  'Only',
  'Until',
  'Note',
  'IMPORTANT',
  'NOTE',
  'Claude',
]);

describe(`MIGRATING.md's account of ${PREVIOUS_TAG} matches ${PREVIOUS_TAG}`, () => {
  const oldFlavor = atTag('packages/roaring/src/index.ts');
  // Core's barrel too: at the tag the flavor re-exported core wholesale, so a name a reader imported from
  // `@cloudbitmaps/roaring` is very often declared only in core. Leaving it out made the ground truth
  // incomplete, and an incomplete ground truth on a guard like this produces confident false accusations.
  const oldCore = atTag('packages/core/src/index.ts');
  const oldSubpaths = ['s3', 'gcs', 'azure'].map(
    (s) => atTag(`packages/core/src/${s}/index.ts`) ?? '',
  );
  const oldSource = [oldFlavor ?? '', oldCore ?? '', ...oldSubpaths].join('\n');

  it(`can read ${PREVIOUS_TAG} at all (a guard that cannot see the tag proves nothing)`, () => {
    expect(
      oldFlavor,
      `could not read packages/roaring/src/index.ts at ${PREVIOUS_TAG} — is the tag fetched?`,
    ).not.toBeNull();
    expect((oldFlavor ?? '').length).toBeGreaterThan(1000);
  });

  it('every identifier shown as the old form exists in the old release', () => {
    const missing = claimedOldIdentifiers()
      .filter(({ name }) => !NOT_OURS.has(name))
      .filter(({ name }) => !new RegExp(`\\b${name}\\b`).test(oldSource))
      .map(
        ({ name, where }) =>
          `${name} (shown in ${where} as the ${PREVIOUS_TAG} form, but absent there)`,
      );
    expect([...new Set(missing)]).toEqual([]);
  });

  it('names the required options a 0.9.x store actually passed', () => {
    // `cold` and `warm` were both required at the tag, so every reader had them. A guide that never mentions
    // them is describing somebody else's code — which is exactly what this one did.
    for (const required of ['cold', 'warm'])
      expect(
        new RegExp(`\\b${required}\\b`).test(guide),
        `MIGRATING.md never mentions \`${required}\`, which was a REQUIRED option at ${PREVIOUS_TAG} — so ` +
          `every reader upgrading from it passed one and will not find it in this guide.`,
      ).toBe(true);
  });
});
