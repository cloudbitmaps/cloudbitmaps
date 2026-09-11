import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Guards the rule that this repository carries NO pointer the public cannot reach — not a link, and not a
// bare citation either. An id like `Phase 4e`, `gap #1`, `finding S2` or `test-strategy T3` refers to a
// private tracker. It is worse than saying less, because it implies checkable evidence and then withholds it.
//
// This exists because the surface drifted TWICE. A `0.9.x` release removed internal-doc citations from
// shipped code comments; a year later a sweep found 271 more across the tree, 71 of them in
// `packages/*/src` — which reach users on hover in an editor and inside the published `.d.ts` and
// sourcemaps. Nothing compared prose to the rule in between: `leak-scan` checks configured needles
// (employer names and the like), the docs gates check that symbols and links resolve, and neither can see a
// citation. The second drift is the one that earns a gate rather than more care.
//
// The fix for a hit is to state the SUBSTANCE inline, not to delete the sentence: `(gap #1)` becomes what
// gap #1 actually said — "a wide segment's parsed index, not its payloads, dominates the reader's
// footprint". A reader then gets the reasoning instead of a dead reference to it.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'coverage',
  '.git',
  'build',
  '.pack-tmp',
  '.rss-stage',
  'golden',
  // Sibling working trees live under `.worktrees/`. This is the only doc gate that walks from the repo ROOT,
  // so without this it would scan a DIFFERENT commit's files and fail on content this commit already fixed —
  // or pass because a stale tree happened to be clean. The other doc gates walk named directories and cannot
  // reach in.
  '.worktrees',
]);

const EXTS = ['.ts', '.md', '.html', '.cjs', '.mjs', '.js', '.yml', '.yaml', '.json', '.txt'];

/** Every tracked text file in the repo: this rule is about the repo being public, not about the tarball. */
function publicFiles(): string[] {
  const out: string[] = [];
  const walk = (rel: string): void => {
    const abs = join(ROOT, rel);
    if (!existsSync(abs)) return;
    for (const entry of readdirSync(abs)) {
      if (SKIP_DIRS.has(entry)) continue;
      const childRel = rel === '.' ? entry : join(rel, entry);
      if (statSync(join(ROOT, childRel)).isDirectory()) walk(childRel);
      else if (EXTS.some((e) => entry.endsWith(e))) out.push(childRel);
    }
  };
  walk('.');
  // Two files must spell the forbidden forms out as literals, because their job is to DEFINE the rule: this
  // one (the patterns, and the examples explaining what each costs a reader) and `CONTRIBUTING.md`, which
  // teaches it. The exemption is deliberately a two-entry list rather than a rule — "anything in backticks"
  // or "anything in a comment" would let every real citation escape by adding a backtick. Neither file ships
  // in a tarball, and a citation copied out of one is still caught wherever it lands.
  const DEFINES_THE_RULE = new Set([
    join('tests', 'docs', 'internal-citations.test.ts'),
    'CONTRIBUTING.md',
  ]);
  return out.filter((f) => !DEFINES_THE_RULE.has(f));
}

/**
 * Citation forms only. Each names a document that exists solely in the private corpus.
 *
 * Deliberately NOT matched, because each one IS resolvable by a reader:
 * - `hard invariant 5` / `invariant #7` — the seven invariants are enumerated in this repo's `CLAUDE.md`.
 * - `§13.5` — a section of a public doc in `docs/guide/`.
 * - `(#76)` — a GitHub PR or issue on this repository, which GitHub itself resolves.
 * - `R2` — Cloudflare R2, the object store, which is a product name and not a decision id.
 */
const CITATIONS: ReadonlyArray<readonly [string, RegExp]> = [
  ['phase id', /\bPhase[\s-]+(?:\d+[a-z]?|[A-G]\d?)\b/],
  ['audit gap', /\bgaps?\s*#\d+|\baudit gaps?\b/i],
  ['review finding', /\bfinding\s+[A-Z]\d+\b/],
  ['test-strategy id', /\btest-strategy\s+[A-Z]?\d+/i],
  ['threat-model id', /\bthreat[\s-]model\s+[A-Z]?\d+/i],
  ['audit round', /\baudit round\s+\d/i],
  ['decision log', /\bDecision\s*#\d+|\bADR\s*#?\s*\d+|\bDECISIONS\s*#\d+/],
  ['internal doc number', /\b\d\d-[A-Z][A-Z-]{3,}\b/],
];

describe('no pointer the public cannot reach', () => {
  const files = publicFiles();

  it('scans the surfaces that have actually leaked before', () => {
    // A renamed or moved tree must fail loudly here rather than silently shrink the guard.
    expect(files).toContain('CHANGELOG.md');
    expect(files.some((f) => f.startsWith(join('packages', 'core', 'src')))).toBe(true);
    expect(files.some((f) => f.startsWith(join('packages', 'roaring', 'src')))).toBe(true);
    expect(files.filter((f) => f.startsWith('site/')).length).toBeGreaterThanOrEqual(4);
    expect(files.length).toBeGreaterThan(150);
  });

  it.each(files)('%s — cites nothing that lives only in the private corpus', (rel) => {
    const src = readFileSync(join(ROOT, rel), 'utf8');
    const hits: string[] = [];
    src.split('\n').forEach((line, i) => {
      for (const [kind, re] of CITATIONS) {
        const m = re.exec(line);
        if (m) hits.push(`${rel}:${i + 1}  ${kind} "${m[0]}"  —  ${line.trim().slice(0, 100)}`);
      }
    });
    expect(hits).toEqual([]);
  });
});
