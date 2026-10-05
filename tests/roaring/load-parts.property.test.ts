import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import fc from 'fast-check';
import roaring from 'roaring';
import ts from 'typescript';
import * as library from '@/index';
import { CloudRoaring, MemoryStorage, ValidationError } from '@/index';
import { brandAsBackend } from '@/core/ports';
import { counting } from '../helpers/counting';
import { craftPortable } from '../helpers/portable-bytes';

/**
 * The loading guide's recipe for the parts of one segment built in separate processes, run as the guide prints it.
 *
 * The test reads the recipe's code block out of `docs/guide/loading.md`, compiles it and runs it, so the page and
 * the behaviour cannot drift apart: what a reader copies is what is held here.
 *
 * Held: the generation the recipe writes is byte for byte the one a load of the whole set writes, wherever the
 * range boundaries fall (inside a 65,536-id chunk or on one), from one part to eight; parts that overlap are
 * refused before anything is written; bytes that are not a well-formed bitmap are refused by the library's own
 * check rather than decoded by the native addon; and the recipe makes the requests of one load, however many
 * parts there are.
 */
const { RoaringBitmap32 } = roaring;
type Bitmap = InstanceType<typeof RoaringBitmap32>;
type Ref = { segment: string; namespace?: string };
const CHUNK = 65_536;
const SPAN = 6 * CHUNK;

interface Recipe {
  partBytes(part: Bitmap): Uint8Array;
  loadParts(store: CloudRoaring, ref: Ref, parts: Uint8Array[]): Promise<library.LoadResult>;
}

const ROOT = join(__dirname, '..', '..');

/** The guide's recipe block: its ```ts fence that declares `loadParts`. */
function recipeSource(): string {
  const guide = readFileSync(join(ROOT, 'docs', 'guide', 'loading.md'), 'utf8');
  const fences = [...guide.matchAll(/```ts\r?\n([\s\S]*?)```/g)].map((m) => m[1] as string);
  const blocks = fences.filter((code) => /export async function loadParts\b/.test(code));
  if (blocks.length !== 1) {
    throw new Error(
      'docs/guide/loading.md must hold exactly one ```ts code block that declares ' +
        `\`export async function loadParts\` (the parts recipe); it holds ${blocks.length}`,
    );
  }
  return blocks[0] as string;
}

/** The compiler's errors for `source` as a file of this repo, resolving the packages to their source. */
function typeErrorsOf(source: string): string[] {
  const config = ts.readConfigFile(join(ROOT, 'tsconfig.json'), ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, ROOT);
  const virtual = join(ROOT, 'tests', 'roaring', 'guide-recipe.virtual.ts');
  const host = ts.createCompilerHost(parsed.options);
  const { fileExists, readFile, getSourceFile } = host;
  host.fileExists = (f) => f === virtual || fileExists.call(host, f);
  host.readFile = (f) => (f === virtual ? source : readFile.call(host, f));
  host.getSourceFile = (f, ...rest) =>
    f === virtual
      ? ts.createSourceFile(f, source, parsed.options.target ?? ts.ScriptTarget.ES2022)
      : getSourceFile.call(host, f, ...rest);
  const program = ts.createProgram([virtual], parsed.options, host);
  const file = program.getSourceFile(virtual);
  return ts
    .getPreEmitDiagnostics(program, file)
    .map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'));
}

/** The guide's recipe: its code block, compiled and evaluated against this repo. */
function recipeFromGuide(): Recipe {
  const js = ts.transpileModule(recipeSource(), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  }).outputText;
  const modules: Record<string, unknown> = { roaring, '@cloudbitmaps/roaring': library };
  const require = (name: string): unknown => {
    if (!(name in modules))
      throw new Error(`the recipe imports ${name}, which this test does not provide`);
    return modules[name];
  };
  const exports: Record<string, unknown> = {};
  new Function('require', 'exports', js)(require, exports);
  return exports as unknown as Recipe;
}

const recipe = recipeFromGuide();
const ref: Ref = { segment: 'parts' };

/** Ids over six chunks: scattered ones, and sometimes a dense run that fills a chunk past the array/bitset line. */
const wholeSet = fc
  .record({
    scattered: fc.uniqueArray(fc.integer({ min: 0, max: SPAN - 1 }), { maxLength: 1_500 }),
    dense: fc.option(
      fc.record({
        from: fc.integer({ min: 0, max: SPAN - 5_000 }),
        length: fc.integer({ min: 1, max: 5_000 }),
      }),
      { nil: undefined },
    ),
  })
  .map(({ scattered, dense }) => {
    const set = new RoaringBitmap32(scattered);
    if (dense !== undefined) set.addRange(dense.from, dense.from + dense.length);
    return set;
  });

/** 0 to 7 cut points, each inside a chunk or exactly on a chunk boundary. */
const cuts = fc.array(
  fc.oneof(
    fc.integer({ min: 0, max: SPAN }),
    fc.integer({ min: 0, max: SPAN / CHUNK }).map((k) => k * CHUNK),
  ),
  { maxLength: 7 },
);

/**
 * A set and the cut points to split it at: those of {@link cuts}, and some at a member or just past one, which is
 * where a range that drops or repeats an id at its edge shows.
 */
const splitCase = fc
  .record({ set: wholeSet, cuts, picks: fc.array(fc.nat(), { maxLength: 4 }) })
  .map(({ set, cuts: cutPoints, picks }) => {
    const ids = set.toArray();
    const atMembers =
      ids.length === 0 ? [] : picks.map((n) => (ids[n % ids.length] as number) + (n % 2));
    return { set, cutPoints: [...cutPoints, ...atMembers].slice(0, 7) };
  });

/** The ids of `set` in each range between consecutive cuts: disjoint, and together exactly `set`. */
function split(set: Bitmap, cutPoints: number[]): Bitmap[] {
  const edges = [0, ...[...cutPoints].sort((a, b) => a - b), 2 ** 32];
  const ids = set.toArray();
  const parts: Bitmap[] = [];
  for (let i = 0; i + 1 < edges.length; i++) {
    const lo = edges[i] as number;
    const hi = edges[i + 1] as number;
    parts.push(new RoaringBitmap32(ids.filter((id) => id >= lo && id < hi)));
  }
  return parts;
}

/** Every object a load of `input` leaves in storage, keyed by its generation, as hex. */
async function stored(backend: MemoryStorage): Promise<Record<number, string>> {
  const out: Record<number, string> = {};
  for await (const key of backend.storage.list(ref)) {
    const tail = await backend.storage.getTail(key, 1 << 30);
    out[key.generation] = Buffer.from(tail.bytes).toString('hex');
  }
  return out;
}

async function loadWhole(
  set: Bitmap,
): Promise<{ result: library.LoadResult; objects: Record<number, string> }> {
  const backend = new MemoryStorage();
  const result = await new CloudRoaring({ storage: backend }).load(ref, set.toArray(), {
    allowEmpty: true,
  });
  return { result, objects: await stored(backend) };
}

async function loadViaRecipe(
  parts: Bitmap[],
): Promise<{ result: library.LoadResult; objects: Record<number, string> }> {
  const backend = new MemoryStorage();
  const result = await recipe.loadParts(
    new CloudRoaring({ storage: backend }),
    ref,
    parts.map((p) => recipe.partBytes(p)),
  );
  return { result, objects: await stored(backend) };
}

describe('the parts recipe in the loading guide', () => {
  it('type-checks as printed, against the packages it imports', () => {
    expect(typeErrorsOf(recipeSource())).toEqual([]);
  }, 60_000);

  it('the type check sees a type error in the recipe', () => {
    const broken = recipeSource().replace('shipped: Uint8Array[]', 'shipped: string[]');
    expect(broken).not.toBe(recipeSource());
    expect(typeErrorsOf(broken).length).toBeGreaterThan(0);
  }, 60_000);

  it('writes the generation a load of the whole set writes, for 1 to 8 parts cut anywhere', async () => {
    await fc.assert(
      fc.asyncProperty(splitCase, async ({ set, cutPoints }) => {
        const parts = split(set, cutPoints);
        expect(parts.length).toBeGreaterThanOrEqual(1);
        expect(parts.length).toBeLessThanOrEqual(8);
        expect(parts.reduce((n, p) => n + p.size, 0)).toBe(set.size);
        // An empty union is refused by any load, so there is nothing to compare.
        fc.pre(set.size > 0);
        const whole = await loadWhole(set);
        const joined = await loadViaRecipe(parts);
        expect(joined.result).toEqual(whole.result);
        expect(joined.objects).toEqual(whole.objects);
        expect(Object.keys(joined.objects)).toHaveLength(1);
      }),
      { numRuns: 60 },
    );
  });

  it('cuts inside a chunk and on a chunk boundary both load', async () => {
    const set = new RoaringBitmap32();
    set.addRange(CHUNK - 10, CHUNK + 10); // a chunk boundary in the middle of the run
    set.addRange(2 * CHUNK + 5, 2 * CHUNK + 6_000); // a dense chunk
    for (const cutPoints of [
      [CHUNK + 3],
      [CHUNK],
      [CHUNK, 2 * CHUNK + 100],
      [1, 2, 3, 4, 5, 6, 7],
    ]) {
      const joined = await loadViaRecipe(split(set, cutPoints));
      expect(joined.objects).toEqual((await loadWhole(set)).objects);
    }
  });

  it('refuses parts that overlap, and writes nothing', async () => {
    await fc.assert(
      fc.asyncProperty(
        splitCase,
        fc.nat(),
        fc.nat(),
        async ({ set, cutPoints }, pickFrom, pickTo) => {
          const parts = split(set, cutPoints);
          const filled = parts.map((p, i) => ({ p, i })).filter(({ p }) => p.size > 0);
          fc.pre(filled.length >= 2);
          const from = filled[pickFrom % filled.length]!;
          const others = filled.filter(({ i }) => i !== from.i);
          const to = others[pickTo % others.length]!;
          // One id of `from` is also in `to`: the parts now overlap by exactly it.
          to.p.add(from.p.toArray()[0] as number);
          const backend = new MemoryStorage();
          await expect(
            recipe.loadParts(
              new CloudRoaring({ storage: backend }),
              ref,
              parts.map((p) => recipe.partBytes(p)),
            ),
          ).rejects.toBeInstanceOf(ValidationError);
          expect(await stored(backend)).toEqual({});
        },
      ),
      { numRuns: 40 },
    );
  });

  it('refuses a part that is not a well-formed bitmap, before the native decoder sees it', async () => {
    // A bitset whose header says 5 values and whose bits hold 3: the native decoder takes it and answers wrongly.
    const bits = new Uint8Array(8_192);
    bits[0] = 0b111;
    const forged = craftPortable([{ key: 0, kind: 'bitset', bits, cardinality: 5 }]);
    const good = recipe.partBytes(new RoaringBitmap32([CHUNK + 1, CHUNK + 2]));
    const backend = new MemoryStorage();
    await expect(
      recipe.loadParts(new CloudRoaring({ storage: backend }), ref, [good, forged]),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(await stored(backend)).toEqual({});
    // Two serializations in one buffer are one part's bytes followed by more: refused too.
    const doubled = new Uint8Array([...good, ...good]);
    await expect(
      recipe.loadParts(new CloudRoaring({ storage: new MemoryStorage() }), ref, [doubled]),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('makes the requests of one load, whatever the number of parts', async () => {
    const set = new RoaringBitmap32();
    for (let c = 0; c < 6; c++) set.addRange(c * CHUNK + 7, c * CHUNK + 7 + 900 * (c + 1));

    const requestsOf = async (
      run: (store: CloudRoaring) => Promise<library.LoadResult>,
    ): Promise<{ storage: Record<string, number>; registry: Record<string, number> }> => {
      const backend = new MemoryStorage();
      const storage: Record<string, number> = {};
      const registry: Record<string, number> = {};
      const store = new CloudRoaring({
        storage: brandAsBackend({
          storage: counting(backend.storage, storage),
          registry: counting(backend.registry, registry),
        }),
      });
      const result = await run(store);
      expect(result.published).toBe(true);
      return { storage, registry };
    };

    const single = await requestsOf((store) => store.load(ref, set.toArray()));
    expect(Object.values(single.storage).reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
    expect(Object.values(single.registry).reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
    for (const n of [1, 3, 8]) {
      const cutPoints = Array.from(
        { length: n - 1 },
        (_, i) => (i + 1) * Math.floor(SPAN / n) + 11,
      );
      const parts = split(set, cutPoints).map((p) => recipe.partBytes(p));
      expect(parts).toHaveLength(n);
      const joined = await requestsOf((store) => recipe.loadParts(store, ref, parts));
      expect(joined).toEqual(single);
    }
  });
});
