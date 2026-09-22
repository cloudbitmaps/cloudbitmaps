import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Guards that every relative link in the repo's docs and in the shareable `site/` pages actually resolves on
// disk. Dead links are cheap to introduce (a doc moves, a page is renamed) and invisible until a reader hits a
// 404 — and `site/` deploys publicly, so a broken link there is outward-facing. It also enforces the harder
// rule below: no file in this repository may reference a document that only exists in the private one.
//
// Scope: relative targets only. Absolute `http(s)://` URLs need the network and would make the gate flaky;
// `mailto:` and pure `#anchor` fragments carry no path.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** Directories never walked: build output, deps, and the fuzz corpus. */
const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'coverage',
  '.git',
  'build',
  '.pack-tmp',
  '.rss-stage',
]);

/**
 * Files named one by one, because a hardcoded list is the only way to guard files that don't live under a
 * walked directory. Deliberately NOT filtered by `existsSync`: a renamed or deleted entry must fail loudly.
 * Silently dropping it is exactly how this repo previously lost an ESLint override, two dependency-cruiser
 * rules, and every Stryker target — each pointed at a path that no longer existed and matched nothing.
 */
const NAMED_FILES = [
  'README.md',
  'CONTRIBUTING.md',
  'CLAUDE.md',
  'SECURITY.md',
  'PRIVACY.md',
  'CODE_OF_CONDUCT.md',
  'CHANGELOG.md',
  'RELEASING.md',
  'MIGRATING.md',
  'packages/roaring/PRIVACY.md',
  'fuzz/README.md',
] as const;

/**
 * Every tracked `.md` file, the named files above, and every `site/` page.
 *
 * The markdown is DERIVED from git as well as walked. A list of places to look went stale the way hand-kept
 * lists here always do: the READMEs added to `bench/`, `scripts/`, `site/` and `tests/` sat outside it, and five
 * links broken in them on purpose passed. The walks and the named list stay — the named list so that a renamed
 * file fails loudly rather than dropping out.
 */
function filesToCheck(): string[] {
  // The package READMEs are derived, not named: hardcoding core + roaring left the three new npm landing
  // pages outside the link check entirely.
  const out: string[] = [
    ...NAMED_FILES,
    ...readdirSync(join(ROOT, 'packages'), { withFileTypes: true })
      .filter((e) => e.isDirectory() && existsSync(join(ROOT, 'packages', e.name, 'README.md')))
      .map((e) => `packages/${e.name}/README.md`)
      .sort(),
  ];

  const walk = (rel: string, match: (name: string) => boolean): void => {
    const abs = join(ROOT, rel);
    if (!existsSync(abs)) return;
    for (const entry of readdirSync(abs)) {
      if (SKIP_DIRS.has(entry)) continue;
      const childRel = join(rel, entry);
      if (statSync(join(ROOT, childRel)).isDirectory()) walk(childRel, match);
      else if (match(entry)) out.push(childRel);
    }
  };
  walk('docs', (n) => n.endsWith('.md'));
  walk('site', (n) => n.endsWith('.html'));
  walk('.github', (n) => n.endsWith('.md'));
  out.push(
    ...execFileSync('git', ['ls-files', '*.md'], { cwd: ROOT, encoding: 'utf8' })
      .split('\n')
      .filter(Boolean),
  );
  return [...new Set(out)];
}

/** Markdown `[text](target)` plus HTML `href="target"` / `src="target"`. */
function linkTargets(src: string): string[] {
  const targets: string[] = [];
  // A link written *inside* a code span or fenced block is a quoted example, not a link — a doc that talks
  // about how to write links would otherwise fail on its own examples. Stripping code spans
  // is safe for the common `[`code`](target)` shape: the backticks only wrap the link *text*, so removing
  // them leaves `[](target)`, which still matches.
  let inFence = false;
  const kept: string[] = [];
  for (const line of src.split('\n')) {
    if (/^\s*(?:```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (!inFence) kept.push(line);
  }
  const prose = kept.join('\n').replace(/``?[^`\n]+``?/g, '');
  for (const m of prose.matchAll(/\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g))
    targets.push(m[1] as string);
  // REFERENCE-STYLE links: `[text][id]` resolved through a `[id]: target` definition at the foot of the file.
  // Invisible to the inline pattern above, and the style is already in use here — `CODE_OF_CONDUCT.md` is
  // written entirely with it. Its targets happen to be absolute today, so nothing was broken; a relative one
  // would have been unchecked, which is the same hole as a dead inline link with a different spelling.
  for (const m of prose.matchAll(/^[ \t]{0,3}\[([^\]]+)\]:[ \t]*(\S+)/gm))
    targets.push(m[2] as string);
  // From `prose`, not `src` — otherwise a fenced HTML *example* in a .md file yields a link that must resolve.
  // Single quotes as well as double: HTML permits either, nothing here forbids one, and a gate that reads
  // only one spelling checks whichever the author happened to type.
  for (const m of prose.matchAll(/(?:href|src)=(?:"([^"]+)"|'([^']+)')/g))
    targets.push((m[1] ?? m[2]) as string);
  return targets;
}

const isRelative = (t: string): boolean =>
  !/^[a-z][a-z0-9+.-]*:/i.test(t) && !t.startsWith('#') && !t.startsWith('//');

/**
 * GitHub's heading→fragment algorithm: lowercase, drop everything that isn't a letter/number/mark/underscore/
 * space/hyphen, then map **each** space to a hyphen.
 *
 * That last step is the subtle one. A heading like `## Cost & performance` becomes `cost--performance` — two
 * hyphens, because the `&` vanishes and leaves the spaces on both sides of it. Collapsing whitespace runs
 * instead (`\s+` → `-`) yields `cost-performance` and would declare most of this repo's own correct links
 * broken, since em dashes and `&` are everywhere in these headings.
 */
function slugify(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/`/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // a link in a heading contributes only its text
    .replace(/[^\p{L}\p{N}\p{M}_\s-]/gu, '')
    .trim()
    .replace(/ /g, '-');
}

/**
 * An absolute URL that points back into THIS repository, as the repo-relative path it names.
 *
 * WHY. The checks below deliberately skip absolute URLs, because resolving them would need the network. But
 * a `https://github.com/cloudbitmaps/cloudbitmaps/blob/main/docs/...` link is not a foreign URL — it is a
 * relative link wearing an absolute spelling, and every one of it can be resolved on disk with no network at
 * all. The five package READMEs have to spell them this way: they are rendered on npmjs.com, where a relative
 * link resolves against npm's own host and 404s. So the repo's most-read pages — the npm landing pages — were
 * the only ones whose links and heading fragments nothing checked, which is the narrower-gate failure this
 * suite exists to prevent.
 *
 * Returns `undefined` for a genuinely foreign URL and for links to issues, releases or the repo root, which
 * name no file in the tree.
 */
const SELF_BLOB = /^https:\/\/github\.com\/cloudbitmaps\/cloudbitmaps\/(?:blob|tree)\/main\/(.+)$/;
function selfLinkTarget(raw: string): string | undefined {
  const m = SELF_BLOB.exec(raw);
  return m === null ? undefined : (m[1] as string);
}

/** Every fragment a `.md` file exposes: heading slugs (deduped GitHub-style) plus explicit `<a id>`/`name`. */
function anchorsOf(src: string): Set<string> {
  const out = new Set<string>();
  let inFence = false;
  for (const line of src.split('\n')) {
    if (/^\s*(?:```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const base = slugify(heading[2] as string);
      // GitHub disambiguates repeats by appending -1, -2, …
      let slug = base;
      for (let i = 1; out.has(slug); i++) slug = `${base}-${i}`;
      out.add(slug);
    }
    for (const m of line.matchAll(/<a\s+(?:id|name)="([^"]+)"/g)) out.add(m[1] as string);
  }
  return out;
}

describe('docs & site links', () => {
  const files = filesToCheck();

  it('finds the files it is supposed to guard', () => {
    // A silently-empty walk, or a hardcoded entry that stopped existing, would make everything below vacuous.
    for (const named of NAMED_FILES) expect(files).toContain(named);
    expect(files.filter((f) => f.startsWith('site/')).length).toBeGreaterThanOrEqual(4);
    expect(files.filter((f) => f.startsWith(join('docs', 'guide'))).length).toBeGreaterThan(0);
    expect(files.filter((f) => f.startsWith('.github'))).toContain(
      join('.github', 'PULL_REQUEST_TEMPLATE.md'),
    );
  });

  // THE INVARIANT: no file in this repository references a document that lives only in the private repo.
  //
  // Existence on disk was never the test — a link into a tree that is not published resolves for whoever has
  // both repos checked out and 404s for everyone else, which is exactly how five such links survived the
  // package split unnoticed. So this asserts the absence of the reference itself, not whether it resolves.
  //
  // The scope used to be just `site/` and the public roadmap, on the stated grounds that "every other
  // public-bound file still cites internal docs legitimately pre-launch". That premise is now retired: the
  // citations are gone from every file — the CHANGELOG's included — so the guard covers everything it can see.
  // Narrowing it again would mean a reference reappearing somewhere this test deliberately isn't looking.
  const publicSurface = files;
  it.each(publicSurface)('%s — references no document outside this repository', (rel) => {
    const src = readFileSync(join(ROOT, rel), 'utf8');
    const internal = linkTargets(src)
      .filter(isRelative)
      .filter((raw) => {
        const path = raw.split('#')[0]?.split('?')[0] ?? '';
        if (path === '') return false;
        const abs = path.startsWith('/')
          ? join(ROOT, normalize(path))
          : resolve(ROOT, dirname(rel), path);
        return abs.startsWith(join(ROOT, 'docs', 'internal'));
      });
    expect(internal).toEqual([]);
  });

  it.each(files)('%s — every relative link resolves', (rel) => {
    const src = readFileSync(join(ROOT, rel), 'utf8');
    const dead: string[] = [];
    for (const raw of linkTargets(src)) {
      if (!isRelative(raw)) continue;
      // Strip a trailing `#anchor` / `?query` — the path is what has to exist.
      const path = raw.split('#')[0]?.split('?')[0] ?? '';
      if (path === '') continue;
      const abs = path.startsWith('/')
        ? join(ROOT, normalize(path))
        : resolve(ROOT, dirname(rel), path);
      if (!existsSync(abs)) dead.push(raw);
    }
    expect(dead).toEqual([]);
  });

  // Resolving the *path* was never the whole invariant. `[x](docs/benchmarks.md#renamed-heading)` passes the
  // check above and still lands the reader at the top of the page with no indication anything is wrong — which
  // is how a stale table-of-contents entry, and six links to a heading that had since gained a
  // `*(gate — ☑ SHIPPED)*` suffix, all survived. Headings drift; fragments pointing at them must fail loudly
  // when they do.
  //
  // Only `.md` targets are checked: `site/*.html` fragments resolve against hand-authored `id=`s, and a
  // `#L997-L1015` line range is a GitHub blob-view convention, not a heading.
  const anchorCache = new Map<string, Set<string>>();
  const anchorsFor = (abs: string): Set<string> => {
    let hit = anchorCache.get(abs);
    if (hit === undefined) {
      hit = anchorsOf(readFileSync(abs, 'utf8'));
      anchorCache.set(abs, hit);
    }
    return hit;
  };

  it.each(files)('%s — every anchor into a .md file resolves to a real heading', (rel) => {
    const src = readFileSync(join(ROOT, rel), 'utf8');
    const broken: string[] = [];
    for (const raw of linkTargets(src)) {
      const hash = raw.indexOf('#');
      if (hash === -1) continue;
      const frag = decodeURIComponent(raw.slice(hash + 1));
      if (frag === '' || /^L\d+(?:-L\d+)?$/.test(frag)) continue;
      const path = raw.slice(0, hash);
      // A bare `#frag` is same-file; otherwise it must be a relative `.md` target we can read.
      if (path !== '' && !isRelative(raw)) continue;
      const abs =
        path === ''
          ? join(ROOT, rel)
          : path.startsWith('/')
            ? join(ROOT, normalize(path))
            : resolve(ROOT, dirname(rel), path);
      if (!abs.endsWith('.md') || !existsSync(abs)) continue;
      if (!anchorsFor(abs).has(frag)) broken.push(raw);
    }
    expect(broken).toEqual([]);
  });

  // The npm landing pages spell their links absolutely because npmjs.com renders them off-host, so every check
  // above — which skips absolute URLs by design — looked straight past them. Resolve the self-referential ones
  // back to disk and hold them to the same standard: the file exists, and the fragment names a real heading.
  it.each(files)('%s — every link back into this repo resolves, path and anchor', (rel) => {
    const src = readFileSync(join(ROOT, rel), 'utf8');
    const broken: string[] = [];
    for (const raw of linkTargets(src)) {
      const target = selfLinkTarget(raw);
      if (target === undefined) continue;
      const hash = target.indexOf('#');
      const path = hash === -1 ? target : target.slice(0, hash);
      const abs = join(ROOT, normalize(path));
      if (!existsSync(abs)) {
        broken.push(`${raw} — no such file: ${path}`);
        continue;
      }
      if (hash === -1) continue;
      const frag = decodeURIComponent(target.slice(hash + 1));
      if (frag === '' || /^L\d+(?:-L\d+)?$/.test(frag)) continue;
      if (!abs.endsWith('.md')) continue;
      if (!anchorsFor(abs).has(frag)) broken.push(`${raw} — no heading "#${frag}" in ${path}`);
    }
    expect(broken).toEqual([]);
  });

  it('the self-link resolver recognises this repo and ignores foreign URLs', () => {
    // Both directions: it must catch our own blob links, and must not claim links it cannot resolve.
    expect(
      selfLinkTarget('https://github.com/cloudbitmaps/cloudbitmaps/blob/main/docs/benchmarks.md'),
    ).toBe('docs/benchmarks.md');
    expect(
      selfLinkTarget('https://github.com/cloudbitmaps/cloudbitmaps/blob/main/docs/guide/x.md#frag'),
    ).toBe('docs/guide/x.md#frag');
    expect(selfLinkTarget('https://github.com/cloudbitmaps/cloudbitmaps/issues')).toBeUndefined();
    expect(selfLinkTarget('https://github.com/cloudbitmaps/cloudbitmaps')).toBeUndefined();
    expect(selfLinkTarget('https://www.npmjs.com/package/@cloudbitmaps/core')).toBeUndefined();
    expect(selfLinkTarget('https://github.com/someone/else/blob/main/README.md')).toBeUndefined();
  });

  it('the anchor checker actually matches this repo’s heading style', () => {
    // Guards the `\s+`-vs-` ` bug directly: get this wrong and the test above passes vacuously on the
    // double-hyphen slugs that dominate these docs, so a real break would sail through.
    expect(slugify('Cost & performance targets')).toBe('cost--performance-targets');
    expect(slugify('Real-cloud calibration — AWS')).toBe('real-cloud-calibration--aws');
    expect(slugify('At scale — measured (1K → 10K → 100K segments)')).toBe(
      'at-scale--measured-1k--10k--100k-segments',
    );
    expect(slugify('Package the family before release *(gate — ☑ SHIPPED)*')).toBe(
      'package-the-family-before-release-gate---shipped',
    );
    // And prove it resolves a fragment the docs actually rely on, so the harness can't be trivially satisfied.
    expect(anchorsOf(readFileSync(join(ROOT, 'docs', 'benchmarks.md'), 'utf8'))).toContain(
      'real-cloud-calibration--aws',
    );
  });
});
