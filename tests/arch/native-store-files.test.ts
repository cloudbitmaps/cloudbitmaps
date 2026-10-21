import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Every test runs the store on the TypeScript codec, the store's default. The one way a store reaches the native codec
 * in a test is the store package's internal codec switch: `withNativeCodec()` (tests/helpers/codec-leg.ts) or
 * `setFlagshipCodec` (from `@/roaring-codec`). Core is handed a codec as an argument and is not a store, and the oracle
 * and the differential tests use the native codec as an object beside the store, so neither is held here.
 *
 * The rule: a test file reaches for that switch only if it is on `NATIVE_STORE_FILES`, with the reason the native
 * codec is the point of that file. Both directions are held:
 *
 *   FORWARD   every file under `tests/` that names the switch is listed;
 *   BACKWARD  every listed file exists and still names it, so a file that stopped needing the native codec leaves the
 *             list.
 *
 * "Names the switch" is a textual match on the two entry points, written as one pattern below. A file that reaches
 * the native codec behind the store another way (patching a module, say) is not seen; no test does today.
 */
const NATIVE_STORE_FILES: Readonly<Record<string, string>> = {
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
    (file) => !DEFINES_SWITCH.has(file) && !listed.has(file) && SWITCH_USE.test(read(file)),
  );
}

const ALL = sources(join(ROOT, 'tests'));
const read = (file: string): string => readFileSync(join(ROOT, file), 'utf8');
const LISTED = new Set(Object.keys(NATIVE_STORE_FILES));

describe('the store runs one codec in the tests, except where the native codec is the point', () => {
  it('the pattern finds the files it exists for (a control that must hit)', () => {
    expect(
      ALL.filter((f) => !DEFINES_SWITCH.has(f) && SWITCH_USE.test(read(f))).length,
    ).toBeGreaterThan(2);
  });

  it('FORWARD: no file puts the native codec behind the store unless it is listed', () => {
    expect(strayNativeStores(ALL, read, LISTED)).toEqual([]);
  });

  it('BACKWARD: every listed file exists and still uses the switch, with a reason', () => {
    for (const [file, reason] of Object.entries(NATIVE_STORE_FILES)) {
      expect(ALL, `${file} is listed and missing`).toContain(file);
      expect(SWITCH_USE.test(read(file)), `${file} is listed and no longer uses the switch`).toBe(
        true,
      );
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
      ['tests/core/chunk-value-range.test.ts', 'withNativeCodec(() => {})'],
    ]);
    const files = [...planted.keys()];
    expect(strayNativeStores(files, (f) => planted.get(f)!, LISTED)).toEqual([
      'tests/x/stray.test.ts',
      'tests/x/stray2.test.ts',
    ]);
  });
});
