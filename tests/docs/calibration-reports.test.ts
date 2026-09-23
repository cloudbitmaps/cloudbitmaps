import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AWS_US_EAST_1_ONDEMAND } from '@/index';
import { DEFAULT_TAIL_BYTES, FOOTER_BYTES, PREAMBLE_BYTES } from '@/core/crbm/format';

/**
 * A real-cloud calibration run's report, and the benchmarks page's section on it, state only what the run's
 * evidence supports — checked in both directions.
 *
 * WHY THIS FILE EXISTS. A run report's numbers are the ones a reader has no way to check: they come from a bill for
 * a run nobody else saw, and a report is written by hand, after the run, by someone who wants the numbers to be
 * good. The first explanation of run `2026-09-23-94416` — written from the run's own log — got three of them wrong:
 * it put a load at one GET where the code makes three, called a byte share a chunk share, and gave identical
 * segments 2,000 chunks where the layout has 1,999. A review then found three more in the published draft: object
 * sizes that included the pointer, a measured figure labelled with the expected one's value, and an upload rate
 * described as the uplink's speed. Each read plausibly. None was checkable from the page.
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
}
interface Figures {
  runId: string;
  remote: boolean;
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
  paragraphsNaming: (doc: string, runId: string) => string;
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
 * A bill table's rows held to the derivation. Each row whose requests cell names a GET or a PUT is one of the
 * derivation's rows, with its cost and — where the table has one — its label; each of the derivation's rows appears
 * exactly once. A row naming no request (storage by the month) is held by the reverse check alone.
 */
function checkBill(
  rows: string[][],
  want: Row[],
  cols: { requests: number; one: number; perMillion: number; label?: number },
): string[] {
  const problems: string[] = [];
  const seen = new Map<string, number>();
  for (const row of rows) {
    const requests = row[cols.requests] ?? '';
    if (!/\b(?:GET|PUT)/.test(requests)) continue;
    const match = want.find((w) => w.requests === requests);
    if (match === undefined) {
      problems.push(`a row bills "${requests}", which the run does not derive`);
      continue;
    }
    seen.set(requests, (seen.get(requests) ?? 0) + 1);
    const got = {
      one: row[cols.one],
      perMillion: row[cols.perMillion],
      ...(cols.label === undefined ? {} : { label: row[cols.label] }),
    };
    const expected = {
      one: match.one,
      perMillion: match.perMillion,
      ...(cols.label === undefined ? {} : { label: match.label }),
    };
    if (JSON.stringify(got) !== JSON.stringify(expected)) {
      problems.push(
        `the "${requests}" row says ${JSON.stringify(got)}, not ${JSON.stringify(expected)}`,
      );
    }
  }
  for (const w of want) {
    const n = seen.get(w.requests) ?? 0;
    if (n !== 1) problems.push(`the "${w.requests}" row appears ${n} times, not once`);
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
      redisMonthlyUSD: AWS_US_EAST_1_ONDEMAND.redis.monthlyUSD,
    });
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
      ]) {
        expect(figures.unaccounted(spelled, values), spelled).toHaveLength(1);
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
        '#### The run `2026-07-25-60291` compared',
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
        const commits = git('log', '--follow', '--format=%H', '--', file)
          .split('\n')
          .filter(Boolean);
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
        expect(checkBill(rows, f.rows, { requests: 1, one: 2, perMillion: 3, label: 4 })).toEqual(
          [],
        );
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
            int(1 / want.usd),
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
    const section = f === undefined ? null : figures.runSection(doc, f.runId);
    const REQUIRED = [
      'run id',
      'exact cold intersects',
      'chunks fetched',
      'GETs the median cold intersect made',
      'a cold intersect, measured',
      'per million cold intersects, measured',
      'GETs a cold intersect makes with each pointer read once',
      'per million cold intersects with each pointer read once',
      'per million single-part write-and-publishes',
      'per million multipart write-and-publishes',
      "per million of a segment's first store.load()",
      'the run',
    ];

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
      const naming = figures.paragraphsNaming(doc.replace(section, ''), f.runId);
      expect(figures.unaccounted(`${section}\n\n${naming}`, f.pageValues)).toEqual([]);
    });

    it('bills each operation as the derivation does', () => {
      expect(f).toBeDefined();
      if (f === undefined || section === null) return;
      const rows = tableAfter(
        section,
        /^\|\s*Operation\s*\|\s*Requests\s*\|\s*One\s*\|\s*Per million\s*\|\s*Label\s*\|/,
      );
      expect(rows.length, 'the section has no bill').toBeGreaterThan(0);
      expect(checkBill(rows, f.rows, { requests: 1, one: 2, perMillion: 3, label: 4 })).toEqual([]);
    });
  });
});
