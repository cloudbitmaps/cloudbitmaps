import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  cellOfPass,
  completePass,
  copyOf,
  verdict as gate,
  withRounds,
  type File,
  type Pass,
  type Round,
} from '../helpers/bitmap-api-pass';

/**
 * The generated "against native" table of the public bitmap class: what it renders to for a record, what a page may
 * hold (the record's figures, commit, Node version and machine, the words "close to native" only for a group stop rule
 * 2 allows, every method above 10 times native named, the cold rows read like the others), each of those fired at a
 * planted record or page, and the committed pages and record held to all of it, with the committed-record checks
 * themselves fired at lying records so they cannot pass vacuously. Nothing here times anything.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const require_ = createRequire(join(ROOT, 'bench', 'sizing.cjs'));

const table = require_('./lib/bitmap-api-table.cjs') as {
  START: string;
  END: string;
  NOT_MEASURED: string;
  render: (file: File, decisions?: Decisions) => string;
  regionText: (doc: string, text: string) => string;
  withRegion: (doc: string, text: string, file: File, decisions?: Decisions) => string;
  problemsOf: (doc: string, text: string, file: File, decisions?: Decisions) => string[];
  readDecisions: (root: string) => Decisions;
  decisionProblems: (decisions: unknown) => string[];
  phraseProblems: (doc: string, text: string) => string[];
};
type Decisions = { date: string | null; words: string; accepted: string[] };
const count = require_('./lib/bitmap-api-count.cjs') as { readResult: (root: string) => string };
const pages = require_('./lib/bitmap-api-pages.cjs') as {
  REGION_PAGES: string[];
  otherPages: (root: string) => string[];
};

const PAGES = pages.REGION_PAGES;
const DATASETS = ['dense', 'sparse', 'runs', 'mixed', 'spread8k'];

/** A record whose `has` cells are within 3 times native, `or returning` is 5 times on `runs`, `toArray` 13 on `dense`. */
const good = (): Pass =>
  completePass({
    'runs or returning': { native: 10, ours: 50 },
    'dense toArray': { native: 10, ours: 130 },
  });
const fileOf = (...passes: Pass[]): File => ({ passes });
const GOOD: File = fileOf(good());

const page = (body = ''): string =>
  `# Page\n\nIntro.\n\n${table.START}\n\n${body}\n\n${table.END}\n\nOutro.\n`;
const rendered = (file: File = GOOD) => page(table.render(file));

describe('the region of a record that holds no complete pass', () => {
  it('says it is not measured, and nothing else is accepted', () => {
    const empty = fileOf();
    expect(table.render(empty)).toBe(table.NOT_MEASURED);
    expect(table.problemsOf('p.md', page(table.NOT_MEASURED), empty)).toEqual([]);
    expect(
      table.problemsOf('p.md', page('| `has` | x | 1.00 | 1 | 1 | 1 | 1 |'), empty).join('\n'),
    ).toContain('must say it is not measured');
  });

  it('is not accepted once the record holds a complete pass', () => {
    expect(table.problemsOf('p.md', page(table.NOT_MEASURED), GOOD).join('\n')).toContain(
      'says it is not measured',
    );
  });

  it('is the state of a record whose passes are a smoke pass, a partial pass or an incomplete one', () => {
    const smoke = good();
    smoke.environment.smoke = true;
    const partial = good();
    partial.partial = '--only=has';
    const lacking = good();
    lacking.cells = lacking.cells.slice(1);
    for (const file of [fileOf(smoke), fileOf(partial), fileOf(lacking), fileOf(smoke, partial)]) {
      expect(table.render(file)).toBe(table.NOT_MEASURED);
    }
  });

  it('judges the last complete pass: a later partial pass changes nothing on the page', () => {
    const later = good();
    later.pass = 2;
    later.partial = '--only=has';
    later.cells = later.cells.filter((c) => c.op === 'has');
    expect(table.render(fileOf(good(), later))).toBe(table.render(GOOD));
  });
});

describe('the table of a record', () => {
  const text = rendered();

  it('is accepted as rendered', () => {
    expect(table.problemsOf('p.md', text, GOOD)).toEqual([]);
  });

  it('says how many fresh processes each first-call figure took: one for a pass that does not record it, the median of five otherwise', () => {
    expect(table.regionText('p.md', text)).toContain(
      'each first-call figure is one call in one fresh process;',
    );
    const five = good();
    five.environment.coldProcesses = 5;
    const region = table.render(fileOf(five));
    expect(region).toContain(
      'each first-call figure is the median of 5 fresh processes, one call in each;',
    );
    expect(region).not.toContain('one call in one fresh process');
    expect(table.problemsOf('p.md', page(region), fileOf(five))).toEqual([]);
    // A page that says one while the record says five is refused.
    expect(table.problemsOf('p.md', page(table.render(GOOD)), fileOf(five)).join('\n')).toContain(
      'not what',
    );
  });

  it('prints each ratio from the rounds, the commit, Node, the machine, the load, the round count and every cell', () => {
    const region = table.regionText('p.md', text);
    expect(region).toContain('commit `abcdef01`');
    expect(region).toContain('Node v24.99.0');
    expect(region).toContain('Test CPU (8 cores)');
    expect(region).toContain('31 rounds a figure');
    expect(region).toContain('at most 1.00 and no round was set aside at 6 or more');
    expect(region).toMatch(/\| `has` \| has \| 1\.50 \| 1\.50 \| 1\.50 \| 1\.50 \| 1\.50 \|/);
    expect(region).toMatch(
      /\| `or returning` \| combine returning \| 1\.50 \| 1\.50 \| 5\.00 \| 1\.50 \| 1\.50 \|/,
    );
    expect(region).toMatch(/\| `has` \| has \| 1\.25 \|/);
    expect(region).toMatch(/\| `first build` \| 1\.50 \| 1\.25 \|/);
    expect(region).toMatch(/\| dense \| 10\.0 \| 2\.00 \| 3\.00 \| 50\.0% \|/);
  });

  it('calls a group close only when stop rule 2 allows it, and names what it does not', () => {
    const region = table.regionText('p.md', text);
    const said =
      /Close to native \(within 3 times native on every cell of the group, every control in band\): ([^.]*)\./.exec(
        region,
      );
    expect(said).not.toBeNull();
    expect(said![1]!.split(', ')).toContain('has');
    expect(said![1]!.split(', ')).toContain('cold');
    expect(said![1]!.split(', ')).not.toContain('export');
    expect(region).toContain(
      'Not called close to native: combine returning (worst 5.00 times, runs or returning)',
    );
    expect(region).toContain('export (worst 13.00 times, dense toArray)');
  });

  it('names a method above 10 times native', () => {
    expect(table.regionText('p.md', text)).toContain('`toArray` (13.00 times, dense toArray)');
  });

  it('says there is none when no method is above 10 on any row', () => {
    const calm = fileOf(completePass());
    expect(table.regionText('p.md', rendered(calm))).toContain(
      'No method is more than 10 times native on any data set.',
    );
  });

  it('stars a figure whose control was out of band, and never calls its group close', () => {
    const noisy = completePass({ 'sparse has': { native: 10, ours: 15, control: 17 } });
    const file = fileOf(noisy);
    const region = table.regionText('p.md', rendered(file));
    expect(region).toContain('1.50 * |');
    expect(region).toContain('not resolved');
    expect(region).toContain(
      'has (worst 1.50 times, dense has; 1 cell(s) with a control out of band)',
    );
    expect(table.problemsOf('p.md', rendered(file), file)).toEqual([]);
  });

  it('labels the rows that are not a like-for-like call', () => {
    const region = table.regionText('p.md', text);
    expect(region).toContain('compare the class with its check against native without one');
    expect(region).toContain('that policy difference');
    expect(region).toContain('only the first operand');
    expect(region).toContain(
      '`intersects overlapping` answers `true` at the first id the two bitmaps share',
    );
    expect(region).toContain('`intersects disjoint` answers `false` after walking every key');
    expect(region).toContain('held to identical bytes');
  });
});

describe('the cold rows are read by the stop rules like every other row', () => {
  it('names a method with a cold row above 10 times native, and prints no "No method" sentence', () => {
    const file = fileOf(completePass({ 'cold first deserialize': { native: 10, ours: 200 } }));
    const region = table.regionText('p.md', rendered(file));
    expect(region).toContain('`RoaringBitmap.deserialize` (20.00 times, cold first deserialize)');
    expect(region).not.toContain('No method is more than');
    expect(table.problemsOf('p.md', rendered(file), file)).toEqual([]);
  });

  it('keeps the cold group from "close to native" beyond 3 times, and says why', () => {
    const file = fileOf(completePass({ 'cold first and': { native: 10, ours: 35 } }));
    const region = table.regionText('p.md', rendered(file));
    expect(region).toContain('cold (worst 3.50 times, cold first and)');
    const closeLine = /Close to native \([^)]*\): ([^.]*)\./.exec(region);
    expect(closeLine![1]!.split(', ')).not.toContain('cold');
  });

  it('refuses a page that says there is no method above 10 times beside a cold row above 10', () => {
    const file = fileOf(completePass({ 'cold first deserialize': { native: 10, ours: 200 } }));
    const lying = rendered(file).replace(
      /More than 10 times native[^\n]*\n/,
      'No method is more than 10 times native on any data set.\n',
    );
    expect(table.problemsOf('p.md', lying, file).length).toBeGreaterThan(0);
  });
});

describe('the count cells of a record', () => {
  const countPass = (route: string, result: string) =>
    fileOf(completePass({}, { countRoute: route, countResult: result }));

  it("names the route the class ran and the decision of the count kernels' own bench, kept", () => {
    const region = table.regionText('p.md', rendered(countPass('kernels', 'kept')));
    expect(region).toContain('by the count kernels in this pass');
    expect(region).toContain('bench/count-kernels.cjs`) kept them');
  });

  it('says what the decision reads: andCardinality against building and counting, not every method or group', () => {
    const region = table.regionText('p.md', rendered(countPass('kernels', 'kept')));
    expect(region).toContain(
      '`andCardinality` took less time than building and counting on every operand-pair group it judges',
    );
    expect(region).not.toContain('every group it measures');
    expect(region).not.toContain('they took less time');
  });

  it('says intersects and isSubset answer without counting, and no count answers intersects', () => {
    const region = table.regionText('p.md', rendered(countPass('kernels', 'kept')));
    expect(region).toContain(
      '`andCardinality`, `orCardinality`, `xorCardinality` and `andNotCardinality` by the count kernels in this pass, and `intersects` and `isSubset` without counting',
    );
    expect(region).not.toContain('`andNotCardinality` and `intersects` by');
  });

  it("states the codec column's range for the two timed counts only when every figure is below 1.00", () => {
    const winners = completePass(
      Object.fromEntries(
        DATASETS.flatMap((d) => [
          [`${d} andCardinality`, { ours: 5, internal: 10 }],
          [`${d} orCardinality`, { ours: 2, internal: 10 }],
        ]),
      ),
    );
    const won = table.regionText('p.md', rendered(fileOf(winners)));
    expect(won).toContain('figure of the codec column is below 1.00 (0.20 to 0.50)');
    const losing = completePass(
      Object.fromEntries(DATASETS.map((d) => [`${d} andCardinality`, { ours: 30, internal: 10 }])),
    );
    const lost = table.regionText('p.md', rendered(fileOf(losing)));
    expect(lost).not.toContain('figure of the codec column is below 1.00');
    const derived = table.regionText('p.md', rendered(countPass('build-then-count', 'derived')));
    expect(derived).not.toContain('figure of the codec column is below 1.00');
  });

  it('names the other route under the other decision', () => {
    const region = table.regionText('p.md', rendered(countPass('build-then-count', 'derived')));
    expect(region).toContain('by building the combination and counting it in this pass');
    expect(region).toContain('did not keep them');
  });

  it("does not recompute the decision from the class's own count cells", () => {
    const losing = completePass(
      Object.fromEntries(DATASETS.map((d) => [`${d} andCardinality`, { ours: 30, internal: 10 }])),
    );
    const region = table.regionText('p.md', rendered(fileOf(losing)));
    expect(region).toContain('kept them');
    expect(region).not.toContain('did not take less time');
  });

  it('is refused when a page names the other route than the record', () => {
    const file = countPass('kernels', 'kept');
    const wrong = rendered(file).replace(
      'by the count kernels in this pass',
      'by building the combination and counting it in this pass',
    );
    expect(table.problemsOf('p.md', wrong, file).join('\n')).toContain('not what');
    expect(table.problemsOf('p.md', rendered(file), file)).toEqual([]);
  });
});

describe('a page that disagrees with the record', () => {
  const text = rendered();
  const edit = (from: string | RegExp, to: string) => {
    const out = text.replace(from, to);
    expect(out).not.toBe(text);
    return out;
  };

  it('is refused for a changed figure, in a cell, a cold row or a load row', () => {
    expect(
      table
        .problemsOf('p.md', edit('| `has` | has | 1.50 |', '| `has` | has | 1.40 |'), GOOD)
        .join('\n'),
    ).toContain('dense has prints 1.40, the rounds say 1.50');
    expect(
      table
        .problemsOf('p.md', edit('| `first build` | 1.50 |', '| `first build` | 1.10 |'), GOOD)
        .join('\n'),
    ).toContain('cold first build prints 1.10, the rounds say 1.50');
    expect(
      table
        .problemsOf(
          'p.md',
          edit('| dense | 10.0 | 2.00 | 3.00 | 50.0% |', '| dense | 10.0 | 2.00 | 3.00 | 5.0% |'),
          GOOD,
        )
        .join('\n'),
    ).toContain('load dense prints 5.0%, the rounds say 50.0%');
  });

  it('is refused for another commit, another Node version, another machine', () => {
    expect(
      table.problemsOf('p.md', edit('commit `abcdef01`', 'commit `12345678`'), GOOD).join('\n'),
    ).toContain('the commit is not the record');
    expect(
      table.problemsOf('p.md', edit('Node v24.99.0', 'Node v22.1.0'), GOOD).join('\n'),
    ).toContain('the Node version is not the record');
    expect(table.problemsOf('p.md', edit('Test CPU', 'Other CPU'), GOOD).join('\n')).toContain(
      'not what',
    );
  });

  it('is refused for another round count or load line', () => {
    expect(
      table.problemsOf('p.md', edit('31 rounds a figure', '99 rounds a figure'), GOOD).join('\n'),
    ).toContain('the round count is not the rounds');
    expect(
      table
        .problemsOf('p.md', edit('at most 1.00 and no round', 'at most 0.50 and no round'), GOOD)
        .join('\n'),
    ).toContain('the load line is not the rounds');
  });

  describe('the rounds set aside at a load of 6 or more', () => {
    const planted = (): Pass => {
      const pass = good();
      for (const name of ['dense has', 'sparse has']) {
        const cell = cellOfPass(pass, name);
        cell.discarded = Array.from({ length: 4 }, () => [...cell.rounds[0]!] as Round);
      }
      pass.load = gate.loadFiguresOf(pass);
      return pass;
    };

    it('prints the total, and scopes the most of any one figure', () => {
      const file = fileOf(planted());
      expect(planted().load.discardedRounds).toBe(4);
      expect(gate.discardedOf(planted())).toEqual({ total: 8, figures: 2, most: 4 });
      const region = table.regionText('p.md', rendered(file));
      expect(region).toContain(
        '8 rounds were set aside at 6 or more and taken again (at most 4 of any one figure, on 2 figures)',
      );
      expect(region).not.toContain('4 round(s)');
      expect(table.problemsOf('p.md', rendered(file), file)).toEqual([]);
    });

    it('is refused when the page gives the most of one figure as the total', () => {
      const file = fileOf(planted());
      const wrong = rendered(file).replace('8 rounds were set aside', '4 rounds were set aside');
      expect(table.problemsOf('p.md', wrong, file).join('\n')).toContain(
        'the load line is not the rounds',
      );
    });

    it('counts a figure of a load row and says "no round" when none was set aside', () => {
      const pass = good();
      expect(gate.discardedOf(pass)).toEqual({ total: 0, figures: 0, most: 0 });
      pass.loadRoundTrip[0]!.discarded = [[10, 2, 3, 1, 7]] as unknown as Round[];
      expect(gate.discardedOf(pass)).toEqual({ total: 1, figures: 1, most: 1 });
      expect(table.regionText('p.md', rendered(fileOf(pass)))).toContain(
        '1 round was set aside at 6 or more and taken again (at most 1 of any one figure, on 1 figure)',
      );
    });
  });

  it('reads a load row back as the page prints it: the share rounded to four places first', () => {
    const edge = good();
    const row = edge.loadRoundTrip[0]!;
    row.rounds = Array.from({ length: 31 }, () => [1000, 1, 0.549999, 1, 1]);
    Object.assign(row, gate.loadRowOf(row.rounds));
    const text = rendered(fileOf(edge));
    expect(table.regionText('p.md', text)).toContain(`| ${row.dataset} | `);
    expect(table.regionText('p.md', text)).toMatch(/ \| 0\.1% \|/);
    expect(table.problemsOf('p.md', text, fileOf(edge))).toEqual([]);
  });

  it('is refused for "close to native" said of a group that is not', () => {
    const said = edit(/(Close to native \([^)]*\): [^.]*)\./, '$1, export.');
    expect(table.problemsOf('p.md', said, GOOD).join('\n')).toContain('said of export');
  });

  it('is refused when the sentence about a method above 10 times native is removed', () => {
    const quiet = edit(/More than 10 times native[^\n]*\n/, '');
    expect(table.problemsOf('p.md', quiet, GOOD).length).toBeGreaterThan(0);
  });

  it('is refused for a missing or doubled region', () => {
    expect(table.problemsOf('p.md', 'no markers', GOOD).join('\n')).toContain(
      'exactly one BITMAP_API:TABLE region',
    );
    expect(table.problemsOf('p.md', text + text, GOOD).join('\n')).toContain(
      'exactly one BITMAP_API:TABLE region',
    );
  });

  it('is rewritten to what the record renders to, and rewriting changes nothing twice', () => {
    const stale = page('stale');
    const fixed = table.withRegion('p.md', stale, GOOD);
    expect(table.problemsOf('p.md', fixed, GOOD)).toEqual([]);
    expect(table.withRegion('p.md', fixed, GOOD)).toBe(fixed);
  });

  it('accepts a figure whose median sits just below a rounding edge: the page rounds the stored four places, the check does the same', () => {
    const edge = good();
    const cell = cellOfPass(edge, 'dense has');
    withRounds(
      cell,
      (cell.rounds as number[][]).map((r) => [r[0]!, r[1]!, r[1]! * 1.164999, ...r.slice(3)]),
    );
    expect(cell.vsNative).toBe(1.165);
    const text = rendered(fileOf(edge));
    expect(table.regionText('p.md', text)).toMatch(/\| `has` \| has \| 1\.17 /);
    expect(table.problemsOf('p.md', text, fileOf(edge))).toEqual([]);
  });

  it('prints from the rounds, never from a stored field: a lying stored figure does not reach the page', () => {
    const lying = good();
    cellOfPass(lying, 'dense has').vsNative = 1.1;
    lying.loadRoundTrip[0]!.roundTripShare = 0.02;
    lying.load = { maxLoadAtEnd: 0.5, discardedRounds: 0, sleptRounds: 0 };
    lying.environment.rounds = 99;
    const region = table.regionText('p.md', rendered(fileOf(lying)));
    expect(region).toContain('| `has` | has | 1.50 |');
    expect(region).toContain('50.0% |');
    expect(region).toContain('at most 1.00');
    expect(region).toContain('31 rounds a figure');
    expect(region).not.toContain('99 rounds');
  });
});

describe('the words "close to native"', () => {
  const FORMS = [
    'the class is close to native',
    'the class is Close To Native',
    'the class is close to\nnative',
    'the class is close  to native',
    'the class is close\u00a0to native',
    'the class is close to\u00a0\nnative',
    'the class is close-to-native',
    'the class is close\tto native',
    'the class is **close** to *native*',
    'the class is close\u200b to native',
    'the class is close to\n> native',
    '> the class is close to\n> native',
    '>> close to\n>> native',
    '- close to\n- native',
    '1. close to\n2. native',
    'the class is close&nbsp;to native',
  ];

  for (const [name, file] of [
    ['an empty record', fileOf()],
    ['a record with a complete pass', GOOD],
  ] as const) {
    it(`are refused outside the region, in every spelling, with ${name}`, () => {
      const body = file === GOOD ? table.render(GOOD) : table.NOT_MEASURED;
      for (const form of FORMS) {
        const text = `# Page\n\n${form}.\n\n${table.START}\n\n${body}\n\n${table.END}\n`;
        expect(table.problemsOf('p.md', text, file).join('\n'), JSON.stringify(form)).toContain(
          'stands outside the generated region',
        );
      }
    });
  }

  it('are refused on every other page, in every spelling', () => {
    for (const form of FORMS) {
      expect(table.phraseProblems('README.md', `Intro\n\n${form}.\n`).join('\n')).toContain(
        'stands on a page',
      );
    }
  });

  it('stay quiet on look-alikes, on every page and beside a region', () => {
    for (const quiet of [
      'native is CRoaring',
      'close to the native codec',
      'the native codec, close by',
      'closer to native speed than before',
      'unclose to nativeness',
      'enclose to natives',
      '> the codec is close\n> to the native one',
      '> a quoted line\n> about native',
      '1. close to\n2. the native codec',
    ]) {
      expect(table.phraseProblems('README.md', quiet), quiet).toEqual([]);
      expect(table.problemsOf('p.md', rendered().replace('Intro.', quiet), GOOD), quiet).toEqual(
        [],
      );
    }
    const plain = rendered().replace('Intro.', 'Intro <!-- BITMAP_API:OTHER -->');
    expect(table.problemsOf('p.md', plain, GOOD)).toEqual([]);
  });

  it('are said in the region only as many times as the generated sentences say them', () => {
    const extra = rendered().replace(
      'Not called close to native',
      'Not called close to native, close to\nnative',
    );
    expect(table.problemsOf('p.md', extra, GOOD).join('\n')).toContain('more often than');
  });

  it('are searched for on every public page of this repository', () => {
    const others = pages.otherPages(ROOT);
    expect(others).toContain('README.md');
    expect(others).toContain('docs/README.md');
    expect(others).toContain('docs/benchmarks.md');
    expect(others).toContain('packages/roaring/README.md');
    expect(others.every((p) => !PAGES.includes(p))).toBe(true);
    for (const p of others) {
      expect(table.phraseProblems(p, readFileSync(join(ROOT, p), 'utf8')), p).toEqual([]);
    }
  });
});

/** What the committed-record checks run: the gate with the count kernels' decision read live, as the script does. */
const recordProblems = (file: File, countResult?: string) =>
  gate.gateProblems(file.passes, { countResult });

describe('the checks that hold the committed record, fired at lying records', () => {
  const lie = (mutate: (pass: Pass) => void): string => {
    const pass = good();
    mutate(pass);
    return recordProblems(fileOf(pass), 'kept').join('\n');
  };

  it('accept a record that tells the truth', () => {
    expect(recordProblems(GOOD, 'kept')).toEqual([]);
  });

  it('refuse a hand-typed figure', () => {
    expect(lie((p) => (cellOfPass(p, 'dense has').vsNative = 1.1))).toContain('stored vsNative');
    expect(lie((p) => (p.loadRoundTrip[0]!.roundTripShare = 0.02))).toContain(
      'stored roundTripShare',
    );
    expect(
      lie((p) => (p.load = { maxLoadAtEnd: 0, discardedRounds: 0, sleptRounds: 0 })),
    ).toContain('stored load summary');
  });

  it('refuse a wrong route, an unknown route and a count decision the record does not give', () => {
    expect(lie((p) => (p.environment.countRoute = 'build-then-count'))).toContain(
      'the class ran build-then-count',
    );
    expect(lie((p) => (p.environment.countRoute = 'other'))).toContain('unknown');
    expect(recordProblems(GOOD, 'derived').join('\n')).toContain('now says derived');
  });

  it('refuse a pass with a cell missing, and a pass of a smoke run', () => {
    expect(lie((p) => (p.cells = p.cells.slice(1)))).toContain('missing');
    expect(lie((p) => (p.environment.smoke = true))).toContain('smoke pass');
  });

  it('refuse a pass whose kept rounds are fewer than the floor or ended at a load of 6', () => {
    expect(
      lie((p) =>
        withRounds(
          cellOfPass(p, 'dense has'),
          cellOfPass(p, 'dense has').rounds.slice(0, 10) as Round[],
        ),
      ),
    ).toContain('fewer than 31');
    expect(lie((p) => (cellOfPass(p, 'dense has').rounds[2]![6] = 6))).toContain('ended at load 6');
  });

  it('refuse a page that says "close to native" of a group the rules do not allow', () => {
    const said = rendered().replace(/(Close to native \([^)]*\): [^.]*)\./, '$1, export.');
    expect(table.problemsOf('p.md', said, GOOD).join('\n')).toContain('said of export');
  });
});

describe("the maintainer's decision the table reads", () => {
  const decided = (...accepted: string[]): Decisions => ({
    date: '2026-10-26',
    words: 'yes to your recommendations',
    accepted,
  });
  const over = /More than 10 times native[^\n]*/;

  it('changes nothing in the region while the list is empty', () => {
    expect(table.render(GOOD, decided())).toBe(table.render(GOOD));
    expect(table.render(GOOD)).toMatch(over);
    expect(table.render(GOOD)).toContain('not shipped unless the maintainer decides otherwise');
  });

  it('says a listed method above the bar ships by the decision of that date, its figure disclosed', () => {
    const region = table.render(GOOD, decided('toArray'));
    expect(region).toContain(
      "Shipping by the maintainer's decision of 2026-10-26 (yes to your recommendations), more than 10 times native on some data set and its figure disclosed: `toArray` (13.00 times, dense toArray).",
    );
    expect(region).not.toMatch(over);
    expect(table.problemsOf('p.md', page(region), GOOD, decided('toArray'))).toEqual([]);
  });

  it('keeps the present sentence for a method above the bar that is not listed', () => {
    const slow = completePass({
      'runs or returning': { native: 10, ours: 50 },
      'dense toArray': { native: 10, ours: 130 },
      'dense has': { native: 10, ours: 150 },
    });
    const file = fileOf(slow);
    const text = page(table.render(file, decided('toArray')));
    const region = table.regionText('p.md', text);
    expect(region).toContain("Shipping by the maintainer's decision of 2026-10-26");
    expect(region).toMatch(/More than 10 times native[^\n]*\(15\.00 times, dense has\)/);
    expect(region).not.toMatch(/More than 10 times native[^\n]*`toArray`/);
    expect(table.problemsOf('p.md', text, file, decided('toArray'))).toEqual([]);
  });

  it('refuses a page that gives a listed method the old sentence, and one that gives an unlisted method the decision', () => {
    const old = page(table.render(GOOD));
    expect(table.problemsOf('p.md', old, GOOD, decided('toArray')).join('\n')).toContain(
      'not what bench/bitmap-api-results.json renders to',
    );
    const said = page(table.render(GOOD, decided('toArray')));
    expect(table.problemsOf('p.md', said, GOOD).join('\n')).toContain('not what');
  });

  it('refuses an accepted method that is not above the bar on the last complete pass', () => {
    const stale = decided('has');
    const problems = table.problemsOf('p.md', page(table.render(GOOD, stale)), GOOD, stale);
    expect(problems.join('\n')).toContain("has is accepted by the maintainer's decision");
    expect(problems.join('\n')).toContain('not above 10 times native');
  });

  it('refuses an accepted method when the record holds no complete pass', () => {
    const none = decided('toArray');
    expect(table.problemsOf('p.md', page(table.NOT_MEASURED), fileOf(), none).join('\n')).toContain(
      'toArray is accepted',
    );
    expect(table.problemsOf('p.md', page(table.NOT_MEASURED), fileOf(), decided())).toEqual([]);
  });

  it('refuses a decision file that is malformed', () => {
    expect(table.decisionProblems(decided())).toEqual([]);
    expect(table.decisionProblems(decided('toArray'))).toEqual([]);
    expect(
      table.decisionProblems({ date: '26/10/2026', words: 'x', accepted: ['a'] }).join(),
    ).toContain('date');
    expect(
      table.decisionProblems({ date: '2026-10-26', words: '', accepted: ['a'] }).join(),
    ).toContain('words');
    expect(
      table.decisionProblems({ date: '2026-10-26', words: 'x', accepted: 'a' }).join(),
    ).toContain('accepted');
    expect(
      table.decisionProblems({ date: '2026-10-26', words: 'x', accepted: ['a', 'a'] }).join(),
    ).toContain('twice');
    expect(table.decisionProblems(null).length).toBeGreaterThan(0);
  });

  it('is committed, well formed and read by the script', () => {
    const committed = table.readDecisions(ROOT);
    expect(table.decisionProblems(committed)).toEqual([]);
  });
});

describe('the committed pages and record', () => {
  const file = JSON.parse(
    readFileSync(join(ROOT, 'bench/bitmap-api-results.json'), 'utf8'),
  ) as File;

  it('keeps the record as the one compact line the bench writes, byte for byte', () => {
    const text = readFileSync(join(ROOT, 'bench/bitmap-api-results.json'), 'utf8');
    expect(text === `${JSON.stringify(JSON.parse(text))}\n`).toBe(true);
  });

  it("hold the record to its gate, with the count kernels' decision read from their own bench", () => {
    expect(file.passes.some((p) => p.environment?.smoke)).toBe(false);
    const live = file.passes.length > 0 ? count.readResult(ROOT) : undefined;
    expect(recordProblems(file, live)).toEqual([]);
  });

  for (const doc of PAGES) {
    it(`${doc} carries the table of the record, and the not-measured state only while it holds no complete pass`, () => {
      expect(
        table.problemsOf(
          doc,
          readFileSync(join(ROOT, doc), 'utf8'),
          file,
          table.readDecisions(ROOT),
        ),
      ).toEqual([]);
    });
  }
});

describe('the script', () => {
  const run = (root: string, ...args: string[]) =>
    spawnSync(process.execPath, [join(ROOT, 'bench/bitmap-api-table.cjs'), ...args], {
      env: { ...process.env, BITMAP_API_TABLE_ROOT: root },
      encoding: 'utf8',
    });

  /** A tree with the bench, the two region pages and a README, the record planted, the count bench saying `result`. */
  const tree = (file: File, result: string, readme = '# Readme\n') => {
    const copy = mkdtempSync(join(tmpdir(), 'bitmap-api-table-'));
    cpSync(join(ROOT, 'bench'), join(copy, 'bench'), { recursive: true });
    writeFileSync(join(copy, 'bench/bitmap-api-results.json'), JSON.stringify(file));
    // The planted record is not the committed one, so the committed decisions (which name methods of that record) do not apply to it.
    writeFileSync(
      join(copy, 'bench/bitmap-api-decisions.json'),
      `${JSON.stringify({ date: null, words: '', accepted: [] })}\n`,
    );
    writeFileSync(
      join(copy, 'bench/count-kernels.cjs'),
      `console.log('RESULT ${result}: planted');\nprocess.exitCode = 0;\n`,
    );
    for (const doc of PAGES) {
      mkdirSync(dirname(join(copy, doc)), { recursive: true });
      const text = readFileSync(join(ROOT, doc), 'utf8');
      writeFileSync(join(copy, doc), table.withRegion(doc, text, file));
    }
    writeFileSync(join(copy, 'README.md'), readme);
    return copy;
  };
  const using = (file: File, result: string, body: (copy: string) => void, readme?: string) => {
    const copy = tree(file, result, readme);
    try {
      body(copy);
    } finally {
      rmSync(copy, { recursive: true, force: true });
    }
  };

  it('passes the committed tree', () => {
    const out = spawnSync(process.execPath, [join(ROOT, 'bench/bitmap-api-table.cjs'), '--check'], {
      env: { ...process.env, BITMAP_API_TABLE_ROOT: ROOT },
      encoding: 'utf8',
    });
    expect(out.stderr).toBe('');
    expect(out.status).toBe(0);
    expect(out.stdout).toContain('ok');
  });

  it('passes a complete record whose pages were generated from it, and fails the moment a page goes stale', () => {
    using(GOOD, 'kept', (copy) => {
      const ok = run(copy, '--check');
      expect(ok.stderr).toBe('');
      expect(ok.status).toBe(0);
      const stale = join(copy, PAGES[0]!);
      writeFileSync(
        stale,
        readFileSync(stale, 'utf8').replace(table.END, `an unrecorded 1.00 figure\n${table.END}`),
      );
      expect(run(copy, '--check').status).toBe(1);
    });
  });

  it('reads the committed decisions of its own tree, so a listed method ships and a stale listing fails', () => {
    const decisions = (...accepted: string[]): Decisions => ({
      date: '2026-10-26',
      words: 'yes to your recommendations',
      accepted,
    });
    const plant = (copy: string, d: Decisions) => {
      writeFileSync(join(copy, 'bench/bitmap-api-decisions.json'), `${JSON.stringify(d)}\n`);
      for (const doc of PAGES) {
        const text = readFileSync(join(copy, doc), 'utf8');
        writeFileSync(join(copy, doc), table.withRegion(doc, text, GOOD, d));
      }
    };
    using(GOOD, 'kept', (copy) => {
      plant(copy, decisions('toArray'));
      const ok = run(copy, '--check');
      expect(ok.stderr).toBe('');
      expect(ok.status).toBe(0);
      expect(readFileSync(join(copy, PAGES[0]!), 'utf8')).toContain(
        "Shipping by the maintainer's decision of 2026-10-26",
      );
    });
    using(GOOD, 'kept', (copy) => {
      plant(copy, decisions('has'));
      const out = run(copy, '--check');
      expect(out.status).toBe(1);
      expect(out.stderr).toContain('has is accepted');
    });
    using(GOOD, 'kept', (copy) => {
      writeFileSync(join(copy, 'bench/bitmap-api-decisions.json'), '{"accepted": 3}\n');
      const out = run(copy, '--check');
      expect(out.status).toBe(1);
      expect(out.stderr).toContain('bitmap-api-decisions.json');
    });
  });

  it("fails when the count kernels' record gives another decision than the pass was taken under, and writes nothing", () => {
    using(GOOD, 'derived', (copy) => {
      const out = run(copy, '--check');
      expect(out.status).toBe(1);
      expect(out.stderr).toContain('now says derived');
      const doc = PAGES[0]!;
      const stale = table.withRegion(doc, readFileSync(join(copy, doc), 'utf8'), fileOf());
      writeFileSync(join(copy, doc), stale);
      const before = readFileSync(join(copy, doc), 'utf8');
      const written = run(copy);
      expect(written.status).toBe(1);
      expect(readFileSync(join(copy, doc), 'utf8')).toBe(before);
    });
  });

  it('refuses to publish from a record whose passes are all partial, with its own exit code', () => {
    const partial = good();
    partial.partial = '--only=has';
    partial.cells = partial.cells.filter((c) => c.op === 'has');
    using(fileOf(partial), 'kept', (copy) => {
      const out = run(copy);
      expect(out.status).toBe(5);
      expect(out.stderr).toContain('no complete pass');
    });
  });

  it('fails on a page that says "close to native" across a line break, and passes one that does not', () => {
    using(fileOf(), 'kept', (copy) => expect(run(copy, '--check').status).toBe(0));
    using(
      fileOf(),
      'kept',
      (copy) => {
        const out = run(copy, '--check');
        expect(out.status).toBe(1);
        expect(out.stderr).toContain('README.md');
      },
      '# Readme\n\nIt is close to\nnative.\n',
    );
  });
});

describe('a planted pass is not mutated by the helpers', () => {
  it('copies deeply', () => {
    const a = good();
    const b = copyOf(a);
    cellOfPass(b, 'dense has').vsNative = 9;
    expect(cellOfPass(a, 'dense has').vsNative).toBe(1.5);
  });
});
