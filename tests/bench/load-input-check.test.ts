import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import roaring from 'roaring';
import { afterEach, describe, expect, it } from 'vitest';

// `pnpm bench:load-input:check` holds the loading guide's "How fast a bitmap loads" figures to the committed
// results, and, while none are recorded, holds the guide to quoting none. Each case plants a defect in a copy of
// the files it reads and expects the check to fail; the unmodified copy must pass. The bench's sets are pure and
// seeded, so the last cases hold them to the container layouts the bench's falsifiable figure depends on.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const BENCH = join(ROOT, 'bench/load-input.cjs');
const GUIDE = 'docs/guide/loading.md';
const RESULTS = 'bench/load-input-results.json';
const { shapeIds, publishedFigures, SHAPES, VARIANTS } = createRequire(import.meta.url)(BENCH) as {
  shapeIds: (shape: string) => Uint32Array;
  publishedFigures: (results: unknown) => Record<string, string>;
  SHAPES: string[];
  VARIANTS: string[];
};
const dirs: string[] = [];

function copy(): string {
  const dir = mkdtempSync(join(tmpdir(), 'load-input-check-'));
  dirs.push(dir);
  mkdirSync(join(dir, 'docs/guide'), { recursive: true });
  mkdirSync(join(dir, 'bench'), { recursive: true });
  cpSync(join(ROOT, GUIDE), join(dir, GUIDE));
  return dir;
}

function check(dir: string): { status: number | null; err: string } {
  const r = spawnSync(process.execPath, [BENCH, '--check'], {
    env: { ...process.env, LOAD_INPUT_ROOT: dir },
    encoding: 'utf8',
  });
  return { status: r.status, err: r.stderr };
}

function section(dir: string): string {
  const guide = readFileSync(join(dir, GUIDE), 'utf8');
  const start = guide.indexOf('<!-- load-input:start -->');
  return guide.slice(start, guide.indexOf('<!-- load-input:end -->', start));
}

function replaceSection(dir: string, body: string): void {
  const p = join(dir, GUIDE);
  const guide = readFileSync(p, 'utf8');
  const old = section(dir);
  expect(old.length).toBeGreaterThan(0);
  writeFileSync(p, guide.replace(old, `<!-- load-input:start -->\n${body}\n`));
}

/** A results file of the shape the bench writes, with a distinct figure for every published slot. */
function plantedResults(): Record<string, unknown> {
  let n = 100;
  const variant = () => ({
    trials: 5,
    wallMs: { median: n++, worst: n + 50 },
    stallMs: { median: 3, worst: 7 },
    nsPerMember: 1,
    samples: [],
  });
  const shapes = Object.fromEntries(
    SHAPES.map((s) => [
      s,
      {
        members: 1,
        chunkCount: 1,
        crbmBytes: 1,
        containers: {},
        identicalBytes: true,
        ...Object.fromEntries(VARIANTS.map((v) => [v, variant()])),
      },
    ]),
  );
  return {
    measuredOn: '2026-10-09',
    env: { cpu: 'Planted CPU', loadavgStart: [1, 1, 1] },
    trials: 5,
    shapes,
  };
}

function withResults(dir: string, results: Record<string, unknown>, body?: string): void {
  writeFileSync(join(dir, RESULTS), JSON.stringify(results));
  const figures = Object.values(publishedFigures(results)).join(', ');
  replaceSection(dir, body ?? `Planted CPU, 2026-10-09, 5 runs: ${figures}.`);
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('bench:load-input:check, before anything is measured', () => {
  it('passes on the committed files', () => {
    expect(check(copy()).status).toBe(0);
  });

  it('fails on a figure the guide quotes with no results file to give it', () => {
    const d = copy();
    replaceSection(d, 'These figures have not been measured yet. A 12M load takes 5 ms.');
    expect(check(d).status).toBe(1);
  });

  it.each([
    'takes 270ms',
    'takes 0.27 s',
    'is 4x faster',
    'is 4.2× faster',
    'costs 22 ns per member',
    'costs 3 µs per container',
    'takes about 200 milliseconds',
    'takes 1.5 seconds',
  ])('fails on a figure in any unit or ratio form: "%s"', (figure) => {
    const d = copy();
    replaceSection(d, `These figures have not been measured yet. A 12M load ${figure}.`);
    expect(check(d).status).toBe(1);
  });

  it('passes the counts, sizes and shares a section legitimately states', () => {
    const d = copy();
    replaceSection(
      d,
      'These figures have not been measured yet. Five sets: a 12M-member set, 245 chunks at 10 % and 90 %, ' +
        '1,048,576 ids, about 28 MB, 14.4M members, 5 runs, 65,536 containers.',
    );
    expect(check(d)).toMatchObject({ status: 0 });
  });

  it('fails when the guide stops saying the figures are unmeasured', () => {
    const d = copy();
    replaceSection(d, 'A load from a bitmap is fast.');
    expect(check(d).status).toBe(1);
  });

  it('fails when the section is gone', () => {
    const d = copy();
    const p = join(d, GUIDE);
    writeFileSync(p, readFileSync(p, 'utf8').replace('<!-- load-input:start -->', ''));
    expect(check(d).status).toBe(1);
  });
});

describe('bench:load-input:check, once results are recorded', () => {
  it('passes when the guide quotes exactly the published figures', () => {
    const d = copy();
    withResults(d, plantedResults());
    expect(check(d)).toMatchObject({ status: 0 });
  });

  it('fails on a guide figure that is not the results', () => {
    const d = copy();
    withResults(d, plantedResults());
    const p = join(d, GUIDE);
    writeFileSync(p, readFileSync(p, 'utf8').replace(/\b100 ms\b/, '99 ms'));
    expect(check(d).status).toBe(1);
  });

  it('fails when the results record an input writing other bytes', () => {
    const d = copy();
    const results = plantedResults();
    (results.shapes as Record<string, { identicalBytes: boolean }>).runs!.identicalBytes = false;
    withResults(d, results);
    expect(check(d).status).toBe(1);
  });

  it('fails on fewer than five trials, and on a guide that does not name the machine', () => {
    const d = copy();
    withResults(d, { ...plantedResults(), trials: 3 });
    expect(check(d).status).toBe(1);
    const e = copy();
    const results = plantedResults();
    withResults(
      e,
      results,
      `2026-10-09, 5 runs: ${Object.values(publishedFigures(results)).join(', ')}.`,
    );
    expect(check(e).status).toBe(1);
  });
});

describe("the bench's sets have the layouts its figures depend on", () => {
  const { RoaringBitmap32 } = roaring;
  const stats = (shape: string) => {
    const ids = shapeIds(shape);
    let ascending = true;
    for (let i = 1; i < ids.length; i++) if (ids[i]! <= ids[i - 1]!) ascending = false;
    expect(ascending).toBe(true);
    return { members: ids.length, ...new RoaringBitmap32(ids).statistics() };
  };

  it('density-10 and density-90 are the same 245 bitset containers, nine times the members apart', () => {
    const low = stats('density-10');
    const high = stats('density-90');
    expect([low.containers, low.bitsetContainers]).toEqual([245, 245]);
    expect([high.containers, high.bitsetContainers]).toEqual([245, 245]);
    expect(high.members / low.members).toBeCloseTo(9, 1);
  });

  it('sparse is 12,058,624 members in every one of the 65,536 chunks, all arrays', () => {
    const s = stats('sparse');
    expect([s.members, s.containers, s.arrayContainers]).toEqual([12_058_624, 65_536, 65_536]);
  });
});
