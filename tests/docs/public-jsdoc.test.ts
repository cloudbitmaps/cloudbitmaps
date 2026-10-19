import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import {
  entryPoints,
  openSurface,
  surfaceKeys,
  type Surface,
  undocumentedSurfaceEntries,
} from './surface-docs';

// Every public method on the facade must carry its own JSDoc — and this gate exists because the way it gets
// lost is invisible.
//
// Inserting a new method's doc block between an EXISTING doc block and the member it documents silently
// reassigns it: TypeScript binds a doc comment to the declaration that follows it, so the old member ends up
// with none. Nothing catches that. Lint does not, prettier does not, `tsc` does not, and no test does — the
// code is still correct, so the only symptom is a shipped verb that lost its hover text and its entry in the
// published `.d.ts`.
//
// Adding a method above an existing one is an ordinary edit, so this is the likely accident rather than an
// exotic one, and it earns a check instead of more care.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const FACADE = join(ROOT, 'packages/roaring/src/index.ts');

/** Members that are deliberately self-explanatory, or documented on the interface they implement. */
const EXEMPT = new Set(['constructor', Symbol.asyncIterator.toString(), '[Symbol.asyncIterator]']);

interface Undocumented {
  readonly cls: string;
  readonly member: string;
}

function undocumentedPublicMembers(): Undocumented[] {
  const source = ts.createSourceFile(
    'index.ts',
    readFileSync(FACADE, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const out: Undocumented[] = [];

  const isPublic = (node: ts.MethodDeclaration): boolean => {
    const mods = ts.getModifiers(node) ?? [];
    return !mods.some(
      (m) => m.kind === ts.SyntaxKind.PrivateKeyword || m.kind === ts.SyntaxKind.ProtectedKeyword,
    );
  };

  const walk = (node: ts.Node): void => {
    if (ts.isClassDeclaration(node) && node.name !== undefined) {
      const cls = node.name.getText();
      for (const member of node.members) {
        if (!ts.isMethodDeclaration(member) || member.name === undefined) continue;
        if (!isPublic(member)) continue;
        const name = member.name.getText();
        if (EXEMPT.has(name) || name.startsWith('#')) continue;
        if ((ts.getJSDocCommentsAndTags(member) ?? []).length === 0)
          out.push({ cls, member: name });
      }
    }
    ts.forEachChild(node, walk);
  };
  walk(source);
  return out;
}

describe('the public facade keeps its documentation', () => {
  it('every public method has a JSDoc block bound to it', () => {
    const missing = undocumentedPublicMembers().map((m) => `${m.cls}.${m.member}`);
    expect(
      missing,
      'public method(s) with no JSDoc — most likely a new doc block was inserted between an existing ' +
        'comment and the member it documented, which silently reassigns it',
    ).toEqual([]);
  });

  it('is not vacuous — it actually finds the facade methods it is checking', () => {
    const source = ts.createSourceFile(
      'index.ts',
      readFileSync(FACADE, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    let documented = 0;
    const walk = (node: ts.Node): void => {
      if (ts.isMethodDeclaration(node) && (ts.getJSDocCommentsAndTags(node) ?? []).length > 0) {
        documented++;
      }
      ts.forEachChild(node, walk);
    };
    walk(source);
    // If a refactor ever makes this parser stop seeing methods, the first test would pass trivially.
    expect(documented).toBeGreaterThan(20);
  });
});

// The same accident anywhere in the packages: a doc block left above another one documents nothing. TypeScript hands
// every doc block before a declaration to that declaration and reads only the last, so the first is lost, and when it
// was the declaration's own (an export's `@deprecated` included) the published `.d.ts` loses it too. A file's opening
// comment followed by its first declaration's is the one legitimate pair.

/** Every `.ts` file under `packages/<name>/src`. */
function sourceFiles(): string[] {
  const out: string[] = [];
  const walkDir = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walkDir(path);
      else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) out.push(path);
    }
  };
  for (const pkg of readdirSync(join(ROOT, 'packages'), { withFileTypes: true })) {
    const src = join(ROOT, 'packages', pkg.name, 'src');
    if (pkg.isDirectory() && existsSync(src)) walkDir(src);
  }
  return out;
}

/**
 * `file:line` of every doc block that stands directly above another, and how many doc blocks there are in all. Read
 * from each node's leading comments: `getJSDocCommentsAndTags` reports only the block TypeScript keeps, the last.
 */
function doubleDocumented(): { found: string[]; documented: number } {
  const found: string[] = [];
  let documented = 0;
  for (const file of sourceFiles()) {
    const text = readFileSync(file, 'utf8');
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const seen = new Set<number>();
    const walk = (node: ts.Node): void => {
      const at = node.getFullStart();
      if (!seen.has(at)) {
        seen.add(at);
        const blocks = (ts.getLeadingCommentRanges(text, at) ?? []).filter(
          (c) => c.kind === ts.SyntaxKind.MultiLineCommentTrivia && text.startsWith('/**', c.pos),
        );
        documented += blocks.length;
        // The file's opening comment stands before its first declaration's; it is the one block that may.
        const opening =
          blocks[0] !== undefined && text.slice(0, blocks[0].pos).trim() === '' ? 1 : 0;
        if (blocks.length - opening > 1) {
          const { line } = source.getLineAndCharacterOfPosition(blocks[opening]!.pos);
          found.push(`${relative(ROOT, file)}:${line + 1}`);
        }
      }
      ts.forEachChild(node, walk);
    };
    walk(source);
  }
  return { found, documented };
}

describe('no doc block is left above another', () => {
  it('every declaration in the packages carries one doc block, its own', () => {
    expect(
      doubleDocumented().found,
      'a doc block followed by another one: the first documents nothing. Move it to the declaration it describes, ' +
        'or delete it if that declaration has its own',
    ).toEqual([]);
  });

  it('is not vacuous — it reads the documented declarations of every package', () => {
    expect(doubleDocumented().documented).toBeGreaterThan(1000);
  });
});

// Every entry of the published surface, not only the facade's methods: `api-surface/surface.json` lists what a user can
// reach, so each of its keys must show hover text. A key passes with its own doc block or one inherited from the member
// it implements or overrides, and a key the gate cannot resolve fails, named. The rule and its limits are in
// `surface-docs.ts`.
describe('every public entry carries hover text', () => {
  // One program serves both tests.
  let program: Surface | undefined;
  const surface = (): Surface => (program ??= openSurface(ROOT));
  it('has a doc block on each entry of api-surface/surface.json, its own or inherited', () => {
    const missing = undocumentedSurfaceEntries(ROOT, surfaceKeys(ROOT), surface()).map(
      (f) => `${f.key}  (${f.reason})`,
    );
    expect(
      missing,
      'public entries with no hover text: add a doc block to each declaration listed (an overload needs its own)',
    ).toEqual([]);
  }, 120_000);

  it('is not vacuous: it resolves a large surface and reports a key it cannot resolve', () => {
    const keys = surfaceKeys(ROOT);
    expect(keys.length).toBeGreaterThan(500);
    const found = undocumentedSurfaceEntries(
      ROOT,
      ['@cloudbitmaps/roaring NoSuchExport'],
      surface(),
    );
    expect(found).toHaveLength(1);
    expect(found[0]?.key).toBe('@cloudbitmaps/roaring NoSuchExport');
  }, 120_000);
});

// The gate's own rules, held on small source trees written for each case: every rule fails on the shape it exists for
// and passes on the look-alike it must leave alone.

/** Writes `files` (paths under `packages/core/src`) as the `@cloudbitmaps/core` package of a throwaway tree. */
function withTree<T>(
  files: Record<string, string>,
  run: (root: string) => T,
  extraPackages: Record<string, unknown> = {},
): T {
  const root = mkdtempSync(join(tmpdir(), 'surface-docs-'));
  try {
    const put = (rel: string, text: string): void => {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), text);
    };
    put(
      'packages/core/package.json',
      JSON.stringify({
        name: '@cloudbitmaps/core',
        exports: {
          '.': { types: './dist/index.d.ts', default: './dist/index.js' },
          ...extraPackages,
        },
      }),
    );
    for (const [rel, text] of Object.entries(files)) put(`packages/core/src/${rel}`, text);
    return run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** The findings of `keys` over a one-package tree, as `key (reason)` lines. */
function findings(files: Record<string, string>, keys: string[]): string[] {
  return withTree(files, (root) =>
    undocumentedSurfaceEntries(root, keys).map((f) => `${f.key} (${f.reason})`),
  );
}

const K = '@cloudbitmaps/core';

describe('the surface gate judges each overload on its own block', () => {
  const source = (first: string, second: string, impl: string): Record<string, string> => ({
    'index.ts': `export class Box {
  ${first}
  put(a: string): string;
  ${second}
  put(a: number): number;
  ${impl}
  put(a: string | number): string | number {
    return a;
  }
}
`,
  });
  const keys = [`${K} Box`, `${K} Box.put`, `${K} Box.put #2`];
  const doc = '/** Documented. */';

  it('fails the overload the unnumbered key names when it has no block, though a later one and the implementation do', () => {
    const got = findings(source('', doc, doc), keys);
    expect(got.map((g) => g.split(' (')[0])).toEqual([`${K} Box`, `${K} Box.put`]);
  });

  it('fails the second form with no block, named', () => {
    const got = findings(source(doc, '', doc), keys.slice(1));
    expect(got.map((g) => g.split(' (')[0])).toEqual([`${K} Box.put #2`]);
  });

  it('passes when each form carries its own block, and the implementation needs none', () => {
    expect(findings(source(doc, doc, ''), keys.slice(1))).toEqual([]);
  });

  it('still lets a member with one declaration inherit the block of the member it implements', () => {
    const got = findings(
      {
        'index.ts': `/** Port. */
export interface Port {
  /** Sends. */
  send(): void;
}
/** Adapter. */
export class Adapter implements Port {
  send(): void {}
}
`,
      },
      [`${K} Adapter.send`],
    );
    expect(got).toEqual([]);
  });
});

describe('the surface gate needs a parameter property to carry its own block', () => {
  const keys = [`${K} Box.root`];
  const cls = (ctorDoc: string, paramDoc: string): Record<string, string> => ({
    'index.ts': `/** A box. */
export class Box {
  ${ctorDoc}
  constructor(${paramDoc} readonly root: string) {}
}
`,
  });

  it('fails a property documented only by the constructor @param tag', () => {
    const got = findings(cls('/** Builds it.\n * @param root Where it lives. */', ''), keys);
    expect(got).toHaveLength(1);
    expect(got[0]).toContain(`${K} Box.root`);
  });

  it('passes a property whose parameter has its own block', () => {
    expect(findings(cls('/** Builds it. */', '/** Where it lives. */'), keys)).toEqual([]);
  });
});

describe('the surface gate fails a form it cannot find', () => {
  const files = {
    'index.ts': `/** A box. */
export class Box {
  /** Builds from a name. */
  constructor(name: string);
  /** Builds from a number. */
  constructor(n: number);
  /** Implementation. */
  constructor(x: string | number) {}
  /** First. */
  put(a: string): string;
  /** Second. */
  put(a: number): number;
  /** Implementation. */
  put(a: string | number): string | number {
    return a;
  }
}
/** First. */
export function estimate(a: string): string;
/** Second. */
export function estimate(a: number): number;
/** Implementation. */
export function estimate(a: string | number): string | number {
  return a;
}
/** Options. */
export interface SegmentOptions {
  /** A name. */
  readonly name?: string;
}
/** A class with no constructor of its own. */
export class Plain {}
`,
  };

  it.each([
    ['a method form past the last one', `${K} Box.put #9`],
    ['the source-only implementation of a method', `${K} Box.put #3`],
    ['a constructor form past the last one', `${K} Box.constructor #5`],
    ['the implementation signature of a constructor', `${K} Box.constructor #3`],
    ['a function form past the last one', `${K} estimate #7`],
    ['the implementation of a function', `${K} estimate #3`],
    ['a value half that does not exist', `${K} SegmentOptions (value)`],
    ['a constructor form on a class that has none', `${K} Plain.constructor #2`],
  ])('fails %s', (_what, key) => {
    const got = findings(files, [key]);
    expect(got).toHaveLength(1);
    expect(got[0]).toContain(key);
  });

  it('passes the forms that exist', () => {
    expect(
      findings(files, [
        `${K} Box.put`,
        `${K} Box.put #2`,
        `${K} Box.constructor`,
        `${K} Box.constructor #2`,
        `${K} estimate`,
        `${K} estimate #2`,
        `${K} Plain.constructor`,
      ]),
    ).toEqual([]);
  });
});

describe('the surface gate fails a name declared in more than one file', () => {
  const entry = `import type { ChurnDeps } from './leases';
/** Runs it. */
export function churn(deps: ChurnDeps): void {}
`;
  const key = `${K} (referenced) ChurnDeps`;

  it('fails a referenced name that two files declare, naming both files', () => {
    const got = findings(
      {
        'index.ts': `import './errors';\n${entry}`,
        'leases.ts': 'export interface ChurnDeps {}\n',
        'errors.ts': '/** An unrelated one. */\ninterface ChurnDeps {}\n',
      },
      [key],
    );
    expect(got).toHaveLength(1);
    expect(got[0]).toContain('leases.ts');
    expect(got[0]).toContain('errors.ts');
  });

  it('judges a referenced name that one file declares on that declaration', () => {
    const files = {
      'index.ts': entry,
      'leases.ts': '/** Deps. */\nexport interface ChurnDeps {}\n',
    };
    expect(findings(files, [key])).toEqual([]);
    const bare = { 'index.ts': entry, 'leases.ts': 'export interface ChurnDeps {}\n' };
    expect(findings(bare, [key])).toHaveLength(1);
  });

  it('does not count a name two files declare when the entry exports one of them', () => {
    const got = findings(
      {
        'index.ts': "export { Held } from './a';\n",
        'a.ts': '/** The exported one. */\nexport interface Held {}\n',
        'b.ts': 'interface Held {}\n',
      },
      [`${K} Held`],
    );
    expect(got).toEqual([]);
  });
});

describe('the surface gate credits a statement block to the first name it declares', () => {
  const files = {
    'index.ts': `/** Both counters. */
export const a = 1, b = 2;
declare const src: { A: number; B: number };
/** Both parts. */
export const { A, B } = src;
`,
  };

  it('passes the first name of a statement and fails the others', () => {
    const got = findings(files, [`${K} a`, `${K} b`, `${K} A`, `${K} B`]);
    expect(got.map((g) => g.split(' (')[0])).toEqual([`${K} b`, `${K} B`]);
  });
});

describe('the surface gate takes its entry points from the packages', () => {
  it('fails a key for a specifier that is no entry point, named', () => {
    const got = findings({ 'index.ts': '/** X. */\nexport const X = 1;\n' }, [
      '@cloudbitmaps/core/newentry X',
    ]);
    expect(got).toHaveLength(1);
    expect(got[0]).toContain('@cloudbitmaps/core/newentry X');
    expect(got[0]).toContain('entry point');
  });

  it('resolves a subpath that a package lists in its exports', () => {
    const got = withTree(
      { 'index.ts': '/** X. */\nexport const X = 1;\n', 'extra.ts': 'export const Y = 2;\n' },
      (root) => undocumentedSurfaceEntries(root, ['@cloudbitmaps/core/extra Y', `${K} X`]),
      { './extra': { types: './dist/extra.d.ts', default: './dist/extra.js' } },
    );
    expect(got.map((f) => f.key)).toEqual(['@cloudbitmaps/core/extra Y']);
    expect(got[0]?.reason).toContain('doc');
  });

  it('lists every entry point of the real packages, and each file exists', () => {
    const entries = entryPoints(ROOT);
    expect(Object.keys(entries).sort()).toEqual([
      '@cloudbitmaps/azure-blob',
      '@cloudbitmaps/core',
      '@cloudbitmaps/core/driver-kit',
      '@cloudbitmaps/gcs',
      '@cloudbitmaps/roaring',
      '@cloudbitmaps/s3',
      '@cloudbitmaps/tools',
    ]);
    for (const e of Object.values(entries)) expect(existsSync(e.file)).toBe(true);
  });
});

describe('the surface gate resolves a key that is not referenced through its entry only', () => {
  const inner = { 'inner.ts': '/** Hidden. */\nexport interface Hidden {}\n' };

  it('fails a name its entry does not export, though a file of the package documents it', () => {
    const got = findings(
      {
        'index.ts': "import type { Hidden } from './inner';\nexport type Alias = Hidden;\n",
        ...inner,
      },
      [`${K} Hidden`],
    );
    expect(got).toHaveLength(1);
    expect(got[0]).toContain(`${K} Hidden`);
    expect(got[0]).toContain('not exported');
  });

  it('passes the same name once the entry exports it', () => {
    expect(
      findings({ 'index.ts': "export * from './inner';\n", ...inner }, [`${K} Hidden`]),
    ).toEqual([]);
  });
});

describe('the surface gate refuses an entry whose source file is missing', () => {
  it('throws, naming the file', () => {
    const run = (): unknown =>
      withTree({ 'index.ts': '/** X. */\nexport const X = 1;\n' }, (root) => openSurface(root), {
        './gone': { types: './dist/gone.d.ts', default: './dist/gone.js' },
      });
    expect(run).toThrow(/gone\.ts/);
  });
});

describe('the surface gate lets a parameter property inherit when no tag names it', () => {
  const cls = (ctorDoc: string): Record<string, string> => ({
    'index.ts': `/** A port. */
export interface Port {
  /** Where it lives. */
  readonly root: string;
}
/** A box. */
export class Box implements Port {
  ${ctorDoc}
  constructor(readonly root: string) {}
}
/** A plain box. */
export class Plain {
  /** Builds it. */
  constructor(readonly home: string) {}
}
`,
  });

  it('passes a property that implements a documented member and is named by no @param tag', () => {
    expect(findings(cls('/** Builds it. */'), [`${K} Box.root`])).toEqual([]);
  });

  it('fails the property when a @param tag names it', () => {
    const got = findings(cls('/** Builds it.\n * @param root The directory. */'), [
      `${K} Box.root`,
    ]);
    expect(got).toHaveLength(1);
  });

  it('fails a property that implements nothing and has no block of its own', () => {
    expect(findings(cls('/** Builds it. */'), [`${K} Plain.home`])).toHaveLength(1);
  });
});

describe('the surface gate credits a later name of a statement when it alone is public', () => {
  const files = (exportLine: string): Record<string, string> => ({
    'index.ts': `declare const src: { A: number; B: number };
/** Both parts. */
const { A, B } = src;
/** Both counters. */
const a = 1, b = 2;
${exportLine}
`,
  });

  it('passes the later name when the earlier one is not exported', () => {
    expect(findings(files('export { B, b };'), [`${K} B`, `${K} b`])).toEqual([]);
  });

  it('fails the later name when the earlier one is exported too', () => {
    const got = findings(files('export { A, B, a, b };'), [`${K} A`, `${K} B`, `${K} a`, `${K} b`]);
    expect(got.map((g) => g.split(' (')[0])).toEqual([`${K} B`, `${K} b`]);
  });
});
