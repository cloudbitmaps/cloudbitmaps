import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

// `pnpm site:replay:check` holds site/demo.html to bench/scale-results.json, and reads the reader's tail size from the
// format source. Each case plants a defect in a copy of the files the script reads and expects it to fail; the
// unmodified copy must pass. The script resolves its root from its own location, so the copy carries the script too.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const FORMAT = 'packages/core/src/core/crbm/format.ts';
const FILES = [
  'scripts/site-replay.cjs',
  'bench/scale-results.json',
  'bench/lib/remove-all.cjs',
  'bench/lib/tail-bytes.cjs',
  'site/demo.html',
  'packages/core/src/core/bit-route.ts',
  FORMAT,
];
const dirs: string[] = [];

function copy(): string {
  const dir = mkdtempSync(join(tmpdir(), 'site-replay-'));
  dirs.push(dir);
  for (const f of FILES) {
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    cpSync(join(ROOT, f), join(dir, f));
  }
  return dir;
}

function check(dir: string): { status: number | null; err: string } {
  const r = spawnSync(process.execPath, [join(dir, 'scripts/site-replay.cjs'), '--check'], {
    encoding: 'utf8',
  });
  return { status: r.status, err: r.stderr };
}

function edit(dir: string, file: string, from: string | RegExp, to: string): void {
  const p = join(dir, file);
  const before = readFileSync(p, 'utf8');
  const after = before.replace(from, to);
  expect(after).not.toBe(before); // the mutation must land
  writeFileSync(p, after);
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('site:replay:check', () => {
  it('passes on the committed files', () => {
    expect(check(copy()).status).toBe(0);
  });

  const record = JSON.parse(readFileSync(join(ROOT, 'bench/scale-results.json'), 'utf8')) as {
    measuredOn: string;
    env: { cpu: string; node: string; commit: string };
  };
  for (const [name, from, to] of [
    ['machine', record.env.cpu, 'Apple M9 Max'],
    ['Node version', `Node ${record.env.node}`, 'Node v1.0.0'],
    ['commit', `commit ${record.env.commit.slice(0, 8)}`, 'commit 00000000'],
    ['day', record.measuredOn, '2000-01-01'],
    ['load at the start', /1-minute load\s+[\d.]+ at the start/, '1-minute load 0.1 at the start'],
    ['load at the end', /and [\d.]+ at the end/, 'and 0.1 at the end'],
  ] as const) {
    it(`fails when the demo's provenance line states another ${name}`, () => {
      const d = copy();
      edit(d, 'site/demo.html', from, to);
      const r = check(d);
      expect(r.status).toBe(1);
      expect(r.err).toContain(name);
    });
  }

  it('fails when the record drops a field the page states', () => {
    const d = copy();
    const p = join(d, 'bench/scale-results.json');
    const r = JSON.parse(readFileSync(p, 'utf8')) as { env: { cpu?: string } };
    delete r.env.cpu;
    writeFileSync(p, JSON.stringify(r, null, 2) + '\n');
    const out = check(d);
    expect(out.status).toBe(1);
    expect(out.err).toContain('machine');
  });

  it('reads the tail size from the format source, and accepts an equal restatement', () => {
    const d = copy();
    edit(d, FORMAT, '256 * 1024', '262144');
    expect(check(d).status).toBe(0);
  });

  for (const [name, to] of [
    ['zero', '0'],
    ['not an integer product', '1.5 * 1024'],
  ] as const) {
    it(`fails loudly, naming the file, when the tail constant is ${name}`, () => {
      const d = copy();
      edit(d, FORMAT, '256 * 1024', to);
      const r = check(d);
      expect(r.status).toBe(1);
      expect(r.err).toContain(FORMAT);
    });
  }

  it('fails loudly, naming the file, when the tail constant is gone', () => {
    const d = copy();
    edit(d, FORMAT, 'DEFAULT_TAIL_BYTES =', 'DEFAULT_TAIL =');
    const r = check(d);
    expect(r.status).toBe(1);
    expect(r.err).toContain(FORMAT);
  });

  it('counts a smaller tail per object, so a changed tail changes the figure it allows', () => {
    const d = copy();
    edit(d, FORMAT, '256 * 1024', '128 * 1024');
    const r = check(d);
    expect(r.status).toBe(1); // the page states 262,144 and the total read under a 256 KiB tail
  });
});
