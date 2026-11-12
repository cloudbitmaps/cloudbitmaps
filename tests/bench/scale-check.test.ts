import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

// `pnpm bench:scale:check` re-renders the at-scale table, footnote included, from the committed results and compares it
// with both pages. Each case plants a defect in a copy of the files it reads and expects the check to fail; the
// unmodified copy must pass. The footnote prints the run's commit, day and load average, so a page quoting a different
// one is what the provenance cases plant.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const FILES = ['bench/scale-results.json', 'docs/benchmarks.md', 'site/benchmarks.html'];
const PAGES = ['docs/benchmarks.md', 'site/benchmarks.html'];
const PROVENANCE =
  /commit [0-9a-f]{8}, \d{4}-\d{2}-\d{2}, load [\d.]+ at the start and [\d.]+ at the end/;
type Results = {
  measuredOn?: string;
  env: { commit?: string; loadavgStart?: number[]; loadavgEnd?: number[] };
};
const dirs: string[] = [];

function copy(): string {
  const dir = mkdtempSync(join(tmpdir(), 'scale-check-'));
  dirs.push(dir);
  for (const f of FILES) {
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    cpSync(join(ROOT, f), join(dir, f));
  }
  return dir;
}

function check(dir: string): { status: number | null; err: string } {
  const r = spawnSync(process.execPath, [join(ROOT, 'bench/scale.cjs')], {
    env: { ...process.env, SCALE_TASK: 'check', SCALE_ROOT: dir },
    encoding: 'utf8',
  });
  return { status: r.status, err: r.stderr };
}

function edit(dir: string, file: string, from: RegExp, to: (m: string) => string): void {
  const p = join(dir, file);
  const before = readFileSync(p, 'utf8');
  const after = before.replace(from, to);
  expect(after).not.toBe(before); // the mutation must land
  writeFileSync(p, after);
}

function results(dir: string, change: (r: Results) => void): void {
  const p = join(dir, 'bench/scale-results.json');
  const r = JSON.parse(readFileSync(p, 'utf8')) as Results;
  change(r);
  writeFileSync(p, JSON.stringify(r, null, 2) + '\n');
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('bench:scale:check', () => {
  it('passes on the committed files', () => {
    expect(check(copy()).status).toBe(0);
  });

  it('quotes the record on both pages, in the footnote', () => {
    const d = copy();
    for (const page of PAGES) {
      expect(readFileSync(join(d, page), 'utf8')).toMatch(PROVENANCE);
    }
  });

  for (const page of PAGES) {
    it(`fails when ${page} quotes another commit`, () => {
      const d = copy();
      edit(d, page, /commit [0-9a-f]{8}/, () => 'commit 00000000');
      expect(check(d).status).toBe(1);
    });

    it(`fails when ${page} quotes another day`, () => {
      const d = copy();
      edit(d, page, PROVENANCE, (m) => m.replace(/\d{4}-\d{2}-\d{2}/, '2000-01-01'));
      expect(check(d).status).toBe(1);
    });

    it(`fails when ${page} quotes another load at the start`, () => {
      const d = copy();
      edit(d, page, PROVENANCE, (m) => m.replace(/load [\d.]+ at/, 'load 0.1 at'));
      expect(check(d).status).toBe(1);
    });

    it(`fails when ${page} quotes another load at the end`, () => {
      const d = copy();
      edit(d, page, PROVENANCE, (m) => m.replace(/and [\d.]+ at the end/, 'and 0.1 at the end'));
      expect(check(d).status).toBe(1);
    });
  }

  it('fails when the record changes its commit, day or load and the pages are not re-rendered', () => {
    for (const change of [
      (r: Results) => (r.env.commit = '0'.repeat(40)),
      (r: Results) => (r.measuredOn = '2000-01-01'),
      (r: Results) => (r.env.loadavgStart = [0.1, 0, 0]),
      (r: Results) => (r.env.loadavgEnd = [0.1, 0, 0]),
    ]) {
      const d = copy();
      results(d, change);
      expect(check(d).status).toBe(1);
    }
  });

  it('fails when the record marks the tree dirty and the pages do not say so', () => {
    const d = copy();
    results(d, (r) => (r.env.commit = `${r.env.commit ?? ''}-dirty`));
    expect(check(d).status).toBe(1);
  });

  it('fails, rather than passing, on a record without the commit, day or load', () => {
    for (const drop of [
      (r: Results) => delete r.env.commit,
      (r: Results) => delete r.measuredOn,
      (r: Results) => delete r.env.loadavgEnd,
    ]) {
      const d = copy();
      results(d, drop);
      expect(check(d).status).toBe(1);
    }
  });
});
