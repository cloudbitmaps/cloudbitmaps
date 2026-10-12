import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eraseIdFromSegment } from '@/core/erase-id';
import { generationsOf } from '@/core/generation-list';
import {
  KNOWN_FILL,
  MAX_KNOWN_GENERATIONS,
  MAX_STORED_KNOWN_GENERATIONS,
  usableKnownGens,
} from '@/core/known-generations';
import { LeaseLimitError } from '@/core/errors';
import { takeLease } from '@/core/leases';
import { loadSegment } from '@/core/load';
import type { IRegistryDriver, RegistryRecord, SegmentRef } from '@/core/ports';
import { rollbackSegment } from '@/core/rollback';
import { ObjectStoreRegistry } from '@/drivers/_shared/object-registry';
import { LocalFsRegistryDriver } from '@/drivers/localfs/registry';
import { MemoryRegistryDriver, MemoryStorageDriver } from '@/drivers/memory';
import { MIN_EXPIRES_AT_MS } from '@/index';
import { roaringCodec } from '@/roaring-codec';
import { CountingObjectStore } from '../helpers/counting';

/**
 * The ledger is bounded on every branch, and a publish or a rollback is never refused for its size. A writer keeps an
 * entry that nothing protects only while the ledger holds fewer than 128 (KNOWN_FILL), and never writes more than 192
 * (MAX_KNOWN_GENERATIONS), which the shared validator holds every registry to; a reader accepts 384. So three hundred
 * publishes into one segment all land, whatever `keep` they ask for and whatever a rollback, a lease or an erasure did
 * between them, over each shipped registry.
 */

const SEG: SegmentRef = { namespace: 'ns', segment: 's' };
const FAR = MIN_EXPIRES_AT_MS * 2;

let root: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'cbm-known-cap-'));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

let dirs = 0;
const registries: ReadonlyArray<readonly [string, () => IRegistryDriver]> = [
  ['MemoryRegistryDriver', () => new MemoryRegistryDriver({ now: () => FAR })],
  [
    'LocalFsRegistryDriver',
    () => new LocalFsRegistryDriver(join(root, `d${dirs++}`), { now: () => FAR }),
  ],
  [
    'ObjectStoreRegistry',
    () => new ObjectStoreRegistry(new CountingObjectStore(0), undefined, () => FAR),
  ],
];

/** A deterministic stream of numbers in `[0, n)`, so a failure replays. */
function stream(seed: number): (n: number) => number {
  let state = seed >>> 0;
  return (n) => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return Math.floor((state / 2 ** 32) * n);
  };
}

const numbers = (row: RegistryRecord | null): number[] =>
  (row?.knownGens ?? []).map((e) => e.generation);

describe.each(registries)('the ledger stays within its cap over %s', (_name, makeRegistry) => {
  it('300 `loadSegment` publishes with the `keep` an `*Into` call publishes with all land: the ledger is the 128 most recently published', async () => {
    const storage = new MemoryStorageDriver();
    const registry = makeRegistry();
    const deps = { storage, registry, codec: roaringCodec };
    for (let n = 1; n <= 300; n++) {
      const r = await loadSegment(SEG, [n], deps, { keep: Number.MAX_SAFE_INTEGER });
      expect(r, `publish ${n}`).toMatchObject({ published: true, generation: n - 1 });
      const row = (await registry.get(SEG))!;
      const held = numbers(row);
      expect(held.length, `after ${n}`).toBe(Math.min(n, KNOWN_FILL));
      expect(held.at(-1)).toBe(n - 1);
      if (n % 50 === 0 || n === 129) {
        // The newest 128, oldest first.
        expect(held).toEqual(Array.from({ length: held.length }, (_, i) => n - held.length + i));
      }
    }
  }, 120_000);

  it('300 `loadSegment` loads with keep 100 all land, the bucket keeps the 100 most recently current and the current one', async () => {
    const storage = new MemoryStorageDriver();
    const registry = makeRegistry();
    const deps = { storage, registry, codec: roaringCodec };
    for (let n = 1; n <= 300; n++) {
      const r = await loadSegment(SEG, [n], deps, { keep: 100 });
      expect(r, `publish ${n}`).toMatchObject({ published: true, generation: n - 1 });
      const row = (await registry.get(SEG))!;
      expect(row.knownGens!.length).toBeLessThanOrEqual(KNOWN_FILL);
      expect(row.knownGens!.at(-1)!.generation).toBe(n - 1);
      expect(usableKnownGens(row)).toBeDefined();
    }
    const present = await generationsOf(storage, SEG);
    expect(present).toEqual(Array.from({ length: 101 }, (_, i) => 299 - 100 + i));
    // The ledger names every one of them.
    const named = new Set(numbers(await registry.get(SEG)));
    for (const g of present) expect(named.has(g), `generation ${g}`).toBe(true);
  }, 120_000);

  it('300 `loadSegment` loads with keep 72 among `rollbackSegment`, `takeLease` and `eraseIdFromSegment` calls: every publish and every rollback lands, and the ledger never passes 192', async () => {
    const storage = new MemoryStorageDriver();
    const registry = makeRegistry();
    const clock = { now: () => FAR, sleep: () => Promise.resolve() };
    const deps = { storage, registry, codec: roaringCodec, clock };
    const next = stream(0x5eed);
    let loads = 0;
    let rollbacks = 0;
    let leases = 0;
    let erasures = 0;
    let steps = 0;
    while (loads < 300) {
      steps += 1;
      const row = await registry.get(SEG);
      const present = await generationsOf(storage, SEG);
      const roll = next(20);
      if (roll === 0 && row?.currentGen !== undefined && row.currentGen !== null) {
        // A rollback onto a generation below the pointer that is in the bucket, or forward onto one a rollback left.
        const below = present.filter((g) => g < row.currentGen!);
        const above = present.filter((g) => g > row.currentGen!);
        const forward = above.length > 0 && next(3) === 0;
        const pool = forward ? above : below;
        if (pool.length > 0) {
          const target = pool[next(pool.length)]!;
          await rollbackSegment(SEG, target, deps, { allowForward: forward });
          rollbacks += 1;
        }
      } else if (roll === 1 && row?.currentGen !== undefined && row.currentGen !== null) {
        const taken = await takeLease(SEG, deps, {
          holder: (leases + 1).toString(16).padStart(16, '0'),
          generation: row.currentGen,
          until: FAR + 60_000,
          row,
          current: true,
        }).catch((err: unknown) => {
          if (err instanceof LeaseLimitError) return 'full';
          throw err;
        });
        if (taken !== 'moved' && taken !== 'full') leases += 1;
      } else if (roll === 2 && row?.currentGen !== undefined && row.currentGen !== null) {
        // A subject erasure: every id this segment holds is in the current generation, so the rewrite publishes.
        const erased = await eraseIdFromSegment(SEG, next(40), deps);
        if (erased.erased) erasures += 1;
      } else {
        const have = row?.currentGen ?? -1;
        const r = await loadSegment(
          SEG,
          Array.from({ length: Math.max(have, 0) + 2 }, (_, i) => i),
          deps,
          { keep: 72 },
        );
        expect(r.published, `load ${loads + 1}`).toBe(true);
        loads += 1;
      }
      const after = (await registry.get(SEG))!;
      if (after.knownGens !== undefined) {
        expect(after.knownGens.length, `step ${steps}`).toBeLessThanOrEqual(MAX_KNOWN_GENERATIONS);
        expect(after.knownGens.at(-1)!.generation, `step ${steps}`).toBe(after.currentGen);
        expect(new Set(numbers(after)).size).toBe(after.knownGens.length);
      }
      expect(await generationsOf(storage, SEG), `step ${steps}`).toContain(after.currentGen);
    }
    // Not vacuous: each kind of step ran.
    expect(rollbacks).toBeGreaterThan(5);
    expect(leases).toBeGreaterThan(5);
    expect(erasures).toBeGreaterThan(5);
  }, 240_000);
});

describe('the most a real writer leaves in a ledger', () => {
  // The writer cap, 192 (MAX_KNOWN_GENERATIONS), cannot be reached by a real writer in this release. A publish keeps in
  // the ledger what its window names (at most 65 entries for a `keep` of 64) or, carrying it, the 128 most recent, and
  // does not yet hold the generations a live lease names: only `capKnown`, which the unit test drives with 150 leased
  // entries, takes a leased set. So live leases on 64 generations change nothing about the size, which this holds at the
  // window's.
  it('64 live leases do not take a keep-64 ledger past its window', async () => {
    const storage = new MemoryStorageDriver();
    const registry = new MemoryRegistryDriver();
    const clock = { now: () => FAR, sleep: () => Promise.resolve() };
    const deps = { storage, registry, codec: roaringCodec, clock };
    for (let g = 0; g < 64; g++) {
      await loadSegment(SEG, [g], deps, { keep: 64 });
      const row = (await registry.get(SEG))!;
      const taken = await takeLease(SEG, deps, {
        holder: (g + 1).toString(16).padStart(16, '0'),
        generation: g,
        until: FAR + 3_600_000,
        row,
        current: true,
      });
      expect(taken, `lease ${g}`).not.toBe('moved');
    }
    for (let n = 64; n < 200; n++) {
      const r = await loadSegment(SEG, [n], deps, { keep: 64 });
      expect(r.published, `load ${n}`).toBe(true);
      const row = (await registry.get(SEG))!;
      expect(row.knownGens!.length, `after ${n}`).toBeLessThanOrEqual(KNOWN_FILL);
    }
    expect((await registry.get(SEG))!.knownGens!.at(-1)!.generation).toBe(199);
  }, 120_000);
});

describe('what each boundary accepts of a ledger', () => {
  it('writes 192 and reads 384', () => {
    expect(KNOWN_FILL).toBe(128);
    expect(MAX_KNOWN_GENERATIONS).toBe(192);
    expect(MAX_STORED_KNOWN_GENERATIONS).toBe(384);
    // A writer's cap is the protected set at its largest: 127 vouched below the new generation, the new one, and the 64
    // leased entries a segment can hold.
    expect(127 + 1 + 64).toBe(MAX_KNOWN_GENERATIONS);
    expect(MAX_STORED_KNOWN_GENERATIONS).toBe(2 * MAX_KNOWN_GENERATIONS);
  });
});
