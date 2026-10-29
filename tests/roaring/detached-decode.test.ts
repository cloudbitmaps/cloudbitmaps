import { describe, expect, it } from 'vitest';
import { TsBitmap } from '@/ts-roaring/bitmap';
import { decodeContainers } from '@/ts-roaring/wire';

/**
 * A detached decode gives every container storage of its own, whatever the mix of kinds and however few small
 * containers there are, and holds the same ids as the decode that reads in place.
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
    it(`${name}: same ids as the in-place decode, no storage shared between containers or with the input`, () => {
      const bytes = bytesOf(ids);
      const shared = decodeContainers(bytes, false);
      const own = decodeContainers(bytes, true);
      expect(own.keys).toEqual(shared.keys);
      expect(own.end).toBe(shared.end);
      expect(own.conts.map((c) => [c.kind, c.card, c.len])).toEqual(
        shared.conts.map((c) => [c.kind, c.card, c.len]),
      );
      const buffers = new Set<unknown>();
      for (const c of own.conts) {
        expect(c.shared).toBe(false);
        expect(c.off).toBe(0);
        expect(c.data.buffer).not.toBe(bytes.buffer);
        buffers.add(c.data.buffer);
      }
      expect(buffers.size).toBe(own.conts.length);
      const rebuilt = TsBitmap.safeDeserialize(bytes, 1 << 27, { detached: true });
      expect([...rebuilt]).toEqual([...new Set(ids)].sort((x, y) => x - y));
    });
  }
});
