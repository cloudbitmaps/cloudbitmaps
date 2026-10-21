import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Every test runs the store, and core's suites run core, on the TypeScript codec, the store's default (core's files
 * take it from `tests/helpers/store-codec.ts`). A test reaches the native codec behind the store through the store
 * package's internal codec switch: `withNativeCodec()` (tests/helpers/codec-leg.ts) or `setFlagshipCodec` (from
 * `@/roaring-codec`); a core suite reaches it by importing `@/native-codec`. The oracle and the differential tests use
 * the native codec as an object beside the store, so they are not held here.
 *
 * The rule: a test file reaches the native codec this way only if it is on `NATIVE_STORE_FILES`, with the reason the
 * native codec is the point of that file. Both directions are held:
 *
 *   FORWARD   every file under `tests/` that names the switch, and every file under `tests/core/` that imports the
 *             native codec, is listed;
 *   BACKWARD  every listed file exists and still does so, so a file that stopped needing the native codec leaves the
 *             list.
 *
 * "Names the switch" and "imports the native codec" are textual matches, written as the patterns below. A file that
 * reaches the native codec behind the store another way (patching a module, say) is not seen; no test does today.
 */
const NATIVE_STORE_FILES: Readonly<Record<string, string>> = {
  'tests/core/bitmap.test.ts':
    "is the native codec's own unit test: it exercises the native bitmap class directly",
  'tests/core/chunk-value-range.test.ts':
    'compares a stored chunk with the bytes a native bitmap serializes to',
  'tests/roaring/codec-switch.test.ts':
    'holds the switch itself: it flips it both ways and restores it',
  'tests/roaring/deserialize-portable.test.ts':
    'spies on the native decoder to prove what a decode does and does not call',
  'tests/roaring/load-no-per-id.test.ts':
    'counts the native bitmap calls a load makes, beside the TypeScript counts',
};

/** Files that define or re-export the switch rather than use it. */
const DEFINES_SWITCH = new Set([
  'tests/helpers/codec-leg.ts',
  'tests/arch/native-store-files.test.ts',
]);

const SWITCH_USE = /\bwithNativeCodec\b|\bsetFlagshipCodec\b/;
const NATIVE_IMPORT = /['"]@\/native-codec['"]/;

/** Whether `file` puts the native codec where this rule holds it: the switch anywhere, an import in a core suite. */
function reachesNative(file: string, text: string): boolean {
  return SWITCH_USE.test(text) || (file.startsWith('tests/core/') && NATIVE_IMPORT.test(text));
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'fixtures' && entry.name !== 'node_modules') out.push(...sources(path));
    } else if (entry.name.endsWith('.ts')) out.push(relative(ROOT, path));
  }
  return out;
}

/** The files in `files` that use the switch and are not on `listed`, whatever their text. */
function strayNativeStores(
  files: readonly string[],
  read: (file: string) => string,
  listed: ReadonlySet<string>,
): string[] {
  return files.filter(
    (file) => !DEFINES_SWITCH.has(file) && !listed.has(file) && reachesNative(file, read(file)),
  );
}

const ALL = sources(join(ROOT, 'tests'));
const read = (file: string): string => readFileSync(join(ROOT, file), 'utf8');
const LISTED = new Set(Object.keys(NATIVE_STORE_FILES));

describe('the store runs one codec in the tests, except where the native codec is the point', () => {
  it('the pattern finds the files it exists for (a control that must hit)', () => {
    expect(
      ALL.filter((f) => !DEFINES_SWITCH.has(f) && reachesNative(f, read(f))).length,
    ).toBeGreaterThan(2);
  });

  it('FORWARD: no file puts the native codec behind the store or into core unless it is listed', () => {
    expect(strayNativeStores(ALL, read, LISTED)).toEqual([]);
  });

  it('BACKWARD: every listed file exists and still uses the native codec, with a reason', () => {
    for (const [file, reason] of Object.entries(NATIVE_STORE_FILES)) {
      expect(ALL, `${file} is listed and missing`).toContain(file);
      expect(
        reachesNative(file, read(file)),
        `${file} is listed and no longer uses the native codec`,
      ).toBe(true);
      expect(reason.length, `${file} needs a reason`).toBeGreaterThan(10);
    }
  });

  it('fires at a planted stray native store, and stays quiet for the listed files and look-alikes', () => {
    const planted = new Map([
      [
        'tests/x/stray.test.ts',
        "import { withNativeCodec } from '../helpers/codec-leg';\nit('x', withNativeCodec(() => {}));",
      ],
      ['tests/x/stray2.test.ts', 'setFlagshipCodec(roaringCodec);'],
      [
        'tests/x/oracle.test.ts',
        "import { roaringCodec } from '@/native-codec';\nroaringCodec.fromValues([1]);",
      ],
      ['tests/x/core.test.ts', 'new SegmentEngine({ storage, codec: roaringCodec });'],
      [
        'tests/core/stray-core.test.ts',
        "import { roaringCodec } from '@/native-codec';\nnew SegmentEngine({ storage, codec: roaringCodec });",
      ],
      [
        'tests/core/store-core.test.ts',
        "import { storeCodec } from '../helpers/store-codec';\nnew SegmentEngine({ storage, codec: storeCodec });",
      ],
      ['tests/core/chunk-value-range.test.ts', "import { SafeBitmap } from '@/native-codec';"],
    ]);
    const files = [...planted.keys()];
    expect(strayNativeStores(files, (f) => planted.get(f)!, LISTED)).toEqual([
      'tests/x/stray.test.ts',
      'tests/x/stray2.test.ts',
      'tests/core/stray-core.test.ts',
    ]);
  });
});
