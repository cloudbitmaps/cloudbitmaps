import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * Every restatement of a guarantee ties the claim it restates: the gate in `scripts/summary-ties.cjs`, run over the
 * tree, and proven in both directions on fixtures.
 *
 * WHY THIS EXISTS. docs/guide/correctness.md says how each guarantee holds under crashes, races and faults, and the
 * guides, READMEs, privacy note, roadmap and site restate those guarantees in short. A restatement written apart from
 * its mechanism drifts from it: it says that a write's random id settles it where the mechanism also reads the row
 * again, or that every race is reported where the mechanism names two that are not. The script's header states the
 * tie, every rule, the baseline and the known limits; the test names below use its labels, R1 to R7 (it skips R5).
 *
 * The cases below are named for what they plant: the ones labelled F1 to F12 must fail, each on the rule it names, and
 * the ones labelled N1 to N11 must not. F5 plants an edit to a tied claim, F6 one to a tied summary: the gate keeps no
 * record of who read what, so both pass the check, and each case asserts that `--changed` hands the review the pair.
 * The label F7 is not used: it would plant a stale record of that reading, which the gate does not keep. The command
 * line's own paths, the baseline compared with the merge base, `--update`, `--changed` and a shallow checkout, run on
 * scratch repositories at the end.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

interface Problem {
  rule: string;
  file: string;
  line: number;
  message: string;
  claim?: string;
}
interface Signature {
  claim: string;
  patterns: RegExp[];
  summary: string;
  lookAlike: string;
}
interface Row {
  file: string;
  claim: string;
  sentence: string;
  starts: string;
}
interface Hit {
  rule: string;
  claim: string;
  file: string;
  line: number;
  sentence: string;
  hash: string;
  excused?: boolean;
}
interface Claim {
  key: string;
  line: number;
  text: string;
  raw: string;
}
interface Region {
  file: string;
  line: number;
  heading: string;
  section?: string;
}
interface Result {
  page: { claims: Map<string, Claim>; sections: Array<{ slug: string; text: string }> };
  scope: string[];
  regions: Region[];
  hits: Hit[];
  problems: Problem[];
  notes: string[];
}
interface Io {
  log(line: string): void;
  error(line: string): void;
}
interface Gate {
  signatures?: Signature[];
  exclusions?: Exclusion[];
}
interface Exclusion {
  path?: string;
  pattern?: RegExp;
  label?: string;
  reason: string;
}
interface Ties {
  SOURCE: string;
  ABSOLUTE: string;
  BASELINE: string;
  MIN_SHARED: number;
  EXCLUDED: Exclusion[];
  SIGNATURES: Signature[];
  analyse(options: {
    files: Map<string, string>;
    baseline?: Row[];
    signatures?: Signature[];
    exclusions?: Exclusion[];
    minShared?: number;
  }): Result;
  check(root?: string, gate?: Gate): Result;
  main(argv: string[], options?: { root?: string; gate?: Gate; io?: Io }): number;
  baselineAt(root: string, sha: string): Row[] | undefined;
  baselineGrowth(head: Row[], base: Row[] | undefined): Problem[];
  changedPairs(
    base: Map<string, string>,
    head: Map<string, string>,
    baseline?: Row[],
  ): {
    claims: Array<{
      key: string;
      tiedBy: Array<{ file: string }>;
      untied: Array<{ file: string; line: number }>;
    }>;
    summaries: Array<{ file: string; claims: Claim[] }>;
  };
  words(text: string): string[];
  grams(text: string): string[];
  readTree(root?: string): Map<string, string>;
  readBaseline(root?: string): Row[];
  report(problems: Problem[]): string;
  sha(text: string): string;
  starts(text: string): string;
  tieForm(path: string, key: string): string;
}

const ties = createRequire(import.meta.url)('../../scripts/summary-ties.cjs') as Ties;
const { SOURCE, SIGNATURES } = ties;
const SOURCE_TEXT = readFileSync(join(ROOT, SOURCE), 'utf8');
/** The gate over the checked-out tree, once. */
const TREE = ties.check(ROOT);
/** The one exclusion a page set of a test's own keeps: correctness.md is the source, not a page. */
const ONLY_THE_SOURCE = ties.EXCLUDED.filter((e) => e.path === SOURCE);

// ---------------------------------------------------------------------------------------------------------------------

describe('the tree: every restatement of a guarantee ties the claim it restates', () => {
  const result = TREE;
  const of = (...rules: string[]): Problem[] =>
    result.problems.filter((p) => rules.includes(p.rule));

  it('reads what it guards: a scope that is not empty, every exclusion naming a file, every section and region', () => {
    for (const page of [
      'README.md',
      'PRIVACY.md',
      'SECURITY.md',
      'docs/ROADMAP.md',
      'docs/format.md',
      'docs/benchmarks.md',
      'docs/guide/loading.md',
      'docs/guide/api-reference.md',
      'packages/s3/README.md',
      'site/index.html',
      'site/flavors/roaring.html',
      'site/llms.txt',
    ])
      expect(result.scope, page).toContain(page);
    expect(result.scope.length).toBeGreaterThan(40);
    for (const page of [
      SOURCE,
      'CHANGELOG.md',
      'AGENTS.md',
      'packages/roaring/PRIVACY.md',
      'tests/README.md',
    ])
      expect(result.scope, page).not.toContain(page);
    expect(of('scope'), ties.report(of('scope'))).toEqual([]);
    expect(result.page.sections.map((s) => s.slug)).toHaveLength(10);
    expect(result.regions.map((r) => r.section).sort()).toEqual(
      result.page.sections.map((s) => s.slug).sort(),
    );
    expect(result.page.claims.size).toBe(75);
    // A key names its claim, never a heading: the section intros carry keys of their own.
    for (const key of [
      'refusal-is-reported-not-thrown',
      'a-load-makes-two-writes',
      'settle-by-read-back',
      'every-delete-reads-the-row',
    ])
      expect(result.page.claims.has(key), key).toBe(true);
    for (const s of result.page.sections)
      expect(result.page.claims.has(s.slug), s.slug).toBe(false);
    expect(result.hits.filter((h) => h.excused).length).toBeGreaterThan(0);
  });

  it('R1: every claim in correctness.md opens with a key of its own', () => {
    expect(of('R1'), ties.report(of('R1'))).toEqual([]);
  });

  it('R2: every link into correctness.md names a claim or a heading', () => {
    expect(of('R2'), ties.report(of('R2'))).toEqual([]);
  });

  it('R3 and R3b: every sentence that restates a claim sits in a block that ties it, or is in the baseline', () => {
    expect(of('R3', 'R3b'), ties.report(of('R3', 'R3b'))).toEqual([]);
  });

  it('R4: every summary region ties what it restates, and every section of correctness.md has one', () => {
    expect(of('R4'), ties.report(of('R4'))).toEqual([]);
  });

  it('R6: the baseline excuses only what it still finds, and holds no row the merge base with origin/main lacks', () => {
    expect(of('R6'), ties.report(of('R6'))).toEqual([]);
    // Where the merge base has no baseline yet, the run says it compared nothing rather than passing quietly.
    for (const n of result.notes) expect(n).toContain('no rows to compare');
  });

  it('R7: every signature names a claim, and each of its patterns still matches something', () => {
    expect(of('R7'), ties.report(of('R7'))).toEqual([]);
  });

  it('the baseline file is the one the gate reads, written as the formatter writes it', () => {
    const text = readFileSync(join(ROOT, ties.BASELINE), 'utf8');
    expect(text).toBe(`${JSON.stringify(JSON.parse(text), null, 2)}\n`);
    expect(ties.readBaseline(ROOT).length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------------

describe('the signatures, each on a real sentence it must match and a real look-alike it must not', () => {
  const page = 'docs/guide/fixture.md';
  const hitsOn = (sentence: string): string[] =>
    ties
      .analyse({
        files: new Map([
          [SOURCE, SOURCE_TEXT],
          [page, `${sentence}\n`],
        ]),
      })
      .hits.filter((h) => h.rule === 'R3' && h.file === page)
      .map((h) => h.claim);

  it.each(SIGNATURES.map((s) => [s.claim, s] as const))('%s', (claim, s) => {
    expect(s.patterns.length).toBeGreaterThan(0);
    expect(hitsOn(s.summary), s.summary).toContain(claim);
    expect(hitsOn(s.lookAlike), s.lookAlike).not.toContain(claim);
  });

  it('names one signature per claim', () => {
    const claims = SIGNATURES.map((s) => s.claim);
    expect(new Set(claims).size).toBe(claims.length);
  });
});

// ---------------------------------------------------------------------------------------------------------------------

/** A link into correctness.md as a page under docs/guide/ writes it. */
const tie = (key: string, text: string): string => `[${text}](correctness.md#${key})`;

/** The loading guide's summary of how a load stays correct, tied claim by claim. */
const TIED_LOADING = [
  `A load ${tie('numbering-is-the-loads', 'takes the next generation number itself')}, ${tie('publish-is-forward-only', 'writes its object first, and only once the object is durable moves the pointer')},`,
  `by a compare-and-swap that never moves it backwards and ${tie('which-fence', 'is fenced on the row the load read')}. So`,
  `${tie('crash-never-moves-the-pointer', 'a crash never moves the pointer')}, a rerun is a newer identical generation, and of two loads racing on one segment at most one lands.`,
  `A load that dies between its write and its publish leaves an orphan, which ${tie('orphan-collected-later', "a later load's collection removes")}.`,
  `A load's collection ${tie('what-collection-does', 'deletes only below the pointer on an active segment, keeps the window the row records')},`,
  `${tie('lease-read-from-the-row', 'spares a generation a live lease holds')}, and ${tie('collection-re-proves-the-row', 're-proves the row before every delete')}.`,
  `The whole mechanism is in [How a load stays correct](correctness.md#how-a-load-stays-correct).`,
].join('\n');

/** The retries summary of `docs/guide/production.md` as it was before it tied anything, linking only its section. */
const RETRIES_UNTIED = `A fault costs a read some latency and a write a re-run, never correctness: generations are write-once, a publish only
moves the pointer forward, and every byte is checksum-verified before use. A cloud SDK's own retry gives the wrong
answer for a conditional write, since a write that lands and loses its response meets itself when it is sent again. So
the S3 and GCS packages send a conditional write with the SDK's retry off for that request alone, except a GCS resumable
upload, which the SDK retries within its session, and the GCS registry's delete. A write that can meet itself carries a
random id in its metadata: every Azure Blob write, a GCS resumable upload, and an S3 or GCS object sent again after a
throttle. When such a write reports a conflict, the backend reads the stored object back, and one that carries the
write's own id is a success. For a generation's object that answer is definitive, since nothing overwrites it. A
registry row is overwritten by compare-and-swap, so a writer that swaps in over a write that landed, before the
read-back, makes that write report a conflict. Each package's conditional writes, and what a tagged write does on a
conflict, are in [How retries stay correct](correctness.md#how-retries-stay-correct).`;

/** One page per section of correctness.md, each holding one tied summary under its heading, so R4 has nothing to say. */
function summaries(omit: readonly string[] = []): string {
  const regions: Array<[string, string, string]> = [
    [
      'When a load is refused',
      'when-a-load-is-refused',
      'A refusal is reported in the result, not thrown.',
    ],
    [
      'When a write is throttled or gets no answer',
      'when-a-write-is-throttled-or-gets-no-answer',
      'A load makes two writes.',
    ],
    [
      'A write that gets no answer',
      'a-write-that-gets-no-answer',
      'A write that gets no answer is read back.',
    ],
    ['How it stays correct', 'how-a-load-stays-correct', "Generation numbering is the load's."],
    [
      'A rollback that races a collection',
      'a-rollback-that-races-a-collection',
      'A rollback can race a delete.',
    ],
    ['How a pin stays correct', 'how-a-pin-stays-correct', 'A pin is safe across a re-creation.'],
    [
      'How retention stays correct',
      'how-retention-stays-correct',
      'A drop writes the tombstone first.',
    ],
    ['How an erasure stays correct', 'how-an-erasure-stays-correct', 'An erasure is a rewrite.'],
    [
      'How encryption stays correct',
      'how-encryption-stays-correct',
      'A segment is never half-encrypted.',
    ],
    ['How retries stay correct', 'how-retries-stay-correct', 'A fault costs a write a re-run.'],
  ];
  const claimOf: Record<string, string> = {
    'when-a-load-is-refused': 'refusal-is-reported-not-thrown',
    'when-a-write-is-throttled-or-gets-no-answer': 'a-load-makes-two-writes',
    'a-write-that-gets-no-answer': 'settle-by-read-back',
    'a-rollback-that-races-a-collection': 'every-delete-reads-the-row',
    'how-a-load-stays-correct': 'numbering-is-the-loads',
    'how-a-pin-stays-correct': 'pin-safe-across-re-creation',
    'how-retention-stays-correct': 'drop-registry-first',
    'how-an-erasure-stays-correct': 'erasure-is-a-rewrite',
    'how-encryption-stays-correct': 'never-half-encrypted',
    'how-retries-stay-correct': 'fault-costs-a-re-run',
  };
  return regions
    .filter(([, slug]) => !omit.includes(slug))
    .map(([heading, slug, text]) => {
      const link = ` ${tie(claimOf[slug] ?? '', 'Why')}.`;
      return `## ${heading}\n\n${text}${link} The rest is in [the section](correctness.md#${slug}).\n`;
    })
    .join('\n');
}

const SUMMARIES = 'docs/guide/summaries.md';

/** The gate over correctness.md, a page holding a tied summary of every section, and `pages`. */
function run(
  pages: Record<string, string>,
  options: { baseline?: Row[]; source?: string; omit?: string[] } = {},
) {
  const files = new Map<string, string>([
    [SOURCE, options.source ?? SOURCE_TEXT],
    [SUMMARIES, summaries(options.omit)],
    ...Object.entries(pages),
  ]);
  return ties.analyse({ files, baseline: options.baseline ?? [] });
}

/** The problems a run found on `file`, as `rule claim` (or the rule alone). */
const on = (result: Result, file: string): string[] =>
  result.problems
    .filter((p) => p.file === file)
    .map((p) => (p.claim === undefined ? p.rule : `${p.rule} ${p.claim}`));

describe('the gate must fail', () => {
  it('F1: the retries summary as it stood, tied only to its section, is reported for each claim it restates', () => {
    const page = 'docs/guide/production.md';
    const found = on(run({ [page]: `## How it stays correct\n\n${RETRIES_UNTIED}\n` }), page);
    for (const claim of [
      'fault-costs-a-re-run',
      'sdk-retry',
      'tagged-writes',
      'object-write-resent',
    ])
      expect(found).toContain(`R3 ${claim}`);
    expect(found).toContain('R4');
    // The drift that earned this gate, in the words it shipped with: a random id that "settles" a write.
    const drift = 'A write that can meet itself carries a random id that settles it.';
    expect(
      on(
        run({ [page]: `${drift} See [retries](correctness.md#how-retries-stay-correct).\n` }),
        page,
      ),
    ).toContain('R3 tagged-writes');
  });

  it('F2: the tied loading summary with every link stripped is reported, on its claims and as a region', () => {
    const page = 'docs/guide/loading.md';
    expect(on(run({ [page]: `## How it stays correct\n\n${TIED_LOADING}\n` }), page)).toEqual([]);
    const stripped = TIED_LOADING.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
    const found = on(run({ [page]: `## How it stays correct\n\n${stripped}\n` }), page);
    expect(found).toContain('R3 crash-never-moves-the-pointer');
    expect(found).toContain('R3 publish-is-forward-only');
    expect(found).toContain('R4');
  });

  it('F3: a tie with a typo in its key names neither a claim nor a heading', () => {
    const page = 'docs/guide/fixture.md';
    const result = run({
      [page]: `So ${tie('crash-never-moves-pointer', 'a crash never moves the pointer')}.\n`,
    });
    expect(on(result, page)).toContain('R2');
    expect(on(result, page)).toContain('R3 crash-never-moves-the-pointer');
  });

  it('F4: a claim with no key, a key twice, a key that is a heading slug or of another shape, an anchor mid-block', () => {
    const rules = (source: string): string[] =>
      run({}, { source })
        .problems.filter((p) => p.rule === 'R1')
        .map((p) => p.message);
    const bold = '**A claim nobody keyed.** It says something about crashes.';
    expect(
      rules(
        SOURCE_TEXT.replace('## How a pin stays correct', `${bold}\n\n## How a pin stays correct`),
      ),
    ).toEqual([expect.stringContaining('a claim with no key')]);
    expect(
      rules(SOURCE_TEXT.replace('<a id="miss-is-a-re-read">', '<a id="which-fence">')),
    ).toEqual([expect.stringContaining('two anchors share the key "which-fence"')]);
    expect(
      rules(SOURCE_TEXT.replace('<a id="miss-is-a-re-read">', '<a id="how-a-load-stays-correct">')),
    ).toEqual([expect.stringContaining("is a heading's slug")]);
    expect(
      rules(SOURCE_TEXT.replace('<a id="miss-is-a-re-read">', '<a id="Miss_Is_A_Re_Read">')),
    ).toEqual([expect.stringContaining('not lower-case words')]);
    expect(
      rules(
        SOURCE_TEXT.replace(
          '<a id="miss-is-a-re-read"></a>**A miss',
          '**A miss <a id="miss-is-a-re-read"></a>',
        ),
      ),
    ).toEqual(expect.arrayContaining([expect.stringContaining('does not open its block')]));
    // A section's opening text is a claim too, keyed like any other, never by its heading.
    expect(rules(SOURCE_TEXT.replace('<a id="a-load-makes-two-writes"></a>', ''))).toEqual([
      expect.stringContaining('before its first anchor is a claim with no key'),
    ]);
    // A numbered step of a claim needs no key of its own.
    expect(rules(SOURCE_TEXT)).toEqual([]);
    expect(SOURCE_TEXT).toMatch(/^1\. \*\*Registry first\.\*\*/m);
  });

  it('F5 (no ledger): a word changed in a tied claim passes the check, and --changed lists it with each block that ties it', () => {
    const page = 'docs/guide/production.md';
    const summary = `A write that can meet itself ${tie('tagged-writes', 'carries a random id')}.\n`;
    const base = new Map([
      [SOURCE, SOURCE_TEXT],
      [page, summary],
    ]);
    const edited = SOURCE_TEXT.replace(
      'works with a client you pass, and adds no option',
      'works with any client, and adds no option',
    );
    expect(edited).not.toBe(SOURCE_TEXT);
    const head = new Map([
      [SOURCE, edited],
      [page, summary],
    ]);
    expect(on(ties.analyse({ files: head }), page)).toEqual([]);
    const { claims } = ties.changedPairs(base, head);
    expect(claims.map((c) => c.key)).toEqual(['tagged-writes']);
    expect(claims[0]?.tiedBy.map((b) => b.file)).toEqual([page]);
  });

  it('F6 (no ledger): a word changed in a tied summary passes the check, and --changed lists it with its claims', () => {
    const page = 'docs/guide/production.md';
    const before = `A write that can meet itself ${tie('tagged-writes', 'carries a random id')}.\n`;
    const after = `A write that can meet itself ${tie('tagged-writes', 'carries a random tag')}.\n`;
    const base = new Map([
      [SOURCE, SOURCE_TEXT],
      [page, before],
    ]);
    const head = new Map([
      [SOURCE, SOURCE_TEXT],
      [page, after],
    ]);
    expect(on(ties.analyse({ files: head }), page)).toEqual([]);
    const { claims, summaries: changed } = ties.changedPairs(base, head);
    expect(claims).toEqual([]);
    expect(changed.map((s) => [s.file, s.claims.map((c) => c.key)])).toEqual([
      [page, ['tagged-writes']],
    ]);
    expect(ties.changedPairs(base, base).summaries).toEqual([]);
  });

  it('F8: a sentence of correctness.md pasted unlinked into a README copies its claim', () => {
    const page = 'packages/s3/README.md';
    const pasted =
      'A registry row is overwritten by compare-and-swap, so a writer that swaps in over a write that landed, before ' +
      'the read-back, makes that write report `WriteConflictError`.';
    expect(on(run({ [page]: `${pasted}\n` }), page)).toContain('R3b tagged-writes');
    // In words no signature lists: only the copied run sees it.
    const unlisted =
      'The read happens only on a conflict, works with a client you pass, and adds no option.';
    expect(on(run({ [page]: `${unlisted}\n` }), page)).toEqual(['R3b tagged-writes']);
  });

  it('F9: the same restatement is seen across a wrap, in a table cell, behind a link, in bold, and across a <br>', () => {
    const md = 'docs/guide/fixture.md';
    const shapes = [
      'So a crash never\nmoves the pointer.',
      '| What | Why |\n|---|---|\n| a load | So a crash never moves the pointer. |',
      'So a crash [never moves the pointer](loading.md).',
      'So a **crash never moves** the pointer.',
      '- A list item: so a crash\n  never moves the pointer.',
      '> So a crash never moves\n> the pointer.',
    ];
    for (const shape of shapes)
      expect(on(run({ [md]: `${shape}\n` }), md), shape).toContain(
        'R3 crash-never-moves-the-pointer',
      );
    const html = 'site/fixture.html';
    const page =
      '<main>\n  <p class="x">So a <strong>crash</strong> never<br>\n    moves the pointer.</p>\n</main>\n';
    expect(on(run({ [html]: page }), html)).toContain('R3 crash-never-moves-the-pointer');
    const txt = 'site/fixture.txt';
    expect(on(run({ [txt]: '- So a crash never moves the pointer.\n' }), txt)).toContain(
      'R3 crash-never-moves-the-pointer',
    );
  });

  it('F10: a section whose summary region is gone, or that has two', () => {
    const missing = run({}, { omit: ['how-encryption-stays-correct'] }).problems.filter(
      (p) => p.rule === 'R4',
    );
    expect(missing.map((p) => p.message)).toEqual([
      expect.stringContaining('"How encryption stays correct" has no summary region'),
    ]);
    const encryption = `## How encryption stays correct\n\n${tie('never-half-encrypted', 'Never half-encrypted')}, in [the section](correctness.md#how-encryption-stays-correct).\n`;
    const twice = run({ 'docs/guide/encryption.md': encryption }).problems.filter(
      (p) => p.rule === 'R4',
    );
    expect(twice.map((p) => p.message)).toEqual([expect.stringContaining('has 2 summary regions')]);
  });

  it('F10: a summary region that names no section, two, or another than its heading; a block in it that ties nothing', () => {
    const page = 'docs/guide/fixture.md';
    const none = run({ [page]: `## How it stays correct\n\nA pin is cheap to take.\n` });
    expect(none.problems.filter((p) => p.file === page).map((p) => p.message)).toEqual([
      expect.stringContaining('ties no claim'),
      expect.stringContaining('names no section'),
    ]);
    const two = `## How it stays correct\n\n${tie('seal-count', 'Seals')} and ${tie('fault-costs-a-re-run', 'faults')}: [a](correctness.md#how-encryption-stays-correct), [b](correctness.md#how-retries-stay-correct).\n`;
    expect(on(run({ [page]: two }), page)).toEqual(['R4']);
    const other = `## How a pin stays correct\n\n${tie('seal-count', 'Seals')}, in [encryption](correctness.md#how-encryption-stays-correct).\n`;
    expect(
      run({ [page]: other })
        .problems.filter((p) => p.file === page)
        .map((p) => p.message),
    ).toEqual([expect.stringContaining('not its own')]);
  });

  it('F11: a baseline row the merge base does not have; a row that excuses nothing once its sentence is tied', () => {
    const page = 'docs/guide/fixture.md';
    const sentence = 'So a crash never moves the pointer.';
    const row: Row = {
      file: page,
      claim: 'crash-never-moves-the-pointer',
      sentence: ties.sha(sentence),
      starts: ties.starts(sentence),
    };
    expect(on(run({ [page]: `${sentence}\n` }, { baseline: [row] }), page)).toEqual([]);
    expect(ties.baselineGrowth([row], []).map((p) => p.rule)).toEqual(['R6']);
    expect(ties.baselineGrowth([row], [row])).toEqual([]);
    // The change that adds the baseline: the merge base has none, so every row is that change's own.
    expect(ties.baselineGrowth([row], undefined)).toEqual([]);
    const tied = `So ${tie('crash-never-moves-the-pointer', 'a crash never moves the pointer')}.\n`;
    const stale = run({ [page]: tied }, { baseline: [row] }).problems.filter(
      (p) => p.rule === 'R6',
    );
    expect(stale.map((p) => p.message)).toEqual([expect.stringContaining('excuses nothing')]);
    expect(
      run({ [page]: `${sentence}\n` }, { baseline: [row, row] }).problems.filter(
        (p) => p.rule === 'R6',
      ),
    ).toHaveLength(1);
  });

  it('F11: a row does not excuse a sentence in a summary region', () => {
    const page = 'docs/guide/fixture.md';
    const sentence = 'So a crash never moves the pointer.';
    const row: Row = {
      file: page,
      claim: 'crash-never-moves-the-pointer',
      sentence: ties.sha(sentence),
      starts: ties.starts(sentence),
    };
    const region = `## How it stays correct\n\n${sentence} ${tie('numbering-is-the-loads', 'Numbering')}, in [the section](correctness.md#how-a-load-stays-correct).\n`;
    expect(on(run({ [page]: region }, { baseline: [row] }), page)).toContain(
      'R3 crash-never-moves-the-pointer',
    );
  });

  it('F12: a signature that names no claim, and a pattern that matches nothing', () => {
    const files = new Map([[SOURCE, SOURCE_TEXT]]);
    const signatures: Signature[] = [
      { claim: 'no-such-claim', patterns: [/crash/i], summary: '', lookAlike: '' },
      {
        claim: 'seal-count',
        patterns: [/96-bit nonce/i, /a phrase written nowhere at all/i],
        summary: '',
        lookAlike: '',
      },
    ];
    const r7 = ties.analyse({ files, signatures }).problems.filter((p) => p.rule === 'R7');
    expect(r7.map((p) => p.message)).toEqual([
      expect.stringContaining('names no claim: "no-such-claim"'),
      expect.stringContaining('/a phrase written nowhere at all/i of `seal-count` matches nothing'),
    ]);
  });

  it('an exclusion that names no file', () => {
    const result = ties.analyse({ files: new Map([[SOURCE, SOURCE_TEXT]]) });
    expect(result.problems.filter((p) => p.rule === 'scope').map((p) => p.file)).toEqual(
      expect.arrayContaining(['CHANGELOG.md', 'AGENTS.md', 'packages/roaring/PRIVACY.md']),
    );
  });
});

describe('the gate must not trip', () => {
  const page = 'docs/guide/fixture.md';

  it('N1: a paraphrase that ties the right claim, and the summary in its own words with its ties', () => {
    const paraphrase = `${tie('crash-never-moves-the-pointer', 'nothing a crash does moves the pointer')}; so a crash never moves the pointer.\n`;
    expect(on(run({ [page]: paraphrase }), page)).toEqual([]);
    expect(on(run({ [page]: `${TIED_LOADING}\n` }), page)).toEqual([]);
  });

  it('N2: a guarantee named as a term', () => {
    const terms = {
      'site/llms.txt':
        'CloudBitmaps keeps each segment as a storage\ntier of write-once `.crbm` generations, with one small registry row per segment.\n',
      'packages/core/README.md':
        '| `publish.ts` | the forward-only pointer advance every write ends with, the lease patch, the refusal to point a keyed row at a cleartext generation |\n',
    };
    const result = run(terms);
    for (const file of Object.keys(terms)) expect(on(result, file), file).toEqual([]);
  });

  it('N3: the same words about another subject', () => {
    const text = [
      '- A `segment.collect` with no `fromGeneration` is not a receipt for the bit.',
      '- A `segment.publish` is not a receipt for anything: it says a set was loaded, not what was removed from it.',
      '',
      '| `StaleOperandError` | another generation, the name deleted and created again, or the number taken again by other bytes |',
    ].join('\n');
    expect(on(run({ [page]: `${text}\n` }), page)).toEqual([]);
  });

  it('N4: a navigation sentence that names claims as topics', () => {
    const nav =
      'The seal count, and why a half-encrypted segment is refused either way round, are in\n' +
      '[How encryption stays correct](correctness.md#how-encryption-stays-correct).\n';
    expect(on(run({ [page]: nav }), page)).toEqual([]);
  });

  it('N5: fenced code, and a code span alone', () => {
    const code =
      '```ts\n// a crash never moves the pointer\nconst n = await segment.count();\n```\n\nIt returns `published: false`.\n';
    expect(on(run({ [page]: code }), page)).toEqual([]);
    const html = 'site/fixture.html';
    expect(
      on(run({ [html]: '<pre><code>// a crash never moves the pointer</code></pre>\n' }), html),
    ).toEqual([]);
  });

  it('N6: a negation in the words before the claim', () => {
    expect(on(run({ [page]: 'Nothing promises that at most one lands.\n' }), page)).toEqual([]);
    // A negation in another clause does not stand a match down.
    expect(on(run({ [page]: 'There is no switch, so it tags each write.\n' }), page)).toContain(
      'R3 tagged-writes',
    );
  });

  it('N7: a restatement in the changelog', () => {
    expect(
      on(run({ 'CHANGELOG.md': '- So a crash never moves the pointer.\n' }), 'CHANGELOG.md'),
    ).toEqual([]);
  });

  it('N8: a block whose tie sits in a later sentence than its restatement', () => {
    const block = `A load writes first. So a crash never moves the pointer. It is cheap. It is ${tie('crash-never-moves-the-pointer', 'proven')}.\n`;
    expect(on(run({ [page]: block }), page)).toEqual([]);
  });

  it('N9: the published privacy note, held equal to the root one by its own gate', () => {
    const npm = 'packages/roaring/PRIVACY.md';
    expect(on(run({ [npm]: 'So a crash never moves the pointer.\n' }), npm)).toEqual([]);
    expect(ties.tieForm('packages/roaring/README.md', 'seal-count')).toBe(
      `${ties.ABSOLUTE}docs/guide/correctness.md#seal-count`,
    );
    expect(ties.tieForm('PRIVACY.md', 'seal-count')).toBe('docs/guide/correctness.md#seal-count');
    expect(ties.tieForm('docs/ROADMAP.md', 'seal-count')).toBe('guide/correctness.md#seal-count');
    const absolute = `So [a crash never moves the pointer](${ties.ABSOLUTE}docs/guide/correctness.md#crash-never-moves-the-pointer).\n`;
    expect(on(run({ 'packages/s3/README.md': absolute }), 'packages/s3/README.md')).toEqual([]);
    const bare = `- So a crash never moves the pointer (${ties.ABSOLUTE}docs/guide/correctness.md#crash-never-moves-the-pointer).\n`;
    expect(on(run({ 'site/fixture.txt': bare }), 'site/fixture.txt')).toEqual([]);
    const href = `<p>So a crash <a href="${ties.ABSOLUTE}docs/guide/correctness.md#crash-never-moves-the-pointer">never moves the pointer</a>.</p>\n`;
    expect(on(run({ 'site/fixture.html': href }), 'site/fixture.html')).toEqual([]);
  });

  it('N10: a heading is a region marker, not a sentence', () => {
    const readme = 'README.md';
    expect(
      on(run({ [readme]: '## Why a crash never moves the pointer\n\nBecause.\n' }), readme),
    ).toEqual([]);
  });

  it("N11: correctness.md's own sentences", () => {
    expect(run({}).hits.filter((h) => h.file === SOURCE)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------

describe('a section intro is keyed like every claim, and a link to its heading is navigation', () => {
  it('an intro region with its claim links stripped and its heading link kept ties no claim', () => {
    const page = 'docs/guide/loading.md';
    const throttled = 'when-a-write-is-throttled-or-gets-no-answer';
    const region = `### When a write is throttled or gets no answer\n\nA load makes two writes, in [When a write is throttled or gets no answer](correctness.md#${throttled}).\n`;
    const stripped = run({ [page]: region }, { omit: [throttled] });
    expect(stripped.problems.filter((p) => p.file === page).map((p) => p.message)).toEqual([
      expect.stringContaining('ties no claim'),
    ]);
    const tied = region.replace(
      'A load makes two writes',
      tie('a-load-makes-two-writes', 'A load makes two writes'),
    );
    expect(on(run({ [page]: tied }, { omit: [throttled] }), page)).toEqual([]);
  });

  it("an intro restated in another section's summary ties by its key, and that summary still names one section", () => {
    const page = 'docs/guide/production.md';
    const retries = 'how-retries-stay-correct';
    const untied = `## How it stays correct\n\nA fault costs a write a re-run, ${tie('fault-costs-a-re-run', 'never correctness')}. A load a guard refuses returns \`published: false\` rather than throwing. The rest is in [How retries stay correct](correctness.md#${retries}).\n`;
    expect(on(run({ [page]: untied }, { omit: [retries] }), page)).toEqual([
      'R3 refusal-is-reported-not-thrown',
    ]);
    const tied = untied.replace(
      'returns `published: false` rather than throwing',
      tie('refusal-is-reported-not-thrown', 'returns `published: false` rather than throwing'),
    );
    expect(on(run({ [page]: tied }, { omit: [retries] }), page)).toEqual([]);
  });

  it('R4: under each summary heading of the tree, a block that ties no claim fails', () => {
    const page = 'docs/guide/fixture.md';
    const regions = TREE.regions;
    expect(regions).toHaveLength(10);
    for (const r of regions) {
      const slug = r.section ?? '';
      const untied = `## ${r.heading}\n\nA plain sentence, in [the section](correctness.md#${slug}).\n`;
      const found = run({ [page]: untied }, { omit: [slug] }).problems.filter(
        (p) => p.file === page,
      );
      expect(
        found.map((p) => p.message),
        r.heading,
      ).toEqual([
        expect.stringContaining(`under the summary heading "${r.heading}" ties no claim`),
      ]);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------

describe('R3b: the threshold, the tie, and the claim a copied run comes from', () => {
  const page = 'docs/guide/fixture.md';
  const claims = run({}).page.claims;

  /** `n + 3` consecutive words of the claim `key`, which share exactly `n` 4-grams with it. */
  function copied(key: string, n: number): string {
    const w = ties.words(claims.get(key)?.text ?? '');
    for (let i = 0; i + n + 3 <= w.length; i++) {
      const s = w.slice(i, i + n + 3).join(' ');
      if (new Set(ties.grams(s)).size === n && !/\d/.test(s)) return s;
    }
    throw new Error(`no run of ${n + 3} words in ${key}`);
  }

  it('a copy of 7 shared 4-grams passes and one of 8 fails: the threshold as measured', () => {
    expect(on(run({ [page]: `${copied('retention-cost', 7)}.\n` }), page)).toEqual([]);
    expect(on(run({ [page]: `${copied('retention-cost', 8)}.\n` }), page)).toEqual([
      'R3b retention-cost',
    ]);
  });

  it('a copy is tied by its own claim, not by whatever else its block links', () => {
    const s = copied('retention-cost', 12);
    expect(on(run({ [page]: `${s}. ${tie('seal-count', 'Seals')}.\n` }), page)).toEqual([
      'R3b retention-cost',
    ]);
    expect(on(run({ [page]: `${s}. ${tie('retention-cost', 'Costs')}.\n` }), page)).toEqual([]);
  });

  it('names the claim a longer run comes from beside the one sharing the most, and a tie to either passes', () => {
    const w = (from: number, n: number): string =>
      Array.from({ length: n }, (_, i) => `w${from + i}`).join(' ');
    // `claim-a` shares nine 4-grams, one per phrase; `claim-b` shares eight, all in one run of eleven words.
    const phrases = Array.from({ length: 9 }, (_, i) => w(100 + i * 10, 4));
    const runB = w(500, 11);
    const source = [
      '# How it stays correct',
      '',
      '## A section',
      '',
      `<a id="claim-a"></a>**Claim a.** ${phrases.join('. ')}.`,
      '',
      `<a id="claim-b"></a>**Claim b.** ${runB}.`,
      '',
      '<a id="claim-c"></a>**Claim c.** Nothing either says.',
      '',
    ].join('\n');
    const sentence = `${phrases.join(' x ')} y ${runB}.`;
    const problems = (block: string): Problem[] =>
      ties
        .analyse({
          files: new Map([
            [SOURCE, source],
            [page, `${block}\n`],
          ]),
          signatures: [],
          exclusions: ONLY_THE_SOURCE,
        })
        .problems.filter((p) => p.file === page);
    const untied = problems(sentence);
    expect(untied.map((p) => `${p.rule} ${p.claim}`)).toEqual(['R3b claim-a']);
    expect(untied[0]?.message).toContain(`"${runB}", is from \`claim-b\``);
    expect(problems(`${sentence} ${tie('claim-b', 'B')}.`)).toEqual([]);
    expect(problems(`${sentence} ${tie('claim-a', 'A')}.`)).toEqual([]);
    expect(problems(`${sentence} ${tie('claim-c', 'C')}.`).map((p) => p.rule)).toEqual(['R3b']);
  });
});

// ---------------------------------------------------------------------------------------------------------------------

describe('what a page is read as: line endings, comments, emphasis, hyphens, link forms', () => {
  const page = 'docs/guide/fixture.md';

  // Budget 15 s, derived: it reads the whole tree twice and spawns git to list it, so its time grows with machine load.
  // About ten times its slowest idle measurement (1.5 s: 1.3 s on a developer machine, 3.3 s on the release job's runner
  // in a single full run, the slower of its two attempts), the headroom for loads of 20 to 80 on a shared machine.
  // Never below vitest's 5 s test default.
  it('a CRLF checkout reads as an LF one: the same problems and hits over the whole tree', () => {
    const files = ties.readTree(ROOT);
    const baseline = ties.readBaseline(ROOT);
    const lf = ties.analyse({ files, baseline });
    const crlf = ties.analyse({
      files: new Map([...files].map(([path, text]) => [path, text.replace(/\n/g, '\r\n')])),
      baseline,
    });
    expect(ties.report(crlf.problems)).toBe(ties.report(lf.problems));
    expect(crlf.hits.map((h) => `${h.file}:${h.line} ${h.claim}`)).toEqual(
      lf.hits.map((h) => `${h.file}:${h.line} ${h.claim}`),
    );
    expect(on(run({ [page]: '- So a crash never\r\n  moves the pointer.\r\n' }), page)).toContain(
      'R3 crash-never-moves-the-pointer',
    );
  }, 15_000);

  it('a comment opener in a code span or a fence is text, and the prose after it is still read', () => {
    const span =
      'Type `<!--` to open a comment.\n\nSo a crash never moves the pointer.\n\nAnd `-->` closes it.\n';
    expect(on(run({ [page]: span }), page)).toContain('R3 crash-never-moves-the-pointer');
    const fence =
      '```html\n<!-- a comment left open\n```\n\nSo a crash never moves the pointer.\n\n<!-- a closed one -->\n';
    expect(on(run({ [page]: fence }), page)).toContain('R3 crash-never-moves-the-pointer');
    const real = 'Before.\n\n<!--\nSo a crash never moves the pointer.\n-->\n\nAfter.\n';
    expect(on(run({ [page]: real }), page)).toEqual([]);
    expect(
      on(run({ [page]: 'Before <!-- So a crash never moves the pointer. --> after.\n' }), page),
    ).toEqual([]);
  });

  it('"no answer" is a claim\'s own wording, not a negation', () => {
    const answer =
      'A load that gets no answer reads the row and sends a fresh compare-and-swap from it.\n';
    expect(on(run({ [page]: answer }), page)).toContain('R3 row-write-settled');
    expect(on(run({ [page]: 'Nothing promises that at most one lands.\n' }), page)).toEqual([]);
  });

  it('emphasis, strikethrough and a non-breaking hyphen do not hide a phrase', () => {
    for (const shape of [
      'So a _crash never_ moves the pointer.',
      'So a crash ~~never~~ moves the pointer.',
      'So a __crash never__ moves the pointer.',
    ])
      expect(on(run({ [page]: `${shape}\n` }), page), shape).toContain(
        'R3 crash-never-moves-the-pointer',
      );
    for (const dash of ['&#8209;', '‑', '&#x2010;'])
      expect(
        on(run({ [page]: `A segment is never half${dash}encrypted.\n` }), page),
        dash,
      ).toContain('R3 never-half-encrypted');
  });

  it("a rollback's swap settled by reading the row asks for its own claim, not the load's", () => {
    const swap =
      'A swap of the pointer that gets no answer (`TransientError`), or that meets a conflict, is settled by reading the row the rollback just swapped.';
    const own = 'correctness.md#rollback-settles-its-swap';
    expect(on(run({ [page]: `${swap}\n` }), page)).toEqual(['R3 rollback-settles-its-swap']);
    expect(
      on(
        run({
          [page]: `${swap.replace('is settled by reading the row', `[is settled by reading the row](${own})`)}\n`,
        }),
        page,
      ),
    ).toEqual([]);
    for (const subject of ['A move', 'A swap'])
      expect(
        on(
          run({ [page]: `${subject} that gets no answer is settled by reading the row.\n` }),
          page,
        ),
        subject,
      ).not.toContain('R3 row-write-settled');
    expect(
      on(
        run({ [page]: 'A registry write that gets no answer is settled by reading the row.\n' }),
        page,
      ),
    ).toEqual(['R3 row-write-settled']);
  });

  it('a soft hyphen inside a word does not hide a phrase', () => {
    expect(
      on(run({ [page]: 'So a cra\u00ADsh never moves the poin\u00ADter.\n' }), page),
    ).toContain('R3 crash-never-moves-the-pointer');
  });

  it('the text after a --> that closes a multi-line comment is read', () => {
    const closed =
      'Before.\n\n<!--\na hidden line\n--> So a crash never moves the pointer.\n\nAfter.\n';
    expect(on(run({ [page]: closed }), page)).toContain('R3 crash-never-moves-the-pointer');
  });

  it('a shortcut reference link and an unquoted href tie, as a reader follows them', () => {
    const claim = 'correctness.md#crash-never-moves-the-pointer';
    const shortcut = `So [a crash never moves the pointer].\n\n[a crash never moves the pointer]: ${claim}\n`;
    expect(on(run({ [page]: shortcut }), page)).toEqual([]);
    expect(on(run({ [page]: 'So [a crash never moves the pointer].\n' }), page)).toContain(
      'R3 crash-never-moves-the-pointer',
    );
    const bare = `So <a href=${claim}>a crash never moves the pointer</a>.\n`;
    expect(on(run({ [page]: bare }), page)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------

describe('--changed hands the review every pair', () => {
  it('a tie re-pointed from one claim to another, its words unchanged', () => {
    const page = 'docs/guide/production.md';
    const before = `Each chunk is sealed ${tie('seal-count', 'with a fresh nonce')}.\n`;
    const after = `Each chunk is sealed ${tie('never-half-encrypted', 'with a fresh nonce')}.\n`;
    const { summaries: changed } = ties.changedPairs(
      new Map([
        [SOURCE, SOURCE_TEXT],
        [page, before],
      ]),
      new Map([
        [SOURCE, SOURCE_TEXT],
        [page, after],
      ]),
    );
    expect(changed.map((s) => [s.file, s.claims.map((c) => c.key)])).toEqual([
      [page, ['never-half-encrypted']],
    ]);
  });

  it("an edit inside a claim's fenced block, and one to a link target in its text", () => {
    const base = new Map([[SOURCE, SOURCE_TEXT]]);
    const fenced = SOURCE_TEXT.replace('reads the row: g may go', 'reads the row: g can go');
    expect(fenced).not.toBe(SOURCE_TEXT);
    expect(ties.changedPairs(base, new Map([[SOURCE, fenced]])).claims.map((c) => c.key)).toEqual([
      'every-delete-reads-the-row',
    ]);
    const target = SOURCE_TEXT.replace(
      '([why, and the exceptions](#how-a-load-stays-correct))',
      '([why, and the exceptions](#orphan-collected-later))',
    );
    expect(target).not.toBe(SOURCE_TEXT);
    expect(ties.changedPairs(base, new Map([[SOURCE, target]])).claims.map((c) => c.key)).toEqual([
      'judged-after-the-write',
    ]);
  });

  it('under a changed claim, the restatements of it that the baseline excuses', () => {
    const page = 'docs/guide/fixture.md';
    const sentence = 'So a crash never moves the pointer.';
    const row: Row = {
      file: page,
      claim: 'crash-never-moves-the-pointer',
      sentence: ties.sha(sentence),
      starts: ties.starts(sentence),
    };
    const edited = SOURCE_TEXT.replace(
      '**A crash never moves the pointer.**',
      '**A crash never moves the pointer, ever.**',
    );
    expect(edited).not.toBe(SOURCE_TEXT);
    const { claims } = ties.changedPairs(
      new Map([
        [SOURCE, SOURCE_TEXT],
        [page, `${sentence}\n`],
      ]),
      new Map([
        [SOURCE, edited],
        [page, `${sentence}\n`],
      ]),
      [row],
    );
    expect(claims.map((c) => [c.key, c.untied.map((h) => `${h.file}:${h.line}`)])).toEqual([
      ['crash-never-moves-the-pointer', [`${page}:1`]],
    ]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------

// Each test below makes temporary git repositories and spawns git many times, so its time grows with machine load.
// Budget 15 s each, derived: about ten times the slowest idle measurement (1.5 s; developer machine, Apple M3 Pro, load
// about 5, one worker, slowest of 3 runs: 0.56 s, 0.55 s, 0.99 s, 0.78 s, 1.50 s, 0.84 s in file order; on the release
// job's runner each is under the 0.33 s its reporter prints), the headroom for loads of 20 to 80 on a shared machine.
// Never below vitest's 5 s test default.
describe('the command line on a repository: the merge base, --update, --changed, a shallow clone', () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });
  const git = (cwd: string, ...args: string[]): string =>
    execFileSync(
      'git',
      [
        '-c',
        'user.name=t',
        '-c',
        'user.email=t@example.com',
        '-c',
        'commit.gpgsign=false',
        ...args,
      ],
      { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );

  const SRC = [
    '# How it stays correct',
    '',
    '## How a widget stays correct',
    '',
    '<a id="widget-keeps-values"></a>**A widget keeps its values.** The widget keeps every frobnicated value until the operator releases it by hand.',
    '',
    '<a id="gadget-answers"></a>**A gadget answers.** The gadget answers every query it is sent from the cache it holds.',
    '',
  ].join('\n');
  const GUIDE =
    '## How it stays correct\n\n[The widget keeps every frobnicated value](correctness.md#widget-keeps-values), in [the section](correctness.md#how-a-widget-stays-correct).\n';
  const COPY = 'The widget keeps every frobnicated value until the operator releases it by hand.';
  const OTHER = 'A widget keeps every frobnicated value for as long as the operator wants.';
  const NOTES = 'docs/notes.md';
  const gate: Gate = {
    signatures: [
      {
        claim: 'widget-keeps-values',
        patterns: [/keeps every frobnicated value/i],
        summary: '',
        lookAlike: '',
      },
    ],
    exclusions: ONLY_THE_SOURCE,
  };
  const rowFor = (sentence: string, file = NOTES): Row => ({
    file,
    claim: 'widget-keeps-values',
    sentence: ties.sha(sentence),
    starts: ties.starts(sentence),
  });
  const baselineText = (rows: Row[]): string => `${JSON.stringify({ untied: rows }, null, 2)}\n`;
  const write = (dir: string, files: Record<string, string>): void => {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), text);
    }
  };
  const commit = (dir: string, files: Record<string, string>): void => {
    write(dir, files);
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'change');
  };

  /**
   * A repository whose origin/main holds a correctness.md, a guide tying it, a page with one untied copy and, unless
   * `atBase` says otherwise, a baseline excusing that copy; checked out on a branch of its own. It carries the script,
   * so the command line can be run in it as it is.
   */
  const repository = (atBase: string | null = baselineText([rowFor(COPY)])): string => {
    const dir = mkdtempSync(join(tmpdir(), 'summary-ties-'));
    dirs.push(dir);
    git(dir, 'init', '-q', '-b', 'main');
    write(dir, { [SOURCE]: SRC, 'docs/guide/widgets.md': GUIDE, [NOTES]: `${COPY}\n` });
    if (atBase !== null) write(dir, { [ties.BASELINE]: atBase });
    for (const script of ['scripts/summary-ties.cjs', 'bench/lib/remove-all.cjs']) {
      mkdirSync(dirname(join(dir, script)), { recursive: true });
      copyFileSync(join(ROOT, script), join(dir, script));
    }
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'base');
    git(dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    git(dir, 'checkout', '-q', '-b', 'feature');
    return dir;
  };
  const cli = (dir: string, ...argv: string[]): { code: number; out: string; err: string } => {
    const out: string[] = [];
    const err: string[] = [];
    const code = ties.main(argv, {
      root: dir,
      gate,
      io: { log: (l) => out.push(l), error: (l) => err.push(l) },
    });
    return { code, out: out.join('\n'), err: err.join('\n') };
  };
  const rowsIn = (dir: string): Row[] =>
    (JSON.parse(readFileSync(join(dir, ties.BASELINE), 'utf8')) as { untied: Row[] }).untied;

  it('passes a branch that changes nothing, and one that ties a copy and drops its row', () => {
    const dir = repository();
    expect(cli(dir)).toEqual({
      code: 0,
      out: 'every restatement found ties the claim it restates',
      err: '',
    });
    commit(dir, {
      [NOTES]: `${COPY} [Why](guide/correctness.md#widget-keeps-values).\n`,
      [ties.BASELINE]: baselineText([]),
    });
    expect(cli(dir).code).toBe(0);
  }, 15_000);

  it('refuses a row the baseline at the merge base does not have: the baseline only shrinks', () => {
    const dir = repository();
    commit(dir, {
      'docs/more.md': `${OTHER}\n`,
      [ties.BASELINE]: baselineText([rowFor(COPY), rowFor(OTHER, 'docs/more.md')]),
    });
    const growth = ties.check(dir, gate).problems.filter((p) => p.rule === 'R6');
    expect(growth.map((p) => p.message)).toEqual([
      expect.stringContaining('is not in the baseline at the merge base'),
    ]);
    const { code, err } = cli(dir);
    expect(code).toBe(1);
    expect(err).toContain('docs/more.md, widget-keeps-values');
  }, 15_000);

  it('--update drops a row that excuses nothing, never adds one, and exits 1 while the gate still fails', () => {
    const tied = repository();
    commit(tied, { [NOTES]: `${COPY} [Why](guide/correctness.md#widget-keeps-values).\n` });
    expect(cli(tied).err).toContain('excuses nothing');
    const updated = cli(tied, '--update');
    expect(updated.code).toBe(0);
    expect(updated.out).toContain('dropped: docs/notes.md, widget-keeps-values');
    expect(updated.out).toContain('1 rows dropped, 0 kept');
    expect(rowsIn(tied)).toEqual([]);

    const untied = repository();
    commit(untied, { 'docs/more.md': `${OTHER}\n` });
    const still = cli(untied, '--update');
    expect(still.code).toBe(1);
    expect(still.err).toContain('the gate still fails');
    expect(rowsIn(untied)).toEqual([rowFor(COPY)]);
  }, 15_000);

  it('--changed reads against the merge base, not the tip of origin/main', () => {
    const dir = repository();
    git(dir, 'checkout', '-q', 'main');
    commit(dir, { [SOURCE]: SRC.replace('from the cache it holds', 'from its own cache') });
    git(dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    git(dir, 'checkout', '-q', 'feature');
    commit(dir, { [SOURCE]: SRC.replace('releases it by hand', 'lets it go by hand') });
    const { code, out } = cli(dir, '--changed');
    expect(code).toBe(0);
    expect(out).toContain('## widget-keeps-values');
    expect(out).not.toContain('## gadget-answers');
    expect(out).toContain('tied by docs/guide/widgets.md:3');
    expect(out).toContain(`- ${NOTES}:1  ${COPY}`);
    expect(cli(dir, '--changed', '--against', 'main').out).toContain('## widget-keeps-values');
    expect(cli(dir, '--changed', '--against')).toEqual({
      code: 2,
      out: '',
      err: expect.stringContaining('--against needs the ref'),
    });
  }, 15_000);

  it('a merge base with no baseline compares nothing and says so; one it cannot read fails the gate', () => {
    const adding = repository(null);
    commit(adding, { [ties.BASELINE]: baselineText([rowFor(COPY)]) });
    const result = ties.check(adding, gate);
    expect(result.problems).toEqual([]);
    expect(result.notes).toEqual([expect.stringContaining('no rows to compare')]);
    expect(cli(adding).out).toContain('note: the merge base');

    const garbled = repository('not json\n');
    commit(garbled, { [ties.BASELINE]: baselineText([rowFor(COPY)]) });
    expect(() => ties.check(garbled, gate)).toThrow(/is not JSON/);
    expect(cli(garbled).code).toBe(2);

    const listless = repository('{ "rows": [] }\n');
    commit(listless, { [ties.BASELINE]: baselineText([rowFor(COPY)]) });
    expect(() => ties.check(listless, gate)).toThrow(/holds no "untied" list/);

    expect(() => ties.baselineAt(adding, '0'.repeat(40))).toThrow(/cannot read the tree/);
  }, 15_000);

  it('a shallow clone, or no origin/main, fails with the command that fetches the history, in one line', () => {
    const dir = repository();
    const shallow = mkdtempSync(join(tmpdir(), 'summary-ties-shallow-'));
    dirs.push(shallow);
    const clone = join(shallow, 'c');
    git(shallow, 'clone', '-q', '--depth', '1', '--branch', 'main', pathToFileURL(dir).href, clone);
    expect(() => ties.check(clone, gate)).toThrow(/a shallow checkout: fetch the history/);
    const { code, err } = cli(clone);
    expect(code).toBe(2);
    expect(err).toMatch(/^summary-ties: a shallow checkout: fetch the history/);
    let spawned: { status: number; stderr: string };
    try {
      execFileSync(process.execPath, [join(clone, 'scripts/summary-ties.cjs')], {
        cwd: clone,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      spawned = { status: 0, stderr: '' };
    } catch (e) {
      spawned = e as { status: number; stderr: string };
    }
    expect(spawned.status).toBe(2);
    expect(spawned.stderr.trim().split('\n')).toEqual([
      expect.stringMatching(/^summary-ties: a shallow checkout: fetch the history/),
    ]);
    git(dir, 'update-ref', '-d', 'refs/remotes/origin/main');
    expect(() => ties.check(dir, gate)).toThrow(/no origin\/main to compare with/);
  }, 15_000);
});
