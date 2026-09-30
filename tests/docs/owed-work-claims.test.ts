import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Work the roadmap still lists as **owed** must not be described anywhere else as done.
 *
 * WHY THIS FILE EXISTS. A list of what has shipped can name "fresh loaded-store benchmarks" while the roadmap
 * marks those same benchmarks **owed**, `docs/benchmarks.md` files them under "What is still owed", and the
 * README itself says a screen earlier that the loaded-store equivalents are on the owed list. Three sources
 * against one, and the one that is wrong is the file most readers start at. The other docs gates check that
 * exports are documented and that links resolve, and neither can see a page contradicting a page.
 *
 * A measurement claimed before it is taken is the most expensive kind of wrong sentence this repo can print.
 * It is the claim a reader is least able to check and most likely to make a decision on, and this project's
 * stated standard is that a figure is measured or it is not published.
 *
 * DERIVED, NOT LISTED. The condition is read from the roadmap itself, so this guard cannot outlive it: when
 * the benchmarks actually land and the roadmap stops saying "owed", the per-file checks stand down and the
 * anchor test below fails, telling whoever landed them to delete this file — so it cannot linger as a stale test
 * nobody remembers. It fails the same way if the roadmap is merely reworded: a guard that silently stops
 * applying is worse than no guard.
 *
 * A SCAN THAT READS LINE BY LINE MISSES THE CLAIM THIS FILE EXISTS FOR. In the sentence
 * "…as it ran, and fresh loaded-store benchmarks." there is no done-word at all; the word that makes it a
 * claim ("Shipped on the loaded store:") is three wrapped lines earlier. A mutation test that adds `shipped`
 * to the end of that sentence verifies a defect a line scan can already see, not the one prose produces.
 * Hence {@link WRAPPED_CLAIM} below: the whole wrapped sentence is pinned as a fixture, so this file
 * cannot pass while blind to the thing it exists for.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SKIP = new Set(['node_modules', 'dist', '.git', 'coverage', '.worktrees', 'build', 'golden']);
const EXTS = ['.ts', '.md', '.html', '.txt', '.cjs', '.mjs'];

/** This file spells the claim out to forbid it; CHANGELOG entries record what was true when written. */
const DEFINES_THE_RULE = new Set([join('tests', 'docs', 'owed-work-claims.test.ts')]);
const HISTORY = new Set(['CHANGELOG.md']);

const ROADMAP = join('docs', 'ROADMAP.md');

/** Words that assert the work exists: "done" and "we ran" as well as "shipped" and "published". */
const ASSERTS_DONE =
  /\b(shipped|ships|published|measured|benchmarked|landed|delivered|done|complete|available now|we ran|here are|results below)\b/i;
/** The honest phrasings, which must stay legal. */
const ASSERTS_OWED = /\b(owed|not shipped|not yet|not published|still to come|pending|remain)\b/i;
/** The phrase, including the possessive form this repo's own README uses. */
const NAMES_THE_WORK =
  /loaded[- ]store(?:'s own)? benchmarks|benchmarks (?:of|for) the loaded store|loaded store's own benchmarks/i;

/**
 * A README-shaped sentence that claims the owed work as shipped, its done-word three wrapped lines before the
 * work it names. Pinned so the guard is tested against a claim wrapped the way prose wraps, not a tidier one —
 * see the docstring above.
 */
const WRAPPED_CLAIM = `Shipped on the loaded store: a single-call \`load()\` with a guard against an upstream query that returned too
little, a \`rollback()\`, \`exists()\` and \`segments()\` so the registry answers "what do I have?" instead of you
keeping a list beside it, a **snapshot handle** so a long export or reconciliation reads one instant rather
than whichever generations were current as it ran, and fresh loaded-store benchmarks. The public roadmap tracks it:`;

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

  /**
   * Sentences, not lines. A markdown paragraph wraps, so the claim and the word that makes it a claim are
   * routinely on different lines, where a line scan cannot see them together. Newlines are folded to spaces
   * first, then the text is split on sentence boundaries.
   */
  function offendingSentences(text: string): string[] {
    // A markdown table row is its own unit. Folding a table into one blob joins unrelated cells into a
    // pseudo-sentence, which would make the roadmap's own status table — whose rows are correctly marked
    // "owed" — read as a single claim containing every done-word on the page.
    const units: string[] = [];
    let para: string[] = [];
    const flush = (): void => {
      if (para.length > 0) units.push(para.join(' '));
      para = [];
    };
    for (const line of text.split('\n')) {
      if (line.trimStart().startsWith('|')) {
        flush();
        units.push(line);
      } else if (line.trim() === '') flush();
      else para.push(line.trim());
    }
    flush();
    return units
      .flatMap((u) => u.split(/(?<=[.!?])\s+/))
      .filter((sentence) => {
        if (!NAMES_THE_WORK.test(sentence)) return false;
        // The owed-word has to be in the SAME CLAUSE as the phrase, not merely somewhere in the sentence.
        // "We shipped fresh loaded-store benchmarks; the Lambda run is not yet done" is a false claim with an
        // honest clause bolted on, and a whole-sentence veto waves it through — so the clause that actually
        // names the work is the one that has to be honest about it.
        // Split on `;` and explicit contrast words only. An em-dash in this repo's prose is usually a
        // PARENTHETICAL — "the benchmarks — load throughput, intersect latency — are owed" — so treating it
        // as a clause break severs the subject from its own verb and flags honest text.
        const clause = sentence
          .split(/;|(?:,\s*(?:but|though|although|while)\b)/)
          .find((c) => NAMES_THE_WORK.test(c));
        if (clause !== undefined && ASSERTS_OWED.test(clause)) return false;
        return ASSERTS_DONE.test(sentence);
      });
  }

  it('catches the claim when its done-word is lines before the work it names', () => {
    expect(offendingSentences(WRAPPED_CLAIM)).not.toEqual([]);
  });

  it('leaves the honest phrasings legal', () => {
    for (const ok of [
      'Loaded-store benchmarks — owed. Load throughput, intersect latency, an RSS soak.',
      "The loaded store's own benchmarks are owed, not shipped; the page says so wherever it quotes one.",
      'Until the loaded-store benchmarks land they remain owed.',
    ])
      expect(offendingSentences(ok), ok).toEqual([]);
  });

  it.each(textFiles())('%s', (rel) => {
    if (!stillOwed) return;
    const hits = offendingSentences(readFileSync(join(ROOT, rel), 'utf8')).map(
      (sentence) =>
        `${rel} — claims the loaded-store benchmarks are done while ${ROADMAP} lists them as owed: ` +
        `"${sentence.trim().slice(0, 160)}"`,
    );
    expect(hits).toEqual([]);
  });
});
