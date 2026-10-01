import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

// `pnpm bench:event-loop:check` holds the guide and two source comments to the committed event-loop results. Each case
// plants a defect in a copy of the files it reads and expects the check to fail; the unmodified copy must pass.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const FILES = [
  'bench/event-loop-results.json',
  'docs/guide/getting-started.md',
  'packages/core/src/core/cooperative.ts',
  'packages/roaring/src/system-clock.ts',
];
const dirs: string[] = [];

function copy(): string {
  const dir = mkdtempSync(join(tmpdir(), 'event-loop-check-'));
  dirs.push(dir);
  for (const f of FILES) {
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    cpSync(join(ROOT, f), join(dir, f));
  }
  return dir;
}

function check(dir: string): { status: number | null; err: string } {
  const r = spawnSync(process.execPath, [join(ROOT, 'bench/event-loop.cjs'), '--check'], {
    env: { ...process.env, EVENT_LOOP_ROOT: dir },
    encoding: 'utf8',
  });
  return { status: r.status, err: r.stderr };
}

function edit(
  dir: string,
  file: string,
  from: string | RegExp,
  to: string | ((m: string) => string),
): void {
  const p = join(dir, file);
  const before = readFileSync(p, 'utf8');
  const after = before.replace(from, to as string);
  expect(after).not.toBe(before); // the mutation must land
  writeFileSync(p, after);
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('bench:event-loop:check', () => {
  it('passes on the committed files', () => {
    expect(check(copy()).status).toBe(0);
  });

  it('fails on a guide figure that is not the results', () => {
    const d = copy();
    edit(d, 'docs/guide/getting-started.md', /~\d+ ms/, '~1 ms');
    expect(check(d).status).toBe(1);
  });

  it('fails on a results figure that the guide does not quote', () => {
    const d = copy();
    const p = join(d, 'bench/event-loop-results.json');
    const r = JSON.parse(readFileSync(p, 'utf8'));
    r.yielded.stallMs.worst += 100;
    writeFileSync(p, JSON.stringify(r));
    expect(check(d).status).toBe(1);
  });

  it('fails on a source comment that does not match, in either place cooperative.ts quotes the run', () => {
    for (const re of [/\*\*\d+ ms\s+\*?\s*wall/, /\d+ ms wall \/ \d+ ms blocked/]) {
      const d = copy();
      edit(d, 'packages/core/src/core/cooperative.ts', re, (m) => m.replace(/\d+/, '1'));
      expect(check(d).status).toBe(1);
    }
    const d = copy();
    edit(d, 'packages/roaring/src/system-clock.ts', /figures are \d+ ms/, 'figures are 1 ms');
    expect(check(d).status).toBe(1);
  });

  it('fails, rather than passing vacuously, when the guide section is gone', () => {
    const d = copy();
    edit(
      d,
      'docs/guide/getting-started.md',
      '## What blocks the event loop, and where to run it',
      '## Elsewhere',
    );
    expect(check(d).status).toBe(1);
  });

  it('fails when the guide drops the load average the results record', () => {
    const d = copy();
    edit(d, 'docs/guide/getting-started.md', /load average was about \d+/, 'load average was low');
    expect(check(d).status).toBe(1);
  });
});
