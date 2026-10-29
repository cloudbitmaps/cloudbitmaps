import { describe, expect, it } from 'vitest';
import { TsBitmap } from '@/ts-roaring/bitmap';
import { BITSET } from '@/ts-roaring/containers';
import { decodeContainers } from '@/ts-roaring/wire';

/**
 * A detached decode holds no view of its input's copy, whatever the mix of kinds and however few small containers
 * there are: a bitset has an array of its own, arrays and runs sit on slabs (see detached-slab.test.ts), and it holds
 * the same ids as the decode that reads in place.
 */
const range = (a: number, b: number) => Array.from({ length: b - a }, (_, i) => a + i);

function bytesOf(ids: number[]): Uint8Array {
  const m = TsBitmap.fromValues(ids);
  m.optimize();
  return m.serialize();
}

const shapes: Record<string, number[]> = {
  'one array': [1, 5, 9],
  'one run': range(100, 900),
  'one bitset': range(0, 30_000).map((v) => v * 2),
  'array, run, bitset, array': [
    ...range(0, 20),
    ...range(65_536 + 10, 65_536 + 3_000),
    ...range(2 * 65_536, 2 * 65_536 + 40_000).filter((v) => v % 3 !== 0),
    3 * 65_536 + 7,
  ],
};

describe('decodeContainers detached', () => {
  for (const [name, ids] of Object.entries(shapes)) {
    it(`${name}: same ids as the in-place decode, no storage shared with the input, a bitset on its own array, a lone array or run owning its slab`, () => {
      const bytes = bytesOf(ids);
      const shared = decodeContainers(bytes, false);
      const own = decodeContainers(bytes, true);
      expect(own.keys).toEqual(shared.keys);
      expect(own.end).toBe(shared.end);
      expect(own.conts.map((c) => [c.kind, c.card, c.len])).toEqual(
        shared.conts.map((c) => [c.kind, c.card, c.len]),
      );
      const small = own.conts.filter((c) => c.kind !== BITSET);
      const slabs = new Set<unknown>();
      for (const c of own.conts) {
        expect(c.data.buffer).not.toBe(bytes.buffer);
        if (c.kind === BITSET) expect(c.shared).toBe(false);
        else slabs.add(c.data.buffer);
      }
      for (const c of small) expect(c.shared).toBe(small.length > 1);
      expect(slabs.size).toBe(small.length === 0 ? 0 : 1);
      expect(
        new Set(own.conts.filter((c) => c.kind === BITSET).map((c) => c.data.buffer)).size,
      ).toBe(own.conts.length - small.length);
      const rebuilt = TsBitmap.safeDeserialize(bytes, 1 << 27, { detached: true });
      expect([...rebuilt]).toEqual([...new Set(ids)].sort((x, y) => x - y));
    });
  }
});
