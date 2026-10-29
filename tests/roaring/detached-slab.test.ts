import { describe, expect, it } from 'vitest';
import { TsBitmap } from '@/ts-roaring/bitmap';
import { ARRAY, RUN } from '@/ts-roaring/containers';
import { DETACHED_SLAB_BYTES, decodeContainers } from '@/ts-roaring/wire';

/**
 * A detached decode puts the arrays and runs of a bitmap on slabs of at most 64 KB each, bitsets on arrays of their
 * own, and flags slab neighbours shared, so the first write to one copies it out and never touches another.
 */
const CAP = 1 << 28;
const range = (a: number, b: number) => Array.from({ length: b - a }, (_, i) => a + i);

/** `count` ids of container `key`, spread so that the container is an array of exactly `count` values. */
const arrayIds = (key: number, count: number) =>
  Array.from({ length: count }, (_, i) => key * 65_536 + i * 15);

/** Eight runs of eight ids in container `key`: a run container after `optimize`. */
const runIds = (key: number) =>
  range(0, 8).flatMap((r) => range(0, 8).map((i) => key * 65_536 + r * 40 + i));

function decodeDetached(ids: number[]): TsBitmap {
  const m = TsBitmap.fromValues(ids);
  m.optimize();
  return TsBitmap.safeDeserialize(m.serialize(), CAP, { detached: true });
}

function bytesOf(ids: number[]): Uint8Array {
  const m = TsBitmap.fromValues(ids);
  m.optimize();
  return m.serialize();
}

describe('the slab bound', () => {
  it('is 64 KB', () => {
    expect(DETACHED_SLAB_BYTES).toBe(65_536);
  });

  it('a decode spanning several slabs: every slab is within the bound and holds whole containers', () => {
    // 4,000 values a container is 8,000 bytes: eight fit in a slab (64,000 bytes), so 20 containers take 3 slabs.
    const ids = range(0, 20).flatMap((k) => arrayIds(k, 4_000));
    const { conts } = decodeContainers(bytesOf(ids), true);
    const slabs = new Map<ArrayBufferLike, number>();
    for (const c of conts) {
      expect(c.kind).toBe(ARRAY);
      expect(c.data.byteLength).toBeLessThanOrEqual(DETACHED_SLAB_BYTES);
      slabs.set(c.data.buffer, (slabs.get(c.data.buffer) ?? 0) + 1);
    }
    expect([...slabs.values()]).toEqual([8, 8, 4]);
    for (const c of conts) expect(c.shared).toBe(true);
    expect([...TsBitmap.safeDeserialize(bytesOf(ids), CAP, { detached: true })]).toEqual(ids);
  });

  it('a slab is as long as its containers, not the bound', () => {
    const { conts } = decodeContainers(bytesOf(range(0, 3).flatMap((k) => arrayIds(k, 100))), true);
    expect(conts[0]?.data.byteLength).toBe(3 * 100 * 2);
  });

  it('containers that exactly fill a slab, and the one that starts the next', () => {
    // 4,096 values is 8,192 bytes: eight fill a slab to the byte.
    const ids = range(0, 17).flatMap((k) => arrayIds(k, 4_096));
    const { conts } = decodeContainers(bytesOf(ids), true);
    const lengths = new Map<ArrayBufferLike, number>();
    for (const c of conts) lengths.set(c.data.buffer, c.data.byteLength);
    expect([...lengths.values()]).toEqual([65_536, 65_536, 8_192]);
    // The slab of one container is that container's own: nothing shares it, so a write need not copy.
    expect(conts.slice(0, 16).every((c) => c.shared)).toBe(true);
    expect(conts[16]?.shared).toBe(false);
    expect(conts[16]?.off).toBe(0);
    expect([...TsBitmap.safeDeserialize(bytesOf(ids), CAP, { detached: true })]).toEqual(ids);
  });

  it('a run container above the bound takes storage of its own and is not flagged', () => {
    // 16,385 runs of one id each: 32,770 values, two more than a slab holds. Written by hand: a run cookie, one run
    // container, its descriptor and body.
    const runs = 16_385;
    const bytes = new Uint8Array(4 + 1 + 4 + 2 + 4 * runs);
    const v = new DataView(bytes.buffer);
    v.setUint32(0, 12_347, true); // run cookie, count - 1 = 0
    bytes[4] = 1; // container 0 is a run container
    v.setUint16(5, 0, true); // key
    v.setUint16(7, runs - 1, true); // cardinality - 1
    v.setUint16(9, runs, true);
    for (let r = 0; r < runs; r++) {
      v.setUint16(11 + 4 * r, 2 * r, true);
      v.setUint16(13 + 4 * r, 0, true);
    }
    const { conts } = decodeContainers(bytes, true);
    expect(conts).toHaveLength(1);
    const c = conts[0]!;
    expect(c.kind).toBe(RUN);
    expect(c.shared).toBe(false);
    expect(c.off).toBe(0);
    expect(c.data.byteLength).toBe(2 * 2 * runs);
    expect(c.card).toBe(runs);
  });

  it('a bitset keeps an 8 KB array of its own, and does not share the slab of the arrays around it', () => {
    const ids = [
      ...arrayIds(0, 100),
      ...range(0, 30_000).map((x) => 65_536 + x * 2),
      ...arrayIds(2, 100),
    ];
    const { conts } = decodeContainers(bytesOf(ids), true);
    expect(conts.map((c) => c.kind === ARRAY)).toEqual([true, false, true]);
    expect(conts[1]?.data.byteLength).toBe(8_192);
    expect(conts[0]?.data.buffer).toBe(conts[2]?.data.buffer);
    expect(conts[1]?.data.buffer).not.toBe(conts[0]?.data.buffer);
  });
});

/** The ids of the bitmap, by key, from `toArray`. */
function byKey(m: TsBitmap): Map<number, number[]> {
  const out = new Map<number, number[]>();
  for (const id of m) {
    const key = id >>> 16;
    const list = out.get(key);
    if (list) list.push(id);
    else out.set(key, [id]);
  }
  return out;
}

type Op = readonly [
  string,
  (b: TsBitmap, other: TsBitmap) => void,
  (cur: Set<number>, x: Set<number>) => Set<number>,
];
const union = (a: Set<number>, b: Set<number>) => new Set([...a, ...b]);
const diff = (a: Set<number>, b: Set<number>) => new Set([...a].filter((v) => !b.has(v)));
const both = (a: Set<number>, b: Set<number>) => new Set([...a].filter((v) => b.has(v)));
const exclusive = (a: Set<number>, b: Set<number>) => union(diff(a, b), diff(b, a));

describe('a write to one container of a slab never changes a neighbour', () => {
  const TARGET = 3;
  // New ids in the target container only (some inside the existing runs, some far from them).
  const extra = [
    TARGET * 65_536 + 1,
    TARGET * 65_536 + 17,
    TARGET * 65_536 + 40_000,
    TARGET * 65_536 + 65_535,
  ];
  const operand = () => TsBitmap.fromValues(extra);
  const ops: Op[] = [
    ['add', (b) => extra.forEach((x) => b.add(x)), union],
    ['addMany', (b) => b.addMany(extra), union],
    ['remove', (b) => b.remove(TARGET * 65_536), (cur) => diff(cur, new Set([TARGET * 65_536]))],
    [
      'removeMany',
      (b) => b.removeMany([TARGET * 65_536, TARGET * 65_536 + 15]),
      (cur) => diff(cur, new Set([TARGET * 65_536, TARGET * 65_536 + 15])),
    ],
    ['orInPlace', (b) => b.orInPlace(operand()), union],
    ['xorInPlace', (b) => b.xorInPlace(operand()), exclusive],
    ['andNotInPlace', (b) => b.andNotInPlace(operand()), diff],
    ['andInPlace', (b, o) => b.andInPlace(o), both],
  ];
  // Four shapes: arrays, runs, both mixed, and enough containers to span slabs.
  const shapes: Array<[string, (key: number) => number[]]> = [
    ['arrays', (k) => arrayIds(k, 300)],
    ['runs', (k) => runIds(k)],
    ['arrays and runs', (k) => (k % 2 === 0 ? arrayIds(k, 300) : runIds(k))],
    ['arrays over several slabs', (k) => arrayIds(k, 3_000)],
  ];

  for (const [shape, make] of shapes) {
    for (const [name, apply, model] of ops) {
      it(`${shape}: ${name}, on the decode and on its clone, before and after the clone`, () => {
        const keys = range(0, 24);
        const ids = keys.flatMap((k) => make(k));
        const before = byKey(decodeDetached(ids));
        const target = new Set(before.get(TARGET));
        // `andInPlace` keeps every other container whole and the first five ids of the target.
        const five = [...target].slice(0, 5);
        const restricted = name === 'andInPlace';
        const other = restricted
          ? TsBitmap.fromValues(ids.filter((x) => x >>> 16 !== TARGET).concat(five))
          : operand();
        const wantTarget = [...model(target, new Set(restricted ? five : extra))].sort(
          (x, y) => x - y,
        );

        const expectUntouched = (m: TsBitmap, label: string) => {
          const got = byKey(m);
          for (const k of keys) {
            if (k === TARGET) continue;
            expect(got.get(k), `${label}: container ${k}`).toEqual(before.get(k));
          }
        };

        // Write to the decode itself.
        const a = decodeDetached(ids);
        apply(a, other);
        expectUntouched(a, 'decode');
        expect(byKey(a).get(TARGET) ?? []).toEqual(wantTarget);

        // Write to a clone: the decode is unchanged. Then write to the decode: the clone is unchanged.
        const b = decodeDetached(ids);
        const c = b.clone();
        apply(c, other);
        expect([...b]).toEqual(ids);
        expectUntouched(c, 'clone');
        const d = c.clone();
        apply(b, other);
        expectUntouched(b, 'decode after a clone');
        expect(byKey(d).get(TARGET) ?? []).toEqual(wantTarget);
        expect(byKey(c).get(TARGET) ?? []).toEqual(wantTarget);
      });
    }
  }
});
