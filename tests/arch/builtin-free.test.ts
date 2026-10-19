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
  ) => Promise<{ exports: string[] }>;
  webGlobals: () => Record<string, unknown>;
  NODE_ONLY_GLOBALS: string[];
};
const { findBuiltinSpecifiers, loadWithoutNode, webGlobals, NODE_ONLY_GLOBALS } = detectors;

type Outcome = 'passes' | 'fails';
interface Layers {
  scan: Outcome;
  bundle: Outcome;
  vm: Outcome;
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
        vm = 'passes';
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
      { scan: 'fails', bundle: 'fails', vm: 'passes' },
    ],
    ['a re-export', "export * from 'node:path';", { scan: 'fails', bundle: 'fails', vm: 'passes' }],
    [
      'a lazy import nothing calls',
      "export async function f() { return import('node:crypto'); }",
      { scan: 'fails', bundle: 'fails', vm: 'passes' },
    ],
    [
      'a bare builtin name, which only the bundle sees',
      "import p from 'path'; export const x = p;",
      { scan: 'passes', bundle: 'fails', vm: 'passes' },
    ],
    [
      'a require inside try/catch, which only the scan sees',
      "export function f() { try { return require('node:fs'); } catch { return undefined; } }",
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
    [
      'a lazy Web Crypto call',
      'export function r(a: Uint8Array) { return crypto.getRandomValues(a); }'.replace(
        ': Uint8Array',
        '',
      ),
    ],
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

it('builds a load context with none of the Node-only globals', () => {
  const globals = webGlobals();
  for (const name of NODE_ONLY_GLOBALS) expect(globals).not.toHaveProperty(name);
  expect(globals).toHaveProperty('TextEncoder');
});

describe('the real source loads with no Node builtin', () => {
  const root = resolve(import.meta.dirname, '../..');
  it.each([
    ['core main entry', 'packages/core/src/index.ts', 'packages/core/tsconfig.json'],
    ['core driver-kit', 'packages/core/src/driver-kit.ts', 'packages/core/tsconfig.json'],
  ])('%s', async (_label, entry, tsconfig) => {
    const { exports } = await loadWithoutNode(join(root, entry), {
      tsconfig: join(root, tsconfig),
    });
    expect(exports.length).toBeGreaterThan(0);
  });
});
