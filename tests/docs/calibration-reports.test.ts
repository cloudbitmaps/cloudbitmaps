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
 * good. The first explanation of the first single-bucket run — written from the run's own log — got three of them
 * wrong: it put a load at one GET where the code makes three, called a byte share a chunk share, and gave identical
 * segments 2,000 chunks where the layout has 1,999. Each read plausibly. None was checkable from the page.
 *
 *   FORWARD   every headline figure `bench/lib/calibration-figures.cjs` derives appears, in the form a reader sees;
 *   REVERSE   no dollar amount, percentage, duration or byte size appears that the evidence cannot account for,
 *             at the precision the page states it — so a wrong figure beside the right ones fails, which a
 *             forward check alone can never catch;
 *   TABLES    the request ledger matches the evidence row by row, billing class included, and the table of cost
 *             by overlap follows from the request shape the run measured.
 *
 * And the evidence itself must be a complete, self-consistent real run before anything is derived from it: the
 * derivation refuses a file whose parts do not reconcile, and a refusal fails here rather than quietly deriving
 * figures from a run that did not happen the way its file says.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const require_ = createRequire(import.meta.url);

type Unit = 'usd' | 'pct' | 'ms' | 's' | 'bytes' | 'bits';
interface Figures {
  runId: string;
  chunksPerSegment: number;
  chunksPerOperand: number;
  coldGets: (k: number) => number;
  byCommand?: Record<string, number>;
  ledger: Record<string, number>;
  kRows: Array<{ k: number; gets: number; usd: number }>;
  anchors: Array<[string, string]>;
  values: Record<Unit, number[]>;
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
  };
  evidenceFiles: (root: string) => string[];
  derive: (run: unknown, sources: unknown) => Figures;
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

// ── the reverse check ────────────────────────────────────────────────────────────────────────────────────────
const BYTE_UNITS: Record<string, number> = {
  B: 1,
  byte: 1,
  bytes: 1,
  KB: 1e3,
  MB: 1e6,
  GB: 1e9,
  KiB: 1024,
  MiB: 1024 ** 2,
  GiB: 1024 ** 3,
};
const NUMBER = String.raw`(\d[\d,]*(?:\.\d+)?)`;
const CLASSES: Array<{ unit: Unit; re: RegExp; scale: (m: RegExpMatchArray) => number }> = [
  { unit: 'usd', re: new RegExp(String.raw`\$${NUMBER}`, 'g'), scale: () => 1 },
  { unit: 'pct', re: new RegExp(String.raw`${NUMBER}\s?%`, 'g'), scale: () => 0.01 },
  { unit: 'ms', re: new RegExp(String.raw`${NUMBER}\s?ms\b`, 'g'), scale: () => 1 },
  { unit: 's', re: new RegExp(String.raw`${NUMBER}\s?(?:s|seconds?)\b`, 'g'), scale: () => 1 },
  {
    unit: 'bytes',
    re: new RegExp(String.raw`${NUMBER}\s?(B|bytes?|KB|MB|GB|KiB|MiB|GiB)\b`, 'g'),
    scale: (m) => BYTE_UNITS[m[2] ?? ''] ?? Number.NaN,
  },
  { unit: 'bits', re: new RegExp(String.raw`${NUMBER}\s?Mbit/s`, 'g'), scale: () => 1e6 },
];

/**
 * Does a stated number round-match one the evidence supports? It must be that value at the precision it is written
 * to — `$0.0000816`, `$0.000082` and `$82` all state 0.0000816 at their own precision — and within 5% of it, so a
 * precision too coarse to mean anything (`$0`, `$0.0001`) cannot pass on a technicality. An integer that ends in
 * zeros may be rounded to its last non-zero digit: `26,000` for 25,993.
 */
function accounted(token: string, candidates: number[]): boolean {
  const plain = token.replace(/,/g, '');
  const x = Number(plain);
  const dp = plain.includes('.') ? (plain.split('.')[1] ?? '').length : 0;
  const zeros = dp === 0 ? (/0+$/.exec(plain)?.[0].length ?? 0) : 0;
  return candidates.some((v) => {
    if (!(v > 0) || Math.abs(x - v) / v > 0.05) return false;
    if (v.toFixed(dp) === x.toFixed(dp)) return true;
    for (let z = 1; z <= zeros; z += 1) if (Math.round(v / 10 ** z) * 10 ** z === x) return true;
    return false;
  });
}

/** Every money figure, percentage, duration and byte size in `text` that `values` cannot account for. */
function unaccounted(text: string, values: Record<Unit, number[]>): string[] {
  const out: string[] = [];
  for (const { unit, re, scale } of CLASSES) {
    for (const m of text.matchAll(re)) {
      const token = m[1] ?? '';
      const inUnits = values[unit].map((v) => v / scale(m));
      if (!accounted(token, inUnits)) out.push(m[0]);
    }
  }
  return out;
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
        .map((c) => c.replace(/\*\*/g, '').trim()),
    );
  }
  return rows;
}

/** The section of `doc` whose heading mentions `needle`, down to the next heading at its level or above. */
function sectionNaming(doc: string, needle: string): string | null {
  const lines = doc.split('\n');
  const at = lines.findIndex((l) => /^#{1,6} /.test(l) && l.includes(needle));
  if (at === -1) return null;
  const level = /^#+/.exec(lines[at] ?? '')?.[0].length ?? 1;
  const end = lines.findIndex(
    (l, i) => i > at && /^#{1,6} /.test(l) && (/^#+/.exec(l)?.[0].length ?? 7) <= level,
  );
  return lines.slice(at, end === -1 ? undefined : end).join('\n');
}

const leadingNumber = (cell: string): number =>
  Number((/^[$~]*([\d,.]+)/.exec(cell)?.[1] ?? 'NaN').replace(/,/g, ''));

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

  // The reverse check is only as good as its ability to fail. These are the look-alikes it must tell apart.
  it('accepts a figure at any honest precision, and nothing else', () => {
    expect(accounted('0.0000816', [0.0000816])).toBe(true);
    expect(accounted('0.000082', [0.0000816])).toBe(true);
    expect(accounted('82', [81.6])).toBe(true);
    expect(accounted('26,000', [25_993])).toBe(true);
    expect(accounted('0.0000817', [0.0000816])).toBe(false);
    expect(accounted('81', [81.6])).toBe(false);
    expect(accounted('0', [0.0000816])).toBe(false);
    expect(accounted('0.0001', [0.0000816])).toBe(false);
    expect(accounted('25,000', [25_993])).toBe(false);
    const values = {
      usd: [0.0000816],
      pct: [0.05],
      ms: [83.1],
      s: [2],
      bytes: [262_144],
      bits: [5.77e6],
    };
    expect(
      unaccounted('$0.0000816 · 5.0% · 83 ms · 2 s · 256 KiB · 5.8 Mbit/s · A ∩ B', values),
    ).toEqual([]);
    expect(unaccounted('$0.0000916 and 6% and 84 ms and 3 s and 255 KiB', values)).toEqual([
      '$0.0000916',
      '6%',
      '84 ms',
      '3 s',
      '255 KiB',
    ]);
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
      it('is exactly the file the harness wrote', () => {
        const raw = read(file);
        expect(raw).toBe(`${JSON.stringify(JSON.parse(raw), null, 2)}\n`);
      });

      it('its report states every headline figure', () => {
        const missing = (f?.anchors ?? []).filter(([, want]) => !report.includes(want));
        expect(missing, `${reportPath} does not state these`).toEqual([]);
      });

      it('its report states no figure the evidence cannot account for', () => {
        expect(f).toBeDefined();
        if (f === undefined) return;
        expect(unaccounted(report, f.values), `${reportPath} states these`).toEqual([]);
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
          const command = /`(\w+)`/.exec(label)?.[1] ?? '';
          expect(billed, label).toBe(
            { put: 'PUT', get: 'GET', free: 'free' }[meter.classify(`${command}Command`)],
          );
          const want =
            command === 'GetObject'
              ? GET_OBJECT.find(([re]) => re.test(label))?.[1]
              : f.byCommand?.[`${command}Command`];
          expect(leadingNumber(count ?? ''), label).toBe(want);
          seen.push(command === 'GetObject' ? label : command);
        }
        // Every command the run sent has a row, and GetObject has one per kind of read, so a row cannot be dropped.
        const commands = Object.keys(f.byCommand ?? {})
          .filter((c) => c !== 'GetObjectCommand')
          .map((c) => c.replace(/Command$/, ''));
        for (const c of commands) expect(seen, `no ledger row for ${c}`).toContain(c);
        expect(seen.filter((s) => s.includes('GetObject'))).toHaveLength(GET_OBJECT.length);
        expect(seen).toContain('total');
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

  // The page a reader lands on quotes the latest run. Its section on that run is held to the same evidence.
  describe('the benchmarks page', () => {
    const latest = EVIDENCE.at(-1);
    const run = latest === undefined ? undefined : JSON.parse(read(latest));
    const f = run === undefined ? undefined : figures.derive(run, SOURCES);
    const doc = read(join('docs', 'benchmarks.md'));
    const section = f === undefined ? null : sectionNaming(doc, f.runId);
    const REQUIRED = [
      'run id',
      'exact cold intersects',
      'chunks fetched',
      'GETs per cold intersect',
      'cold intersect',
      'per million cold intersects',
      'per million single-part loads',
      'per million multipart loads',
    ];

    it('has a section on the latest run, which links its report', () => {
      expect(section, `docs/benchmarks.md has no heading naming run ${f?.runId}`).not.toBeNull();
      expect(section).toContain(`../bench/calibration/${f?.runId}.md`);
    });

    it("states the run's headline figures", () => {
      const anchors = (f?.anchors ?? []).filter(([name]) => REQUIRED.includes(name));
      expect(anchors).toHaveLength(REQUIRED.length);
      expect(anchors.filter(([, want]) => !(section ?? '').includes(want))).toEqual([]);
    });

    // Not vacuous when the section is missing: the empty string would account for everything.
    it('states no figure the evidence cannot account for', () => {
      expect(f).toBeDefined();
      expect(section).not.toBeNull();
      if (f === undefined || section === null) return;
      expect(unaccounted(section, f.values)).toEqual([]);
    });
  });
});
