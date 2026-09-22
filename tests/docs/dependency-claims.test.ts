import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A dependency count has to say WHOSE.
 *
 * WHY THIS EXISTS. Before the package split there was one third-party runtime dependency in the whole
 * project, so "1 third-party dependency" was a fair thing to print on a badge. The split gave
 * `@cloudbitmaps/s3`, `/gcs` and `/azure-blob` a real cloud SDK each, and the sentence stopped being true —
 * in eight places on the public site, in `README.md` six lines below its own table listing four separate
 * pulls, and in `SECURITY.md`, where a stale two-package enumeration was the stated reason for a conclusion
 * about what reaches consumers.
 *
 * Every one of those passed CI. The site's own figure gate even *checked* the number — against
 * `packages/roaring/package.json` alone, which answers "how many does the codec have?" while the badge made
 * a claim about the project. A derivation narrower than the claim it checks cannot fail when the claim goes
 * wrong.
 *
 * WHY REPO-WIDE RATHER THAN site/. The first version of this rule lived in `scripts/site-figures.cjs` and
 * walked `site/**\/*.html`, because that is where the defect was noticed. The two worst instances were in
 * `README.md` and `SECURITY.md` and it could not see either — a detector written to the boundary of the
 * sighting rather than the boundary of the claim. Doc comments are in the corpus too: they ship in the
 * published `.d.ts` and show on hover in a user's editor.
 *
 * THE RULE. A count of third-party dependencies is legal only where the surrounding text names the package
 * it applies to. `CONTRIBUTING.md`'s per-package table is the source everything else is derived from.
 */

const ROOT = join(__dirname, '..', '..');

/**
 * Everything a reader or a tool could see. `CHANGELOG.md` is exempt as a whole — its entries describe what
 * was true when written, and rewriting them to match today would make it a worse record.
 */
/**
 * Files that must spell the retired sentence out, because narrating the defect is their job: this gate, and
 * the site figure script whose comments record what the badge used to say and why it was wrong. Both are
 * scripts rather than reader-facing prose, so exempting them costs nothing a reader can see.
 */
const EXPLAINS_THE_RULE = new Set([
  'tests/docs/dependency-claims.test.ts',
  'scripts/site-figures.cjs',
]);

const FILES = execFileSync(
  'git',
  ['ls-files', '*.ts', '*.md', '*.html', '*.txt', '*.cjs', '*.mjs', '*.yml'],
  { cwd: ROOT, encoding: 'utf8' },
)
  .split('\n')
  .filter(Boolean)
  .filter((f) => f !== 'CHANGELOG.md' && !EXPLAINS_THE_RULE.has(f));

/** Third-party (non-workspace) runtime dependencies, per package — the ground truth. */
function thirdPartyByPackage(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const manifest of execFileSync('git', ['ls-files', 'packages/*/package.json'], {
    cwd: ROOT,
    encoding: 'utf8',
  })
    .split('\n')
    .filter(Boolean)) {
    const pkg = JSON.parse(readFileSync(join(ROOT, manifest), 'utf8')) as {
      name: string;
      dependencies?: Record<string, string>;
    };
    out.set(
      pkg.name,
      Object.entries(pkg.dependencies ?? {})
        .filter(([, range]) => !String(range).startsWith('workspace:'))
        .map(([dep]) => dep),
    );
  }
  return out;
}

/**
 * A package specifier or a product name. Anywhere in the window, this scopes the claim: the reader can see
 * exactly which package is being counted.
 */
const SCOPED_STRONG = /@cloudbitmaps\/\w|CRoaring|roaring-node/i;

/**
 * A common noun that can scope a count — "the codec's one third-party dependency" — but only when it is
 * attached to the claim.
 *
 * WHY THE DISTINCTION. Accepting these anywhere in the ±160 window is what let the retired badge come back.
 * Every hero and footer strip on the site reads `Apache-2.0 · v0.10.0 · zero-dependency core · 4 storage
 * drivers`; drop `· 1 third-party dependency ·` into the middle of one and the bare `core` thirty characters
 * to its left excused it. The claim said "the project", the scoping word belonged to a different item in the
 * same list, and the gate written to kill that exact string passed over it on the landing page.
 *
 * Both real claims in this repo are scoped the STRONG way — `npm i @cloudbitmaps/roaring · 1 third-party
 * dependency` and `@cloudbitmaps/core has no third-party dependencies` — so requiring attachment for the
 * weak form costs nothing here and closes the laundering route.
 */
const SCOPED_WEAK = /\bcodec\b|\bcore\b|\bengine\b|\bflavor\b/gi;

/**
 * What separates one item of a meta strip, or one sentence, from the next. A weak scoping word on the far
 * side of one of these belongs to a different claim.
 */
const CLAUSE_BREAK = /[·•|;\n]|\.\s/;

/** Does some scoping token govern the claim at `at`, within `around`? */
function isScoped(around: string, claimStart: number, claimLength: number): boolean {
  if (SCOPED_STRONG.test(around)) return true;
  for (const w of around.matchAll(SCOPED_WEAK)) {
    const wAt = w.index ?? 0;
    const between =
      wAt < claimStart
        ? around.slice(wAt + w[0].length, claimStart)
        : around.slice(claimStart + claimLength, wAt);
    if (!CLAUSE_BREAK.test(between)) return true;
  }
  return false;
}

/** A stated count of third-party dependencies, in digits or words. */
const CLAIM =
  /\b(\d+|one|two|three|four|five|no|zero|a single)\s+third-party\s+(?:runtime\s+)?dependenc\w*/gi;

describe('a dependency count says which package it counts', () => {
  const deps = thirdPartyByPackage();

  it('the ground truth is readable, and more than one package carries a dependency', () => {
    // The premise of the whole rule: if only one package had a third-party dep, an unqualified count would
    // be fair and this gate would be noise.
    expect(deps.size).toBeGreaterThanOrEqual(5);
    expect([...deps.values()].filter((d) => d.length > 0).length).toBeGreaterThan(1);
    expect(deps.get('@cloudbitmaps/core')).toEqual([]);
    expect(FILES.length).toBeGreaterThan(50);
  });

  it('CONTRIBUTING.md still carries the per-package table everything derives from', () => {
    // Named explicitly: this is the upstream copy. If it is deleted or reworded away, the other surfaces
    // have nothing to be re-derived from and drift silently, which is how they drifted the first time.
    const contributing = readFileSync(join(ROOT, 'CONTRIBUTING.md'), 'utf8');
    expect(contributing).toContain('Third-party runtime dependencies are counted **per package**');
    for (const pkg of deps.keys())
      expect(contributing).toContain(pkg.replace('@cloudbitmaps/', ''));
  });

  it.each(FILES)('%s', (file) => {
    const raw = readFileSync(join(ROOT, file), 'utf8');
    // Tags become spaces rather than vanishing, so an offset still points where it did in the source and a
    // scoping word in a NEIGHBOURING element cannot be dragged against the claim by the collapse.
    const text = raw.replace(/<[^>]+>/g, (tag) => ' '.repeat(tag.length));
    const unscoped: string[] = [];
    for (const m of text.matchAll(CLAIM)) {
      const at = m.index ?? 0;
      // One sentence's worth either side: enough to carry "`@cloudbitmaps/roaring`'s one third-party dep",
      // short enough that an unrelated package name further down the page cannot launder a false claim.
      const from = Math.max(0, at - 160);
      const around = text.slice(from, at + m[0].length + 160);
      if (!isScoped(around, at - from, m[0].length)) {
        unscoped.push(
          `"${m[0].trim()}" — in: …${around.replace(/\s+/g, ' ').trim().slice(0, 130)}…`,
        );
      }
    }
    expect(
      unscoped,
      `${file} states a third-party dependency count without naming the package it applies to. ` +
        `Counted per package: ${[...deps]
          .map(([n, d]) => `${n}=${d.length}`)
          .join(', ')}. See CONTRIBUTING.md#dependency-policy.`,
    ).toEqual([]);
  });
});
