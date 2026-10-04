import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AWS_US_EAST_1_ONDEMAND, ONE_REDIS_HA_CLUSTER } from '@/index';
import { DEFAULT_TAIL_BYTES, FOOTER_BYTES, PREAMBLE_BYTES } from '@/core/crbm/format';

/**
 * A real-cloud calibration run's report, and the benchmarks page's section on it, state only what the run's
 * evidence supports — checked in both directions.
 *
 * WHY THIS FILE EXISTS. A run report's numbers are the ones a reader has no way to check: they come from a bill for
 * a run nobody else saw, and a report is written by hand, after the run, by someone who wants the numbers to be
 * good. The errors such a report makes read plausibly, even written from the run's own log, and none is checkable
 * from the page: a load put at one GET where the code makes three, a byte share called a chunk share, identical
 * segments given 2,000 chunks where the layout has 1,999, object sizes that include the pointer, a measured figure
 * labelled with the expected one's value, an upload rate described as the uplink's speed.
 *
 *   FORWARD   every headline figure `bench/lib/calibration-figures.cjs` derives appears, as a whole figure, in the
 *             text a reader sees — not inside a longer number, and not in a comment;
 *   REVERSE   no dollar amount, percentage, duration, byte size or bit rate appears that the evidence cannot account
 *             for at the precision it is written, and no count of requests, chunks, ids, loads, intersects or
 *             segments either — so a wrong figure beside the right ones fails, which a forward check alone never
 *             catches;
 *   TABLES    the bill, the request ledger and the table of cost by overlap match the derivation row by row,
 *             labels and billing classes included, so the right numbers on the wrong rows fail too.
 *
 * And the evidence itself must be a complete, self-consistent real run before anything is derived from it: the
 * derivation refuses a file whose parts do not reconcile, and a refusal fails here rather than quietly deriving
 * figures from a run that did not happen the way its file says. It must also be the harness's own output, touched
 * by one commit only: evidence is written once.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const require_ = createRequire(import.meta.url);

interface Values {
  counts: Record<string, number[]>;
  pairs: Record<string, Array<[number, number]>>;
  [unit: string]: unknown;
}
interface Row {
  requests: string;
  one: string;
  perMillion: string;
  label: string;
  says: RegExp;
}
interface Figures {
  runId: string;
  remote: boolean;
  loadVia: string | null;
  chunksPerSegment: number;
  chunksPerOperand: number;
  byCommand: Record<string, number>;
  ledger: Record<string, number>;
  kRows: Array<{ k: number; gets: number; usd: number }>;
  anchors: Array<[string, string]>;
  rows: Row[];
  values: Values;
  pageValues: Values;
}
const figures = require_(join(ROOT, 'bench', 'lib', 'calibration-figures.cjs')) as {
  readSources: (root: string) => {
    pricing: {
      name: string;
      getPerMillion: number;
      putPerMillion: number;
      storagePerGiBMonth: number;
      redisMonthlyUSD: number;
    };
    secondsPerMonth: number;
    tailBytes: number;
    footerBytes: number;
    preambleBytes: number;
    genTtlMs: number;
    intersectConcurrency: number;
  };
  evidenceFiles: (root: string) => string[];
  derive: (run: unknown, sources: unknown) => Figures;
  unaccounted: (text: string, values: Values) => string[];
  accounted: (token: string, candidates: number[], options?: { hedged?: boolean }) => boolean;
  statesFigure: (text: string, figure: string) => boolean;
  runSection: (doc: string, runId: string) => string | null;
  paragraphsNaming: (doc: string, runId: string, aliases?: string[]) => string;
  claimsAbout: (
    doc: string,
    runId: string,
    aliases?: string[],
  ) => { section: string | null; elsewhere: string };
  format: {
    int: (n: number) => string;
    usd: (n: number, dp: number) => string;
  };
};
const meter = require_(join(ROOT, 'bench', 'lib', 'aws-meter.cjs')) as {
  classify: (command: string) => 'put' | 'get' | 'free';
};

const DIR = join('bench', 'calibration');
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8');
const SOURCES = figures.readSources(ROOT);
const EVIDENCE = figures.evidenceFiles(ROOT);
const { int, usd } = figures.format;
const git = (...args: string[]): string =>
  execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();

/**
 * The commits that touched an evidence file, following it through a move between evidence paths. Git's `--follow`
 * also finds a copy source for a file that merely resembles another, such as a test fixture of the same shape, and
 * would then count that fixture's history as the evidence's. The history is cut at the first commit that adds the
 * file from a path outside `bench/calibration/`.
 */
function evidenceCommits(file: string, cwd: string = ROOT): string[] {
  const out = execFileSync(
    'git',
    ['log', '--follow', '--name-status', '--format=%x00%H', '--', file],
    { cwd, encoding: 'utf8' },
  );
  const commits: string[] = [];
  for (const block of out.split('\0').filter((b) => b.trim() !== '')) {
    const [hash, ...rest] = block.trim().split('\n');
    commits.push(hash ?? '');
    const moved = rest.map((l) => l.split('\t')).find((c) => /^[RC]\d+$/.test(c[0] ?? ''));
    // A copy is a new file that resembles another, whose source still has its own history: the copy's starts here.
    // A move carries the file's history with it, unless it came from outside the evidence directory.
    const copied = (moved?.[0] ?? '').startsWith('C');
    if (moved !== undefined && (copied || !(moved[1] ?? '').startsWith('bench/calibration/')))
      break;
  }
  return commits;
}

/**
 * The anchors a benchmarks-page section must state. A run that timed `store.load()` has the loads' own prices to
 * state; one that timed the write and publish has those, and the first `store.load()` the tests count.
 */
function requiredAnchors(loadVia: string | null): string[] {
  return [
    'run id',
    'exact cold intersects',
    'chunks fetched',
    'GETs the median cold intersect made',
    'a cold intersect, measured',
    'per million cold intersects, measured',
    'GETs a cold intersect makes with each pointer read once',
    'per million cold intersects with each pointer read once',
    ...(loadVia === null
      ? [
          'per million single-part write-and-publishes',
          'per million multipart write-and-publishes',
          "per million of a segment's first store.load()",
        ]
      : ['per million single-part store.load() calls', 'per million multipart store.load() calls']),
    'the run',
  ];
}

/** The rows of the markdown table whose header line matches `header`, as trimmed cells. */
function tableAfter(text: string, header: RegExp): string[][] {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => header.test(l));
  if (start === -1) return [];
  const rows: string[][] = [];
  for (const line of lines.slice(start + 2)) {
    if (!line.trimStart().startsWith('|')) break;
    rows.push(
      line
        .trim()
        .replace(/^\||\|$/g, '')
        .split('|')
        .map((c) => c.replace(/\*\*|`/g, '').trim()),
    );
  }
  return rows;
}

const leadingNumber = (cell: string): number =>
  Number((/^[$~]*([\d,.]+)/.exec(cell)?.[1] ?? 'NaN').replace(/,/g, ''));

/**
 * A bill table's rows held to the derivation. Every row with a price per million is one of the derivation's rows:
 * its requests, its cost, its label, and words in its operation that say which operation it is — so the measured and
 * the expected intersect cannot trade places. Each of the derivation's rows appears exactly once. A row with no price
 * per million is storage by the month, and must say so; the reverse check holds its figures.
 */
function checkBill(
  rows: string[][],
  want: Row[],
  cols: { operation: number; requests: number; one: number; perMillion: number; label?: number },
): string[] {
  const problems: string[] = [];
  const seen = new Map<string, number>();
  const labels = new Set(want.map((w) => w.label));
  for (const row of rows) {
    const requests = row[cols.requests] ?? '';
    const operation = row[cols.operation] ?? '';
    if ((row[cols.perMillion] ?? '') === '') {
      if (!/ a month$/.test(row[cols.one] ?? '')) {
        problems.push(`the "${operation}" row prices nothing per million and nothing by the month`);
      }
      if (cols.label !== undefined && row[cols.label] !== 'derived') {
        problems.push(`the "${operation}" row is labelled "${row[cols.label]}", not "derived"`);
      }
      continue;
    }
    if (cols.label !== undefined && !labels.has(row[cols.label] ?? '')) {
      problems.push(
        `the "${operation}" row is labelled "${row[cols.label]}", which the run does not use`,
      );
    }
    const group = want.filter((w) => w.requests === requests);
    const match = group[0];
    if (match === undefined) {
      problems.push(`a row bills "${requests}", which the run does not derive`);
      continue;
    }
    // A run whose measured and expected counts are equal derives two rows with one request count and one price: a
    // single row may state both, which then must say both, or two rows may each say one.
    const same = group.every((w) => w.one === match.one && w.perMillion === match.perMillion);
    const said = group.filter((w) => w.says.test(operation));
    const ok = same && group.length > 1 ? said.length > 0 : said.includes(match);
    if (!ok) {
      problems.push(
        `the "${requests}" row calls itself "${operation}", which does not say ${match.says}`,
      );
    }
    seen.set(requests, (seen.get(requests) ?? 0) + 1);
    const wanted = same && group.length > 1 ? (said[0] ?? match) : match;
    const got = {
      one: row[cols.one],
      perMillion: row[cols.perMillion],
      ...(cols.label === undefined ? {} : { label: row[cols.label] }),
    };
    const expected = {
      one: wanted.one,
      perMillion: wanted.perMillion,
      ...(cols.label === undefined ? {} : { label: wanted.label }),
    };
    if (JSON.stringify(got) !== JSON.stringify(expected)) {
      problems.push(
        `the "${requests}" row says ${JSON.stringify(got)}, not ${JSON.stringify(expected)}`,
      );
    }
  }
  for (const requests of new Set(want.map((w) => w.requests))) {
    const group = want.filter((w) => w.requests === requests);
    const n = seen.get(requests) ?? 0;
    // Two derived rows with one figure may be stated as one row or as two.
    const allowed =
      group.length > 1 && group.every((w) => w.one === group[0]?.one) ? group.length : 1;
    if (n < 1 || n > allowed) {
      problems.push(
        `the "${requests}" row appears ${n} times, not ${allowed === 1 ? 'once' : 'once or twice'}`,
      );
    }
  }
  return problems;
}

describe('calibration reports are held to their evidence', () => {
  it('reads the constants it derives from out of the library, correctly', () => {
    expect(SOURCES.pricing).toEqual({
      name: AWS_US_EAST_1_ONDEMAND.name,
      getPerMillion: AWS_US_EAST_1_ONDEMAND.storage.getPerMillion,
      putPerMillion: AWS_US_EAST_1_ONDEMAND.storage.putPerMillion,
      storagePerGiBMonth: AWS_US_EAST_1_ONDEMAND.storage.storagePerGiBMonth,
      // A run's crossover is against one cluster; the default profile sizes Redis to the data instead.
      redisMonthlyUSD: ONE_REDIS_HA_CLUSTER.monthlyUSD,
    });
    expect(SOURCES.secondsPerMonth).toBe(730 * 3600);
    expect(SOURCES.tailBytes).toBe(DEFAULT_TAIL_BYTES);
    expect(SOURCES.footerBytes).toBe(FOOTER_BYTES);
    expect(SOURCES.preambleBytes).toBe(PREAMBLE_BYTES);
    expect(SOURCES.genTtlMs).toBeGreaterThan(0);
    expect(SOURCES.intersectConcurrency).toBeGreaterThan(0);
  });

  it('finds the committed runs, and every report has its evidence', () => {
    expect(EVIDENCE.length).toBeGreaterThanOrEqual(1);
    const reports = readdirSync(join(ROOT, DIR)).filter(
      (f) => f.endsWith('.md') && f !== 'README.md',
    );
    const runs = new Set(EVIDENCE.map((f) => basename(f, '.json')));
    expect(
      reports.filter((r) => !runs.has(basename(r, '.md'))),
      'reports with no evidence',
    ).toEqual([]);
  });

  // The reverse check is only as good as its ability to fail. These are the look-alikes it must tell apart, and
  // the spellings a wrong figure could otherwise hide behind.
  // The evidence is committed once. A new file that resembles a fixture is not followed into the fixture's history,
  // a second commit touching it still counts, and a move between evidence paths is followed.
  describe('the evidence commit count', () => {
    const body = JSON.stringify({ a: Array.from({ length: 50 }, (_, i) => `line ${i}`) }, null, 2);
    const repo = (): string => {
      const dir = mkdtempSync(join(tmpdir(), 'evidence-commits-'));
      execFileSync('git', ['init', '-q'], { cwd: dir });
      mkdirSync(join(dir, 'bench', 'calibration'), { recursive: true });
      mkdirSync(join(dir, 'fixtures'), { recursive: true });
      return dir;
    };
    const commit = (dir: string, msg: string): void => {
      execFileSync('git', ['add', '-A'], { cwd: dir });
      execFileSync(
        'git',
        [
          '-c',
          'user.name=t',
          '-c',
          'user.email=t@example.com',
          '-c',
          'commit.gpgsign=false',
          'commit',
          '-q',
          '-m',
          msg,
        ],
        { cwd: dir },
      );
    };

    it('counts a new file that resembles a fixture once, and a second commit twice', () => {
      const dir = repo();
      try {
        writeFileSync(join(dir, 'fixtures', 'f.json'), `${body}\n`);
        commit(dir, 'fixture');
        writeFileSync(join(dir, 'fixtures', 'f.json'), `${body.replace('line 1"', 'line 1b"')}\n`);
        commit(dir, 'fixture edit');
        const file = 'bench/calibration/run.json';
        writeFileSync(join(dir, file), `${body.replace('line 2"', 'line 2b"')}\n`);
        commit(dir, 'evidence');
        expect(evidenceCommits(file, dir)).toHaveLength(1);
        writeFileSync(join(dir, file), `${body}\n`);
        commit(dir, 'edit');
        expect(evidenceCommits(file, dir)).toHaveLength(2);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('counts a new run that resembles an earlier run once, and the earlier run still once', () => {
      // Two runs of one harness share their shape, so git reports the second as a copy of the first. A copy's
      // source still exists with its own history, so the copy's history starts at the commit that made it.
      const dir = repo();
      try {
        writeFileSync(join(dir, 'bench', 'calibration', 'first.json'), `${body}\n`);
        commit(dir, 'first run');
        const second = 'bench/calibration/second.json';
        writeFileSync(join(dir, second), `${body.replace('line 3"', 'line 3b"')}\n`);
        commit(dir, 'second run');
        expect(evidenceCommits(second, dir)).toHaveLength(1);
        expect(evidenceCommits('bench/calibration/first.json', dir)).toHaveLength(1);
        writeFileSync(join(dir, second), `${body}\n`);
        commit(dir, 'edit');
        expect(evidenceCommits(second, dir)).toHaveLength(2);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('follows a move between evidence paths', () => {
      const dir = repo();
      try {
        writeFileSync(join(dir, 'bench', 'calibration', 'old.json'), `${body}\n`);
        commit(dir, 'evidence');
        execFileSync('git', ['mv', 'bench/calibration/old.json', 'bench/calibration/new.json'], {
          cwd: dir,
        });
        commit(dir, 'move');
        expect(evidenceCommits('bench/calibration/new.json', dir)).toHaveLength(2);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  // The figures of a run's own stages are derived from its evidence, not listed: each real one is accepted, and a
  // number that no stage holds is refused beside them.
  describe('the stage figures of the in-region run', () => {
    const evidence = EVIDENCE.find((e) => e.includes('2026-10-03-e13c7'));
    const run = evidence === undefined ? undefined : JSON.parse(read(evidence));
    const f = run === undefined ? undefined : figures.derive(run, SOURCES);
    const check = (sentence: string): string[] =>
      f === undefined ? ['no evidence'] : figures.unaccounted(sentence, f.values);

    it('accepts what each stage measured, and what follows from it', () => {
      expect(
        check(
          'The sweep at 1,000 shared chunks took 4,238.82 ms and 2,004 GETs; at 2,000, 8,658.44 ms and 4,004 GETs, 2.04 times the first. ' +
            'A warm intersect took 3.96 ms. A cold count took 27.48 ms. andNot took 8,687.10 ms and 3,021 GETs. ' +
            'A GET round is about 26.9 ms. Loads ran at 2.86 million ids a second and 11.3 million. The run was bounded at $0.044470.',
        ),
      ).toEqual([]);
    });

    it('refuses a figure that no stage holds', () => {
      for (const wrong of [
        'The sweep at 1,000 shared chunks took 4,238.83 ms.',
        'A warm intersect took 3.97 ms.',
        'A cold count took 31.37 ms.',
        'andNot made 3,333 GETs.',
        'A GET round is about 31.2 ms.',
        'Loads ran at 3.86 million ids a second.',
        'The run was bounded at $0.054470.',
        'Doubling the overlap took 3.04 times as long.',
      ]) {
        expect(check(wrong), wrong).not.toEqual([]);
      }
    });
  });

  // A run whose measured and expected intersect make the same requests derives two rows with one figure. The bill
  // may state them as one row or as two, but not as none, and a pair that differs still needs both rows.
  describe('the bill table when the measured and the expected count agree', () => {
    const cols = { operation: 0, requests: 1, one: 2, perMillion: 3, label: 4 };
    const row = (requests: string, label: string, says: RegExp, price = '$0.0000816'): Row => ({
      requests,
      one: price,
      perMillion: price === '$0.0000816' ? '$81.60' : '$82.40',
      label,
      says,
    });
    const equal = [
      row('204 GET', 'derived', /\bmedian\b|\bmeasured\b/i),
      row('204 GET', 'expected', /\bonce\b|\bexpected\b|\binside the region\b/i),
    ];
    const differ = [
      row('206 GET', 'derived', /\bmedian\b|\bmeasured\b/i, '$0.0000824'),
      row('204 GET', 'expected', /\bonce\b|\bexpected\b|\binside the region\b/i),
    ];

    it('accepts one row that says both, or two rows with the same figure', () => {
      expect(
        checkBill(
          [
            [
              'cold intersect, the median measured and expected inside the region',
              '204 GET',
              '$0.0000816',
              '$81.60',
              'derived',
            ],
          ],
          equal,
          cols,
        ),
      ).toEqual([]);
      expect(
        checkBill(
          [
            [
              'cold intersect, the median this run measured',
              '204 GET',
              '$0.0000816',
              '$81.60',
              'derived',
            ],
            [
              'the same, expected, each pointer read once',
              '204 GET',
              '$0.0000816',
              '$81.60',
              'expected',
            ],
          ],
          equal,
          cols,
        ),
      ).toEqual([]);
    });

    it('refuses a wrong figure, a row that says neither, and a differing pair stated once', () => {
      expect(
        checkBill([['median measured', '204 GET', '$0.0000817', '$81.70', 'derived']], equal, cols),
      ).not.toEqual([]);
      expect(
        checkBill([['cold intersect', '204 GET', '$0.0000816', '$81.60', 'derived']], equal, cols),
      ).not.toEqual([]);
      expect(checkBill([], equal, cols)).not.toEqual([]);
      expect(
        checkBill(
          [['cold intersect, the median measured', '206 GET', '$0.0000824', '$82.40', 'derived']],
          differ,
          cols,
        ),
      ).not.toEqual([]);
      expect(
        checkBill(
          [
            ['cold intersect, the median measured', '206 GET', '$0.0000824', '$82.40', 'derived'],
            ['the same, expected inside the region', '204 GET', '$0.0000816', '$81.60', 'expected'],
          ],
          differ,
          cols,
        ),
      ).toEqual([]);
    });
  });

  // Which anchors a section must state follows from what the run timed.
  describe('the anchors a benchmarks section must state', () => {
    const names = (via: string | null): string[] =>
      requiredAnchors(via).filter((n) => /single-part|multipart|first store\.load/.test(n));
    const anchorsOf = (path: string): string[] => {
      const ev = EVIDENCE.find((e) => e.includes(path));
      if (ev === undefined) throw new Error(`no evidence for ${path}`);
      return figures.derive(JSON.parse(read(ev)), SOURCES).anchors.map(([n]) => n);
    };

    it('are, for a run that timed store.load(), its own load prices, and all of them exist', () => {
      expect(names('store.load()')).toHaveLength(2);
      const have = anchorsOf('2026-10-03-e13c7');
      for (const n of requiredAnchors('store.load()')) expect(have).toContain(n);
      expect(requiredAnchors('store.load()')).not.toContain(
        'per million single-part write-and-publishes',
      );
    });

    it('are, for a write-and-publish run, the three old names, and all of them exist', () => {
      expect(names(null)).toHaveLength(3);
      const have = anchorsOf('2026-09-23-94416');
      for (const n of requiredAnchors(null)) expect(have).toContain(n);
      expect(requiredAnchors(null)).not.toContain('per million multipart store.load() calls');
    });

    it('fail a section that leaves out a load anchor', () => {
      const ev = EVIDENCE.find((e) => e.includes('2026-10-03-e13c7'));
      if (ev === undefined) throw new Error('no evidence');
      const f = figures.derive(JSON.parse(read(ev)), SOURCES);
      const section = 'run 2026-10-03-e13c7 $11.60 per million single-part';
      const missing = f.anchors
        .filter(([n]) => requiredAnchors(f.loadVia).includes(n))
        .filter(([, want]) => !figures.statesFigure(section, want));
      expect(missing.map(([n]) => n)).toContain('per million multipart store.load() calls');
    });
  });

  describe('the reverse check', () => {
    const values: Values = {
      usd: [0.0000816, 81.6, 346],
      pct: [0.05, 0.95],
      ms: [83.1],
      s: [2],
      h: [730],
      bytes: [262_144, 1_052_087],
      bits: [5.77e6],
      million: [4.2],
      perSecond: [1.6],
      counts: {
        get: [204],
        put: [2],
        chunks: [1_999, 26_204],
        chunkReads: [8_000],
        ids: [500_000],
        loads: [12],
        intersects: [40],
      },
      pairs: { chunks: [[100, 1_999]], intersects: [[40, 40]] },
    };

    it('accepts a figure at any honest precision', () => {
      expect(figures.accounted('0.0000816', [0.0000816])).toBe(true);
      expect(figures.accounted('0.000082', [0.0000816])).toBe(true);
      expect(figures.accounted('82', [81.6])).toBe(true);
      expect(figures.accounted('26,000', [26_204], { hedged: true })).toBe(true);
      expect(
        figures.unaccounted(
          '$0.0000816 · $81.60 · 5.0% · 95% · 83 ms · 2 s · 730 hours · 256 KiB · 1.05 MB · 5.8 Mbit/s · ' +
            '4.2 million · 1.6 a second · 204 GETs · 2 PUT · 1,999 chunks · about 26,000 chunks · 8,000 chunk reads · ' +
            '500,000-id segments · 12 loads · 100 of 1,999 chunks · 40 of 40 intersects · A ∩ B · S3 PUTs · v0.10.0',
          values,
        ),
      ).toEqual([]);
    });

    it('refuses a figure at the wrong value, or at a precision too coarse to mean it', () => {
      expect(figures.accounted('0.0000817', [0.0000816])).toBe(false);
      expect(figures.accounted('81', [81.6])).toBe(false);
      expect(figures.accounted('0', [0.0000816])).toBe(false);
      expect(figures.accounted('0.0001', [0.0000816])).toBe(false);
      // Rounding an integer to its last non-zero digit takes a hedge: "2,000 chunks" is not 1,999 chunks.
      expect(figures.accounted('2,000', [1_999])).toBe(false);
      expect(figures.accounted('26,000', [26_204])).toBe(false);
      expect(
        figures.unaccounted(
          '$0.0000916 · 6% · 84 ms · 3 s · 255 KiB · 205 GETs · 3 PUT · 2,000 chunks · 8,002 chunk reads · ' +
            '12 intersects · 101 of 1,999 chunks · 39 of 40 intersects · [a link](#3-bytes-on-the-wire)',
          values,
        ),
      ).toEqual([
        '$0.0000916',
        '6%',
        '84 ms',
        '3 s',
        '255 KiB',
        '205 GETs',
        '3 PUT',
        '2,000 chunks',
        '8,002 chunk reads',
        '12 intersects',
        '101 of 1,999 chunks',
        '39 of 40 intersects',
      ]);
    });

    it('reads a figure however it is spelled', () => {
      for (const spelled of [
        '$ 99',
        '$**99**',
        '&#36;99',
        '99 USD',
        '99 dollars',
        '99 percent',
        '99 per cent',
        '99&nbsp;ms',
        '99 milliseconds',
        '99 msec',
        '99 seconds',
        '99-second',
        '99 secs',
        '99 kB',
        '99 kilobytes',
        '99 TB',
        '99 Mbps',
        '99 Mb/s',
        '99 Gbit/s',
        '99-byte',
        '$99M',
        '99 million',
        '99 every second',
        '99 cold intersects a second',
        '99 minutes',
        '99 cents',
        '99¢',
        '99×',
        '99 times',
        '99M cold intersects',
        '**99** ms',
        '_99%_',
      ]) {
        expect(figures.unaccounted(spelled, values), spelled).toHaveLength(1);
      }
    });

    // Wrong figures planted into the real report one at a time, each a misreading the run's evidence invites: a
    // request shape, a share, a count, a size, a label. Each must fail it, however plausibly it is written.
    it('fails on each misreading of the run planted into its report', () => {
      const report = read(join(DIR, '2026-09-23-94416.md'));
      const evidence = EVIDENCE.find((e) => e.includes('2026-09-23-94416'));
      expect(evidence).toBeDefined();
      if (evidence === undefined) return;
      const f = figures.derive(JSON.parse(read(evidence)), SOURCES);
      const plant = (sentence: string): string[] =>
        figures.unaccounted(`${report}\n\n${sentence}\n`, f.values);
      expect(plant('')).toEqual([]);
      for (const wrong of [
        'A write and publish is 2 PUT + 1 GET, $10.40 per million.',
        'An intersect fetched 4.9% of the chunks.',
        'Identical segments share 2,000 chunks, so an intersect of them is 4,004 GETs.',
        'The object itself is 1,052,248 bytes.',
        'The median cold intersect made 204 GETs, $81.60 per million.',
        'Inside the region the same intersect would make 206 GETs, $82.40 per million.',
        '98% of the chunks were skipped.',
        'Each intersect read 10 chunks per operand.',
        "A segment's first store.load() costs $11.60 per million, as measured.",
        // Seven more figures the report states, each misstated: a byte share, a depth, a per-request time, a price
        // per dollar, a crossover rate, a load price and the objects' sizes.
        "Of the two objects' bytes, 29.9% were fetched and 70.1% never left S3.",
        'The median cold intersect was about 15 requests deep.',
        'Each of its requests took about 194 ms.',
        'A dollar buys 12,136 cold intersects.',
        'Past 329.15 cold intersects a second, sustained, the node is cheaper.',
        "A segment's store.load() costs $12.40 per million.",
        'The two objects are 2,104,496 bytes, and the index is 20,152 bytes.',
      ]) {
        expect(plant(wrong), wrong).not.toEqual([]);
      }
    });

    // A share is read by the words nearest it in its own clause. Read across the semicolon below, the chunk share that
    // ends the first clause stands nearer the second clause's payload than its own chunks, and a right sentence fails.
    it('reads each clause of a sentence apart, so neighbouring shares keep their own words', () => {
      const report = read(join(DIR, '2026-09-23-94416.md'));
      const evidence = EVIDENCE.find((e) => e.includes('2026-09-23-94416'));
      if (evidence === undefined) throw new Error('no evidence for 2026-09-23-94416');
      const f = figures.derive(JSON.parse(read(evidence)), SOURCES);
      const plant = (sentence: string): string[] =>
        figures.unaccounted(`${report}\n\n${sentence}\n`, f.values);
      expect(
        plant(
          'It fetched 100 of 1,999 chunks and skipped the other 95.0%; the payload fetched was 4.9% of the bytes.',
        ),
      ).toEqual([]);
      expect(
        plant(
          'It fetched 100 of 1,999 chunks and skipped the other 4.9%; the payload fetched was 95.0% of the bytes.',
        ),
      ).not.toEqual([]);
    });

    // A binding in one direction only lets the reverse claim through: the object's size called the upload's passes
    // while the upload's size called the object's fails. Each value that can make two claims fails both ways, and
    // each wrong claim below sits beside an honest one with the same number.
    it('binds both directions of a claim that two values can make', () => {
      const report = read(join(DIR, '2026-09-23-94416.md'));
      const evidence = EVIDENCE.find((e) => e.includes('2026-09-23-94416'));
      if (evidence === undefined) throw new Error('no evidence for 2026-09-23-94416');
      const f = figures.derive(JSON.parse(read(evidence)), SOURCES);
      const plant = (sentence: string): string[] =>
        figures.unaccounted(`${report}\n\n${sentence}\n`, f.values);
      for (const [wrong, right] of [
        ['The upload is 1,052,087 bytes.', 'The object itself is 1,052,087 bytes.'],
        [
          'With each pointer read once, the path is about 16 requests deep.',
          'That puts about 16 requests in line.',
        ],
        [
          'A write and publish is 2 PUT + 3 GET, $11.60 per million.',
          "A segment's first store.load() is expected at $11.60 per million.",
        ],
        [
          'A dollar buys 12,254 cold intersects as the run measured them.',
          'At 100 shared chunks, a dollar buys 12,254 of them, expected.',
        ],
        [
          'Inside the region, a dollar buys 12,135 cold intersects.',
          'A dollar buys 12,135 of them.',
        ],
        [
          'The median made 3.8 pointer reads.',
          'It made 3.8 pointer reads an intersect on average.',
        ],
        [
          'This run measured 36.0 million cold intersects a month at 10 shared chunks.',
          'At 10 shared chunks it would buy 36.0 million cold intersects a month.',
        ],
      ] as const) {
        expect(plant(wrong), wrong).not.toEqual([]);
        expect(plant(right), right).toEqual([]);
      }
    });

    it('states a figure only as a whole figure, outside comments', () => {
      expect(figures.statesFigure('skipped 95.0% of them', '5.0%')).toBe(false);
      expect(figures.statesFigure('fetched 5.0% of them', '5.0%')).toBe(true);
      expect(figures.statesFigure('$182.40', '$82.40')).toBe(false);
      expect(figures.statesFigure('$82.405', '$82.40')).toBe(false);
      expect(figures.statesFigure('<!-- $82.40 -->', '$82.40')).toBe(false);
      expect(figures.statesFigure('$82.40&nbsp;per million', '$82.40')).toBe(true);
    });

    it('scopes a section to its run, and ends it at the next run', () => {
      const doc = [
        '## Runs',
        '### Run `2026-09-23-94416`',
        'ours $1',
        '#### Detail',
        'still ours $2',
        '#### The run `2026-10-01-11111` compared',
        'not ours $3',
        '### Next',
        'not ours $4',
      ].join('\n');
      const section = figures.runSection(doc, '2026-09-23-94416') ?? '';
      expect(section).toContain('$2');
      expect(section).not.toContain('$3');
      expect(section).not.toContain('$4');
      expect(
        figures.paragraphsNaming(
          'a\n\nsee run 2026-09-23-94416:\n$5 here\n\nb $6',
          '2026-09-23-94416',
        ),
      ).toContain('$5');
      expect(
        figures.paragraphsNaming(
          'a\n\nsee run 2026-09-23-94416:\n$5 here\n\nb $6',
          '2026-09-23-94416',
        ),
      ).not.toContain('$6');
      const list = '- one $7\n- run 2026-09-23-94416 cost $8\n- three $9';
      expect(figures.paragraphsNaming(list, '2026-09-23-94416')).toBe(
        '- run 2026-09-23-94416 cost $8',
      );
    });
  });

  describe('evidence with every field the harness records', () => {
    // Run order is the time a run started. The committed run's file has no start time, and keyed by its date alone it
    // would sort after every run started later the same day, since `T` sorts before `|`: a second run that day would
    // never become the latest, and the pages would go on being checked against the first.
    it('puts a run without a start time before a later run the same day', () => {
      const root = mkdtempSync(join(tmpdir(), 'calib-order-'));
      try {
        const dir = join(root, 'bench', 'calibration');
        mkdirSync(dir, { recursive: true });
        const put = (name: string, run: object): void =>
          writeFileSync(join(dir, name), JSON.stringify(run));
        put('2026-09-23-94416.json', { runId: '2026-09-23-94416' });
        put('2026-09-23-zzzzz.json', { startedAt: '2026-09-23T10:00:00.000Z' });
        put('2026-09-23-aaaaa.json', { startedAt: '2026-09-23T11:00:00.000Z' });
        put('2026-09-22-bbbbb.json', { startedAt: '2026-09-22T23:00:00.000Z' });
        put('2026-09-23-ccccc.partial.json', {});
        put('2026-09-23-ddddd.20260923T120000000Z.partial.json', {});
        expect(figures.evidenceFiles(root).map((f) => basename(f))).toEqual([
          '2026-09-22-bbbbb.json',
          '2026-09-23-94416.json',
          '2026-09-23-zzzzz.json',
          '2026-09-23-aaaaa.json',
        ]);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    // The harness records the object's size apart from what a load uploaded, and a large segment's ids; the committed
    // run's file records neither. The same run with both recorded must derive the same figures. An upload RATE is the
    // object and its pointer's body a second, so a derivation that pairs it with the object's size refuses every file
    // that records the two apart.
    it('derives the same figures from the same run with every field recorded', () => {
      const file = EVIDENCE.find((e) => e.includes('2026-09-23-94416'));
      expect(file).toBeDefined();
      if (file === undefined) return;
      const run = JSON.parse(read(file)) as {
        startedAt?: string;
        workload: Record<string, number>;
        phases: {
          load: Record<'singlePart' | 'multipart', Record<string, number>>;
          intersect: Record<string, number>;
        };
      };
      const later = structuredClone(run);
      const POINTER_BODY = 161;
      for (const kind of ['singlePart', 'multipart'] as const) {
        const phase = later.phases.load[kind];
        phase.medianUploadBytes = phase.medianObjectBytes ?? 0;
        phase.medianObjectBytes = (phase.medianObjectBytes ?? 0) - POINTER_BODY;
      }
      later.phases.intersect.payloadFraction =
        ((run.phases.intersect.payloadFraction ?? 0) *
          (run.phases.load.singlePart.medianObjectBytes ?? 0)) /
        (later.phases.load.singlePart.medianObjectBytes ?? 1);
      later.workload.largeIdsPerSegment = 1_536 * 8_192;
      later.startedAt = '2026-09-23T03:00:00.000Z';
      const before = figures.derive(run, SOURCES);
      const after = figures.derive(later, SOURCES);
      expect(after.anchors).toEqual(before.anchors);
      expect(after.rows).toEqual(before.rows);
    });
  });

  // A run that timed `store.load()` records its loads' and every stage's own requests, and is priced from those
  // (tests/bench/calibration-figures-store-load.test.ts). A file that says it timed `store.load()` and records none
  // of them is refused, rather than priced as a write and publish.
  describe('a run that says it timed store.load()', () => {
    it('is refused when it records no requests of its own', () => {
      const file = EVIDENCE.find((e) => e.includes('2026-09-23-94416'));
      expect(file).toBeDefined();
      if (file === undefined) return;
      const run = JSON.parse(read(file)) as { phases: { load: Record<string, unknown> } };
      expect(() => figures.derive(run, SOURCES)).not.toThrow();
      const later = structuredClone(run);
      later.phases.load.via = 'store.load()';
      expect(() => figures.derive(later, SOURCES)).toThrow(
        /records no requests for its load stage/,
      );
    });
  });

  describe.each(EVIDENCE.map((file) => ({ file, id: basename(file, '.json') })))(
    'run $id',
    ({ file, id }) => {
      const run = JSON.parse(read(file)) as { runId: string };
      const reportPath = join(DIR, `${id}.md`);
      const report = existsSync(join(ROOT, reportPath)) ? read(reportPath) : '';
      let f: Figures | undefined;
      let refused: unknown;
      try {
        f = figures.derive(run, SOURCES);
      } catch (err) {
        refused = err;
      }

      it('is the run its file is named for, and has a report', () => {
        expect(run.runId).toBe(id);
        expect(report, `write ${reportPath}`).not.toBe('');
      });

      it('is a complete, self-consistent real run', () => {
        expect(refused).toBeUndefined();
      });

      // Committed unedited: byte for byte the form the harness writes, so a formatter or an editor that touched it
      // shows up here. `.prettierignore` keeps the pre-commit hook's formatter away from it.
      it('is in the form the harness writes', () => {
        const raw = read(file);
        expect(raw).toBe(`${JSON.stringify(JSON.parse(raw), null, 2)}\n`);
      });

      // Evidence is written once. A second commit touching the file is an edit to what a run measured, however
      // innocent: the one way to change a run's evidence is to make a new run.
      it('has been committed once, and never edited', () => {
        expect(
          git('rev-parse', '--is-shallow-repository'),
          'a shallow checkout has no history to check; CI checks out with fetch-depth: 0',
        ).toBe('false');
        const commits = evidenceCommits(file);
        expect(
          commits.length,
          `${file} is touched by ${commits.length} commits`,
        ).toBeLessThanOrEqual(1);
      });

      it('its report states every headline figure', () => {
        const missing = (f?.anchors ?? []).filter(
          ([, want]) => !figures.statesFigure(report, want),
        );
        expect(missing, `${reportPath} does not state these`).toEqual([]);
      });

      it('its report states no figure the evidence cannot account for', () => {
        expect(f).toBeDefined();
        if (f === undefined) return;
        expect(figures.unaccounted(report, f.values), `${reportPath} states these`).toEqual([]);
      });

      it("its bill matches the derivation, every row's cost and label", () => {
        expect(f).toBeDefined();
        if (f === undefined) return;
        const rows = tableAfter(
          report,
          /^\|\s*operation\s*\|\s*requests\s*\|\s*each\s*\|\s*per million\s*\|\s*label\s*\|/,
        );
        expect(rows.length, `${reportPath} has no bill`).toBeGreaterThan(0);
        expect(
          checkBill(rows, f.rows, { operation: 0, requests: 1, one: 2, perMillion: 3, label: 4 }),
        ).toEqual([]);
      });

      it("its request ledger matches the evidence, every request and each one's billing class", () => {
        expect(f).toBeDefined();
        if (f === undefined) return;
        const rows = tableAfter(report, /^\|\s*request\s*\|\s*billed as\s*\|\s*count\s*\|/);
        expect(rows.length, `${reportPath} has no request ledger`).toBeGreaterThan(0);
        const { ledger } = f;
        const GET_OBJECT: Array<[RegExp, number]> = [
          [/byte range/, ledger.chunkReads ?? Number.NaN],
          [/tail/, ledger.tailReads ?? Number.NaN],
          [/not there yet/, ledger.loadPointerReads ?? Number.NaN],
          [/pointer/, ledger.pointerReads ?? Number.NaN],
        ];
        const seen: string[] = [];
        for (const [what, billed, count] of rows) {
          const label = what ?? '';
          if (/^All of it/.test(label)) {
            expect((count ?? '').match(/[\d,]+/g)?.map((d) => Number(d.replace(/,/g, '')))).toEqual(
              [ledger.put, ledger.get, ledger.free],
            );
            seen.push('total');
            continue;
          }
          const command = /^(\w+)/.exec(label)?.[1] ?? '';
          expect(billed, label).toBe(
            { put: 'PUT', get: 'GET', free: 'free' }[meter.classify(`${command}Command`)],
          );
          const kind =
            command === 'GetObject' ? GET_OBJECT.findIndex(([re]) => re.test(label)) : -1;
          const want =
            command === 'GetObject' ? GET_OBJECT[kind]?.[1] : f.byCommand[`${command}Command`];
          expect(leadingNumber(count ?? ''), label).toBe(want);
          seen.push(command === 'GetObject' ? `GetObject#${kind}` : command);
        }
        // Every command the run sent has exactly one row, and GetObject one per kind of read, so a row can be
        // neither dropped nor repeated.
        const commands = Object.keys(f.byCommand)
          .filter((c) => c !== 'GetObjectCommand')
          .map((c) => c.replace(/Command$/, ''));
        const expected = [
          ...commands,
          ...GET_OBJECT.map((_, i) => `GetObject#${i}`),
          'total',
        ].sort();
        expect([...seen].sort()).toEqual(expected);
      });

      it('its table of cost by overlap follows from the request shape the run measured', () => {
        expect(f).toBeDefined();
        if (f === undefined) return;
        const rows = tableAfter(report, /^\|\s*chunks the two share\s*\|\s*GETs\s*\|/);
        expect(rows.map((r) => leadingNumber(r[0] ?? ''))).toEqual(f.kRows.map((r) => r.k));
        for (const [row, want] of rows.map((r, i) => [r, f?.kRows[i]] as const)) {
          if (want === undefined) continue;
          const cells = row.slice(1, 5).map((c) => /^\S+/.exec(c)?.[0]);
          expect(cells, `the k = ${want.k} row`).toEqual([
            int(want.gets),
            usd(want.usd, 7),
            usd(1e6 * want.usd, 2),
            // Whole intersects: a dollar does not buy a fraction of one, so the count is rounded down.
            int(Math.floor(1 / want.usd)),
          ]);
        }
        // The run's own overlap and identical segments bound the table, so both must be in it.
        expect(f.kRows.map((r) => r.k)).toContain(f.chunksPerOperand);
        expect(f.kRows.map((r) => r.k)).toContain(f.chunksPerSegment);
      });
    },
  );

  // The page a reader lands on quotes the latest run. Its section on that run — and any paragraph elsewhere on the
  // page that names the run — is held to the same evidence, without the timings a remote client measured.
  describe('the benchmarks page', () => {
    const latest = EVIDENCE.at(-1);
    const run = latest === undefined ? undefined : JSON.parse(read(latest));
    const f = run === undefined ? undefined : figures.derive(run, SOURCES);
    const doc = read(join('docs', 'benchmarks.md'));
    // What the page calls the run besides its id. A paragraph that names it either way is a claim about it; one
    // inside another run's section is not.
    const ALIASES = ['September run', 'September 2026', 'single-bucket run', 'single-bucket bill'];
    const claims = f === undefined ? null : figures.claimsAbout(doc, f.runId, ALIASES);
    const section = claims?.section ?? null;
    const REQUIRED = requiredAnchors(f?.loadVia ?? null);

    it('has a section on the latest run, which links its report', () => {
      expect(section, `docs/benchmarks.md has no heading naming run ${f?.runId}`).not.toBeNull();
      expect(section).toContain(`../bench/calibration/${f?.runId}.md`);
    });

    it("states the run's headline figures", () => {
      const anchors = (f?.anchors ?? []).filter(([name]) => REQUIRED.includes(name));
      expect(anchors.map(([name]) => name).sort()).toEqual([...REQUIRED].sort());
      expect(anchors.filter(([, want]) => !figures.statesFigure(section ?? '', want))).toEqual([]);
    });

    // Not vacuous when the section is missing: the empty string would account for everything.
    it('states no figure the evidence cannot account for', () => {
      expect(f).toBeDefined();
      expect(section).not.toBeNull();
      if (f === undefined || section === null) return;
      expect(figures.unaccounted(`${section}\n\n${claims?.elsewhere ?? ''}`, f.pageValues)).toEqual(
        [],
      );
    });

    it('bills each operation as the derivation does', () => {
      expect(f).toBeDefined();
      if (f === undefined || section === null) return;
      const rows = tableAfter(
        section,
        /^\|\s*Operation\s*\|\s*Requests\s*\|\s*One\s*\|\s*Per million\s*\|\s*Label\s*\|/,
      );
      expect(rows.length, 'the section has no bill').toBeGreaterThan(0);
      expect(
        checkBill(rows, f.rows, { operation: 0, requests: 1, one: 2, perMillion: 3, label: 4 }),
      ).toEqual([]);
    });
  });
});
