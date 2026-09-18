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

/** A private-corpus id: one or two capitals then one or two digits — `S2`, `C13`, `T4`, `P13`. */
const BARE_ID = '[A-Z]{1,2}\\d{1,2}';

/**
 * Ids in that exact shape that a reader CAN resolve, because they name a product or a standard rather than
 * a document. Without these the frames below are unusable: `the S3 bucket`, `the R2 bucket`, `(V8)` and
 * `the B2 endpoint` are ordinary English about real things, and `S3` alone appears 337 times here. This is
 * the narrow, honest collision the rule says to exempt by NAME — widening the frames instead would let
 * every real citation through.
 *
 * Exempted by NAME, never by shape. An earlier draft wrote `V\d+` to cover the V8 engine and thereby
 * excused `V4`, `V5` and `V7`, which are private-corpus ids — the exemption silently swallowed three real
 * hits. Only `V8` is a product.
 */
const PRODUCT_IDS = /^(?:S3|R2|B2|V8|EC2|H[23]|TS\d+|ES\d+|AL\d+)$/;

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
  // `decision 6` — lowercase and with no `#` — shipped in a core `.d.ts` while this pattern required a
  // capital D or a hash. The naming word is what makes it a citation; the punctuation around it is not.
  ['decision log', /\bdecisions?\s*#?\s*\d+|\bADR\s*#?\s*\d+|\bDECISIONS\s*#\d+/i],
  ['internal doc number', /\b\d\d-[A-Z][A-Z-]{3,}\b/],
  // The BARE forms, which every pattern above missed because each of those requires a naming word
  // ("finding", "Phase", "ADR") that a bare id by definition does not carry. They are the majority of what
  // actually shipped: `(S2)`, `(C13)`, `— S2)`, `the T4 cache-row contention stress`, `case R8`. Three of
  // them reached the published `.d.ts` of packages created by the very change that added this gate.
  //
  // Matching a bare `[A-Z]\d+` anywhere is not an option — `S3`, `R2`, `B2`, `V8`, `T0` and friends occur
  // ~470 times in this repo and every one is legitimate. So these match the FRAME instead: an id standing
  // alone inside a parenthesis, closing one after a dash, or sitting between a determiner and a noun. That
  // is how a citation is written and how a product name is not; `PRODUCT_IDS` below covers the overlap.
  [
    'bare parenthetical id',
    new RegExp(`\\((?:see\\s+|cf\\.\\s+)?${BARE_ID}(?:,\\s*${BARE_ID})*\\)`),
  ],
  ['id closing a parenthetical', new RegExp(`[—–-]\\s*${BARE_ID}\\)`)],
  [
    'id modifying a noun',
    new RegExp(`\\b(?:the|The|in|In|case|per|from|by|and)\\s+${BARE_ID}\\s+[a-z]`),
  ],
  [
    'labelled id',
    new RegExp(`\\b(?:Conformance|conformance|round|Round|item|Item)\\s+${BARE_ID}\\b`),
  ],
  // `(T3 regression guard)` — the id OPENS the parenthetical instead of filling it, which the first frame
  // (paren contains only ids) cannot see.
  ['id opening a parenthetical', new RegExp(`\\(${BARE_ID}\\s+[a-z]`)],
];

describe('no pointer the public cannot reach', () => {
  const files = publicFiles();

  it('scans the surfaces that have actually leaked before', () => {
    // A renamed or moved tree must fail loudly here rather than silently shrink the guard.
    expect(files).toContain('CHANGELOG.md');
    expect(files.some((f) => f.startsWith(join('packages', 'core', 'src')))).toBe(true);
    expect(files.some((f) => f.startsWith(join('packages', 'roaring', 'src')))).toBe(true);
    // The three driver packages publish `.d.ts` exactly like the two above, and the split created them with
    // a citation already in one — so they are named here rather than left to the walk. A guard that reaches
    // a tree only by accident stops reaching it the day the walk changes.
    for (const pkg of ['s3', 'gcs', 'azure-blob']) {
      expect(
        files.some((f) => f.startsWith(join('packages', pkg, 'src'))),
        `packages/${pkg}/src is not being scanned`,
      ).toBe(true);
    }
    expect(files.filter((f) => f.startsWith('site/')).length).toBeGreaterThanOrEqual(4);
    expect(files.length).toBeGreaterThan(150);
  });

  it.each(files)('%s — cites nothing that lives only in the private corpus', (rel) => {
    const src = readFileSync(join(ROOT, rel), 'utf8');
    const hits: string[] = [];
    src.split('\n').forEach((line, i) => {
      for (const [kind, re] of CITATIONS) {
        // EVERY match on the line, and the product exemption applied PER MATCHED ID.
        //
        // The first version did `re.exec(line)` and `continue`d the whole pattern when that one match's id
        // was a product name. So `the S3 bucket is read before the C13 cache row` passed: `S3` is exempt,
        // `continue` abandoned the line, and `C13` was never looked at. Since `S3` alone appears ~337 times
        // in this repo, "a line that mentions S3 AND carries a citation" is the common case, not a
        // contrived one — the exemption was hiding exactly the hits the gate exists to find.
        for (const m of line.matchAll(new RegExp(re.source, `${re.flags.replace('g', '')}g`))) {
          // EVERY id in the match must be a product for the match to be excused. A match can carry more
          // than one — `(I2, V4, V5)` is a list, and so is `(S3, C13)`, where reading only the first id
          // would excuse the citation sitting behind a product name.
          const ids = [...m[0].matchAll(new RegExp(BARE_ID, 'g'))].map((x) => x[0]);
          if (ids.length > 0 && ids.every((x) => PRODUCT_IDS.test(x))) continue;
          hits.push(`${rel}:${i + 1}  ${kind} "${m[0]}"  —  ${line.trim().slice(0, 100)}`);
        }
      }
    });
    expect(hits).toEqual([]);
  });
});
