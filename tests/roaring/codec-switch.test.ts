import { describe, expect, it } from 'vitest';
import { CloudRoaring, MemoryStorage, RoaringBitmap } from '@/index';
import { flagshipCodec, setFlagshipCodec } from '@/roaring-codec';
import { roaringCodec } from '@/native-codec';
import { tsRoaringCodec } from '@/ts-roaring/bitmap';
import roaring from 'roaring';

const { RoaringBitmap32 } = roaring;

/**
 * The store package's internal codec switch. Every suite runs on the TypeScript codec, the store's default; the first
 * test here fails when it is not the one in force, so no project passes on native by accident. A harness flips the
 * switch to the native codec, the oracle's reference, for the tests that compare the two.
 */
describe('the store package codec switch', () => {
  it('has the TypeScript codec in force by default', () => {
    expect(flagshipCodec()).toBe(tsRoaringCodec);
  });

  it('builds the codec of a store and a load from the switch, and decodes bytes with the TypeScript codec whatever it holds', async () => {
    const store = new CloudRoaring({ storage: new MemoryStorage() });
    await store.load({ segment: 's' }, [1, 2, 70_000]);
    expect(await store.segment('s').count()).toBe(3);
    const bytes = new RoaringBitmap32([5, 9]).serialize('portable' as never);
    const decoded = RoaringBitmap.deserialize(bytes);
    expect([...decoded]).toEqual([5, 9]);
    // a bitmap the codec made reads back through the codec that is in force
    expect(flagshipCodec().owns!(flagshipCodec().fromValues([1]))).toBe(true);
    expect(flagshipCodec().owns!(roaringCodec.fromValues([1]))).toBe(false);
  });

  it('names which codec asks for the smallest-first intersect order: the TypeScript codec, not the native one', () => {
    expect(tsRoaringCodec.intersectSmallestFirst).toBe(true);
    expect(roaringCodec.intersectSmallestFirst).not.toBe(true);
  });

  it('does not move the public class: RoaringBitmap.deserialize decodes in TypeScript when the switch is native', () => {
    const was = setFlagshipCodec(roaringCodec);
    try {
      const decoded = RoaringBitmap.deserialize(
        new RoaringBitmap32([5, 9]).serialize('portable' as never),
      );
      expect(tsRoaringCodec.owns!(flagshipCodec().fromValues([1]))).toBe(false);
      expect([...decoded]).toEqual([5, 9]);
      decoded.add(11);
      expect(decoded.toArray()).toEqual([5, 9, 11]);
    } finally {
      setFlagshipCodec(was);
    }
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
