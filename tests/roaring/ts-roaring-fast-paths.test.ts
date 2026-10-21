import { describe, expect, it, vi } from 'vitest';
import type { CodecBitmap } from '@cloudbitmaps/core';
import { roaringCodec as NA } from '@/native-codec';
import { tsRoaringCodec as TS } from '@/ts-roaring/bitmap';
import { runExport } from '@/export';
import { CloudRoaring, MemoryStorage } from '@/index';
import type { ExportSink, ExportWriter } from '@/index';

/**
 * Differential regression tests for the TypeScript codec's fast paths, each compared with the native codec (and a
 * plain sorted set): the gallop around its skew of 16, the bitset popcount and word loops, run edges and word
 * boundaries, copy-on-write of shared containers against every mutator (before, in the middle of, and with a clone
 * during an encodeChunks), a bitmap combined with itself, and decoded bitmaps that must not alias their input
 * (a Uint8Array, a Buffer, a pooled Buffer, a SharedArrayBuffer, an offset subarray). Each case checks the fast
 * path's bytes and contents against the native codec and against a set built one id at a time.
 */
// The differential cases combine many 64 Ki-value operands in both codecs; a shared CI runner needs more than 5 s.
vi.setConfig({ testTimeout: 60_000 });

const CAP = 1 << 27;
const hex = (u: Uint8Array) => Buffer.from(u).toString('hex');
const range = (a: number, b: number) => Array.from({ length: b - a }, (_, i) => a + i);
const thin = (n: number, step: number, off = 0) =>
  Array.from({ length: n }, (_, i) => off + i * step);

function pair(a: number[], b: number[]) {
  const A = [...new Set(a)].sort((x, y) => x - y),
    B = [...new Set(b)].sort((x, y) => x - y);
  const sb = new Set(B);
  for (const [op, want] of [
    ['andInPlace', A.filter((v) => sb.has(v))],
    ['orInPlace', [...new Set([...A, ...B])].sort((x, y) => x - y)],
    ['andNotInPlace', A.filter((v) => !sb.has(v))],
  ] as const) {
    for (const runsA of [false, true])
      for (const runsB of [false, true]) {
        const mk = (ids: number[], runs: boolean) => {
          const m = TS.fromValues(ids);
          if (runs) {
            m.optimize?.();
            return TS.safeDeserialize(m.serialize(), CAP);
          }
          return m;
        };
        const x = mk(A, runsA),
          y = mk(B, runsB);
        x[op](y);
        expect([...x], `${op} runsA=${runsA} runsB=${runsB} A=${A.length} B=${B.length}`).toEqual(
          want,
        );
        expect([...y]).toEqual(B);
        const n = NA.fromValues(A);
        n[op](NA.fromValues(B));
        x.optimize?.();
        n.optimize?.();
        expect(hex(x.serialize()), `bytes ${op}`).toBe(hex(n.serialize()));
        const s = TS.fromValues(A);
        s[op](s);
        const wantSelf = op === 'andNotInPlace' ? [] : A;
        expect([...s], `self ${op}`).toEqual(wantSelf);
      }
  }
}
describe('gallop', () => {
  it('skew boundaries', () => {
    for (const big of [thin(160, 7), thin(1600, 11, 3)]) {
      for (const k of [1, 2, 9, 10, 11, 15, 16, 17, 18, 100]) {
        const small = big
          .filter((_, i) => i % Math.max(1, Math.floor(big.length / k)) === 0)
          .slice(0, k);
        pair(small, big);
        pair(big, small);
        pair(
          small.map((v) => v + 1),
          big,
        );
        pair(
          big,
          small.map((v) => v + 1),
        );
      }
      pair([big[0]!], big);
      pair([big[big.length - 1]!], big);
      pair([0], big);
      pair([65535], [...big, 65535]);
      pair([], big);
      pair(big, []);
      pair(big, big);
      pair([big[0]!, big[big.length - 1]!, 65535, 0], big);
    }
    // exact ratios: |big| = 16*|small|, 16*|small|-1, +1
    for (const s of [3, 5, 50])
      for (const d of [-1, 0, 1]) {
        const big = thin(16 * s + d, 3);
        const small = thin(s, 48, 3);
        pair(small, big);
        pair(big, small);
        pair(thin(s, 48, 4), big);
      }
  });
});
describe('array intersection through a scratch bitset', () => {
  // Spread values over the whole chunk, so word and bit extremes (0, 31, 32, 65535) are held.
  const spread = (n: number, off: number) =>
    Array.from({ length: n }, (_, i) => Math.min(65_535, Math.floor((i * 65_536) / n) + off));
  it('either side of its minimum length and of the gallop skew, with every overlap', () => {
    for (const small of [1, 31, 32, 33, 64]) {
      for (const mult of [1, 2, 15, 16, 17]) {
        const big = spread(small * mult, 0);
        const half = big.filter((_, i) => i % 2 === 0).slice(0, small);
        for (const other of [spread(small, 1), spread(small, 0), half, big.slice(0, small)]) {
          pair(other, big);
          pair(big, other);
        }
      }
    }
  });
  it('4,096-value arrays, the full chunk edge of an array, and disjoint then equal operands', () => {
    const a = thin(4096, 16);
    const b = thin(4096, 16, 3);
    pair(a, b);
    pair(a, a);
    pair(a, thin(4096, 16, 8));
    pair(thin(4097, 15), a);
    pair(range(0, 4096), range(61_440, 65_536));
    pair([0, 65_535], [0, 65_535]);
  });
  it('leaves nothing behind in the scratch: a later intersection never sees an earlier one', () => {
    const first = TS.fromValues(thin(500, 100));
    first.andInPlace(TS.fromValues(thin(500, 100)));
    const second = TS.fromValues(thin(500, 100, 7));
    second.andInPlace(TS.fromValues(thin(500, 100, 9)));
    expect([...second]).toEqual([]);
  });
});

describe('array intersection with runs, either side of the values-versus-runs choice', () => {
  const runsOf = (count: number, len: number, gap: number, start = 0) =>
    range(0, count).flatMap((r) => range(start + r * (len + gap), start + r * (len + gap) + len));
  it('fewer values than runs, as many, and more', () => {
    const runs = runsOf(40, 10, 10);
    for (const n of [1, 39, 40, 41, 80, 400]) {
      pair(thin(n, 7, 3), runs);
      pair(thin(n, 3, 9), runs);
      pair(runs, thin(n, 5));
    }
  });
  it('values below, between, inside and above the runs; the last run ending at 65535; none shared', () => {
    const runs = runsOf(30, 20, 40, 100);
    pair([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16], runs);
    pair(thin(100, 60, 120), runs);
    pair(thin(100, 60, 130), runs);
    pair(range(2000, 2100), runs);
    const tail = range(65_000, 65_536);
    pair([64_999, 65_000, 65_535, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17], tail);
    pair(thin(600, 100, 5), tail.concat(range(100, 200)));
  });
});

describe('bitset / popcount', () => {
  it('word counts and patterns', () => {
    const full = range(0, 65536);
    const alt = thin(32768, 2),
      alt1 = thin(32768, 2, 1);
    const sparseWords = [] as number[];
    for (let w = 0; w < 2048; w += 3) sparseWords.push(w * 32 + (w % 32));
    const dense = (n: number) => range(0, 4097 + n).filter((v) => v % 3 !== 0);
    for (const [a, b] of [
      [full, alt],
      [alt, alt1],
      [alt, alt],
      [full, full],
      [full, []],
      [alt, full],
      [sparseWords.concat(alt), alt1],
      [dense(0), dense(1)],
      [dense(5), alt],
    ]) {
      pair(a!, b!);
      const t = TS.fromValues(a!);
      expect(t.size).toBe(new Set(a).size);
      expect([...t.toUint32Array!()]).toEqual([...new Set(a)].sort((x, y) => x - y));
    }
    // cardinalities around array/bitset limit
    for (const n of [4095, 4096, 4097]) {
      pair(thin(n, 15), thin(n, 15, 5));
      pair(thin(n, 15), range(0, n));
    }
  });
});
describe('runs', () => {
  it('adjacent, edge, split, word boundaries', () => {
    const cases: [number[], number[]][] = [
      [range(0, 100), range(100, 200)],
      [range(100, 200), range(0, 100)],
      [range(0, 100).concat(range(101, 200)), [100]],
      [range(60000, 65536), range(65000, 65536)],
      [range(60000, 65536), [65535]],
      [range(0, 65536), range(1000, 1001)],
      [range(0, 65536), range(31, 33)],
      [range(0, 65536), range(1000, 3000).concat(range(5000, 5002))],
      [range(10, 500), range(32, 64)],
      [range(10, 500), range(33, 63)],
      [range(10, 500), range(0, 32).concat(range(64, 96))],
      [range(0, 5000).concat(range(6000, 9000)), range(32, 4096)],
      [range(1, 65536), range(0, 1)],
      [range(0, 64), range(0, 64)],
      [range(0, 64), range(63, 64)],
      [range(5, 40), thin(5000, 13)],
      [thin(5000, 13), range(5, 6000)],
      [range(0, 32).concat(range(33, 65), range(66, 100)), range(0, 100)],
      [range(0, 32).concat(range(33, 65)), range(32, 33)],
      [range(0, 2).concat(range(4, 6), range(8, 10)), range(1, 9)],
    ];
    for (const [a, b] of cases) pair(a, b);
  });
});

function ids(): number[] {
  const out: number[] = [];
  out.push(...thin(50, 100)); // key0 array
  out.push(...thin(300, 13).map((v) => 65536 + v)); // key1 array
  out.push(...range(0, 9000).map((v) => 2 * 65536 + v)); // key2 run/bitset
  out.push(...thin(20000, 3).map((v) => 3 * 65536 + v)); // key3 bitset
  out.push(
    ...range(100, 4000)
      .concat(range(5000, 5100))
      .map((v) => 4 * 65536 + v),
  ); // key4 run
  out.push(5 * 65536 + 7);
  out.push(...thin(60, 7).map((v) => 6 * 65536 + v));
  return out;
}
const asRuns = (b: CodecBitmap) => {
  b.optimize?.();
  return TS.safeDeserialize(b.serialize(), CAP);
};
const chunks = (b: CodecBitmap) =>
  [...b.encodeChunks!()].map((c) => `${c.chunkKey}:${c.cardinality}:${hex(c.payload)}`);
const BUILDS: Record<string, () => CodecBitmap> = {
  built: () => TS.fromValues(ids()),
  decoded: () => TS.safeDeserialize(TS.fromValues(ids()).serialize(), CAP),
  decodedOpt: () => asRuns(TS.fromValues(ids())),
  decodedBuf: () => TS.safeDeserialize(Buffer.from(TS.fromValues(ids()).serialize()), CAP),
  single: () => TS.safeDeserialize(TS.fromValues(thin(50, 100)).serialize(), CAP),
};
const MUT: Record<string, (b: CodecBitmap) => void> = {
  add: (b) => {
    for (const v of [
      1,
      65536 + 1,
      2 * 65536 + 9001,
      3 * 65536 + 1,
      4 * 65536 + 4500,
      5 * 65536 + 8,
      6 * 65536 + 1,
      9 * 65536,
    ])
      b.add(v);
  },
  addMany: (b) =>
    b.addMany([
      2,
      3,
      65536 + 2,
      2 * 65536 + 9500,
      3 * 65536 + 2,
      4 * 65536 + 4400,
      5 * 65536 + 9,
      6 * 65536 + 3,
      12 * 65536,
      0,
    ]),
  remove: (b) => {
    for (const v of [
      0,
      100,
      65536,
      2 * 65536 + 5,
      3 * 65536,
      4 * 65536 + 100,
      5 * 65536 + 7,
      6 * 65536,
    ])
      b.remove(v);
  },
  removeMany: (b) =>
    b.removeMany([
      0,
      100,
      65536,
      2 * 65536 + 5,
      3 * 65536,
      4 * 65536 + 100,
      5 * 65536 + 7,
      6 * 65536,
      6 * 65536 + 7,
      ...range(2 * 65536, 2 * 65536 + 100),
    ]),
  or: (b) =>
    b.orInPlace(
      TS.fromValues([
        1,
        65536 + 1,
        2 * 65536 + 20000,
        3 * 65536 + 1,
        4 * 65536 + 4500,
        5 * 65536 + 1,
        7 * 65536,
      ]),
    ),
  andNot: (b) => b.andNotInPlace(TS.fromValues(ids().filter((v) => v % 3 === 0))),
  and: (b) => b.andInPlace(TS.fromValues(ids().filter((v) => v % 2 === 0))),
  orSelf: (b) => b.orInPlace(b),
  andSelf: (b) => b.andInPlace(b),
  andNotSelf: (b) => b.andNotInPlace(b),
  optimize: (b) => b.optimize?.(),
  clear: (b) => b.removeMany(ids()),
};
describe('cow', () => {
  for (const bn of Object.keys(BUILDS))
    for (const mn of Object.keys(MUT))
      for (const when of ['before', 'mid', 'cloneMid']) {
        it(`${bn} ${mn} ${when}`, () => {
          const want = chunks(BUILDS[bn]!());
          const b = BUILDS[bn]!();
          const enc = b.encodeChunks!();
          const it_ = enc[Symbol.iterator]();
          const got: string[] = [];
          const take = () => {
            const r = it_.next();
            if (!r.done)
              got.push(`${r.value.chunkKey}:${r.value.cardinality}:${hex(r.value.payload)}`);
            return r.done;
          };
          if (when === 'before') MUT[mn]!(b);
          if (when === 'mid') {
            take();
            MUT[mn]!(b);
          }
          if (when === 'cloneMid') {
            take();
            const c = b.clone();
            const cBefore = [...c];
            MUT[mn]!(c);
            MUT.add!(c);
            MUT.removeMany!(c);
            expect([...b]).toEqual(BUILDS[bn]!().toArray()); // original untouched by clone mutation
            MUT[mn]!(b);
            void cBefore;
          }
          while (!take());
          expect(got).toEqual(want);
        });
      }
});
describe('mutation results correct on shared', () => {
  for (const bn of Object.keys(BUILDS))
    for (const mn of Object.keys(MUT))
      it(`${bn} ${mn} content`, () => {
        const a = BUILDS[bn]!();
        const nat = NA.fromValues(a.toArray());
        a.encodeChunks!();
        MUT[mn]!(a);
        {
          const m = mn;
          const ids2 = (f: (v: number) => boolean) => ids().filter(f);
          if (m === 'or')
            nat.orInPlace(
              NA.fromValues([
                1,
                65536 + 1,
                2 * 65536 + 20000,
                3 * 65536 + 1,
                4 * 65536 + 4500,
                5 * 65536 + 1,
                7 * 65536,
              ]),
            );
          else if (m === 'andNot') nat.andNotInPlace(NA.fromValues(ids2((v) => v % 3 === 0)));
          else if (m === 'and') nat.andInPlace(NA.fromValues(ids2((v) => v % 2 === 0)));
          else if (m === 'orSelf') nat.orInPlace(nat);
          else if (m === 'andSelf') nat.andInPlace(nat);
          else if (m === 'andNotSelf') nat.andNotInPlace(nat);
          else MUT[m]!(nat);
        }
        expect(a.toArray()).toEqual(nat.toArray());
        expect(a.size).toBe(nat.size);
        a.optimize?.();
        nat.optimize?.();
        expect(hex(a.serialize())).toBe(hex(nat.serialize()));
      });
});
describe('input aliasing', () => {
  const src = ids();
  for (const kind of ['u8', 'buffer', 'bufferPooled', 'shared', 'offset'] as const)
    for (const bn of ['full', 'single', 'bitsetOnly', 'runOnly']) {
      it(`${kind} ${bn}`, () => {
        const base =
          bn === 'full'
            ? TS.fromValues(src)
            : bn === 'single'
              ? TS.fromValues(thin(50, 100))
              : bn === 'bitsetOnly'
                ? TS.fromValues(thin(20000, 3))
                : TS.fromValues(range(10, 9000));
        base.optimize?.();
        const bytes = base.serialize();
        const want = base.toArray();
        let buf: Uint8Array;
        if (kind === 'u8') buf = Uint8Array.from(bytes);
        else if (kind === 'buffer') buf = Buffer.from(bytes);
        else if (kind === 'bufferPooled') buf = Buffer.from(Array.from(bytes));
        else if (kind === 'shared') {
          buf = new Uint8Array(new SharedArrayBuffer(bytes.length));
          buf.set(bytes);
        } else {
          const big = new Uint8Array(bytes.length + 6);
          big.set(bytes, 3);
          buf = big.subarray(3, 3 + bytes.length);
        }
        const d = TS.safeDeserialize(buf, CAP);
        const cl = d.clone();
        buf.fill(0xa5);
        expect(d.toArray()).toEqual(want);
        expect(hex(d.serialize())).toBe(hex(bytes));
        // and mutating decoded must not write into input
        const again = kind === 'u8' ? Uint8Array.from(bytes) : Buffer.from(bytes);
        const snap = hex(again);
        const d2 = TS.safeDeserialize(again, CAP);
        d2.add(1);
        d2.add(65537);
        d2.remove(100);
        d2.removeMany(range(0, 200));
        d2.addMany(range(0, 300));
        d2.orInPlace(d);
        d2.andNotInPlace(cl);
        d2.optimize?.();
        expect(hex(again)).toBe(snap);
        expect(cl.toArray()).toEqual(want);
      });
    }
});
describe('export batching vs per-id native', () => {
  const sets: Record<string, number[]> = {
    onePerChunk: Array.from({ length: 3000 }, (_, i) => i * 65536 + ((i * 31) % 65536)),
    dense: range(0, 200000),
    runs: range(0, 1000).concat(range(65536 - 5, 65536 + 5), range(3e6, 3e6 + 500000)),
    chunks62000: Array.from({ length: 62000 }, (_, i) => i * 65536 + 5),
    high: [
      2 ** 31 - 1,
      2 ** 31,
      2 ** 31 + 1,
      2 ** 32 - 1,
      2 ** 32 - 2,
      4_000_000_000,
      ...range(2 ** 31 + 70000, 2 ** 31 + 80000),
    ],
    mixed: [...thin(70000, 997), ...range(2 ** 31, 2 ** 31 + 100000)],
  };
  for (const [n, s0] of Object.entries(sets))
    it(n, () => {
      const s = [...new Set(s0)].sort((a, b) => a - b);
      const per = NA.empty();
      for (const v of s) per.add(v);
      const bm = NA.empty();
      const batch = new Uint32Array(1 << 16);
      let held = 0;
      for (const v of s) {
        batch[held++] = v;
        if (held === batch.length) {
          bm.addMany(batch);
          held = 0;
        }
      }
      if (held > 0) bm.addMany(batch.subarray(0, held));
      expect(hex(bm.serialize())).toBe(hex(per.serialize()));
      expect(bm.size).toBe(per.size);
      // TS too, and batch-buffer reuse must not corrupt
      const t = TS.empty();
      held = 0;
      for (const v of s) {
        batch[held++] = v;
        if (held === batch.length) {
          t.addMany(batch);
          batch.fill(7);
          held = 0;
        }
      }
      if (held > 0) {
        t.addMany(batch.subarray(0, held));
        batch.fill(7);
      }
      t.optimize?.();
      per.optimize?.();
      expect(hex(t.serialize())).toBe(hex(per.serialize()));
    });
});

describe('runExport batching, end to end', () => {
  // More than 65,536 ids across many chunks, with ids at and above 2^31 up to 2^32 - 1, so the export's full-batch
  // flush runs more than once and its tail flush runs after it.
  const ids = [
    ...Array.from({ length: 150 }, (_, c) => range(0, 900).map((i) => c * 65536 + i * 7)).flat(),
    ...range(2 ** 31 - 3, 2 ** 31 + 3),
    ...range(2 ** 31 + 70000, 2 ** 31 + 70500),
    ...range(2 ** 32 - 1000, 2 ** 32),
  ];
  for (const [name, codec] of [
    ['native', NA],
    ['typescript', TS],
  ] as const)
    it(`exports ${ids.length} ids in the bytes a per-id add writes (${name} codec)`, async () => {
      expect(ids.length).toBeGreaterThan(2 * 65536 - 1);
      const backend = new MemoryStorage();
      await new CloudRoaring({ storage: backend }).load({ segment: 's' }, ids);
      const store = new CloudRoaring({ storage: backend });
      const out: Uint8Array[] = [];
      const sink: ExportSink = {
        open(): ExportWriter {
          return {
            write: (b) => void out.push(Uint8Array.from(b)),
            close() {},
          };
        },
      };
      const manifest = await runExport(store, backend.registry, sink, { codec });
      expect(manifest.totalIds).toBe(ids.length);
      const want = codec.empty();
      for (const v of ids) want.add(v);
      expect(hex(Buffer.concat(out))).toBe(hex(want.serialize()));
    });
});
