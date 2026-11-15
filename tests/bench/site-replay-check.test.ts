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

// Replace a value inside the provenance sentence itself (the text after "checked into the repository ("), so a value
// that also appears earlier on the page cannot make the case mutate the wrong place.
function editSentence(dir: string, from: string | RegExp, to: string): void {
  const p = join(dir, 'site/demo.html');
  const html = readFileSync(p, 'utf8');
  const at = html.indexOf('checked into the repository (');
  expect(at).toBeGreaterThan(-1);
  const head = html.slice(0, at);
  const tail = html.slice(at);
  const after = tail.replace(from, to);
  expect(after).not.toBe(tail); // the mutation must land
  writeFileSync(p, head + after);
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
      editSentence(d, from, to);
      const r = check(d);
      expect(r.status).toBe(1);
      expect(r.err).toContain(`demo.html states ${name} `);
    });
  }

  it('does not let a correct copy elsewhere on the page stand in for a stale line', () => {
    const d = copy();
    const p = join(d, 'site/demo.html');
    const html = readFileSync(p, 'utf8');
    const line = /\(([^()]*Node v[\d.]+[^()]*)\)/.exec(html)![0];
    editSentence(d, record.measuredOn, '2000-01-01');
    writeFileSync(
      p,
      readFileSync(p, 'utf8').replace('</body>', `<p>The run (${line.slice(1)}</p></body>`),
    );
    const r = check(d);
    expect(r.status).toBe(1);
    expect(r.err).toContain('demo.html states day ');
  });

  it('fails when the page has a second copy of the provenance sentence, or none', () => {
    const d = copy();
    const p = join(d, 'site/demo.html');
    const html = readFileSync(p, 'utf8');
    writeFileSync(
      p,
      html.replace('</body>', '<p>checked into the repository (a second)</p></body>'),
    );
    const two = check(d);
    expect(two.status).toBe(1);
    expect(two.err).toContain('2 sentences that open with');
    writeFileSync(p, html.replace('checked into the repository (', 'checked into the repo ('));
    const none = check(d);
    expect(none.status).toBe(1);
    expect(none.err).toContain('0 sentences that open with');
  });

  it('fails when the record drops a field the page states', () => {
    const d = copy();
    const p = join(d, 'bench/scale-results.json');
    const r = JSON.parse(readFileSync(p, 'utf8')) as { env: { cpu?: string } };
    delete r.env.cpu;
    writeFileSync(p, JSON.stringify(r, null, 2) + '\n');
    const out = check(d);
    expect(out.status).toBe(1);
    expect(out.err).toContain('the record carries no machine');
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
      expect(r.err).toContain(
        name === 'zero' ? 'is 0, not a positive integer' : 'DEFAULT_TAIL_BYTES is not declared',
      );
      expect(r.err).toContain(FORMAT);
    });
  }

  it('fails loudly, naming the file, when the tail constant is gone', () => {
    const d = copy();
    edit(d, FORMAT, 'DEFAULT_TAIL_BYTES =', 'DEFAULT_TAIL =');
    const r = check(d);
    expect(r.status).toBe(1);
    expect(r.err).toContain('DEFAULT_TAIL_BYTES is not declared');
    expect(r.err).toContain(FORMAT);
  });

  it('counts a smaller tail per object, so a changed tail changes the figure it allows', () => {
    const d = copy();
    edit(d, FORMAT, '256 * 1024', '128 * 1024');
    const r = check(d);
    expect(r.status).toBe(1);
    expect(r.err).toContain('262,144'); // the page states the 256 KiB tail, which a 128 KiB tail does not allow
  });

  it('counts the whole object where it is smaller than a tail', () => {
    const fixture = JSON.parse(readFileSync(join(ROOT, 'bench/scale-results.json'), 'utf8')) as {
      intersect: { objectBytes: { A: number; B: number }; storageBytesRead: number };
    };
    const { objectBytes, storageBytesRead } = fixture.intersect;
    const tail = 256 * 1024;
    const smaller = 100_000;
    const g = (n: number): string => n.toLocaleString('en-US');
    const swap = (html: string, from: number, to: number): string =>
      html.split(g(from)).join(g(to));
    const rebuilt = (total: number): string => {
      const d = copy();
      const p = join(d, 'bench/scale-results.json');
      const r = JSON.parse(readFileSync(p, 'utf8')) as typeof fixture;
      r.intersect.objectBytes.A = smaller;
      writeFileSync(p, JSON.stringify(r, null, 2) + '\n');
      const page = join(d, 'site/demo.html');
      let html = readFileSync(page, 'utf8');
      html = swap(html, objectBytes.A, smaller);
      html = swap(html, storageBytesRead + 2 * tail, total);
      writeFileSync(page, html);
      return d;
    };
    // The page states the total read with A counted whole (under a tail), which the check allows ...
    expect(check(rebuilt(storageBytesRead + smaller + tail)).status).toBe(0);
    // ... and not the total a flat two tails would give.
    const flat = check(rebuilt(storageBytesRead + 2 * tail));
    expect(flat.status).toBe(1);
  });
});
