import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, expect } from 'vitest';

/**
 * Not a test: the setup of the `ts-codec` project in `vitest.config.ts`, which re-runs the store's own suites with the
 * store package's internal codec switch on the TypeScript codec instead of the native one. `tests/roaring/codec-switch.test.ts`
 * asserts the flip took effect, so the project cannot pass on native by accident.
 *
 * It also guards the leg: the native codec's methods are wrapped, and a test fails when one ran while it was not
 * meant to (a store built before the flip, for instance, which would keep the native codec and leave the leg testing
 * native without a word). Two rules say which files are checked:
 *   1. Guarded: every "store file", one that builds a store with `new CloudRoaring(` or through a helper in `tests/helpers`
 *      that builds them (`new CloudRoaring(` in the helper, or an import of another such helper, to a fixed point; a helper
 *      that itself names the native codec is not one).
 *      A file that builds no store has nothing to guard.
 *   2. Exempt, because it names the native codec on purpose: a store file that names `roaringCodec` or imports the
 *      `roaring` binding, or imports a store-building helper that does (the oracle files, and the core files that hand
 *      the native codec to core).
 * Coverage: 160 of the leg's 321 files are store files; 88 are guarded and 72 exempt (11 under `tests/roaring/`, which
 * hold the native codec as the oracle or load with it on purpose, and 61 under `tests/core/`, which pass `roaringCodec`
 * to core directly because core is codec-agnostic and the file is testing core, not the store).
 * Within a guarded file, a synchronous native call whose nearest caller is a test or helper frame is exempt. After an
 * `await` only library frames remain on the stack, so a helper's native call made there can be misread as a store's (a
 * possible false positive; nothing trips it today). Not checked:
 * native calls made in a file's `beforeAll` or `afterAll` (the check runs after each test), and the rare call made
 * synchronously from a core-class method a test calls directly, with no facade frame on the stack. A store a test
 * builds at module scope is still native when the leg flips, and the guard fails it as soon as it decodes or encodes.
 *
 * The flip is made in `beforeAll`, with dynamic imports, and not at the top of this file: a setup file's imports load
 * core's modules before the test file's `vi.mock` calls take effect, so importing the library here would hand every
 * file that mocks a core module the unmocked one (five files fail that way). The native codec is restored in `afterAll`.
 */
/**
 * Whether the native codec call that is running was made for a store, as opposed to by a test or helper that seeds or
 * drives core with the native codec on purpose.
 */
function calledByStore(): boolean {
  const { stackTraceLimit, prepareStackTrace } = Error;
  // Raw call sites: formatting a stack through the source-map hook is too slow for a codec call in a loop.
  Error.stackTraceLimit = 40;
  Error.prepareStackTrace = (_error, sites) => sites;
  const sites = new Error().stack as unknown as NodeJS.CallSite[];
  Error.prepareStackTrace = prepareStackTrace;
  Error.stackTraceLimit = stackTraceLimit;
  const files = sites
    .map((site) => site.getFileName() ?? '')
    .filter(
      (file) => !file.endsWith('/setup-codec-ts.ts') && !file.endsWith('/helpers/native-codec.ts'),
    );
  // Innermost first: the nearest of a test frame (a helper that drives core with the native codec on purpose) and the
  // facade frame (a store) says who asked. Neither (a continuation of an async store operation) is a store.
  for (const file of files) {
    if (file.startsWith(TESTS_DIR)) return false;
    if (file.endsWith('/packages/roaring/src/index.ts')) return true;
  }
  return files.some((file) => /\/packages\/[^/]+\/src\//.test(file));
}

const TESTS_DIR = `${dirname(fileURLToPath(import.meta.url))}/`;

let nativeCalls: string[] = [];

const NATIVE_ON_PURPOSE = /\broaringCodec\b|from 'roaring'/;

// Helpers that build stores, found once: `new CloudRoaring(` in the helper, or an import of one that does.
let storeHelpers: string[] | undefined;
function storeBuildingHelpers(): string[] {
  if (storeHelpers) return storeHelpers;
  const dir = join(TESTS_DIR, 'helpers');
  const sources = new Map<string, string>();
  for (const entry of readdirSync(dir)) {
    if (entry.endsWith('.ts'))
      sources.set(entry.slice(0, -3), readFileSync(join(dir, entry), 'utf8'));
  }
  // A helper that names the native codec hands it to core on purpose, so a file that imports it is exempt like one that
  // names the codec itself.
  for (const [name, source] of sources) if (NATIVE_ON_PURPOSE.test(source)) sources.delete(name);
  const found = new Set<string>();
  for (const [name, source] of sources) if (source.includes('new CloudRoaring(')) found.add(name);
  for (let grew = true; grew;) {
    grew = false;
    for (const [name, source] of sources) {
      if (found.has(name)) continue;
      if ([...found].some((h) => new RegExp(`from '\\./${h}'`).test(source))) {
        found.add(name);
        grew = true;
      }
    }
  }
  storeHelpers = [...found];
  return storeHelpers;
}

const exemptFiles = new Map<string, boolean>();
function usesNativeOnPurpose(path: string): boolean {
  let exempt = exemptFiles.get(path);
  if (exempt === undefined) {
    const source = readFileSync(path, 'utf8');
    const buildsStores =
      source.includes('new CloudRoaring(') ||
      storeBuildingHelpers().some((h) =>
        new RegExp(`from '(?:\\.\\.?/)+helpers/${h}'`).test(source),
      );
    exempt = !buildsStores || NATIVE_ON_PURPOSE.test(source);
    exemptFiles.set(path, exempt);
  }
  return exempt;
}

type Codec = typeof import('@/native-codec').roaringCodec;
let restore: (() => void) | undefined;

beforeAll(async () => {
  const { roaringCodec } = await import('@/native-codec');
  const { setFlagshipCodec } = await import('@/roaring-codec');
  const { tsRoaringCodec } = await import('@/ts-roaring/bitmap');
  const methods = roaringCodec as unknown as Record<string, unknown>;
  const originals = { ...methods };
  for (const [name, original] of Object.entries(originals)) {
    if (typeof original !== 'function') continue;
    methods[name] = function (this: unknown, ...args: unknown[]) {
      if (calledByStore()) nativeCalls.push(name);
      return (original as (...a: unknown[]) => unknown).apply(this, args);
    };
  }
  setFlagshipCodec(tsRoaringCodec);
  restore = () => {
    Object.assign(methods, originals);
    setFlagshipCodec(roaringCodec as Codec);
  };
});
afterAll(() => restore?.());
beforeEach(() => {
  nativeCalls = [];
});
afterEach(() => {
  const path = expect.getState().testPath;
  if (path === undefined || usesNativeOnPurpose(path)) return;
  const calls = [...new Set(nativeCalls)];
  nativeCalls = [];
  expect(calls, 'the native codec ran on the TypeScript leg').toEqual([]);
});
