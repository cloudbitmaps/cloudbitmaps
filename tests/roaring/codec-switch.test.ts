import { describe, expect, it } from 'vitest';
import { CloudRoaring, MemoryStorage } from '@/index';
import {
  deserializePortable,
  flagshipCodec,
  roaringCodec,
  setFlagshipCodec,
} from '@/roaring-codec';
import { tsRoaringCodec } from '@/ts-roaring/bitmap';
import roaring from 'roaring';
import { codecLeg } from '../helpers/codec-leg';

const { RoaringBitmap32 } = roaring;

/**
 * The store package's internal codec switch. The suites run once on the native codec and once, in the `ts-codec`
 * project, on the TypeScript codec; the first test here fails when the project's codec is not the one in force, so the
 * TypeScript leg cannot pass on native by accident.
 */
describe('the store package codec switch', () => {
  it('has the codec the running project asks for in force', () => {
    expect(flagshipCodec()).toBe(codecLeg() === 'ts' ? tsRoaringCodec : roaringCodec);
  });

  it('builds the codec of a store, a load and a decoded bitmap from the switch', async () => {
    const store = new CloudRoaring({ storage: new MemoryStorage() });
    await store.load({ segment: 's' }, [1, 2, 70_000]);
    expect(await store.segment('s').count()).toBe(3);
    const bytes = new RoaringBitmap32([5, 9]).serialize('portable' as never);
    const decoded = deserializePortable(bytes);
    expect([...decoded]).toEqual([5, 9]);
    // a bitmap the codec made reads back through the codec that is in force
    expect(flagshipCodec().owns!(flagshipCodec().fromValues([1]))).toBe(true);
    expect(
      flagshipCodec().owns!((codecLeg() === 'ts' ? roaringCodec : tsRoaringCodec).fromValues([1])),
    ).toBe(false);
  });

  it('flips and restores', () => {
    const was = setFlagshipCodec(roaringCodec === flagshipCodec() ? tsRoaringCodec : roaringCodec);
    try {
      expect(flagshipCodec()).not.toBe(was);
    } finally {
      expect(setFlagshipCodec(was)).not.toBe(was);
    }
    expect(flagshipCodec()).toBe(was);
  });
});
