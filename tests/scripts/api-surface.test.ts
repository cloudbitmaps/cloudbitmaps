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
    required?: Record<string, string>,
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

describe('the constructor a class inherits', () => {
  // Its own file, so the FIXTURE above stays as it is; `surfaceOf` writes every file it is given before each read.
  mkdirSync(join(dir, 'node_modules', 'dep'), { recursive: true });
  const surface = surfaceOf({
    'node_modules/dep/package.json': JSON.stringify({ name: 'dep', types: 'index.d.ts' }),
    'node_modules/dep/index.d.ts': 'export declare class DepBase { constructor(x: number); }\n',
    // A class no entry exports, named by a public signature, so it is recorded as referenced.
    'hiddensub.d.ts':
      "import { Root } from './index';\nexport declare class HiddenSub extends Root {}\n",
    'index.d.ts': `
      import { DepBase } from 'dep';
      import type { HiddenSub } from './hiddensub';
      export declare function makeSub(): HiddenSub;
      export declare abstract class FromAbs extends Root {}
      export declare class FromDep extends DepBase {}
      declare const MixBase: { new (a: string): { m(): void } };
      export declare class FromMix extends MixBase {}
      export declare class Root { constructor(message: string); }
      export declare class Child extends Root {}
      export declare class Grandchild extends Child { readonly code: number; }
      export declare class Own extends Root { constructor(message: string, code: number); }
      export declare class Two { constructor(a: number); constructor(a: string, b: boolean); }
      export declare class FromTwo extends Two {}
      declare class Guarded { protected constructor(n: number); }
      export declare class FromGuarded extends Guarded {}
      export declare class Bare {}
      export declare class FromBare extends Bare {}
      export declare class FromError extends Error {}
      export declare class Closed { private constructor(); }
    `,
  });
  const constructorsOf = (name: string): string[] =>
    Object.keys(surface).filter((k) => k.startsWith(`fx ${name}.constructor`));

  it('is recorded under the class own key, printed as the nearest base that declares one prints it', () => {
    expect(surface['fx Root.constructor']).toBe('constructor(message: string);');
    expect(surface['fx Child.constructor']).toBe('constructor(message: string);');
    expect(surface['fx Grandchild.constructor']).toBe('constructor(message: string);');
    expect(surface['fx FromTwo.constructor']).toBe('constructor(a: number);');
    expect(surface['fx FromTwo.constructor #2']).toBe('constructor(a: string, b: boolean);');
    expect(surface['fx FromGuarded.constructor']).toBe('protected constructor(n: number);');
  });

  it('is recorded for an abstract class and for a class recorded as referenced', () => {
    expect(surface['fx FromAbs']).toBe('abstract class FromAbs extends Root');
    expect(surface['fx FromAbs.constructor']).toBe('constructor(message: string);');
    // A referenced key starts with the name of the package that holds the file, which this temporary directory lacks.
    const referenced = (rest: string): string | undefined =>
      Object.entries(surface).find(([k]) => k.endsWith(` (referenced) ${rest}`))?.[1];
    expect(referenced('HiddenSub')).toBe('class HiddenSub extends Root');
    expect(referenced('HiddenSub.constructor')).toBe('constructor(message: string);');
  });

  it('gives way to a constructor the class declares', () => {
    expect(constructorsOf('Own')).toEqual(['fx Own.constructor']);
    expect(surface['fx Own.constructor']).toBe('constructor(message: string, code: number);');
  });

  it('is the one TypeScript gives, `constructor();`, when no class in the chain declares one', () => {
    for (const name of ['Bare', 'FromBare']) {
      expect(constructorsOf(name), name).toEqual([`fx ${name}.constructor`]);
      expect(surface[`fx ${name}.constructor`], name).toBe('constructor();');
    }
  });

  it('records a private constructor as declared, the one private member it records', () => {
    expect(constructorsOf('Closed')).toEqual(['fx Closed.constructor']);
    expect(surface['fx Closed.constructor']).toBe('private constructor();');
  });

  it('is not recorded when it comes from outside the workspace', () => {
    for (const name of ['FromError', 'FromDep']) {
      expect(constructorsOf(name), name).toEqual([]);
    }
    expect(surface['fx FromError']).toBe('class FromError extends Error');
    expect(surface['fx FromDep']).toBe('class FromDep extends DepBase');
  });

  it('is not recorded from a base that is not a class, such as a value with a construct signature', () => {
    expect(surface['fx FromMix']).toBe('class FromMix extends MixBase');
    expect(Object.keys(surface).filter((k) => k.startsWith('fx FromMix.'))).toEqual([]);
  });
});

describe('diffSurfaces and breakingChanges', () => {
  const was = { 'p A': 'function A(): void;', 'p B': 'function B(): void;', 'p C.x': 'x: number;' };

  it('passes an identical surface', () => {
    expect(surfaceTool.breakingChanges(was, was, [])).toEqual({ problems: [] });
  });

  it('fails an addition without a row, as a new public entry, and passes it with one', () => {
    const now = { ...was, 'p D': 'function D(): void;' };
    expect(surfaceTool.breakingChanges(was, now, []).problems).toEqual([
      'added: p D\n    a new public entry; add a reason row\n    now: function D(): void;',
    ]);
    expect(surfaceTool.breakingChanges(was, now, [{ entry: 'p D', reason: 'agreed' }])).toEqual({
      problems: [],
    });
    // A row needs its reason for an addition too, and a row for another key excuses nothing.
    expect(surfaceTool.breakingChanges(was, now, [{ entry: 'p D', reason: ' ' }]).problems).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/has no reason/),
        expect.stringMatching(/^added: p D\n/),
      ]),
    );
    expect(
      surfaceTool.breakingChanges(was, now, [{ entry: 'p Dx', reason: 'agreed' }]).problems,
    ).toHaveLength(1);
  });

  it('fails a new referenced key without a row: a public signature that names a type no entry exports', () => {
    const now = {
      ...was,
      'p (referenced) Hidden': 'interface Hidden',
      'p (referenced) Hidden.a': 'a: number;',
    };
    const { problems } = surfaceTool.breakingChanges(was, now, []);
    expect(problems).toHaveLength(2);
    expect(problems[0]).toMatch(
      /^added: p \(referenced\) Hidden\n\s+a new public entry; add a reason row\n/,
    );
    // A row for the exported name of the same symbol is another key, and covers neither.
    expect(
      surfaceTool.breakingChanges(was, now, [{ entry: 'p Hidden*', reason: 'agreed' }]).problems,
    ).toHaveLength(2);
    expect(
      surfaceTool.breakingChanges(was, now, [{ entry: 'p (referenced) Hidden*', reason: 'agreed' }])
        .problems,
    ).toEqual([]);
  });

  it('takes a narrow prefix row for a new type and its members, and no other key', () => {
    const now = {
      ...was,
      'p Fresh': 'interface Fresh',
      'p Fresh.a': 'a: number;',
      'p Fresh.m': 'm(): void;',
      'p Fresh.m #2': 'm(x: number): void;',
      'p Fresh (value)': 'const Fresh: number',
      // Names that start with the prefix's name are other symbols.
      'p FreshOptions': 'interface FreshOptions',
      'p FreshOptions.x': 'x: number;',
      'p Other': 'function Other(): void;',
    };
    const { problems } = surfaceTool.breakingChanges(was, now, [
      { entry: 'p Fresh*', reason: 'new' },
    ]);
    expect(problems.map((p) => p.split('\n')[0])).toEqual([
      'added: p FreshOptions',
      'added: p FreshOptions.x',
      'added: p Other',
    ]);
  });

  it('matches a prefix row only where a symbol name ends, so a longer name keeps its removal and its change', () => {
    const base = {
      'p Thing': 'interface Thing',
      'p Thing.a': 'a: number;',
      'p ThingOptions': 'interface ThingOptions',
      'p ThingOptions.x': 'x: number;',
      'p (referenced) Deep [src/deep]': 'interface Deep',
      'p (referenced) Deeper': 'interface Deeper',
    };
    const row = (entry: string) => [{ entry, reason: 'Thing changes' }];
    const without = (...keys: string[]) =>
      Object.fromEntries(Object.entries(base).filter(([k]) => !keys.includes(k)));
    const changedOptions = { ...base, 'p Thing.a': 'a: string;', 'p ThingOptions.x': 'x: string;' };
    expect(surfaceTool.breakingChanges(base, changedOptions, row('p Thing*')).problems).toEqual([
      'changed: p ThingOptions.x\n    was: x: number;\n    now: x: string;',
    ]);
    expect(
      surfaceTool
        .breakingChanges(base, without('p ThingOptions', 'p ThingOptions.x'), row('p Thing*'))
        .problems.map((p) => p.split('\n')[0]),
    ).toEqual(['removed: p ThingOptions', 'removed: p ThingOptions.x']);
    // A prefix that ends in `.` covers the members alone.
    expect(
      surfaceTool
        .breakingChanges(
          base,
          { ...base, 'p Thing': 'interface Thing<T>', 'p Thing.a': 'a: T;' },
          row('p Thing.*'),
        )
        .problems.map((p) => p.split('\n')[0]),
    ).toEqual(['changed: p Thing']);
    // A referenced key told apart by file continues after its name with a space.
    expect(
      surfaceTool
        .breakingChanges(
          base,
          without('p (referenced) Deep [src/deep]', 'p (referenced) Deeper'),
          row('p (referenced) Deep*'),
        )
        .problems.map((p) => p.split('\n')[0]),
    ).toEqual(['removed: p (referenced) Deeper']);
  });

  it('refuses a too-wide row for an addition, and the addition still fails', () => {
    const now = { ...was, 'p D': 'function D(): void;', 'p (referenced) H': 'interface H' };
    for (const entry of ['*', 'p *', 'p (referenced) *', 'p (*']) {
      const { problems } = surfaceTool.breakingChanges(was, now, [{ entry, reason: 'wide' }]);
      expect(
        problems.some((p) => p.includes('too wide')),
        entry,
      ).toBe(true);
      expect(
        problems.some((p) => p.startsWith('added: p D\n')),
        entry,
      ).toBe(true);
      expect(
        problems.some((p) => p.startsWith('added: p (referenced) H\n')),
        entry,
      ).toBe(true);
    }
  });

  it('keeps the required-member message for a parent the base has, and names any other addition as new', () => {
    const base = { 'p I': 'interface I', 'p I.x': 'x: number;' };
    const now = {
      ...base,
      'p I.y': 'y: string;',
      'p I.z': 'z?: string;',
      'p J': 'interface J',
      'p J.r': 'r: string;',
    };
    const required = { 'p I.x': 'p I', 'p I.y': 'p I', 'p J.r': 'p J' };
    const { problems } = surfaceTool.breakingChanges(base, now, [], required);
    expect(problems).toEqual([
      'added: p I.y\n    a required member added to an existing interface (p I)\n    now: y: string;',
      'added: p I.z\n    a new public entry; add a reason row\n    now: z?: string;',
      'added: p J\n    a new public entry; add a reason row\n    now: interface J',
      'added: p J.r\n    a new public entry; add a reason row\n    now: r: string;',
    ]);
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
