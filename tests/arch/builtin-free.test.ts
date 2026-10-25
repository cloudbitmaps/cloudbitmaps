import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * The builtin-free detectors, fired at planted inputs in BOTH directions, and run once over the real source.
 *
 * Each layer catches what the other cannot, so each planted form must fail exactly the layer(s) its row names and
 * every legitimate look-alike must pass all of them: a gate that fires on everything teaches people to route around
 * it. The real-source cases are the early warning in `pnpm test`; `pnpm smoke` is the claim about what ships.
 */
const detectors = createRequire(import.meta.url)('../../scripts/builtin-free.cjs') as {
  findBuiltinSpecifiers: (source: string) => string[];
  loadWithoutNode: (
    entryFile: string,
    options?: { tsconfig?: string },
  ) => Promise<{ exports: string[]; entry: Record<string, unknown> }>;
  webGlobals: () => Record<string, unknown>;
  NODE_ONLY_GLOBALS: string[];
};
const { findBuiltinSpecifiers, loadWithoutNode, webGlobals, NODE_ONLY_GLOBALS } = detectors;

type Outcome = 'passes' | 'fails' | 'not reached';
interface Layers {
  scan: Outcome;
  bundle: Outcome;
  vm: Outcome;
}

/** Load an entry that re-exports `chunk` in a context with web globals only, and return its exports object. */
async function loadChunk(chunk: string): Promise<Record<string, unknown>> {
  const dir = mkdtempSync(join(tmpdir(), 'builtin-free-'));
  try {
    writeFileSync(join(dir, 'index.js'), "export * from './chunk-a.js';\n");
    writeFileSync(join(dir, 'chunk-a.js'), chunk);
    return (await loadWithoutNode(join(dir, 'index.js'))).entry;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Plant `chunk` in a chunk an entry imports, run all three layers, and say which failed. */
async function layersOf(chunk: string): Promise<Layers> {
  const dir = mkdtempSync(join(tmpdir(), 'builtin-free-'));
  try {
    writeFileSync(join(dir, 'index.js'), "import './chunk-a.js';\nexport const ok = 1;\n");
    writeFileSync(join(dir, 'chunk-a.js'), chunk);
    const scan = findBuiltinSpecifiers(chunk).length > 0 ? 'fails' : 'passes';
    let bundle: Outcome = 'passes';
    let vm: Outcome = 'passes';
    try {
      await loadWithoutNode(join(dir, 'index.js'));
    } catch (e) {
      const message = String((e as Error).message);
      if (message.includes('does not bundle')) {
        bundle = 'fails';
        vm = 'not reached';
      } else {
        vm = 'fails';
      }
    }
    return { scan, bundle, vm };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('the builtin-free gate fails the layer that can see the plant', () => {
  it.each<[string, string, Layers]>([
    [
      'a static import in a chunk',
      "import fs from 'node:fs'; export const x = fs;",
      { scan: 'fails', bundle: 'fails', vm: 'not reached' },
    ],
    [
      'a re-export',
      "export * from 'node:path';",
      { scan: 'fails', bundle: 'fails', vm: 'not reached' },
    ],
    [
      'a lazy import nothing calls',
      "export async function f() { return import('node:crypto'); }",
      { scan: 'fails', bundle: 'fails', vm: 'not reached' },
    ],
    [
      'a bare builtin name, which only the bundle sees',
      "import p from 'path'; export const x = p;",
      { scan: 'passes', bundle: 'fails', vm: 'not reached' },
    ],
    [
      'a require inside try/catch, which only the scan sees',
      "export function f() { try { return require('node:fs'); } catch { return undefined; } }",
      { scan: 'fails', bundle: 'passes', vm: 'passes' },
    ],
    [
      'a require inside try/catch after a regex literal holding quotes, which only the scan sees',
      `var SIG = /(sig=["']?)[^&"']*/g;
export function redact(s) { return s.replace(SIG, '$1'); }
export function f() { try { return require('node:crypto'); } catch { return undefined; } }`,
      { scan: 'fails', bundle: 'passes', vm: 'passes' },
    ],
    [
      'process.getBuiltinModule after a regex literal holding a quote',
      `export const r = /"/g;
export function f() { return process.getBuiltinModule('node:fs'); }`,
      { scan: 'fails', bundle: 'passes', vm: 'passes' },
    ],
    [
      'process.getBuiltinModule with a node: name, which only the scan sees',
      "export function f() { return process.getBuiltinModule('node:fs'); }",
      { scan: 'fails', bundle: 'passes', vm: 'passes' },
    ],
    [
      'a top-level Buffer, which only the load sees',
      "export const x = Buffer.from('x');",
      { scan: 'passes', bundle: 'passes', vm: 'fails' },
    ],
    [
      'a top-level process, which only the load sees',
      'export const x = process.env.X;',
      { scan: 'passes', bundle: 'passes', vm: 'fails' },
    ],
  ])('%s', async (_label, chunk, expected) => {
    expect(await layersOf(chunk)).toEqual(expected);
  });
});

describe('the builtin-free gate does NOT fire on', () => {
  it.each<[string, string]>([
    ['a JSDoc naming node:crypto', '/** hashes with `node:crypto` */\nexport const x = 1;'],
    ['a line comment naming node:fs', "// reads from 'node:fs'\nexport const x = 1;"],
    [
      'an error message naming a builtin mid-sentence',
      "export const m = 'install node:crypto support first';",
    ],
    ['a message that starts with node:', "export const m = 'node: not available here';"],
    ['a property named path', 'export const o = { path: 1 }; export const p = o.path;'],
    ['a plain string naming a bare builtin', "export const s = 'fs';"],
    ['a top-level TextEncoder', 'export const e = new TextEncoder();'],
    ['a lazy Web Crypto call', 'export function r(a) { return crypto.getRandomValues(a); }'],
  ])('%s', async (_label, chunk) => {
    expect(await layersOf(chunk)).toEqual({ scan: 'passes', bundle: 'passes', vm: 'passes' });
  });
});

it('finds only whole node: specifiers, deduplicated', () => {
  const source = 'import \'node:fs/promises\'; require("node:fs/promises"); const t = `node:path`;';
  expect(findBuiltinSpecifiers(source).sort()).toEqual(['node:fs/promises', 'node:path']);
  expect(findBuiltinSpecifiers("'node:'")).toEqual([]);
  expect(findBuiltinSpecifiers("'node:Fs'")).toEqual([]);
});

describe('the scan reads tokens, not quote pairs', () => {
  it.each<[string, string, string[]]>([
    [
      'a regex with quotes before a specifier',
      `const r = /["']/g; require('node:fs');`,
      ['node:fs'],
    ],
    [
      'a division, then a specifier',
      `const a = (1 + 2) / 3; f('node:fs'); const b = 4 / 2;`,
      ['node:fs'],
    ],
    [
      'a regex after return',
      `function f(s) { return /'/.test(s); } g('node:path');`,
      ['node:path'],
    ],
    ['a template substitution, then a specifier', 'const t = `a${1}b`; f("node:fs");', ['node:fs']],
    ['a template holding a specifier alone', 'f(`node:fs`);', ['node:fs']],
    ['a template with a substitution is no specifier', 'f(`node:${x}`);', []],
    ['a specifier in a block comment', "/* 'node:fs' */ const x = 1;", []],
    ['a specifier in a regex', "const r = /'node:fs'/;", []],
  ])('%s', (_label, source, expected) => {
    expect(findBuiltinSpecifiers(source)).toEqual(expected);
  });
});

it('builds a load context with none of the Node-only globals', () => {
  const globals = webGlobals();
  for (const name of NODE_ONLY_GLOBALS) expect(globals).not.toHaveProperty(name);
  expect(globals).toHaveProperty('TextEncoder');
});

describe('the load context follows the Workers rules', () => {
  it.each<[string, string]>([
    ['a top-level getRandomValues', 'export const r = crypto.getRandomValues(new Uint8Array(1));'],
    ['a top-level randomUUID', 'export const r = crypto.randomUUID();'],
    ['a top-level setTimeout', 'export const r = setTimeout(() => {}, 1);'],
    ['a top-level fetch', "export const r = fetch('https://example.com');"],
    ['a top-level eval', "export const r = eval('1');"],
    ['a top-level new Function', "export const r = new Function('return 1');"],
  ])('refuses %s', async (_label, chunk) => {
    expect((await layersOf(chunk)).vm).toBe('fails');
  });

  it('refuses a random value asked for in a promise callback the load queued', async () => {
    const chunk =
      'Promise.resolve().then(() => crypto.getRandomValues(new Uint8Array(1))); export const ok = 1;';
    expect((await layersOf(chunk)).vm).toBe('fails');
  });

  it('allows the same calls inside a function, once the load is over', async () => {
    const entry = await loadChunk(
      `export function f(a) {
         return { bytes: crypto.getRandomValues(a), id: crypto.randomUUID(), timer: setTimeout(() => {}, 1) };
       }`,
    );
    const got = (entry.f as (a: Uint8Array) => { bytes: Uint8Array; id: string; timer: unknown })(
      new Uint8Array(8),
    );
    expect(got.bytes).toHaveLength(8);
    expect(got.id).toHaveLength(36);
    expect(got.timer).toBeDefined();
    clearTimeout(got.timer as NodeJS.Timeout);
  });

  it('exposes the isolate globals Workers, Deno and Vercel Edge share', async () => {
    const chunk = `for (const [name, type] of Object.entries({
      navigator: typeof navigator,
      CompressionStream: typeof CompressionStream,
      DecompressionStream: typeof DecompressionStream,
      TextEncoderStream: typeof TextEncoderStream,
      TextDecoderStream: typeof TextDecoderStream,
      FormData: typeof FormData,
      File: typeof File,
      self: typeof self,
    })) if (type === 'undefined') throw new Error(name + ' is missing');
    export const ok = 1;`;
    expect(await layersOf(chunk)).toEqual({ scan: 'passes', bundle: 'passes', vm: 'passes' });
  });
});

describe('the real source loads with no Node builtin', () => {
  const root = resolve(import.meta.dirname, '../..');
  it.each([
    ['core main entry', 'packages/core/src/index.ts', 'packages/core/tsconfig.json'],
    ['core driver-kit', 'packages/core/src/driver-kit.ts', 'packages/core/tsconfig.json'],
    ['roaring bitmap subpath', 'packages/roaring/src/bitmap.ts', 'packages/roaring/tsconfig.json'],
  ])('%s', async (_label, entry, tsconfig) => {
    const { exports } = await loadWithoutNode(join(root, entry), {
      tsconfig: join(root, tsconfig),
    });
    expect(exports.length).toBeGreaterThan(0);
  });
});

describe('the bitmap subpath entry fails on a plant beside its real source, and passes without one', () => {
  const root = resolve(import.meta.dirname, '../..');
  const bitmap = join(root, 'packages/roaring/src/bitmap.ts');
  const store = join(root, 'packages/roaring/src/index.ts');
  const tsconfig = join(root, 'packages/roaring/tsconfig.json');

  /** Load an entry that re-exports the real bitmap entry and `planted`, as the subpath's closure plus one more module. */
  async function loadWith(planted: string | undefined): Promise<string[]> {
    const dir = mkdtempSync(join(tmpdir(), 'builtin-free-bitmap-'));
    try {
      writeFileSync(
        join(dir, 'entry.ts'),
        `export * from ${JSON.stringify(bitmap)};\n` +
          (planted === undefined ? '' : `export * from './planted';\n`),
      );
      if (planted !== undefined) writeFileSync(join(dir, 'planted.ts'), planted);
      return (await loadWithoutNode(join(dir, 'entry.ts'), { tsconfig })).exports;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('passes with nothing planted, and exposes the class (the control that must hit)', async () => {
    expect(await loadWith(undefined)).toContain('RoaringBitmap');
  });

  it.each<[string, string, RegExp]>([
    ['a node:fs import', "import fs from 'node:fs'; export const planted = fs;", /does not bundle/],
    [
      "an import of the store, which reaches core's node entry",
      `export * from ${JSON.stringify(store)};`,
      /does not bundle/,
    ],
    ['a top-level Buffer', "export const planted = Buffer.from('x');", /Buffer|not defined/],
    ['a top-level process', 'export const planted = process.env.X;', /process|not defined/],
  ])('%s', async (_label, planted, message) => {
    await expect(loadWith(planted)).rejects.toThrow(message);
  });

  it('does not fire on the legitimate look-alikes: a TextEncoder, a lazy Web Crypto call, a comment naming node:fs', async () => {
    const exports = await loadWith(
      "// reads from 'node:fs'\nexport const planted = new TextEncoder();\nexport function r(a: Uint8Array) { return crypto.getRandomValues(a); }",
    );
    expect(exports).toContain('planted');
  });
});
