import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Guards `scripts/leak-scan-tarballs.cjs --from <dir>`, the mode the release workflow uses: the tarballs are
// packed once, those very files are scanned, and the same files are uploaded and published. The scan must
// therefore refuse a directory that is not exactly one tarball per publishable package (a missing one would
// be published unscanned if it came from elsewhere; an extra one is bytes nobody checked), and must still find
// a leak inside a tarball it is given. Each defect is planted below, and the good set is the look-alike that
// must stay quiet.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = join(ROOT, 'scripts', 'leak-scan-tarballs.cjs');

const names = readdirSync(join(ROOT, 'packages'))
  .map(
    (d) =>
      JSON.parse(readFileSync(join(ROOT, 'packages', d, 'package.json'), 'utf8')) as {
        name: string;
        private?: boolean;
      },
  )
  .filter((m) => m.private !== true)
  .map((m) => m.name);

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** Write one tarball for a package named `name` into `dir`, with `extra` as the content of one more file. */
function pack(dir: string, file: string, name: string, extra = 'hello\n'): void {
  const tree = mkdtempSync(join(tmpdir(), 'cbm-from-tree-'));
  dirs.push(tree);
  mkdirSync(join(tree, 'package'));
  writeFileSync(
    join(tree, 'package', 'package.json'),
    JSON.stringify({
      name,
      version: '1.2.3',
      exports: { './package.json': './package.json' },
    }),
  );
  writeFileSync(join(tree, 'package', 'README.md'), extra);
  const r = spawnSync('tar', ['-czf', join(dir, file), '-C', tree, 'package']);
  if (r.status !== 0) throw new Error(`tar failed: ${String(r.stderr)}`);
}

function setOf(skip: string[] = [], extraPlanted?: { name: string; content: string }): string {
  const dir = mkdtempSync(join(tmpdir(), 'cbm-from-dir-'));
  dirs.push(dir);
  for (const name of names) {
    if (skip.includes(name)) continue;
    const content = extraPlanted?.name === name ? extraPlanted.content : undefined;
    pack(dir, `${name.replace(/[^a-z0-9]+/gi, '-')}-1.2.3.tgz`, name, content);
  }
  return dir;
}

function scan(dir: string): { status: number | null; out: string } {
  const r = spawnSync(process.execPath, [SCRIPT, '--from', dir], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, LEAK_SCAN_EXTRA: '' },
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

describe('leak-scan-tarballs --from', () => {
  it('has the six publishable packages to work with', () => {
    expect(names.length).toBe(6);
  });

  it('passes a directory with exactly one clean tarball per package', () => {
    const r = scan(setOf());
    expect(r.out).toContain('all package tarballs clean');
    expect(r.status).toBe(0);
  });

  it('fails when a package has no tarball', () => {
    const r = scan(setOf([names[0] as string]));
    expect(r.status).not.toBe(0);
    expect(r.out).toContain(`missing [${names[0]}]`);
  });

  it('fails on a tarball that is not a publishable package', () => {
    const dir = setOf();
    pack(dir, 'stranger-1.2.3.tgz', '@cloudbitmaps/not-in-the-workspace');
    const r = scan(dir);
    expect(r.status).not.toBe(0);
    expect(r.out).toContain('extra [@cloudbitmaps/not-in-the-workspace]');
  });

  it('fails on a second tarball of the same package', () => {
    const dir = setOf();
    pack(dir, 'second-copy.tgz', names[0] as string);
    const r = scan(dir);
    expect(r.status).not.toBe(0);
    expect(r.out).toContain(`two tarballs for ${names[0]}`);
  });

  it('fails on a directory that does not exist, instead of scanning nothing', () => {
    const r = scan(join(tmpdir(), 'cbm-from-does-not-exist'));
    expect(r.status).not.toBe(0);
    expect(r.out).toContain('--from needs an existing directory');
  });

  it('still finds a leak inside a tarball it was given', () => {
    const planted = `${'-----BEGIN RSA '}${'PRIVATE KEY-----'}\nMIIEow==\n`;
    const r = scan(setOf([], { name: names[1] as string, content: planted }));
    expect(r.status).not.toBe(0);
    expect(r.out).toContain('FAILED');
  });
});
