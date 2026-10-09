import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Guards the rule that this repository carries NO pointer the public cannot reach — not a link, and not a
// bare citation either. An id like `Phase 4e`, `gap #1`, `finding S2` or `test-strategy T3` refers to a
// private tracker. It is worse than saying less, because it implies checkable evidence and then withholds it.
//
// A citation can land wherever prose is written, and a hand sweep finds some and leaves the rest, those in
// `packages/*/src` among them — which reach users on hover in an editor and inside the published `.d.ts` and
// sourcemaps. Nothing else compares prose to the rule: `leak-scan` checks configured needles (employer names
// and the like), the docs gates check that symbols and links resolve, and neither can see a citation. A
// defect that recurs earns a gate rather than more care.
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
  // Sibling working trees live under `.worktrees/`, which git does not track; named here as well so a tree
  // added to the index by mistake is still not read as this commit's content.
  '.worktrees',
]);

const EXTS = ['.ts', '.md', '.html', '.cjs', '.mjs', '.js', '.yml', '.yaml', '.json', '.txt'];

/**
 * Every tracked text file in the repo: this rule is about the repo being public, not about the tarball. Listed from
 * git's index rather than by walking the disk, so a file something else writes into the tree and removes while this
 * runs is never listed and then found gone. A new file is checked once it is staged.
 */
function publicFiles(): string[] {
  const out = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' })
    .split('\0')
    .filter((f) => f !== '')
    .map((f) => join(...f.split('/')))
    .filter((f) => !f.split(/[\\/]/).some((segment) => SKIP_DIRS.has(segment)))
    .filter((f) => EXTS.some((e) => f.endsWith(e)))
    // A tracked file deleted in the working tree and not yet committed has nothing to read.
    .filter((f) => existsSync(join(ROOT, f)));
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
 * `the B2 endpoint` are ordinary English about real things, and `S3` alone appears hundreds of times here.
 * This is the narrow, honest collision the rule says to exempt by NAME — widening the frames instead would
 * let every real citation through.
 *
 * Exempted by NAME, never by shape. A `V\d+` written to cover the V8 engine would excuse `V4`, `V5` and
 * `V7`, which are private-corpus ids, and swallow their hits silently. Only `V8` is a product.
 */
const PRODUCT_IDS = /^(?:S3|R2|B2|V8|EC2|H[23]|TS\d+|ES\d+|AL\d+|C[01]|P\d{1,2})$/;
//                                                        ^^^^^  ^^^^^^^
// `C0`/`C1` are the Unicode control-character blocks — `// C0 plus DEL: a bare \`< 0x20\` lets U+007F
// through` is a standards reference a reader resolves without us. `P50`/`P95`/`P99` are percentile notation,
// which in a latency-benchmark repo will appear the moment someone starts a sentence with one. Both are the
// narrow, honest collision the rule says to exempt by name rather than absorb by widening a frame.

/**
 * Citation forms only. Each names a document that exists solely in the private corpus.
 *
 * Deliberately NOT matched, because each one IS resolvable by a reader:
 * - `hard invariant 5` / `invariant #7` — the seven invariants are enumerated in this repo's `AGENTS.md`.
 * - `§13.5` — a section of a public doc in `docs/guide/`.
 * - `(#76)` — a GitHub PR or issue on this repository, which GitHub itself resolves.
 * - `R2` — Cloudflare R2, the object store, which is a product name and not a decision id.
 */
const CITATIONS: ReadonlyArray<readonly [string, RegExp]> = [
  // Case-insensitivity applies to the NUMBERED form only. `phase 4e` is a tracker citation however it is
  // capitalised, but a lone letter is usually a local identifier — `site/demo.js` says "the point of phase B"
  // about its own `function phaseB` a few lines up, which a reader resolves by scrolling. Lower-casing the
  // letter form would turn that into a hit.
  ['phase id', /\bphase[\s-]+\d+[a-z]?\b/i],
  ['phase id (letter)', /\bPhase[\s-]+[A-G]\d?\b/],
  ['audit gap', /\bgaps?\s*#\d+|\baudit gaps?\b/i],
  ['review finding', /\bfindings?\s+[A-Z]\d+\b/i],
  ['test-strategy id', /\btest-strategy\s+[A-Z]?\d+/i],
  ['threat-model id', /\bthreat[\s-]model\s+[A-Z]?\d+/i],
  ['audit round', /\baudit round\s+\d/i],
  // `decision 6`, lowercase and with no `#`, is a citation all the same. The naming word is what makes it
  // one; the case and the punctuation around it are not.
  ['decision log', /\bdecisions?\s*#?\s*\d+|\bADR\s*#?\s*\d+|\bDECISIONS\s*#\d+/i],
  ['internal doc number', /\b\d\d-[A-Z][A-Z-]{3,}\b/],
  // The BARE forms, which every pattern above misses because each of those requires a naming word
  // ("finding", "Phase", "ADR") that a bare id by definition does not carry. They are the commonest shape a
  // citation takes: `(S2)`, `(C13)`, `— S2)`, `the T4 cache-row contention stress`, `case R8`.
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
    // The trailing context is punctuation OR a lowercase word. Requiring a word misses `removed in D2,` and
    // `see the T4.` — a citation that ends its clause is the commonest shape of all, and the one a sweep
    // leaves behind when it deletes the surrounding words.
    new RegExp(`\\b(?:the|The|in|In|case|per|from|by|and)\\s+${BARE_ID}(?:\\s+[a-z]|[,.;:)])`),
  ],
  [
    'labelled id',
    new RegExp(`\\b(?:Conformance|conformance|round|Round|item|Item|case|Case)\\s+${BARE_ID}\\b`),
  ],
  // `(T3 regression guard)` — the id OPENS the parenthetical instead of filling it, which the first frame
  // (paren contains only ids) cannot see.
  ['id opening a parenthetical', new RegExp(`\\(${BARE_ID}\\s+[a-z]`)],
  // `S1: validate size, then deserialize…` — the id LABELS what follows instead of sitting inside a phrase,
  // so it carries no determiner, no parenthesis and no naming word. Every frame above needs one of those.
  // On the doc comment of a public method it ships in the published `.d.ts`, and reaches users on hover.
  ['id labelling a step', new RegExp(`(?:^|[\\s>])${BARE_ID}:\\s+[a-z]`, 'm')],
  // `…against a deterministic oracle: S1 a budgeted drain …; S2 hot-row contention…` — an inline enumeration
  // where each id heads its own clause, so there is no determiner in front and no bracket around it.
  ['id heading a clause', new RegExp(`[:;]\\s+${BARE_ID}\\s+[a-z]`)],
];

/**
 * Frames that apply to PUBLISHED SOURCE only, by name.
 *
 * `id labelling a step` is the right check for a doc comment and the wrong one for prose, because the prose
 * that writes `M1 — local end-to-end:` is DEFINING M1 in the same breath — `README.md` and `bench/scale.cjs`
 * both enumerate their own milestone vocabulary in the file that uses it, which is precisely what makes those
 * ids resolvable. Applied everywhere, the frame flags them, and a gate that fires on the honest cases is one
 * people learn to route around.
 *
 * Under `packages/*\/src` there is no such list, and the stakes are highest: these files become the published
 * `.d.ts` and sourcemaps, where an `S1: validate size, then deserialize` would sit on a public method.
 */
const SOURCE_ONLY_KINDS = new Set(['id labelling a step']);
const isPublishedSource = (rel: string): boolean => /^packages[/\\][^/\\]+[/\\]src[/\\]/.test(rel);

/**
 * The text as a READER sees it, with an index back to the original for reporting.
 *
 * Two things sit between the raw bytes and the sentence a reader parses, and a pattern applied to the raw
 * bytes misses a citation that is plainly there in both.
 *
 * **Markdown emphasis.** `(**I5**)` is not `(I5)`; `case **R8**` is not `case R8`. Every frame below is
 * built around the punctuation that surrounds an id, and a `**` lands exactly there. Without this, the gate
 * fails on its own documented example: this very file names ``case R8`` as a form it catches, and a
 * `case **R8**` in `CHANGELOG.md` would pass it.
 *
 * **Hard wraps.** These files wrap at ~110 columns, so `in Phase\n4e` is one phrase in two lines. A per-line
 * scan cannot see it, and which half a citation lands in is decided by how long the preceding words happen
 * to be; `vocabulary-damage.test.ts` reads across wraps for the same reason. Joining also has to drop the
 * continuation's comment prefix, or a JSDoc `*` sits where the id should be.
 *
 * Positions are mapped rather than recomputed: `map[i]` is the original offset of normalized character `i`,
 * so a hit still reports the line a human would open.
 */
function normalize(src: string): { text: string; map: number[] } {
  const out: string[] = [];
  const map: number[] = [];
  let i = 0;
  while (i < src.length) {
    const ch0 = src[i] as string;
    // Code ticks are presentation as well: a reader sees `Conformance \`D4\`` as "Conformance D4", and the
    // frame that names it cannot span the tick.
    if (ch0 === '`') {
      i += 1;
      continue;
    }
    // Bold/italic markers vanish: they are presentation, never part of the id or its frame.
    if (src.startsWith('**', i) || src.startsWith('__', i)) {
      i += 2;
      continue;
    }
    const ch = ch0;
    if ((ch === '*' || ch === '_') && /[A-Za-z0-9(]/.test(src[i + 1] ?? '')) {
      const prev = src[i - 1] ?? ' ';
      // An OPENING single marker: preceded by whitespace or an opening bracket. A `*` that follows a word
      // (`a*b`) or starts a JSDoc line is handled by the join below, not here.
      if (/[\s([{]/.test(prev)) {
        i += 1;
        continue;
      }
    }
    if ((ch === '*' || ch === '_') && /[A-Za-z0-9).,;:]/.test(src[i - 1] ?? '')) {
      i += 1;
      continue;
    }
    // A hard wrap becomes one space, taking the continuation's comment prefix with it.
    if (ch === '\n') {
      const m = /^\n[ \t]*(?:\*(?!\/)[ \t]?|\/\/[ \t]?|#[ \t]?|>[ \t]?)?/.exec(src.slice(i));
      const consumed = m === null ? 1 : m[0].length;
      out.push(' ');
      map.push(i);
      i += consumed;
      continue;
    }
    out.push(ch);
    map.push(i);
    i += 1;
  }
  return { text: out.join(''), map };
}

describe('no pointer the public cannot reach', () => {
  const files = publicFiles();

  it('scans the surfaces a citation reaches readers through', () => {
    // A renamed or moved tree must fail loudly here rather than silently shrink the guard.
    expect(files).toContain('CHANGELOG.md');
    expect(files.some((f) => f.startsWith(join('packages', 'core', 'src')))).toBe(true);
    expect(files.some((f) => f.startsWith(join('packages', 'roaring', 'src')))).toBe(true);
    // The three driver packages publish `.d.ts` exactly like the two above, so they are named here rather
    // than left to the listing. A guard that reaches a tree only by accident stops reaching it the day the
    // listing changes.
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
    const { text: line, map } = normalize(src);
    const hits: string[] = [];
    const lineOf = (idx: number): number => {
      const orig = map[Math.min(idx, map.length - 1)] ?? 0;
      return src.slice(0, orig).split('\n').length;
    };
    {
      for (const [kind, re] of CITATIONS) {
        if (SOURCE_ONLY_KINDS.has(kind) && !isPublishedSource(rel)) continue;
        // EVERY match on the line, and the product exemption applied PER MATCHED ID.
        //
        // A check that takes one match with `re.exec(line)` and `continue`s the whole pattern when that
        // match's id is a product name passes `the S3 bucket is read before the C13 cache row`: `S3` is
        // exempt, `continue` abandons the line, and `C13` is never looked at. Since `S3` alone appears hundreds
        // of times in this repo, "a line that mentions S3 AND carries a citation" is the common case, not a
        // contrived one — the exemption would hide exactly the hits the gate exists to find.
        for (const m of line.matchAll(new RegExp(re.source, `${re.flags.replace('g', '')}g`))) {
          // EVERY id in the match must be a product for the match to be excused. A match can carry more
          // than one — `(I2, V4, V5)` is a list, and so is `(S3, C13)`, where reading only the first id
          // would excuse the citation sitting behind a product name.
          const ids = [...m[0].matchAll(new RegExp(BARE_ID, 'g'))].map((x) => x[0]);
          if (ids.length > 0 && ids.every((x) => PRODUCT_IDS.test(x))) continue;
          hits.push(`${rel}:${lineOf(m.index ?? 0)}  ${kind} "${m[0]}"`);
        }
      }
    }
    expect(hits).toEqual([]);
  });
});
