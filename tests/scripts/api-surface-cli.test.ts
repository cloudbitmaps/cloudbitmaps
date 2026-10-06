import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// The command line of the public-signature gate, run on a throwaway git repository with fixture packages (a
// manifest, declaration files standing in for a build, a committed snapshot), so nothing here needs `packages/*/dist`.
const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), '../../scripts/api-surface.cjs');

let repo = '';
const put = (rel: string, text: string): void => {
  mkdirSync(dirname(join(repo, rel)), { recursive: true });
  writeFileSync(join(repo, rel), text);
};
const git = (...args: string[]): string =>
  execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const commit = (): void => {
  git('add', '-A');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'x');
};
interface Run {
  status: number | null;
  out: string;
  err: string;
}
const run = (args: string[], env: Record<string, string> = {}): Run => {
  const r = spawnSync('node', [SCRIPT, ...args, '--root', repo], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  return { status: r.status, out: r.stdout, err: r.stderr };
};
const snapshot = (): Record<string, string> =>
  (
    JSON.parse(readFileSync(join(repo, 'api-surface/surface.json'), 'utf8')) as {
      entries: Record<string, string>;
    }
  ).entries;

const MAIN = `export declare function keep(a: string): string;
export declare function drop(a: number): number;
export declare function widen(a: string): void;
export declare const fixed: 'x';
export declare const inferred = 5;
export interface Shape {
  /** a comment inside */
  a: string; // trailing
  b: number;
}
export declare class Thing /* header comment */ extends Base {
  get size(): number;
}
declare class Base {}
`;
const EXTRA = `export declare function extra(x: boolean): void;\n`;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'api-surface-cli-'));
  git('init', '-q');
  put(
    'packages/a/package.json',
    JSON.stringify({
      name: '@fx/a',
      exports: {
        '.': { import: { types: './dist/index.d.ts', default: './dist/index.js' } },
        './extra': { types: './dist/extra.d.ts', default: './dist/extra.js' },
        './package.json': './package.json',
      },
    }),
  );
  put('packages/a/dist/index.d.ts', MAIN);
  put('packages/a/dist/extra.d.ts', EXTRA);
  put('api-surface/allowed.json', '[]\n');
  expect(run(['--write']).status).toBe(0);
  commit();
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

const withMain = (edit: (s: string) => string): void =>
  put('packages/a/dist/index.d.ts', edit(MAIN));

describe('--write and --check', () => {
  it('writes every entry point, a nested `types` condition and a subpath included, and passes on no change', () => {
    const entries = snapshot();
    expect(entries['@fx/a keep']).toBe('function keep(a: string): string;');
    expect(entries['@fx/a/extra extra']).toBe('function extra(x: boolean): void;');
    const r = run(['--check']);
    expect(r.status).toBe(0);
    expect(r.out).toContain('is the committed snapshot');
  });

  it('prints types the way the declarations say, comments stripped', () => {
    const e = snapshot();
    expect(e['@fx/a fixed']).toBe("const fixed: 'x'");
    expect(e['@fx/a inferred']).toBe('const inferred: 5');
    expect(e['@fx/a Shape.a']).toBe('a: string;');
    expect(e['@fx/a Thing']).toBe('class Thing extends Base');
    expect(JSON.stringify(e)).not.toMatch(/comment|trailing/);
  });

  it('fails an addition, naming it as added, with the new text', () => {
    withMain((s) => `${s}export declare function fresh(): void;\n`);
    const r = run(['--check']);
    expect(r.status).toBe(1);
    expect(r.err).toMatch(/added: +@fx\/a fresh\n\s+now: function fresh\(\): void;/);
    expect(r.err).not.toContain('removed:');
    expect(r.err).toContain('pnpm api:surface`');
    expect(r.err).not.toContain('pnpm build && pnpm api:surface');
  });

  it('fails a removal as removed and a change as changed, with was and now the right way round', () => {
    withMain((s) =>
      s
        .replace('export declare function drop(a: number): number;\n', '')
        .replace('widen(a: string)', 'widen(a: string | null)'),
    );
    const r = run(['--check']);
    expect(r.status).toBe(1);
    expect(r.err).toMatch(/removed: +@fx\/a drop\n\s+was: function drop\(a: number\): number;/);
    expect(r.err).toMatch(
      /changed: +@fx\/a widen\n\s+was: function widen\(a: string\): void;\n\s+now: function widen\(a: string \| null\): void;/,
    );
  });

  it('fails closed on an exports entry whose types it cannot resolve, and names it', () => {
    put(
      'packages/a/package.json',
      JSON.stringify({ name: '@fx/a', exports: { '.': { default: './dist/index.js' } } }),
    );
    const r = run(['--check']);
    expect(r.status).not.toBe(0);
    expect(r.err).toContain('@fx/a exports "."');
  });

  it('fails on a declaration file that is not built', () => {
    rmSync(join(repo, 'packages/a/dist/extra.d.ts'));
    const r = run(['--check']);
    expect(r.status).not.toBe(0);
    expect(r.err).toContain('pnpm build');
  });
});

describe('--against', () => {
  it('passes with no change and with an addition', () => {
    expect(run(['--against', 'HEAD']).status).toBe(0);
    withMain((s) => `${s}export declare function fresh(): void;\n`);
    expect(run(['--write']).status).toBe(0);
    const r = run(['--against', 'HEAD']);
    expect(r.status).toBe(0);
    expect(r.out).toContain('no entry present at HEAD is removed or changed');
  });

  it('fails a removal and a change, and says nothing of an addition', () => {
    withMain(
      (s) =>
        `${s.replace('export declare function drop(a: number): number;\n', '').replace('widen(a: string)', 'widen(a: number)')}export declare function fresh(): void;\n`,
    );
    run(['--write']);
    const r = run(['--against', 'HEAD']);
    expect(r.status).toBe(1);
    expect(r.err).toMatch(/removed: @fx\/a drop\n\s+was: function drop\(a: number\): number;/);
    expect(r.err).toMatch(
      /changed: @fx\/a widen\n\s+was: function widen\(a: string\): void;\n\s+now: function widen\(a: number\): void;/,
    );
    expect(r.err).not.toContain('fresh');
  });

  const breakIt = (): void => {
    withMain((s) => s.replace('export declare function drop(a: number): number;\n', ''));
    run(['--write']);
  };

  it('honours a row added in this change, and a row with no reason is refused', () => {
    breakIt();
    put('api-surface/allowed.json', JSON.stringify([{ entry: '@fx/a drop', reason: 'replaced' }]));
    expect(run(['--against', 'HEAD']).status).toBe(0);
    put('api-surface/allowed.json', JSON.stringify([{ entry: '@fx/a drop', reason: ' ' }]));
    const r = run(['--against', 'HEAD']);
    expect(r.status).toBe(1);
    expect(r.err).toContain('has no reason');
    expect(r.err).toContain('removed: @fx/a drop');
  });

  it('ignores a row the base already has', () => {
    put(
      'api-surface/allowed.json',
      JSON.stringify([{ entry: '@fx/a drop', reason: 'earlier change' }]),
    );
    commit();
    breakIt();
    const r = run(['--against', 'HEAD']);
    expect(r.status).toBe(1);
    expect(r.err).toContain('removed: @fx/a drop');
    expect(r.err).toContain('a row the base already has excuses nothing');
  });

  it('refuses a row that is too wide', () => {
    breakIt();
    put('api-surface/allowed.json', JSON.stringify([{ entry: '*', reason: 'everything' }]));
    const r = run(['--against', 'HEAD']);
    expect(r.status).toBe(1);
    expect(r.err).toContain('too wide');
  });

  it('passes with a note when the ref has no snapshot, and fails on a ref that is not a commit', () => {
    git('rm', '-q', '-r', '--cached', 'api-surface');
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'no snapshot');
    const none = run(['--against', 'HEAD']);
    expect(none.status).toBe(0);
    expect(none.out).toContain('nothing to compare against');
    const bad = run(['--against', 'no-such-ref']);
    expect(bad.status).toBe(1);
    expect(bad.err).toContain('not a commit');
  });

  it('fails, rather than reporting no snapshot, when git cannot read the path at the ref', () => {
    const tree = git('rev-parse', 'HEAD:api-surface').trim();
    rmSync(join(repo, '.git/objects', tree.slice(0, 2), tree.slice(2)));
    const r = run(['--against', 'HEAD']);
    expect(r.status).toBe(1);
    expect(r.out).not.toContain('nothing to compare against');
  });

  it('needs no TypeScript: it reads committed files only', () => {
    const block = join(repo, 'block.cjs');
    writeFileSync(
      block,
      `const M = require('node:module'); const load = M._load;
       M._load = function (r, ...a) { if (r === 'typescript') throw new Error('typescript was loaded'); return load.call(this, r, ...a); };`,
    );
    const r = run(['--against', 'HEAD'], { NODE_OPTIONS: `--require=${block}` });
    expect(r.status).toBe(0);
    expect(run(['--check'], { NODE_OPTIONS: `--require=${block}` }).status).not.toBe(0);
  });
});

describe('types a public signature names that no entry exports', () => {
  const HIDDEN = `export interface Pub { h: Hidden; r: Ext; }
interface Hidden { a: number; deep: Deep; priv: never }
interface Deep { x: string }
import type { Ext } from 'ext';
export {};
`;
  beforeEach(() => {
    put('node_modules/ext/package.json', JSON.stringify({ name: 'ext', types: 'index.d.ts' }));
    put('node_modules/ext/index.d.ts', 'export interface Ext { y: 1 }\n');
    put('packages/a/dist/index.d.ts', HIDDEN);
    expect(run(['--write']).status).toBe(0);
  });

  it('records them, transitively, as referenced; a type from outside the workspace is not expanded', () => {
    const e = snapshot();
    expect(e['@fx/a (referenced) Hidden']).toBe('interface Hidden');
    expect(e['@fx/a (referenced) Hidden.a']).toBe('a: number;');
    expect(e['@fx/a (referenced) Deep.x']).toBe('x: string;');
    expect(Object.keys(e).some((k) => k.includes('Ext'))).toBe(false);
  });

  it('sees a member added to a referenced type, and a widened one', () => {
    commit();
    put('packages/a/dist/index.d.ts', HIDDEN.replace('x: string }', 'x: string; z: 1 }'));
    expect(run(['--check']).err).toContain('added:   @fx/a (referenced) Deep.z');
    put('packages/a/dist/index.d.ts', HIDDEN.replace('a: number;', 'a: number | string;'));
    run(['--write']);
    const r = run(['--against', 'HEAD']);
    expect(r.status).toBe(1);
    expect(r.err).toContain('changed: @fx/a (referenced) Hidden.a');
  });
});
