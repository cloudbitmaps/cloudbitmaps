import { beforeAll } from 'vitest';

/**
 * Not a test: the setup of the `ts-codec` project in `vitest.config.ts`, which re-runs the store's own suites with the
 * store package's internal codec switch on the TypeScript codec instead of the native one. `tests/roaring/codec-switch.test.ts`
 * asserts the flip took effect, so the project cannot pass on native by accident.
 *
 * The flip is made in `beforeAll`, with dynamic imports, and not at the top of this file: a setup file's imports load
 * before the test file's `vi.mock` calls take effect, so importing the library here would hand every file that mocks a
 * core module the unmocked one. A store a test builds at module scope, before `beforeAll`, would still be native.
 */
beforeAll(async () => {
  const { setFlagshipCodec } = await import('@/roaring-codec');
  const { tsRoaringCodec } = await import('@/ts-roaring/bitmap');
  setFlagshipCodec(tsRoaringCodec);
});
