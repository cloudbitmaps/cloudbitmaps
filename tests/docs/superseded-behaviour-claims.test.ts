import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Claims about behaviour this library NO LONGER HAS, spelled out so they cannot come back.
 *
 * WHY THIS FILE EXISTS. "An empty result publishes an empty generation" was true, was documented as
 * deliberate, and lived in **four** places: the guide's `*Into` section, two entries in the roadmap, and a
 * doc-comment that ships in the published `.d.ts`. The change that made it false updated exactly one of them,
 * and the full gate stayed green — the docs gates check that exports are documented and that links resolve,
 * neither of which can see prose contradicting behaviour.
 *
 * That is the second time a single sentence has outlived the code in this repo, which is the point at which
 * being careful stops being the answer. Each entry below is a phrase that was TRUE and is now FALSE; a hit
 * means someone wrote it again, or a stale copy survived a sweep.
 *
 * Adding an entry is the cheap half of retiring a behaviour. Removing one is only correct if the behaviour
 * came back.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SKIP = new Set(['node_modules', 'dist', '.git', 'coverage', '.worktrees', 'build', 'golden']);
const EXTS = ['.ts', '.md', '.html', '.txt', '.cjs', '.mjs'];

/** Phrases that describe behaviour this library used to have. Each carries what to say instead. */
const RETIRED: ReadonlyArray<{ readonly claim: RegExp; readonly why: string }> = [
  {
    claim: /publish(?:es|ing)? an empty generation over `?dest/i,
    why: 'the *Into verbs refuse an empty result over a non-empty destination — say that instead',
  },
  {
    claim: /an empty result publishes an empty generation/i,
    why: 'the *Into verbs refuse it; `allowEmpty: true` is the override',
  },
  {
    claim: /still calls the bulk-load path directly/i,
    why: 'the *Into verbs route through the guarded loadSegment path',
  },
  {
    claim: /does \*\*not\*\* yet cover these verbs/i,
    why: 'the load guard covers the *Into verbs now',
  },
];

/**
 * Files that DEFINE the rule and so must spell the retired phrases out — this one, and nothing else.
 * CHANGELOG.md is exempt as a whole: its old entries describe what was true when they were written, and
 * rewriting history to match today would make it a worse record.
 */
const DEFINES_THE_RULE = new Set([join('tests', 'docs', 'superseded-behaviour-claims.test.ts')]);
const HISTORY = new Set(['CHANGELOG.md']);

function textFiles(): string[] {
  const out: string[] = [];
  const walk = (rel: string): void => {
    const abs = join(ROOT, rel);
    if (!existsSync(abs)) return;
    for (const entry of readdirSync(abs)) {
      if (SKIP.has(entry)) continue;
      const child = rel === '.' ? entry : join(rel, entry);
      if (statSync(join(ROOT, child)).isDirectory()) walk(child);
      else if (EXTS.some((e) => entry.endsWith(e))) out.push(child);
    }
  };
  walk('.');
  return out.filter((f) => !DEFINES_THE_RULE.has(f) && !HISTORY.has(f));
}

describe('no document claims behaviour this library has retired', () => {
  const files = textFiles();

  it('is scanning the surfaces where the stale copies actually were', () => {
    // Each of these held one of the four copies. A guard that stopped reaching them would pass silently.
    expect(files).toContain(join('docs', 'guide', 'getting-started.md'));
    expect(files).toContain(join('docs', 'ROADMAP.md'));
    expect(files).toContain(join('packages', 'roaring', 'src', 'index.ts'));
    expect(files.some((f) => f.startsWith('site/'))).toBe(true);
    expect(files.length).toBeGreaterThan(150);
  });

  it.each(files)('%s', (rel) => {
    const src = readFileSync(join(ROOT, rel), 'utf8');
    const hits: string[] = [];
    src.split('\n').forEach((line, i) => {
      for (const { claim, why } of RETIRED) {
        const m = claim.exec(line);
        if (m) hits.push(`${rel}:${i + 1} — "${m[0]}" is no longer true. ${why}`);
      }
    });
    expect(hits).toEqual([]);
  });
});
