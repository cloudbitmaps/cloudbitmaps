import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The rule that judges the paired before-and-after bench (`bench/lib/paired-verdict.cjs`), held at its boundaries, and
 * the committed evidence (`bench/ts-codec-paired-results.json`), when it is committed, held to it: every median,
 * quartile and verdict in the file is recomputed from the rounds beside it. Nothing here times anything.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const require_ = createRequire(join(ROOT, 'bench', 'sizing.cjs'));

type Round = number[];
type Cell = {
  dataset: string;
  op: string;
  answersAgree: boolean;
  rounds: Round[];
  verdict: string;
  typescriptVsNative: number;
  controlVsNative: number;
  controlQuartiles: number[];
};
const rule = require_('./lib/paired-verdict.cjs') as {
  CONTROL_LIMIT: number;
  BAND_FLOOR: number;
  WITHIN: string;
  SLOWER: string;
  FASTER: string;
  INCONCLUSIVE: string;
  MALFORMED: string;
  bandOf: (q: number[]) => number;
  pairedVerdictOf: (head: number, control: number, q: number[]) => string;
  worstPaired: (vs: string[]) => string;
};
const codec = require_('./lib/codec-verdict.cjs') as {
  MIN_ROUNDS: number;
  summarise: (rounds: Round[], places?: number) => Omit<Cell, 'verdict'>;
};
const { WITHIN, SLOWER, FASTER, INCONCLUSIVE, MALFORMED, pairedVerdictOf, worstPaired, bandOf } =
  rule;

/** A quiet control: median 0, quartiles at +-0.4%. */
const QUIET = [-0.004, 0.004];

describe('the paired verdict rule', () => {
  it('takes the band from the control: half its interquartile range, never under 1%', () => {
    expect(bandOf([-0.004, 0.004])).toBe(0.01);
    expect(bandOf([-0.03, 0.03])).toBe(0.03);
    expect(bandOf([0, 0])).toBe(0.01);
  });

  it('puts the head inside, above or below the band around the control median', () => {
    expect(pairedVerdictOf(0.01, 0, QUIET)).toBe(WITHIN);
    expect(pairedVerdictOf(0.0101, 0, QUIET)).toBe(SLOWER);
    expect(pairedVerdictOf(-0.01, 0, QUIET)).toBe(WITHIN);
    expect(pairedVerdictOf(-0.0101, 0, QUIET)).toBe(FASTER);
    // The band moves with the control's own median, so a control that sits at +2% does not make a head at +2% slower.
    expect(pairedVerdictOf(0.03, 0.02, QUIET)).toBe(WITHIN);
    expect(pairedVerdictOf(0.0301, 0.02, QUIET)).toBe(SLOWER);
  });

  it('widens the band when the control is noisy, so noise is not called a regression', () => {
    expect(pairedVerdictOf(0.025, 0, [-0.03, 0.03])).toBe(WITHIN);
    expect(pairedVerdictOf(0.0301, 0, [-0.03, 0.03])).toBe(SLOWER);
  });

  it('calls a cell inconclusive when the control median is past 3%, whatever the head shows', () => {
    expect(pairedVerdictOf(0.03, 0.03, QUIET)).toBe(WITHIN);
    expect(pairedVerdictOf(0, 0.0301, QUIET)).toBe(INCONCLUSIVE);
    expect(pairedVerdictOf(0.5, -0.0301, QUIET)).toBe(INCONCLUSIVE);
    expect(pairedVerdictOf(-0.5, 0.05, QUIET)).toBe(INCONCLUSIVE);
  });

  it('calls a figure that is not a number malformed, never a pass', () => {
    expect(pairedVerdictOf(Number.NaN, 0, QUIET)).toBe(MALFORMED);
    expect(pairedVerdictOf(0, Number.POSITIVE_INFINITY, QUIET)).toBe(MALFORMED);
    expect(pairedVerdictOf(0, 0, [Number.NaN, 0])).toBe(MALFORMED);
    expect(pairedVerdictOf(0, 0, [])).toBe(MALFORMED);
  });

  it('takes the worst of a list: malformed, slower, inconclusive, faster, within; none is malformed', () => {
    expect(worstPaired([WITHIN, WITHIN])).toBe(WITHIN);
    expect(worstPaired([WITHIN, FASTER])).toBe(FASTER);
    expect(worstPaired([FASTER, INCONCLUSIVE])).toBe(INCONCLUSIVE);
    expect(worstPaired([INCONCLUSIVE, SLOWER, WITHIN])).toBe(SLOWER);
    expect(worstPaired([SLOWER, MALFORMED])).toBe(MALFORMED);
    expect(worstPaired([])).toBe(MALFORMED);
  });
});

type Pass = {
  pass: number;
  reads: Cell[];
  write: Cell[];
  import: { runs: number; moduleLoadMs: Cell };
  verdict: string;
  started: string;
  environment: { rounds: number; tree: string; base: string; head: string; loadAtStart: number };
};

describe('the committed paired results', () => {
  const file = join(ROOT, 'bench', 'ts-codec-paired-results.json');
  const passes = existsSync(file)
    ? (JSON.parse(readFileSync(file, 'utf8')) as { passes: Pass[] }).passes
    : null;

  it.skipIf(passes === null)(
    'keeps every pass, numbered from 1 without a gap, each with its time and commits',
    () => {
      expect(passes!.length).toBeGreaterThan(0);
      passes!.forEach((p, i) => {
        expect(p.pass, `pass ${i + 1}`).toBe(i + 1);
        expect(Number.isNaN(Date.parse(p.started))).toBe(false);
        expect(p.environment.base).toMatch(/^[0-9a-f]{40}$/);
        expect(p.environment.head).toMatch(/^[0-9a-f]{40}$/);
      });
    },
  );

  it.skipIf(passes === null)(
    'recomputes every median, quartile and verdict of every pass from its rounds',
    () => {
      for (const doc of passes!) {
        const cells = [...doc.reads, ...doc.write, doc.import.moduleLoadMs];
        expect(cells.length).toBeGreaterThan(10);
        for (const c of cells) {
          const name = `pass ${doc.pass} ${c.dataset ?? 'import'} ${c.op ?? ''}`;
          expect(c.rounds.length, name).toBeGreaterThanOrEqual(codec.MIN_ROUNDS);
          const s = codec.summarise(c.rounds, 0);
          expect(c.typescriptVsNative, name).toBe(s.typescriptVsNative);
          expect(c.controlVsNative, name).toBe(s.controlVsNative);
          expect(c.verdict, name).toBe(
            pairedVerdictOf(s.typescriptVsNative, s.controlVsNative, s.controlQuartiles),
          );
        }
        for (const c of [...doc.reads, ...doc.write]) expect(c.answersAgree).toBe(true);
        expect(doc.verdict).toBe(worstPaired([...doc.reads, ...doc.write].map((c) => c.verdict)));
      }
    },
  );

  it.skipIf(passes === null)('was taken on a clean tree at full strength', () => {
    for (const doc of passes!) {
      expect(doc.environment.tree).toBe('clean');
      expect(doc.environment.rounds).toBeGreaterThanOrEqual(codec.MIN_ROUNDS);
    }
  });

  it.skipIf(passes === null)(
    're-took every inconclusive pass, and a conclusive slower blocks the merge',
    () => {
      const cells = (p: Pass): Cell[] => [...p.reads, ...p.write];
      passes!.forEach((p, i) => {
        const last = i === passes!.length - 1;
        if (cells(p).some((c) => c.verdict === rule.INCONCLUSIVE) && !last) {
          expect(passes![i + 1], `pass ${p.pass} was inconclusive`).toBeDefined();
        }
      });
      const final = passes![passes!.length - 1]!;
      expect(
        cells(final)
          .filter((c) => c.verdict === rule.SLOWER)
          .map((c) => `${c.dataset} ${c.op}`),
        'a conclusive slower in the last pass',
      ).toEqual([]);
    },
  );
});
