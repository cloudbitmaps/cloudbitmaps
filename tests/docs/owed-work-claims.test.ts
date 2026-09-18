import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Work the roadmap still lists as **owed** must not be described anywhere else as done.
 *
 * WHY THIS FILE EXISTS. The README listed "fresh loaded-store benchmarks" among what had shipped, while the
 * roadmap marked those same benchmarks **owed**, `docs/benchmarks.md` filed them under "What is still owed",
 * and the README itself said twenty-two lines earlier that the loaded-store equivalents were on the owed
 * list. Three sources against one, and the one that was wrong is the file most readers start at. Nothing
 * caught it: the docs gates check that exports are documented and that links resolve, and neither can see a
 * page contradicting a page.
 *
 * A measurement claimed before it is taken is the most expensive kind of wrong sentence this repo can print.
 * It is the claim a reader is least able to check and most likely to make a decision on, and this project's
 * stated standard is that a figure is measured or it is not published.
 *
 * DERIVED, NOT LISTED. The condition is read from the roadmap itself, so this guard cannot outlive it: when
 * the benchmarks actually land and the roadmap stops saying "owed", the rule relaxes on its own rather than
 * becoming a stale test someone has to remember to delete. That is also why it fails loudly if it can no
 * longer find the roadmap entry it keys on — a guard that silently stops applying is worse than no guard.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SKIP = new Set(['node_modules', 'dist', '.git', 'coverage', '.worktrees', 'build', 'golden']);
const EXTS = ['.ts', '.md', '.html', '.txt', '.cjs', '.mjs'];

/** This file spells the claim out to forbid it; CHANGELOG entries record what was true when written. */
const DEFINES_THE_RULE = new Set([join('tests', 'docs', 'owed-work-claims.test.ts')]);
const HISTORY = new Set(['CHANGELOG.md']);

const ROADMAP = join('docs', 'ROADMAP.md');

/** Words that assert a thing exists. `owed`/`not shipped` nearby is the honest phrasing and must stay legal. */
const ASSERTS_DONE = /\b(shipped|published|measured|landed|delivered|available now)\b/i;
const ASSERTS_OWED = /\b(owed|not shipped|not yet|not published|still to come|pending)\b/i;

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

describe('nothing claims work the roadmap still lists as owed', () => {
  const roadmap = readFileSync(join(ROOT, ROADMAP), 'utf8');
  const stillOwed = /loaded-store benchmarks[^\n]*\bowed\b/i.test(roadmap);

  it('the roadmap still marks the loaded-store benchmarks owed (the condition this guard keys on)', () => {
    // If this fails because the benchmarks LANDED, delete this file — the rule has served its purpose.
    // If it fails because the roadmap was reworded, re-anchor it. What it must never do is pass vacuously.
    expect(
      stillOwed,
      `${ROADMAP} no longer marks the loaded-store benchmarks "owed". Either they shipped (remove this ` +
        `guard) or the wording moved (re-anchor it) — do not leave it matching nothing.`,
    ).toBe(true);
  });

  it.each(textFiles())('%s', (rel) => {
    if (!stillOwed) return;
    const hits: string[] = [];
    readFileSync(join(ROOT, rel), 'utf8')
      .split('\n')
      .forEach((line, i) => {
        if (!/loaded[- ]store benchmarks/i.test(line)) return;
        if (ASSERTS_OWED.test(line)) return; // "benchmarks — owed", "owed, not shipped": the honest form
        if (ASSERTS_DONE.test(line))
          hits.push(
            `${rel}:${i + 1} — claims the loaded-store benchmarks are done while ${ROADMAP} lists them ` +
              `as owed: "${line.trim()}"`,
          );
      });
    expect(hits).toEqual([]);
  });
});
