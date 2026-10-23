import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import roaring from 'roaring';
import { tsRoaringCodec } from '@/ts-roaring/bitmap';
import { CODECS } from '../helpers/roaring-oracle';

/**
 * The oracle is a pinned CRoaring, and moving it is a deliberate change.
 *
 * `roaring` bundles one CRoaring, and the bytes `optimize()` then `serialize()` give depend on that CRoaring's
 * choices: before CRoaring 4.4.0 an array body was counted as `2 x cardinality + 2`, so a run at the array tie
 * (three consecutive values, or five in two runs) was written where 4.4.0 and later write an array. The stored-byte
 * rule in `docs/format.md` section 3 does not move with a dependency; the oracle suite checks that the pinned CRoaring
 * agrees with it. An update that changes either version below can therefore turn hundreds of oracle cases red for a
 * reason that is not a codec bug, so a change to either must be made here, on purpose.
 */
const PINNED_ROARING = '2.7.0';
const PINNED_CROARING = '4.5.0';

const require = createRequire(import.meta.url);
const installed = require('roaring/package.json') as { version: string; roaring_version?: string };

describe('the codec oracle pin', () => {
  it('uses the roaring package this oracle was written against', () => {
    expect(
      installed.version,
      `\`roaring\` is ${installed.version}, not ${PINNED_ROARING}. Bumping the oracle is a deliberate change: update PINNED_ROARING in this file in the same change, then re-check (1) the oracle suite (codec-oracle.test.ts): a failure against the written rule means the bundled CRoaring changed what it stores, so keep it pinned rather than follow it; (2) docs/format.md section 3 against the new CRoaring's array, run and bitset size rules; (3) the golden .crbm files; (4) that the version the docs name for the install still matches.`,
    ).toBe(PINNED_ROARING);
  });

  it('uses the CRoaring that roaring bundles', () => {
    expect(
      installed.roaring_version,
      `\`roaring\` ${installed.version} bundles CRoaring ${installed.roaring_version}, not ${PINNED_CROARING}. Bumping the oracle is a deliberate change: update PINNED_CROARING here, run the oracle suite, and read the new CRoaring's release notes for any change to how it sizes an array, run or bitset container (the 4.4.0 change moved the array tie). If the suite fails against the written rule in docs/format.md section 3, keep CRoaring pinned.`,
    ).toBe(PINNED_CROARING);
  });

  it('is the version the repo root declares as a dev dependency, exactly, and no package of the family depends on it', () => {
    const manifest = (path: string) =>
      JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8')) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
        peerDependencies?: Record<string, string>;
        optionalDependencies?: Record<string, string>;
      };
    expect(
      manifest('../../package.json').devDependencies?.roaring,
      'the repo root must declare `roaring` as an exact version, never a range',
    ).toBe(PINNED_ROARING);
    for (const pkg of ['core', 'roaring', 's3', 'gcs', 'azure-blob', 'tools']) {
      const m = manifest(`../../packages/${pkg}/package.json`);
      for (const field of [m.dependencies, m.peerDependencies, m.optionalDependencies]) {
        expect(
          Object.keys(field ?? {}),
          `@cloudbitmaps/${pkg} must not depend on roaring`,
        ).not.toContain('roaring');
      }
    }
  });
});

describe('the oracle compares two different codecs', () => {
  const [reference, subject] = CODECS;

  it('holds the TypeScript codec as the subject and a distinct codec as the reference', () => {
    expect(subject!.codec).toBe(tsRoaringCodec);
    expect(reference!.codec).not.toBe(subject!.codec);
    expect(reference!.codec.owns?.(tsRoaringCodec.fromValues([1]))).toBe(false);
    expect(tsRoaringCodec.owns?.(reference!.codec.fromValues([1]))).toBe(false);
  });

  it("makes the reference's bitmaps with the roaring package's own class, so it is CRoaring and nothing of ours", () => {
    const held = (reference!.codec.fromValues([1]) as unknown as { bitmap: unknown }).bitmap;
    expect(held).toBeInstanceOf(roaring.RoaringBitmap32);
  });
});
