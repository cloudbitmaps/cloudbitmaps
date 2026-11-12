import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { completePass, copyOf, verdict as gate } from '../helpers/bitmap-api-pass';

/**
 * The digest of the build a bitmap-api pass measured (`bench/lib/built-digest.cjs`): it changes when a built file does,
 * a new pass without it is refused, the passes committed before it existed are not, and the bench and its gate keep
 * calling it.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const lib = createRequire(join(ROOT, 'bench', 'sizing.cjs'))('./lib/built-digest.cjs') as {
  BUILT_DIRS: string[];
  LAST_PASS_WITHOUT_BUILT: number;
  builtDigest: (root: string, dirs?: string[]) => Record<string, string>;
  builtProblems: (
    label: string,
    environment: unknown,
    number?: number,
    dirs?: string[],
  ) => string[];
};

const made: string[] = [];
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

/** A root holding the two built folders the bench imports, each with a little code, a declaration and a map. */
function built(): string {
  const root = mkdtempSync(join(tmpdir(), 'built-digest-'));
  made.push(root);
  const files: [string, string][] = [
    ['packages/core/dist/index.js', 'export const core = 1;\n'],
    ['packages/core/dist/driver-kit/index.js', 'export const kit = 1;\n'],
    ['packages/core/dist/index.d.ts', 'export declare const core: 1;\n'],
    ['packages/roaring/dist/index.js', 'export const roaring = 1;\n'],
    ['packages/roaring/dist/index.js.map', '{"version":3}\n'],
  ];
  for (const [file, text] of files) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  }
  return root;
}

const COUNT = { countResult: 'kept' };
const NEW = lib.LAST_PASS_WITHOUT_BUILT + 1;

describe('the digest of a build', () => {
  it('names each built folder with a SHA-256', () => {
    const d = lib.builtDigest(built());
    expect(Object.keys(d).sort()).toEqual([...lib.BUILT_DIRS].sort());
    for (const v of Object.values(d)) expect(v).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is the same for the same bytes and changes with a built file', () => {
    const root = built();
    const before = lib.builtDigest(root);
    expect(lib.builtDigest(root)).toEqual(before);
    writeFileSync(join(root, 'packages/roaring/dist/index.js'), 'export const roaring = 2;\n');
    const after = lib.builtDigest(root);
    expect(after['packages/roaring/dist']).not.toBe(before['packages/roaring/dist']);
    expect(after['packages/core/dist']).toBe(before['packages/core/dist']);
  });

  it('changes when a file is added, removed or renamed', () => {
    const root = built();
    const base = lib.builtDigest(root)['packages/core/dist'];
    const extra = join(root, 'packages/core/dist/extra.js');
    writeFileSync(extra, '');
    const added = lib.builtDigest(root)['packages/core/dist'];
    expect(added).not.toBe(base);
    rmSync(extra);
    expect(lib.builtDigest(root)['packages/core/dist']).toBe(base);
    const moved = join(root, 'packages/core/dist/driver-kit/other.js');
    writeFileSync(moved, readFileSync(join(root, 'packages/core/dist/driver-kit/index.js')));
    rmSync(join(root, 'packages/core/dist/driver-kit/index.js'));
    expect(lib.builtDigest(root)['packages/core/dist']).not.toBe(base);
  });

  it('leaves out declarations and source maps, which no import runs', () => {
    const root = built();
    const base = lib.builtDigest(root);
    writeFileSync(join(root, 'packages/core/dist/index.d.ts'), '// edited\n');
    writeFileSync(join(root, 'packages/roaring/dist/index.js.map'), '{}\n');
    expect(lib.builtDigest(root)).toEqual(base);
  });

  it('fails closed on a missing or empty built folder', () => {
    const root = built();
    rmSync(join(root, 'packages/roaring/dist'), { recursive: true });
    expect(() => lib.builtDigest(root)).toThrow(/pnpm build first/);
    mkdirSync(join(root, 'packages/roaring/dist'));
    expect(() => lib.builtDigest(root)).toThrow(/no built code/);
  });
});

describe('the gate reads the digest of a pass', () => {
  const ok = () => lib.builtDigest(built());
  const problems = (environment: unknown, number: number | undefined) =>
    lib.builtProblems('pass 9', environment, number);

  it('refuses a new pass without it', () => {
    const found = problems({}, NEW);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(/does not record the digest of the build/);
    expect(problems({}, undefined)).toHaveLength(1);
    expect(problems(undefined, NEW)).toHaveLength(1);
  });

  it('accepts the passes committed before the field existed, and a new one that has it', () => {
    for (let n = 1; n <= lib.LAST_PASS_WITHOUT_BUILT; n++) expect(problems({}, n)).toEqual([]);
    expect(problems({ built: ok() }, NEW)).toEqual([]);
    expect(problems({ built: ok() }, 1)).toEqual([]);
  });

  it.each([
    ['not an object', () => 'x', /not an object/],
    [
      'a missing folder',
      (b: Record<string, unknown>) => ({ 'packages/core/dist': b['packages/core/dist'] }),
      /names/,
    ],
    [
      'an extra folder',
      (b: Record<string, unknown>) => ({ ...b, 'packages/s3/dist': 'a'.repeat(64) }),
      /names/,
    ],
    [
      'a short digest',
      (b: Record<string, unknown>) => ({ ...b, 'packages/core/dist': 'abc' }),
      /not a SHA-256/,
    ],
    [
      'an upper-case digest',
      (b: Record<string, unknown>) => ({ ...b, 'packages/core/dist': 'A'.repeat(64) }),
      /not a SHA-256/,
    ],
  ])('refuses %s, for an old pass too', (_name, make, message) => {
    for (const n of [1, NEW]) {
      const found = problems({ built: make(ok()) }, n);
      expect(found).toHaveLength(1);
      expect(found[0]).toMatch(message);
    }
  });
});

describe('the bitmap-api gate and bench use it', () => {
  const read = (file: string) => readFileSync(join(ROOT, file), 'utf8');

  it('the gate refuses a numbered new pass of the record without the digest and takes an old one', () => {
    const old = completePass();
    expect(gate.gateProblems([old], COUNT)).toEqual([]);
    const fresh = copyOf(old);
    fresh.pass = NEW;
    expect(gate.gateProblems([fresh], COUNT).join('\n')).toMatch(
      /does not record the digest of the build/,
    );
    fresh.environment.built = Object.fromEntries(lib.BUILT_DIRS.map((d) => [d, 'a'.repeat(64)]));
    expect(gate.gateProblems([fresh], COUNT)).toEqual([]);
  });

  it('every committed pass is at or below the last one allowed without it, or has it', () => {
    const file = JSON.parse(read('bench/bitmap-api-results.json')) as {
      passes: { pass: number; environment: { built?: unknown } }[];
    };
    for (const p of file.passes) {
      expect(p.pass <= lib.LAST_PASS_WITHOUT_BUILT || p.environment.built !== undefined).toBe(true);
    }
  });

  it('bitmap-api.cjs records the digest of the folders it imports, beside head', () => {
    expect(read('bench/bitmap-api.cjs')).toMatch(
      /head: git\('rev-parse', 'HEAD'\),\n\s+built: builtDigest\(ROOT\),/,
    );
  });
});
