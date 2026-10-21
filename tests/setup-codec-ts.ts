import { readFileSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, beforeEach, expect } from 'vitest';

/**
 * Not a test: the setup of the `ts-codec` project in `vitest.config.ts`, which re-runs the store's own suites with the
 * store package's internal codec switch on the TypeScript codec instead of the native one. `tests/roaring/codec-switch.test.ts`
 * asserts the flip took effect, so the project cannot pass on native by accident.
 *
 * It also guards the leg: the native codec's methods are wrapped, and a test fails when one ran while it was not
 * meant to (a store built before the flip, for instance, which would keep the native codec and leave the leg testing
 * native without a word). A test file that names `roaringCodec` or imports the `roaring` binding itself (the oracle
 * files, and the core files that hand the native codec to core on purpose) is exempt. So is a native call whose nearest
 * caller is a test or helper frame. A store a test builds at module scope is still native when the leg flips, and the
 * guard fails it as soon as it decodes or encodes.
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
    .filter((file) => !file.endsWith('/setup-codec-ts.ts'));
  // Innermost first: the nearest of a test frame (a helper that drives core with the native codec on purpose) and the
  // facade frame (a store) says who asked. Neither (a continuation of an async store operation) is a store.
  for (const file of files) {
    if (file.includes('/tests/')) return false;
    if (file.endsWith('/packages/roaring/src/index.ts')) return true;
  }
  return files.some(
    (file) => /\/packages\/[^/]+\/src\//.test(file) && !file.endsWith('/roaring-codec.ts'),
  );
}

let nativeCalls: string[] = [];

const exemptFiles = new Map<string, boolean>();
function usesNativeOnPurpose(path: string): boolean {
  let exempt = exemptFiles.get(path);
  if (exempt === undefined) {
    const source = readFileSync(path, 'utf8');
    // Guarded: a file that builds a store through the package facade. Exempt: one that names the native codec itself.
    exempt = !/from '@\/index'/.test(source) || /\broaringCodec\b|from 'roaring'/.test(source);
    exemptFiles.set(path, exempt);
  }
  return exempt;
}

type Codec = typeof import('@/roaring-codec').roaringCodec;
let restore: (() => void) | undefined;

beforeAll(async () => {
  const { roaringCodec, setFlagshipCodec } = await import('@/roaring-codec');
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
