import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// The public-signature gate, tested on small declaration files it reads without a build (CI runs the tests before
// the build, so nothing here may need `packages/*/dist`). The gate itself, against the built declarations, runs in
// the CI step after the build.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const require_ = createRequire(import.meta.url);
const surfaceTool = require_(join(ROOT, 'scripts', 'api-surface.cjs')) as {
  buildSurface: (entries: { specifier: string; dts: string }[]) => Record<string, string>;
  diffSurfaces: (
    was: Record<string, string>,
    now: Record<string, string>,
  ) => { removed: string[]; added: string[]; changed: string[] };
  breakingChanges: (
    was: Record<string, string>,
    now: Record<string, string>,
    allowed: unknown,
  ) => { problems: string[] };
  allowlistProblems: (rows: unknown) => string[];
  newRows: (rows: unknown, base: unknown) => unknown;
  entryPoints: (root: string) => { specifier: string; dts: string }[];
};

// Made when the file loads, because `describe` bodies run before any `beforeAll`.
const dir = mkdtempSync(join(tmpdir(), 'api-surface-'));
mkdirSync(join(dir, 'sub'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function surfaceOf(files: Record<string, string>): Record<string, string> {
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return surfaceTool.buildSurface([{ specifier: 'fx', dts: join(dir, 'index.d.ts') }]);
}

const FIXTURE = {
  'index.d.ts': `
    export { Inner as Renamed } from './sub/inner.js';
    export * from './more.js';
    /** A doc comment that must not reach the snapshot. */
    export declare class Box<T extends object = {}> extends Base implements Thing {
      private secret;
      readonly size: number;
      static make(): Box;
      constructor(a: string);
      constructor(a: number, b?: boolean);
      get value(): T;
      set value(v: T);
      put(x: T): void;
      put(x: T, y: number): Promise<void>;
      [key: string]: unknown;
    }
    declare class Base {}
    interface Thing { (n: number): string; new (s: string): Thing; id: string }
    export type { Thing };
    export type Pair<A, B = A> = readonly [A, B];
    export declare enum Color { Red = 0, Green = 1 }
    export declare const LIMIT: 10;
    export declare function pick(a: string): string;
    export declare function pick(a: number): number;
    export declare namespace Util { function help(x: number): void; const k: string }
  `,
  'more.d.ts': `export declare function more(opts?: { a: number }): void;`,
  'sub/inner.d.ts': `export interface Inner { readonly a: number; b(): void }`,
};

describe('buildSurface', () => {
  const surface = surfaceOf(FIXTURE);

  it('lists a class header and each member, overloads and accessors separately', () => {
    expect(surface['fx Box']).toBe(
      'class Box<T extends object = {}> extends Base implements Thing',
    );
    expect(surface['fx Box.size']).toBe('readonly size: number;');
    expect(surface['fx Box.make']).toBe('static make(): Box;');
    expect(surface['fx Box.constructor']).toBe('constructor(a: string);');
    expect(surface['fx Box.constructor #2']).toBe('constructor(a: number, b?: boolean);');
    expect(surface['fx Box.value']).toBe('get value(): T;');
    expect(surface['fx Box.value #2']).toBe('set value(v: T);');
    expect(surface['fx Box.put #2']).toBe('put(x: T, y: number): Promise<void>;');
    expect(surface['fx Box.[index:string]']).toBe('[key: string]: unknown;');
    expect(surface['fx Box.secret']).toBeUndefined(); // private: not public API
  });

  it('lists interface members, call and construct signatures', () => {
    expect(surface['fx Thing']).toBe('interface Thing');
    expect(surface['fx Thing.[call]']).toBe('(n: number): string;');
    expect(surface['fx Thing.[new]']).toBe('new (s: string): Thing;');
    expect(surface['fx Thing.id']).toBe('id: string;');
  });

  it('lists every overload of a function, a type alias, an enum with its members, a const', () => {
    expect(surface['fx pick']).toBe('function pick(a: string): string;');
    expect(surface['fx pick #2']).toBe('function pick(a: number): number;');
    expect(surface['fx Pair']).toBe('type Pair<A, B = A> = readonly [ A, B ];');
    expect(surface['fx Color']).toBe('enum Color');
    expect(surface['fx Color.Green']).toBe('Green = 1');
    expect(surface['fx LIMIT']).toBe('const LIMIT: 10');
  });

  it('lists namespace members', () => {
    expect(surface['fx Util']).toBe('namespace Util');
    expect(surface['fx Util.help']).toBe('function help(x: number): void;');
    expect(surface['fx Util.k']).toBe('const k: string');
  });

  it('follows a renamed re-export and an export-star, naming by the exported name', () => {
    expect(surface['fx Renamed']).toBe('interface Inner');
    expect(surface['fx Renamed.b']).toBe('b(): void;');
    expect(surface['fx more']).toBe('function more(opts?: { a: number; }): void;');
  });

  it('carries no comment, no absolute path and a stable order', () => {
    const text = JSON.stringify(surface);
    expect(text).not.toContain('doc comment');
    expect(text).not.toContain(dir);
    const keys = Object.keys(surface);
    expect(keys).toEqual([...keys].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
    expect(surfaceOf(FIXTURE)).toEqual(surface);
  });

  it('sees a changed parameter type, a removed overload and an added member', () => {
    const base = surfaceOf(FIXTURE);
    const edited = surfaceOf({
      ...FIXTURE,
      'index.d.ts': FIXTURE['index.d.ts']
        .replace('put(x: T): void;', 'put(x: T | null): void;')
        .replace('export declare function pick(a: number): number;', '')
        .replace('readonly size: number;', 'readonly size: number; extra: string;'),
    });
    const { removed, added, changed } = surfaceTool.diffSurfaces(base, edited);
    expect(changed).toEqual(['fx Box.put']);
    expect(removed).toEqual(['fx pick #2']);
    expect(added).toEqual(['fx Box.extra']);
  });

  it('refuses a declaration file that is not there', () => {
    expect(() =>
      surfaceTool.buildSurface([{ specifier: 'fx', dts: join(dir, 'missing.d.ts') }]),
    ).toThrow(/pnpm build/);
  });
});

describe('diffSurfaces and breakingChanges', () => {
  const was = { 'p A': 'function A(): void;', 'p B': 'function B(): void;', 'p C.x': 'x: number;' };

  it('passes an addition and an identical surface', () => {
    expect(surfaceTool.breakingChanges(was, { ...was, 'p D': 'function D(): void;' }, [])).toEqual({
      problems: [],
    });
    expect(surfaceTool.breakingChanges(was, was, [])).toEqual({ problems: [] });
  });

  it('fails a removal and a change, naming the entry and both texts', () => {
    const now = { 'p A': 'function A(x: string): void;', 'p C.x': 'x: number;' };
    const { problems } = surfaceTool.breakingChanges(was, now, []);
    expect(problems).toHaveLength(2);
    expect(problems.join('\n')).toContain('removed: p B');
    expect(problems.join('\n')).toMatch(
      /changed: p A\n\s+was: function A\(\): void;\n\s+now: function A\(x: string\): void;/,
    );
  });

  it('excuses an entry only by a row with a reason, exact or by prefix', () => {
    const now = { 'p C.x': 'x: number;' };
    const rows = [
      { entry: 'p A', reason: 'replaced by A2' },
      { entry: 'p B', reason: '' },
    ];
    const { problems } = surfaceTool.breakingChanges(was, now, rows);
    expect(problems.some((p) => p.includes('row 1 (p B) has no reason'))).toBe(true);
    expect(problems.some((p) => p.startsWith('removed: p B'))).toBe(true);
    expect(problems.some((p) => p.includes('removed: p A'))).toBe(false);

    const wild = surfaceTool.breakingChanges(was, {}, [
      { entry: 'p A*', reason: 'dropped' },
      { entry: 'p B*', reason: 'dropped' },
      { entry: 'p C*', reason: 'dropped' },
    ]);
    expect(wild.problems).toEqual([]);
    const narrow = surfaceTool.breakingChanges(was, {}, [{ entry: 'p C*', reason: 'dropped' }]);
    expect(narrow.problems).toHaveLength(2);
  });

  it('rejects an allowlist that is not an array of rows', () => {
    expect(surfaceTool.allowlistProblems({})).toHaveLength(1);
    expect(surfaceTool.allowlistProblems([{ reason: 'x' }])).toHaveLength(1);
    expect(surfaceTool.allowlistProblems([])).toEqual([]);
  });

  it('refuses a prefix that does not name a package and a symbol', () => {
    for (const entry of ['*', 'p *', '@cloudbitmaps/core*']) {
      expect(surfaceTool.allowlistProblems([{ entry, reason: 'r' }]).join()).toContain('too wide');
      // and a wide row excuses nothing
      const { problems } = surfaceTool.breakingChanges({ 'p A': 'a' }, {}, [
        { entry, reason: 'r' },
      ]);
      expect(problems.some((p) => p.startsWith('removed: p A'))).toBe(true);
    }
    expect(surfaceTool.allowlistProblems([{ entry: 'p A*', reason: 'r' }])).toEqual([]);
  });

  it('newRows drops the rows the base already has, by entry and reason', () => {
    const rows = [
      { entry: 'p A', reason: 'old' },
      { entry: 'p B', reason: 'new' },
    ];
    expect(surfaceTool.newRows(rows, [{ entry: 'p A', reason: 'old' }])).toEqual([rows[1]]);
    // The same entry with another reason is a later change agreed afresh, so it is new.
    expect(surfaceTool.newRows(rows, [{ entry: 'p A', reason: 'reworded' }])).toEqual(rows);
    expect(surfaceTool.newRows(rows, [])).toEqual(rows);
  });
});

describe('the committed files', () => {
  it('the allowlist is a valid array of rows with reasons', () => {
    const rows: unknown = JSON.parse(readFileSync(join(ROOT, 'api-surface/allowed.json'), 'utf8'));
    expect(surfaceTool.allowlistProblems(rows)).toEqual([]);
  });

  it('the snapshot is version 1, sorted, and has an entry for every package', () => {
    const snap = JSON.parse(readFileSync(join(ROOT, 'api-surface/surface.json'), 'utf8')) as {
      version: number;
      entries: Record<string, string>;
    };
    expect(snap.version).toBe(1);
    const keys = Object.keys(snap.entries);
    expect(keys).toEqual([...keys].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
    for (const pkg of ['core', 'core/driver-kit', 'roaring', 's3', 'gcs', 'azure-blob']) {
      expect(keys.some((k) => k.startsWith(`@cloudbitmaps/${pkg} `))).toBe(true);
    }
  });
});
