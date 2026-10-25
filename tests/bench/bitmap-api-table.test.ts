import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The generated "against native" table of the public bitmap class: what it renders to for a record, what a page may
 * hold (the record's figures, commit, Node version and machine, the words "close to native" only for a group stop rule
 * 2 allows, every method above 10 times native named), each of those fired at a mutated copy, and the committed pages
 * and record held to all of it. Nothing here times anything.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const require_ = createRequire(join(ROOT, 'bench', 'sizing.cjs'));

type Round = Array<number | null>;
type Cell = Record<string, unknown> & { rounds: Round[]; dataset: string; op: string };
type Pass = {
  environment: Record<string, unknown>;
  cells?: Cell[];
  cold?: Cell[];
  [key: string]: unknown;
};
type File = { passes: Pass[] };
const table = require_('./lib/bitmap-api-table.cjs') as {
  START: string;
  END: string;
  NOT_MEASURED: string;
  render: (file: File) => string;
  regionText: (doc: string, text: string) => string;
  withRegion: (doc: string, text: string, file: File) => string;
  problemsOf: (doc: string, text: string, file: File) => string[];
};
const verdict = require_('./lib/bitmap-api-verdict.cjs') as {
  cellOf: (rounds: Round[], places?: number) => Record<string, unknown>;
  gateProblems: (passes: unknown[]) => string[];
};

const PAGES = ['docs/guide/api-reference.md', 'docs/guide/roaring-codec.md'];
const DATASETS = ['dense', 'sparse', 'runs', 'mixed', 'spread8k'];

const rounds = (
  native: number,
  ours: number,
  control = ours,
  internal: number | null = null,
): Round[] => Array.from({ length: 31 }, (_, i) => [i % 6, native, ours, control, internal, 1, 1]);

/** A pass with the given cells: `[dataset, op, group, method, native, ours, control, internal]`. */
function passOf(cells: Array<[string, string, string, string, number, number, number?, number?]>) {
  return {
    schema: 1,
    unit: 'ms',
    rule: 'bitmap-api-v1',
    pass: 1,
    environment: {
      node: 'v24.99.0',
      platform: 'darwin arm64',
      cpu: 'Test CPU',
      cores: 8,
      head: 'abcdef0123456789abcdef0123456789abcdef01',
      tree: 'clean',
      roaring: '2.7.0',
      anyLoad: false,
      smoke: false,
      rounds: 31,
      maxLoad: 6,
    },
    started: '2026-10-26T10:00:00.000Z',
    cells: cells.map(([dataset, op, group, method, native, ours, control, internal]) => ({
      dataset,
      op,
      group,
      method,
      answersAgree: true,
      ...verdict.cellOf(rounds(native, ours, control ?? ours, internal ?? null)),
    })) as unknown as Cell[],
    load: { maxLoadAtEnd: 4.5, discardedRounds: 2, sleptRounds: 0 },
  };
}

const GOOD: File = {
  passes: [
    passOf([
      ...DATASETS.map((d): [string, string, string, string, number, number, number, number] => [
        d,
        'has',
        'has',
        'has',
        10,
        15,
        15,
        12,
      ]),
      ...DATASETS.map((d): [string, string, string, string, number, number] => [
        d,
        'or returning',
        'combine returning',
        'RoaringBitmap.or',
        10,
        d === 'runs' ? 50 : 20,
      ]),
      ...DATASETS.map((d): [string, string, string, string, number, number] => [
        d,
        'toArray',
        'export',
        'toArray',
        10,
        d === 'dense' ? 130 : 12,
      ]),
    ]),
  ],
};

const page = (body = ''): string =>
  `# Page\n\nIntro.\n\n${table.START}\n\n${body}\n\n${table.END}\n\nOutro.\n`;
const rendered = (file: File = GOOD) => page(table.render(file));

describe('the region of a record that holds no pass', () => {
  it('says it is not measured, and nothing else is accepted', () => {
    const empty: File = { passes: [] };
    expect(table.render(empty)).toBe(table.NOT_MEASURED);
    expect(table.problemsOf('p.md', page(table.NOT_MEASURED), empty)).toEqual([]);
    expect(
      table.problemsOf('p.md', page('| `has` | x | 1.00 | 1 | 1 | 1 | 1 |'), empty).join('\n'),
    ).toContain('must say it is not measured');
  });

  it('is not accepted once the record holds a pass, and a smoke pass does not count as one', () => {
    expect(table.problemsOf('p.md', page(table.NOT_MEASURED), GOOD).join('\n')).toContain(
      'says it is not measured',
    );
    const smoke: File = {
      passes: [
        { ...GOOD.passes[0]!, environment: { ...GOOD.passes[0]!.environment, smoke: true } },
      ],
    };
    expect(table.render(smoke)).toBe(table.NOT_MEASURED);
  });
});

describe('the table of a record', () => {
  const text = rendered();

  it('is accepted as rendered', () => {
    expect(table.problemsOf('p.md', text, GOOD)).toEqual([]);
  });

  it('prints each ratio from the rounds, the commit, Node, the machine, the load and every cell', () => {
    const region = table.regionText('p.md', text);
    expect(region).toContain('commit `abcdef01`');
    expect(region).toContain('Node v24.99.0');
    expect(region).toContain('Test CPU (8 cores)');
    expect(region).toContain('at most 4.50 and 2 round(s)');
    expect(region).toMatch(/\| `has` \| has \| 1\.50 \| 1\.50 \| 1\.50 \| 1\.50 \| 1\.50 \|/);
    expect(region).toMatch(
      /\| `or returning` \| combine returning \| 2\.00 \| 2\.00 \| 5\.00 \| 2\.00 \| 2\.00 \|/,
    );
    // The codec's figure has its own table.
    expect(region).toMatch(/\| `has` \| has \| 1\.25 \|/);
  });

  it('calls a group close only when stop rule 2 allows it, and names what it does not', () => {
    const region = table.regionText('p.md', text);
    expect(region).toContain(
      'Close to native (within 3 times native on every cell of the group, every control in band): has.',
    );
    expect(region).toContain(
      'Not called close to native: combine returning (worst 5.00 times, runs or returning)',
    );
    expect(region).toContain('export (worst 13.00 times, dense toArray)');
  });

  it('names a method above 10 times native', () => {
    expect(table.regionText('p.md', text)).toContain('`toArray` (13.00 times, dense toArray)');
  });

  it('says there is none when no method is above 10', () => {
    const calm: File = {
      passes: [passOf(DATASETS.map((d) => [d, 'has', 'has', 'has', 10, 15, 15, 12] as never))],
    };
    expect(table.regionText('p.md', rendered(calm))).toContain(
      'No method is more than 10 times native on any data set.',
    );
  });

  it('stars a figure whose control was out of band, and never calls its group close', () => {
    const noisy: File = {
      passes: [
        passOf(
          DATASETS.map((d) => [d, 'has', 'has', 'has', 10, 15, d === 'sparse' ? 17 : 15] as never),
        ),
      ],
    };
    const region = table.regionText('p.md', rendered(noisy));
    expect(region).toContain('1.50 * |');
    expect(region).toContain('not resolved');
    expect(region).not.toContain('Close to native');
    expect(table.problemsOf('p.md', rendered(noisy), noisy)).toEqual([]);
  });
});

describe('a page that disagrees with the record', () => {
  const text = rendered();
  const edit = (from: string | RegExp, to: string) => {
    const out = text.replace(from, to);
    expect(out).not.toBe(text);
    return out;
  };

  it('is refused for a changed figure', () => {
    const problems = table.problemsOf(
      'p.md',
      edit('| `has` | has | 1.50 |', '| `has` | has | 1.40 |'),
      GOOD,
    );
    expect(problems.join('\n')).toContain('dense has prints 1.40, the rounds say 1.50');
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

  it('is refused for "close to native" said of a group that is not, or outside the region', () => {
    const said = edit(
      'Close to native (within 3 times native on every cell of the group, every control in band): has.',
      'Close to native (within 3 times native on every cell of the group, every control in band): has, export.',
    );
    expect(table.problemsOf('p.md', said, GOOD).join('\n')).toContain('said of export');
    const outside = text.replace('Intro.', 'Intro: the class is close to native.');
    expect(table.problemsOf('p.md', outside, GOOD).join('\n')).toContain(
      'stands outside the generated region',
    );
    const loud = text.replace('Outro.', 'Close To Native, they say.');
    expect(table.problemsOf('p.md', loud, GOOD).join('\n')).toContain(
      'stands outside the generated region',
    );
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

  it('stays quiet on look-alikes: the phrase "native" alone and a marker-like comment elsewhere', () => {
    const plain = text.replace('Intro.', 'Intro: native is CRoaring. <!-- BITMAP_API:OTHER -->');
    expect(table.problemsOf('p.md', plain, GOOD)).toEqual([]);
  });

  it('is rewritten to what the record renders to, and rewriting changes nothing twice', () => {
    const stale = page('stale');
    const fixed = table.withRegion('p.md', stale, GOOD);
    expect(table.problemsOf('p.md', fixed, GOOD)).toEqual([]);
    expect(table.withRegion('p.md', fixed, GOOD)).toBe(fixed);
  });
});

describe('the committed pages and record', () => {
  const file = JSON.parse(
    readFileSync(join(ROOT, 'bench/bitmap-api-results.json'), 'utf8'),
  ) as File;

  it('hold the record to its gate and to no smoke pass', () => {
    expect(file.passes.some((p) => p.environment?.smoke)).toBe(false);
    if (file.passes.length > 0) expect(verdict.gateProblems(file.passes)).toEqual([]);
  });

  it('recompute every stored cell figure from the rounds beside it', () => {
    for (const pass of file.passes) {
      for (const cell of [...(pass.cells ?? []), ...(pass.cold ?? [])]) {
        const again = verdict.cellOf(cell.rounds, 7);
        for (const key of [
          'vsNative',
          'vsNativeInterval',
          'controlVsOurs',
          'controlInBand',
          'vsInternal',
        ]) {
          expect(cell[key], `${cell.dataset} ${cell.op} ${key}`).toEqual(again[key]);
        }
      }
    }
  });

  for (const doc of PAGES) {
    it(`${doc} carries the table of the record, and the not-measured state only while it holds no pass`, () => {
      expect(table.problemsOf(doc, readFileSync(join(ROOT, doc), 'utf8'), file)).toEqual([]);
    });
  }

  it('is checked by the script, which fails on a stale page', () => {
    const copy = mkdtempSync(join(tmpdir(), 'bitmap-api-table-'));
    try {
      for (const f of ['bench/bitmap-api-results.json', ...PAGES]) {
        cpSync(join(ROOT, f), join(copy, f), { recursive: true });
      }
      const run = () =>
        execFileSync(process.execPath, [join(ROOT, 'bench/bitmap-api-table.cjs'), '--check'], {
          env: { ...process.env, BITMAP_API_TABLE_ROOT: copy },
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      expect(run()).toContain('ok');
      const stale = join(copy, PAGES[0]!);
      writeFileSync(
        stale,
        readFileSync(stale, 'utf8').replace(table.END, `an unrecorded 1.00 figure\n${table.END}`),
      );
      expect(run).toThrow();
    } finally {
      rmSync(copy, { recursive: true, force: true });
    }
  });
});
