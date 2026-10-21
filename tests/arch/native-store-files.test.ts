import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Every test runs the store, and every suite that builds an engine, on the TypeScript codec, the store's default (a
 * test takes it from `tests/helpers/store-codec.ts`). A test reaches the native codec behind the store through the
 * store package's internal codec switch: `withNativeCodec()` (tests/helpers/codec-leg.ts) or `setFlagshipCodec` (from
 * `@/roaring-codec`). It can also import the native codec itself, by any path ending in `native-codec`, whether the
 * specifier is an alias or relative, from any directory except `tests/roaring/` and `tests/helpers/`: the oracle and
 * the differential tests live there and use the native codec as an object beside the store.
 *
 * The rule: a file reaches the native codec this way only if it is on a list below, with the reason.
 *
 *   NATIVE_STORE_FILES   the native codec is the point of the file: it flips the switch, or hands the native codec to
 *                        an engine, or tests the native bitmap class itself;
 *   NATIVE_BYTES_FILES   the file only uses the native bitmap class to build chunk bytes or decode them, an
 *                        independent reader and writer beside the store, and never passes the native codec to an
 *                        engine (no `roaringCodec` in its text).
 *
 * Both directions are held:
 *
 *   FORWARD   every file under `tests/` that names the switch or imports the native codec (outside the two oracle
 *             directories) is on a list;
 *   BACKWARD  every listed file exists and still does so, so a file that stopped needing the native codec leaves the
 *             list; a bytes-only file never names `roaringCodec`.
 *
 * "Names the switch" and "imports the native codec" are textual matches, written as the patterns below. A file that
 * reaches the native codec behind the store another way (patching a module, a re-export under another name) is not
 * seen; no test does today.
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

const NATIVE_BYTES_FILES: Readonly<Record<string, string>> = {
  'tests/bench/anchors.test.ts': 'builds the chunk bytes of a generation it then measures',
  'tests/bin/export-segments.test.ts': 'decodes an exported chunk with an independent reader',
  'tests/drivers/azure/read-timeout.test.ts': 'builds the chunk bytes of the generations it reads',
  'tests/engine.localfs.test.ts': 'builds the chunk bytes of a generation written to disk',
  'tests/export/export.test.ts': 'decodes an exported chunk with an independent reader',
  'tests/integration/azure.test.ts': 'builds chunk bytes and decodes what the backend holds',
  'tests/integration/gcs.test.ts': 'builds chunk bytes and decodes what the backend holds',
  'tests/integration/s3.test.ts': 'builds chunk bytes and decodes what the backend holds',
  'tests/tools/cost.test.ts': 'sizes a chunk by the bytes a native bitmap serializes to',
};

/** Files that define or re-export the switch rather than use it. */
const DEFINES_SWITCH = new Set([
  'tests/helpers/codec-leg.ts',
  'tests/arch/native-store-files.test.ts',
]);

/** The directories whose files hold the native codec as an oracle beside the store. */
const ORACLE_DIRS = ['tests/roaring/', 'tests/helpers/'];

const SWITCH_USE = /\bwithNativeCodec\b|\bsetFlagshipCodec\b/;
const NATIVE_IMPORT = /native-codec['"]/;
const NATIVE_ENGINE_CODEC = /\broaringCodec\b/;

/** Whether `file` puts the native codec where this rule holds it: the switch anywhere, an import outside the oracles. */
function reachesNative(file: string, text: string): boolean {
  return (
    SWITCH_USE.test(text) ||
    (!ORACLE_DIRS.some((d) => file.startsWith(d)) && NATIVE_IMPORT.test(text))
  );
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
const LISTED = new Set([...Object.keys(NATIVE_STORE_FILES), ...Object.keys(NATIVE_BYTES_FILES)]);

describe('the store runs one codec in the tests, except where the native codec is the point', () => {
  it('the pattern finds the files it exists for (a control that must hit)', () => {
    expect(
      ALL.filter((f) => !DEFINES_SWITCH.has(f) && reachesNative(f, read(f))).length,
    ).toBeGreaterThan(8);
  });

  it('FORWARD: no file puts the native codec behind the store or into core unless it is listed', () => {
    expect(strayNativeStores(ALL, read, LISTED)).toEqual([]);
  });

  it('BACKWARD: every listed file exists and still uses the native codec, with a reason', () => {
    for (const [file, reason] of [
      ...Object.entries(NATIVE_STORE_FILES),
      ...Object.entries(NATIVE_BYTES_FILES),
    ]) {
      expect(ALL, `${file} is listed and missing`).toContain(file);
      expect(
        reachesNative(file, read(file)),
        `${file} is listed and no longer uses the native codec`,
      ).toBe(true);
      expect(reason.length, `${file} needs a reason`).toBeGreaterThan(10);
    }
  });

  it('a bytes-only file never hands the native codec to an engine', () => {
    for (const file of Object.keys(NATIVE_BYTES_FILES)) {
      expect(
        NATIVE_ENGINE_CODEC.test(read(file)),
        `${file} is listed as bytes-only and names roaringCodec`,
      ).toBe(false);
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
        'tests/roaring/oracle-beside.test.ts',
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
      [
        'tests/drivers/rel.test.ts',
        "import { roaringCodec } from '../helpers/native-codec';\nnew SegmentEngine({ codec: roaringCodec });",
      ],
      ['tests/helpers/oracle.ts', "import { roaringCodec } from './native-codec';"],
      ['tests/x/storecodec.test.ts', "import { storeCodec } from '../helpers/store-codec';"],
    ]);
    const files = [...planted.keys()];
    expect(strayNativeStores(files, (f) => planted.get(f)!, LISTED)).toEqual([
      'tests/x/stray.test.ts',
      'tests/x/stray2.test.ts',
      'tests/core/stray-core.test.ts',
      'tests/drivers/rel.test.ts',
    ]);
  });
});
