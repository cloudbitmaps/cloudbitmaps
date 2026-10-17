import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
export type Opts = { a: string };
`;
const EXTRA = `export declare function extra(x: boolean): void;\n`;

/** The commit every test starts from, and the snapshot it holds. */
let base = '';

// One repository for the whole file, built once: a test starts from `base` again, whatever the one before it did to the
// working tree, the index or the history (`beforeEach` resets all three and removes what the test left untracked).
beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'api-surface-cli-'));
  git('init', '-q');
  // No background repack started by a commit while a test reads or removes the repository.
  git('config', 'maintenance.auto', 'false');
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
  base = git('rev-parse', 'HEAD').trim();
});
beforeEach(() => {
  git('reset', '-q', '--hard', base);
  git('clean', '-q', '-f', '-d');
});
afterAll(() => rmSync(repo, { recursive: true, force: true }));

const withMain = (edit: (s: string) => string): void =>
  put('packages/a/dist/index.d.ts', edit(MAIN));

describe('--write and --check', { timeout: 60_000 }, () => {
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

  it('fails when the committed record of required members is not what the declarations say, and names the member', () => {
    const file = join(repo, 'api-surface/surface.json');
    const committed = readFileSync(file, 'utf8');
    const parsed = JSON.parse(committed) as { required: Record<string, string> };
    expect(parsed.required['@fx/a Shape.a']).toBe('@fx/a Shape');
    delete parsed.required['@fx/a Shape.a'];
    writeFileSync(file, JSON.stringify(parsed, null, 2) + '\n');
    let r = run(['--check']);
    expect(r.status).toBe(1);
    expect(r.err).toContain('required, not recorded: @fx/a Shape.a');
    parsed.required['@fx/a Shape.a'] = '@fx/a Shape';
    parsed.required['@fx/a keep'] = '@fx/a Shape';
    writeFileSync(file, JSON.stringify(parsed, null, 2) + '\n');
    r = run(['--check']);
    expect(r.status).toBe(1);
    expect(r.err).toContain('recorded as required, and is not: @fx/a keep');
    writeFileSync(file, committed);
    expect(run(['--check']).status).toBe(0);
  });

  it('fails on a declaration file that is not built', () => {
    rmSync(join(repo, 'packages/a/dist/extra.d.ts'));
    const r = run(['--check']);
    expect(r.status).not.toBe(0);
    expect(r.err).toContain('pnpm build');
  });
});

describe('--against', { timeout: 60_000 }, () => {
  const NEW_MSG = 'a new public entry; add a reason row';

  it('passes with no change', () => {
    const r = run(['--against', 'HEAD']);
    expect(r.status).toBe(0);
    expect(r.out).toContain(
      'no entry is removed, changed or added against HEAD without a reason row',
    );
  });

  it('fails an addition without a row, as a new public entry, and passes it with one', () => {
    withMain((s) => `${s}export declare function fresh(): void;\n`);
    expect(run(['--write']).status).toBe(0);
    let r = run(['--against', 'HEAD']);
    expect(r.status).toBe(1);
    expect(r.err).toContain(`added: @fx/a fresh\n    ${NEW_MSG}\n    now: function fresh(): void;`);
    expect(r.err).toContain('A removed, changed or added entry is a public-contract change');
    put('api-surface/allowed.json', JSON.stringify([{ entry: '@fx/a fresh', reason: 'agreed' }]));
    r = run(['--against', 'HEAD']);
    expect(r.status, r.err).toBe(0);
    expect(r.out).toContain('without a reason row');
  });

  it('fails a removal, a change and an addition, each named as what it is', () => {
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
    expect(r.err).toContain(`added: @fx/a fresh\n    ${NEW_MSG}`);
  });

  it('fails a new referenced key without a row: a public signature that starts naming a type no entry exports', () => {
    put('packages/a/dist/hidden.d.ts', 'export interface Hidden { x: string }\n');
    withMain(
      (s) =>
        `${s.replace('keep(a: string)', 'keep(a: string | Hidden)')}import type { Hidden } from './hidden';\n`,
    );
    run(['--write']);
    expect(snapshot()['@fx/a (referenced) Hidden.x']).toBe('x: string;');
    put(
      'api-surface/allowed.json',
      JSON.stringify([{ entry: '@fx/a keep', reason: 'takes a Hidden too' }]),
    );
    let r = run(['--against', 'HEAD']);
    expect(r.status).toBe(1);
    expect(r.err).not.toContain('changed: @fx/a keep');
    expect(r.err).toContain(`added: @fx/a (referenced) Hidden\n    ${NEW_MSG}`);
    expect(r.err).toContain(`added: @fx/a (referenced) Hidden.x\n    ${NEW_MSG}`);
    put(
      'api-surface/allowed.json',
      JSON.stringify([
        { entry: '@fx/a keep', reason: 'takes a Hidden too' },
        {
          entry: '@fx/a (referenced) Hidden*',
          reason: 'callers name it as Parameters<typeof keep>[0]',
        },
      ]),
    );
    r = run(['--against', 'HEAD']);
    expect(r.status, r.err).toBe(0);
  });

  it('takes a narrow prefix row for a new type and its members, and refuses one too wide', () => {
    withMain((s) => `${s}export interface Fresh { r: string; m(): void }\n`);
    run(['--write']);
    put(
      'api-surface/allowed.json',
      JSON.stringify([{ entry: '@fx/a Fresh*', reason: 'new type' }]),
    );
    expect(run(['--against', 'HEAD']).status).toBe(0);
    for (const entry of ['*', '@fx/a *', '@fx/a (*']) {
      put('api-surface/allowed.json', JSON.stringify([{ entry, reason: 'wide' }]));
      const r = run(['--against', 'HEAD']);
      expect(r.status, entry).toBe(1);
      expect(r.err, entry).toContain('too wide');
      expect(r.err, entry).toContain(`added: @fx/a Fresh.r\n    ${NEW_MSG}`);
    }
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

  it('honours a row for the same entry with a reason of its own, as a later change agreed afresh', () => {
    put(
      'api-surface/allowed.json',
      JSON.stringify([{ entry: '@fx/a drop', reason: 'earlier change' }]),
    );
    commit();
    breakIt();
    put('api-surface/allowed.json', JSON.stringify([{ entry: '@fx/a drop', reason: 'replaced' }]));
    expect(run(['--against', 'HEAD']).status).toBe(0);
  });

  it('refuses a row that is too wide', () => {
    breakIt();
    put('api-surface/allowed.json', JSON.stringify([{ entry: '*', reason: 'everything' }]));
    const r = run(['--against', 'HEAD']);
    expect(r.status).toBe(1);
    expect(r.err).toContain('too wide');
  });

  it('refuses a prefix that stops before a name, excuses nothing by one that stops inside a name, and takes the whole name', () => {
    breakIt();
    for (const entry of ['@fx/a (*', '@fx/a (referenced) *']) {
      put('api-surface/allowed.json', JSON.stringify([{ entry, reason: 'wide' }]));
      const r = run(['--against', 'HEAD']);
      expect(r.status, entry).toBe(1);
      expect(r.err, entry).toContain('too wide');
    }
    put(
      'api-surface/allowed.json',
      JSON.stringify([{ entry: '@fx/a d*', reason: 'part of a name' }]),
    );
    const r = run(['--against', 'HEAD']);
    expect(r.status).toBe(1);
    expect(r.err).toContain('removed: @fx/a drop');
    put('api-surface/allowed.json', JSON.stringify([{ entry: '@fx/a drop*', reason: 'replaced' }]));
    expect(run(['--against', 'HEAD']).status).toBe(0);
  });

  it('lets a prefix row for one type excuse nothing of a longer name that starts with it', () => {
    withMain((s) => `${s}export interface ShapeOptions { x: number }\n`);
    run(['--write']);
    commit();
    withMain(
      (s) =>
        `${s.replace('  b: number;\n}', '  b: number;\n  c?: string;\n}')}export interface ShapeOptions { x: string }\n`,
    );
    run(['--write']);
    put(
      'api-surface/allowed.json',
      JSON.stringify([{ entry: '@fx/a Shape*', reason: 'Shape gains c' }]),
    );
    let r = run(['--against', 'HEAD']);
    expect(r.status).toBe(1);
    expect(r.err).toContain('changed: @fx/a ShapeOptions.x');
    expect(r.err).not.toContain('@fx/a Shape.c');
    put(
      'api-surface/allowed.json',
      JSON.stringify([
        { entry: '@fx/a Shape*', reason: 'Shape gains c' },
        { entry: '@fx/a ShapeOptions*', reason: 'x takes a string' },
      ]),
    );
    r = run(['--against', 'HEAD']);
    expect(r.status, r.err).toBe(0);
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
    // Commits that name an object the repository never had: once as the `api-surface` tree, once as the snapshot's
    // blob inside a readable tree, so both `git ls-tree` and `git show` failing are covered. Deleting a stored
    // object's loose file is not enough: git may also hold the object in a pack (the background maintenance a commit
    // starts can write one), and then reads it from there.
    const missing = '1'.repeat(git('rev-parse', 'HEAD').trim().length);
    const mktree = (listing: string): string =>
      execFileSync('git', ['mktree', '--missing'], {
        cwd: repo,
        encoding: 'utf8',
        input: listing,
      }).trim();
    const swap = (listing: string, entry: RegExp, oid: string): string => {
      const out = listing.replace(entry, `$1${oid}$2`);
      expect(out).toContain(oid);
      return out;
    };
    const subtree = /^(040000 tree )\S+(\tapi-surface)$/m;
    const root = git('ls-tree', 'HEAD');
    const noBlob = mktree(
      swap(git('ls-tree', 'HEAD:api-surface'), /^(100644 blob )\S+(\tsurface\.json)$/m, missing),
    );
    expect(() => git('cat-file', '-e', missing)).toThrow();
    for (const tree of [
      mktree(swap(root, subtree, missing)),
      mktree(swap(root, subtree, noBlob)),
    ]) {
      const at = git(
        '-c',
        'user.name=t',
        '-c',
        'user.email=t@t',
        'commit-tree',
        '-m',
        'x',
        '-p',
        'HEAD',
        tree,
      ).trim();
      const r = run(['--against', at]);
      expect(r.status, r.out + r.err).toBe(1);
      expect(r.out).not.toContain('nothing to compare against');
      expect(r.err).not.toContain('is not a commit here');
    }
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

describe('a member added to an existing type', { timeout: 60_000 }, () => {
  const REQUIRED_MSG = 'a required member added to an existing interface';
  /** Adds `extra` members to `Shape` (an interface the base has), writes the snapshot and compares with HEAD. */
  const addToShape = (extra: string): Run => {
    withMain((s) => s.replace('  b: number;\n}', `  b: number;\n  ${extra}\n}`));
    expect(run(['--write']).status).toBe(0);
    return run(['--against', 'HEAD']);
  };

  it.each([
    ['a required property', 'c: string;', '@fx/a Shape.c'],
    ['a required method', 'run(x: number): void;', '@fx/a Shape.run'],
    ['an index signature', '[k: string]: unknown;', '@fx/a Shape.[index:string]'],
    ['a call signature', '(n: number): string;', '@fx/a Shape.[call]'],
    ['a construct signature', 'new (n: number): Shape;', '@fx/a Shape.[new]'],
  ])('fails %s', (_what, member, key) => {
    const r = addToShape(member);
    expect(r.status).toBe(1);
    expect(r.err).toContain(REQUIRED_MSG);
    expect(r.err).toContain(`added: ${key}`);
  });

  const NEW_MSG = 'a new public entry; add a reason row';

  // An optional member breaks no implementer, and is still a new public entry: every addition is reviewed.
  it.each([
    ['an optional property', 'c?: string;', '@fx/a Shape.c'],
    ['an optional method', 'run?(x: number): void;', '@fx/a Shape.run'],
  ])(
    'fails %s without a row, as a new public entry, and passes it with one',
    (_what, member, key) => {
      let r = addToShape(member);
      expect(r.status).toBe(1);
      expect(r.err).toContain(`added: ${key}\n    ${NEW_MSG}`);
      expect(r.err).not.toContain(REQUIRED_MSG);
      put('api-surface/allowed.json', JSON.stringify([{ entry: key, reason: 'agreed' }]));
      r = run(['--against', 'HEAD']);
      expect(r.status, r.err).toBe(0);
    },
  );

  it('fails a required member of an existing object type alias, and an optional one as a new entry', () => {
    withMain((s) => s.replace('{ a: string }', '{ a: string; b: number }'));
    run(['--write']);
    const bad = run(['--against', 'HEAD']);
    expect(bad.status).toBe(1);
    expect(bad.err).toContain(`added: @fx/a Opts.b\n    ${REQUIRED_MSG} (@fx/a Opts)`);
    withMain((s) => s.replace('{ a: string }', '{ a: string; b?: number }'));
    run(['--write']);
    const optional = run(['--against', 'HEAD']);
    expect(optional.status).toBe(1);
    expect(optional.err).toContain(`added: @fx/a Opts.b\n    ${NEW_MSG}`);
  });

  it('fails a new interface, a new class method and a new export as new entries, with no required-member message', () => {
    withMain(
      (s) =>
        `${s.replace('  get size(): number;', '  get size(): number;\n  extra(): void;')}export interface Fresh { r: string; m(): void }\nexport declare function more(): void;\n`,
    );
    run(['--write']);
    expect(snapshot()['@fx/a Thing.extra']).toBe('extra(): void;');
    expect(snapshot()['@fx/a Fresh.r']).toBe('r: string;');
    let r = run(['--against', 'HEAD']);
    expect(r.status).toBe(1);
    for (const key of [
      '@fx/a Thing.extra',
      '@fx/a Fresh',
      '@fx/a Fresh.r',
      '@fx/a Fresh.m',
      '@fx/a more',
    ]) {
      expect(r.err).toContain(`added: ${key}\n    ${NEW_MSG}`);
    }
    // A required member of a type that is itself new binds no existing implementer.
    expect(r.err).not.toContain(REQUIRED_MSG);
    put(
      'api-surface/allowed.json',
      JSON.stringify([
        { entry: '@fx/a Thing.extra', reason: 'agreed' },
        { entry: '@fx/a Fresh*', reason: 'agreed' },
        { entry: '@fx/a more', reason: 'agreed' },
      ]),
    );
    r = run(['--against', 'HEAD']);
    expect(r.status, r.err).toBe(0);
  });

  it('fails a required member of an existing referenced interface', () => {
    put(
      'packages/a/dist/index.d.ts',
      'export interface Pub { h: Deps }\ninterface Deps { a?: number }\nexport {};\n',
    );
    run(['--write']);
    commit();
    put(
      'packages/a/dist/index.d.ts',
      'export interface Pub { h: Deps }\ninterface Deps { a?: number; need: string }\nexport {};\n',
    );
    run(['--write']);
    const r = run(['--against', 'HEAD']);
    expect(r.status).toBe(1);
    expect(r.err).toContain('added: @fx/a (referenced) Deps.need');
    expect(r.err).toContain(REQUIRED_MSG);
  });

  it('is excused by a row with a reason added in this change, and not by one the base has', () => {
    expect(addToShape('c: string;').status).toBe(1);
    put('api-surface/allowed.json', JSON.stringify([{ entry: '@fx/a Shape.c', reason: 'agreed' }]));
    expect(run(['--against', 'HEAD']).status).toBe(0);
    commit();
    withMain((s) => s.replace('  b: number;\n}', '  b: number;\n  c: string;\n  d: string;\n}'));
    run(['--write']);
    put('api-surface/allowed.json', JSON.stringify([{ entry: '@fx/a Shape.c', reason: 'agreed' }]));
    const r = run(['--against', 'HEAD']);
    expect(r.status).toBe(1);
    expect(r.err).toContain('added: @fx/a Shape.d');
  });
});

describe('the constructor a class inherits', { timeout: 60_000 }, () => {
  const CLASSES = `export declare class Root {
  constructor(message: string);
}
export declare class Err extends Root {
  readonly code: number;
}
export declare class Own extends Root {
  constructor(message: string, code: number);
}
export declare class Plain {}
export declare class FromPlain extends Plain {}
export declare class Oops extends Error {}
export declare class Sink {
  count(): number;
}
`;
  /** Writes the classes, edited, after the main fixture, regenerates the snapshot and compares it with HEAD. */
  const againstHead = (edit: (s: string) => string): Run => {
    withMain((s) => s + edit(CLASSES));
    expect(run(['--write']).status).toBe(0);
    return run(['--against', 'HEAD']);
  };
  // Every test starts from a commit that has the classes as they are above.
  beforeEach(() => {
    withMain((s) => s + CLASSES);
    expect(run(['--write']).status).toBe(0);
    commit();
  });
  const DETAILS = 'constructor(message: string, details: { readonly limit: number });';

  it('records it under the class own key as the base declares it, `constructor();` for a chain that declares none, and nothing from outside the workspace', () => {
    const e = snapshot();
    expect(e['@fx/a Err.constructor']).toBe('constructor(message: string);');
    expect(e['@fx/a Own.constructor']).toBe('constructor(message: string, code: number);');
    for (const name of ['Plain', 'FromPlain', 'Sink', 'Thing']) {
      expect(e[`@fx/a ${name}.constructor`], name).toBe('constructor();');
    }
    expect(Object.keys(e).filter((k) => k.startsWith('@fx/a Oops.constructor'))).toEqual([]);
  });

  it('fails a private constructor added to a class whose chain declared none, and its removal, as changes', () => {
    let r = againstHead((s) =>
      s.replace('  count(): number;\n', '  private constructor();\n  count(): number;\n'),
    );
    expect(r.status).toBe(1);
    expect(r.err).toContain(
      'changed: @fx/a Sink.constructor\n    was: constructor();\n    now: private constructor();',
    );
    commit();
    withMain((s) => s + CLASSES);
    expect(run(['--write']).status).toBe(0);
    r = run(['--against', 'HEAD']);
    expect(r.status).toBe(1);
    expect(r.err).toContain(
      'changed: @fx/a Sink.constructor\n    was: private constructor();\n    now: constructor();',
    );
  });

  it('passes a `constructor();` declared where the chain declared none, and the snapshot does not change', () => {
    const r = againstHead((s) =>
      s.replace('  count(): number;\n', '  constructor();\n  count(): number;\n'),
    );
    expect(r.status, r.err).toBe(0);
    expect(git('status', '--porcelain', '--', 'api-surface')).toBe('');
  });

  it('fails a declared constructor that differs from the inherited one, as a change, and passes it with a row', () => {
    let r = againstHead((s) =>
      s.replace('  readonly code: number;\n', `  readonly code: number;\n  ${DETAILS}\n`),
    );
    expect(r.status).toBe(1);
    expect(r.err).toContain(
      'changed: @fx/a Err.constructor\n    was: constructor(message: string);\n    now: constructor(message: string, details: { readonly limit: number; });',
    );
    expect(r.err).not.toContain('added: @fx/a Err.constructor');
    put(
      'api-surface/allowed.json',
      JSON.stringify([{ entry: '@fx/a Err.constructor', reason: 'takes its details' }]),
    );
    r = run(['--against', 'HEAD']);
    expect(r.status, r.err).toBe(0);
  });

  it('passes a declared constructor identical to the inherited one, and the snapshot does not change', () => {
    const r = againstHead((s) =>
      s.replace(
        '  readonly code: number;\n',
        '  readonly code: number;\n  constructor(message: string);\n',
      ),
    );
    expect(r.status, r.err).toBe(0);
    expect(git('status', '--porcelain', '--', 'api-surface')).toBe('');
  });

  it('fails a removed constructor that leaves the class one of another shape to inherit', () => {
    const r = againstHead((s) => s.replace('  constructor(message: string, code: number);\n', ''));
    expect(r.status).toBe(1);
    expect(r.err).toContain(
      'changed: @fx/a Own.constructor\n    was: constructor(message: string, code: number);\n    now: constructor(message: string);',
    );
  });

  it('sees a change to the base constructor in every class that inherits it', () => {
    const r = againstHead((s) =>
      s.replace(
        'constructor(message: string);\n}\nexport declare class Err',
        'constructor(message: string, cause?: unknown);\n}\nexport declare class Err',
      ),
    );
    expect(r.status).toBe(1);
    expect(r.err).toContain('changed: @fx/a Root.constructor');
    expect(r.err).toContain('changed: @fx/a Err.constructor');
    expect(r.err).not.toContain('@fx/a Own.constructor');
  });

  it('reads a constructor declared where the chain declared none as a change, and where it came from outside the workspace as an addition', () => {
    const r = againstHead((s) =>
      s
        .replace(
          'class FromPlain extends Plain {}',
          'class FromPlain extends Plain {\n  constructor(x: number);\n}',
        )
        .replace(
          'class Oops extends Error {}',
          'class Oops extends Error {\n  constructor(code: number);\n}',
        ),
    );
    expect(r.status).toBe(1);
    expect(r.err).toContain(
      'changed: @fx/a FromPlain.constructor\n    was: constructor();\n    now: constructor(x: number);',
    );
    expect(r.err).toContain('added: @fx/a Oops.constructor\n    a new public entry');
  });
});

describe('a constructor inherited from another workspace package', { timeout: 60_000 }, () => {
  const ROOT_CLASS = 'export declare class Root {\n  constructor(message: string);\n}\n';
  // Package d's class extends package a's, reached the way a workspace dependency is: through d's node_modules.
  beforeEach(() => {
    withMain((s) => s + ROOT_CLASS);
    put(
      'packages/d/package.json',
      JSON.stringify({
        name: '@fx/d',
        exports: { '.': { types: './dist/index.d.ts', default: './dist/index.js' } },
      }),
    );
    put(
      'packages/d/dist/index.d.ts',
      "import { Root } from '@fx/a';\nexport declare class Sub extends Root {}\n",
    );
    mkdirSync(join(repo, 'packages/d/node_modules/@fx'), { recursive: true });
    symlinkSync('../../../a', join(repo, 'packages/d/node_modules/@fx/a'));
    expect(run(['--write']).status).toBe(0);
    commit();
  });

  it('is recorded under the subclass own key, and a change to the base shows in both packages', () => {
    expect(snapshot()['@fx/d Sub']).toBe('class Sub extends Root');
    expect(snapshot()['@fx/d Sub.constructor']).toBe('constructor(message: string);');
    withMain((s) => s + ROOT_CLASS.replace('message: string', 'message: string, code?: number'));
    expect(run(['--write']).status).toBe(0);
    const r = run(['--against', 'HEAD']);
    expect(r.status).toBe(1);
    expect(r.err).toContain('changed: @fx/a Root.constructor');
    expect(r.err).toContain(
      'changed: @fx/d Sub.constructor\n    was: constructor(message: string);\n    now: constructor(message: string, code?: number);',
    );
  });
});

describe('types a public signature names that no entry exports', { timeout: 60_000 }, () => {
  const HIDDEN = `export interface Pub { h: Hidden; r: Ext; }
interface Hidden { a: number; deep: Deep; priv: never }
interface Deep { x: string }
import type { Ext } from 'ext';
export {};
`;
  // The snapshot of the declarations below, written once; each test puts the files and that snapshot back.
  let written = '';
  beforeAll(() => {
    // From `base`, whatever the test before this describe left: the file's `beforeEach` runs before a test, not here.
    git('reset', '-q', '--hard', base);
    git('clean', '-q', '-f', '-d');
    put('node_modules/ext/package.json', JSON.stringify({ name: 'ext', types: 'index.d.ts' }));
    put('node_modules/ext/index.d.ts', 'export interface Ext { y: 1 }\n');
    put('packages/a/dist/index.d.ts', HIDDEN);
    expect(run(['--write']).status).toBe(0);
    written = readFileSync(join(repo, 'api-surface/surface.json'), 'utf8');
    git('reset', '-q', '--hard', base);
    git('clean', '-q', '-f', '-d');
  });
  beforeEach(() => {
    put('node_modules/ext/package.json', JSON.stringify({ name: 'ext', types: 'index.d.ts' }));
    put('node_modules/ext/index.d.ts', 'export interface Ext { y: 1 }\n');
    put('packages/a/dist/index.d.ts', HIDDEN);
    put('api-surface/surface.json', written);
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

describe('internal entries', { timeout: 60_000 }, () => {
  const CORE = `export interface Ctx { n: number }
export declare function engine(c: Ctx, a: string): void;
export declare function other(): void;
`;
  const KIT = `import type { Ctx } from './index';\nexport declare function useCtx(c: Ctx): void;\n`;
  const internalRow = { entry: '@fx/b (internal)', reason: 'only our own packages use it' };
  const manifestB = (internal: boolean): string =>
    JSON.stringify({
      name: '@fx/b',
      ...(internal ? { cloudbitmaps: { internalEntries: ['.'] } } : {}),
      exports: {
        '.': { types: './dist/index.d.ts', default: './dist/index.js' },
        './kit': { types: './dist/kit.d.ts', default: './dist/kit.js' },
      },
    });
  const setB = (internal: boolean, core = CORE, kit = KIT): void => {
    put('packages/b/package.json', manifestB(internal));
    put('packages/b/dist/index.d.ts', core);
    put('packages/b/dist/kit.d.ts', kit);
    expect(run(['--write']).status).toBe(0);
  };
  const internalFile = (): Record<string, string> =>
    (
      JSON.parse(readFileSync(join(repo, 'api-surface/internal.json'), 'utf8')) as {
        entries: Record<string, string>;
      }
    ).entries;

  it('leaves an internal entry out of the snapshot, writes it to internal.json, and keeps a type it names referenced', () => {
    setB(true);
    const e = snapshot();
    expect(
      Object.keys(e).filter((k) => k.startsWith('@fx/b engine') || k === '@fx/b other'),
    ).toEqual([]);
    expect(e['@fx/b/kit useCtx']).toBe('function useCtx(c: Ctx): void;');
    expect(e['@fx/b (referenced) Ctx.n']).toBe('n: number;');
    expect(Object.keys(e).some((k) => k.startsWith('@fx/b Ctx'))).toBe(false);
    const inner = internalFile();
    expect(inner['@fx/b engine']).toBe('function engine(c: Ctx, a: string): void;');
    expect(inner['@fx/b Ctx.n']).toBe('n: number;');
    expect(run(['--check']).status).toBe(0);
  });

  it('fails --check when internal.json is out of date, and when it is missing its entries', () => {
    setB(true);
    put('packages/b/dist/index.d.ts', `${CORE}export declare function fresh(): void;\n`);
    let r = run(['--check']);
    expect(r.status).toBe(1);
    expect(r.err).toContain('internal added:   @fx/b fresh');
    put('packages/b/dist/index.d.ts', CORE.replace('a: string', 'a: number'));
    r = run(['--check']);
    expect(r.status).toBe(1);
    expect(r.err).toContain('internal changed: @fx/b engine');
    put('packages/b/dist/index.d.ts', CORE);
    rmSync(join(repo, 'api-surface/internal.json'));
    r = run(['--check']);
    expect(r.status).toBe(1);
    expect(r.err).toContain('internal added:   @fx/b engine');
  });

  it('does not fail --against for a change or a removal in an internal entry', () => {
    setB(true);
    commit();
    setB(
      true,
      CORE.replace('a: string', 'a: number').replace(
        'export declare function other(): void;\n',
        '',
      ),
    );
    const r = run(['--against', 'HEAD']);
    expect(r.status, r.err).toBe(0);
    expect(internalFile()['@fx/b engine']).toBe('function engine(c: Ctx, a: number): void;');
  });

  it('needs no row for an addition to an internal entry, and wants one when a public signature names its new type', () => {
    setB(true);
    put('api-surface/allowed.json', JSON.stringify([internalRow]));
    commit();
    const MORE = `${CORE}export interface Fresh { f: number }\nexport declare function fresh(x: Fresh): void;\n`;
    setB(true, MORE);
    expect(internalFile()['@fx/b fresh']).toBe('function fresh(x: Fresh): void;');
    let r = run(['--against', 'HEAD']);
    expect(r.status, r.err).toBe(0);
    setB(
      true,
      MORE,
      `${KIT}import type { Fresh } from './index';\nexport declare function useFresh(f: Fresh): void;\n`,
    );
    r = run(['--against', 'HEAD']);
    expect(r.status).toBe(1);
    expect(r.err).toContain('added: @fx/b/kit useFresh\n    a new public entry');
    expect(r.err).toContain('added: @fx/b (referenced) Fresh.f\n    a new public entry');
  });

  it('fails making an entry internal without the row, and passes with it', () => {
    setB(false);
    commit();
    setB(true);
    let r = run(['--against', 'HEAD']);
    expect(r.status).toBe(1);
    expect(r.err).toContain('internal: @fx/b');
    expect(r.err).toContain('@fx/b (internal)');
    put('api-surface/allowed.json', JSON.stringify([{ entry: '@fx/b (internal)', reason: ' ' }]));
    expect(run(['--against', 'HEAD']).status).toBe(1);
    put('api-surface/allowed.json', JSON.stringify([internalRow]));
    r = run(['--against', 'HEAD']);
    expect(r.status, r.err).toBe(0);
  });

  it('wants no row once the base is already internal', () => {
    setB(true);
    put('api-surface/allowed.json', JSON.stringify([internalRow]));
    commit();
    expect(run(['--against', 'HEAD']).status).toBe(0);
    put('api-surface/allowed.json', '[]\n');
    expect(run(['--against', 'HEAD']).status).toBe(0);
  });

  it('takes no excuse from a row the base already has, or from a row for a subpath', () => {
    setB(false);
    put('api-surface/allowed.json', JSON.stringify([internalRow]));
    commit();
    setB(true);
    let r = run(['--against', 'HEAD']);
    expect(r.status).toBe(1);
    expect(r.err).toContain('internal: @fx/b\n');
    put(
      'api-surface/allowed.json',
      JSON.stringify([{ entry: '@fx/b/kit (internal)', reason: 'not this entry' }]),
    );
    r = run(['--against', 'HEAD']);
    expect(r.status).toBe(1);
    expect(r.err).toContain('internal: @fx/b\n');
  });

  it('leaves a type only the internal entry names out of the snapshot', () => {
    setB(
      true,
      `${CORE}export interface OnlyCore { m: string }\nexport declare function solo(o: OnlyCore): void;\n`,
    );
    expect(Object.keys(snapshot()).filter((k) => k.includes('OnlyCore'))).toEqual([]);
    expect(internalFile()['@fx/b OnlyCore.m']).toBe('m: string;');
  });

  // Making an entry internal takes its own functions out of the promise, never a type a public signature still names.
  describe('a type the newly internal entry exported, still promised', () => {
    const TWO = CORE.replace('n: number }', 'n: number; m: string }');
    const madeInternal = (core: string, kit = KIT): Run => {
      setB(false, TWO);
      commit();
      setB(true, core, kit);
      put('api-surface/allowed.json', JSON.stringify([internalRow]));
      return run(['--against', 'HEAD']);
    };

    it('passes when the type is unchanged', () => {
      const r = madeInternal(TWO);
      expect(r.status, r.err).toBe(0);
    });

    it('fails a changed member', () => {
      const r = madeInternal(TWO.replace('n: number', 'n: string'));
      expect(r.status).toBe(1);
      expect(r.err).toContain('changed: @fx/b (referenced) Ctx.n');
    });

    it('fails a removed member', () => {
      const r = madeInternal(CORE);
      expect(r.status).toBe(1);
      expect(r.err).toContain('removed: @fx/b (referenced) Ctx.m');
    });

    it('fails a new required member', () => {
      const r = madeInternal(TWO.replace('m: string }', 'm: string; extra: boolean }'));
      expect(r.status).toBe(1);
      expect(r.err).toContain('added: @fx/b (referenced) Ctx.extra');
    });

    const KIT_EXPORTS = `export type { Ctx } from './index';\n${KIT}`;

    it('passes when another public entry of the package now exports the type unchanged', () => {
      const r = madeInternal(TWO, KIT_EXPORTS);
      expect(r.status, r.err).toBe(0);
    });

    it('fails a change when another public entry of the package now exports the type', () => {
      const r = madeInternal(TWO.replace('n: number', 'n: string'), KIT_EXPORTS);
      expect(r.status).toBe(1);
      expect(r.err).toContain('changed: @fx/b/kit Ctx.n');
    });
  });

  it('reports a type removed when only the newly internal entry still names it', () => {
    // In its own file, which no entry exports: a declaration file exports every top-level declaration of its own.
    put('packages/b/dist/hidden.d.ts', 'export interface Hidden { h: number }\n');
    const HIDDEN = `${CORE}import type { Hidden } from './hidden';\nexport declare function onlyMain(x: Hidden): void;\n`;
    setB(false, HIDDEN);
    expect(snapshot()['@fx/b (referenced) Hidden.h']).toBe('h: number;');
    commit();
    setB(true, HIDDEN);
    put('api-surface/allowed.json', JSON.stringify([internalRow]));
    const r = run(['--against', 'HEAD']);
    expect(r.status).toBe(1);
    expect(r.err).toContain('removed: @fx/b (referenced) Hidden.h');
  });

  // Two types of one name in one package: the gate compares each as itself rather than guess which is which.
  describe('a name two types share', () => {
    const manifestC = (internal: boolean): string =>
      JSON.stringify({
        name: '@fx/c',
        ...(internal ? { cloudbitmaps: { internalEntries: ['.'] } } : {}),
        exports: {
          '.': { types: './dist/index.d.ts', default: './dist/index.js' },
          './kit': { types: './dist/kit.d.ts', default: './dist/kit.js' },
          './other': { types: './dist/other.d.ts', default: './dist/other.js' },
        },
      });
    const setC = (internal: boolean, files: Record<string, string>): void => {
      put('packages/c/package.json', manifestC(internal));
      put('packages/c/dist/hidden.d.ts', 'export interface Foo { a: number }\n');
      put('packages/c/dist/other.d.ts', 'export interface Foo { a: string }\n');
      for (const [name, text] of Object.entries(files)) put(`packages/c/dist/${name}`, text);
      expect(run(['--write']).status).toBe(0);
    };
    const USES = (from: string): string =>
      `import type { Foo } from './${from}';\nexport declare function use(f: Foo): void;\n`;

    it('reports a referenced type removed when a signature moves to an exported type of the same name', () => {
      setC(false, {
        'index.d.ts': 'export declare function e(): void;\n',
        'kit.d.ts': USES('hidden'),
      });
      commit();
      setC(false, {
        'index.d.ts': 'export declare function e(): void;\n',
        'kit.d.ts': USES('other'),
      });
      expect(snapshot()['@fx/c/kit use']).toBe('function use(f: Foo): void;');
      const r = run(['--against', 'HEAD']);
      expect(r.status).toBe(1);
      expect(r.err).toContain('removed: @fx/c (referenced) Foo.a');
    });

    it('compares an internal line as itself when its referenced key in the base is another type of that name', () => {
      // The main entry exports Foo (A); the kit names A and a hidden Foo (B). The branch makes the main entry internal,
      // points the kit at A alone and changes A to B's shape: the line for B now matches, and A's change must not hide.
      const HIDDEN_B = 'export interface Foo { x: string }\n';
      const KIT = (second: string): string =>
        `import type { Foo } from './index';\nimport type { Foo as HB } from './hidden';\n` +
        `export declare function useA(f: Foo): void;\nexport declare function useB(f: ${second}): void;\n`;
      put(
        'api-surface/allowed.json',
        JSON.stringify([{ entry: '@fx/c (internal)', reason: 'ours only' }]),
      );
      setC(false, {
        'index.d.ts': 'export interface Foo { x: number }\n',
        'hidden.d.ts': HIDDEN_B,
        'kit.d.ts': KIT('HB'),
      });
      commit();
      setC(true, {
        'index.d.ts': 'export interface Foo { x: string }\n',
        'hidden.d.ts': HIDDEN_B,
        'kit.d.ts': KIT('Foo'),
      });
      put(
        'api-surface/allowed.json',
        JSON.stringify([{ entry: '@fx/c (internal)', reason: 'ours only' }]),
      );
      const r = run(['--against', 'HEAD']);
      expect(r.status).toBe(1);
      expect(r.err).toContain('removed: @fx/c Foo.x');
    });

    it('compares a name it tells apart by file as it is, so making its entry internal reads as a removal', () => {
      put(
        'api-surface/allowed.json',
        JSON.stringify([{ entry: '@fx/c (internal)', reason: 'ours only' }]),
      );
      // The main entry exports a second hidden Foo; once it is internal, the kit names both, and one is told apart by file.
      const MAIN = "export type { Foo } from './hidden2';\nexport declare function e(): void;\n";
      const TWO_REFS = `${USES('hidden')}import type { Foo as F2 } from './hidden2';\nexport declare function use2(f: F2): void;\n`;
      put('packages/c/dist/hidden2.d.ts', 'export interface Foo { b: boolean }\n');
      setC(false, { 'index.d.ts': MAIN, 'kit.d.ts': USES('hidden') });
      commit();
      setC(true, { 'index.d.ts': MAIN, 'kit.d.ts': TWO_REFS });
      expect(Object.keys(snapshot()).some((k) => /^@fx\/c \(referenced\) Foo \[/.test(k))).toBe(
        true,
      );
      put(
        'api-surface/allowed.json',
        JSON.stringify([{ entry: '@fx/c (internal)', reason: 'ours only' }]),
      );
      const r = run(['--against', 'HEAD']);
      expect(r.status).toBe(1);
      expect(r.err).toContain('removed: @fx/c Foo');
    });
  });

  it('counts exporting a referenced type as no removal, and still compares it', () => {
    setB(true);
    put('api-surface/allowed.json', JSON.stringify([internalRow]));
    commit();
    const KIT_EXPORTS = `export type { Ctx } from './index';\n${KIT}`;
    setB(true, CORE, KIT_EXPORTS);
    expect(Object.keys(snapshot()).filter((k) => k.includes('(referenced) Ctx'))).toEqual([]);
    let r = run(['--against', 'HEAD']);
    expect(r.status, r.err).toBe(0);
    setB(true, CORE.replace('n: number', 'n: string'), KIT_EXPORTS);
    r = run(['--against', 'HEAD']);
    expect(r.status).toBe(1);
    expect(r.err).toContain('changed: @fx/b/kit Ctx.n');
  });

  it('still tracks a referenced type of the internal entry', () => {
    setB(false);
    put('api-surface/allowed.json', JSON.stringify([internalRow]));
    setB(true);
    commit();
    put('api-surface/allowed.json', '[]\n');
    setB(true, CORE.replace('n: number', 'n: string'));
    const r = run(['--against', 'HEAD']);
    expect(r.status).toBe(1);
    expect(r.err).toContain('changed: @fx/b (referenced) Ctx.n');
  });

  it('does not let the internal row excuse a referenced key', () => {
    setB(true);
    put('api-surface/allowed.json', JSON.stringify([internalRow]));
    commit();
    setB(true, CORE.replace('n: number', 'n: string'));
    put('api-surface/allowed.json', JSON.stringify([{ ...internalRow, reason: 'again' }]));
    const r = run(['--against', 'HEAD']);
    expect(r.status).toBe(1);
    expect(r.err).toContain('changed: @fx/b (referenced) Ctx.n');
  });
});
