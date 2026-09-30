import { vi } from 'vitest';
import * as core from '@cloudbitmaps/core';
import { CloudRoaring, MemoryStorage, ValidationError, loadSegment } from '@/index';
import type { Clock, IRegistryDriver, IStorageDriver, SegmentRef } from '@/index';
import { SystemClock } from '@/system-clock';
import { roaringCodec } from '@/roaring-codec';
import { joinId } from '@/core/bit-route';

/**
 * `loadSegment` from `@cloudbitmaps/roaring` is the load a caller wiring their own drivers is sent to, and what it
 * adds over core's is two bindings: the roaring codec, and a real clock, which is what makes a large load yield the
 * event loop. Each binding fills an absent value and keeps a supplied one. These tests call the flavor's own
 * export, so a binding that is dropped, or that overrides the caller, fails here rather than passing through a
 * helper that binds for itself.
 */
const REF: SegmentRef = { segment: 'bound' };

// One id per chunk across 40,000 chunks: a load that yields many times, fast enough for a unit test.
const IDS = Array.from({ length: 40_000 }, (_, i) => joinId(i % 61_035, i % 65_536));

async function countOf(backend: MemoryStorage): Promise<number> {
  return new CloudRoaring({ storage: backend }).segment(REF.segment).count();
}

/** Records every method called on `target`. */
function recording<T extends object>(target: T, calls: string[]): T {
  return new Proxy(target, {
    get(t, p, rx) {
      const v = Reflect.get(t, p, rx) as unknown;
      if (typeof v !== 'function') return v;
      return (...args: unknown[]) => {
        calls.push(String(p));
        return (v as (...a: unknown[]) => unknown).apply(t, args);
      };
    },
  });
}

describe("@cloudbitmaps/roaring's loadSegment", () => {
  it('binds a real clock when none is passed, so a large load yields the event loop', async () => {
    const yields = vi.spyOn(SystemClock.prototype, 'yieldNow');
    try {
      const backend = new MemoryStorage();
      const r = await loadSegment(REF, IDS, {
        storage: backend.storage,
        registry: backend.registry,
      });
      expect(r.published).toBe(true);
      expect(yields.mock.calls.length).toBeGreaterThan(20);
    } finally {
      yields.mockRestore();
    }
  });

  it('keeps a clock the caller passes, and binds none of its own', async () => {
    const bound = vi.spyOn(SystemClock.prototype, 'yieldNow');
    try {
      let yields = 0;
      const clock: Clock = {
        now: () => Date.now(),
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        yieldNow: () => {
          yields += 1;
          return new Promise((resolve) => setImmediate(resolve));
        },
      };
      const backend = new MemoryStorage();
      await loadSegment(REF, IDS, { storage: backend.storage, registry: backend.registry, clock });
      expect(yields).toBeGreaterThan(20);
      expect(bound).not.toHaveBeenCalled();
    } finally {
      bound.mockRestore();
    }
  });

  it('binds the roaring codec when none is passed, and when `codec: undefined` is', async () => {
    for (const codec of [{}, { codec: undefined }]) {
      const backend = new MemoryStorage();
      const r = await loadSegment(REF, [1, 2, 70_000], {
        storage: backend.storage,
        registry: backend.registry,
        ...codec,
      });
      expect(r).toMatchObject({ published: true, cardinality: 3 });
      expect(await countOf(backend)).toBe(3);
    }
  });
});

describe("@cloudbitmaps/roaring's loadSegment, with a codec of the caller's", () => {
  it('reaches core with the codec the caller passed', async () => {
    let calls = 0;
    const codec = new Proxy(roaringCodec, {
      get(t, p, rx) {
        const v = Reflect.get(t, p, rx) as unknown;
        if (typeof v !== 'function') return v;
        return (...args: unknown[]) => {
          calls += 1;
          return (v as (...a: unknown[]) => unknown).apply(t, args);
        };
      },
    });
    const backend = new MemoryStorage();
    const r = await loadSegment(REF, [1, 2, 70_000], {
      storage: backend.storage,
      registry: backend.registry,
      codec,
    });
    expect(r.published).toBe(true);
    expect(calls).toBeGreaterThan(0);
  });
});

describe("@cloudbitmaps/core's loadSegment", () => {
  it('refuses a missing codec by its own name, before any storage or registry call', async () => {
    const backend = new MemoryStorage();
    const calls: string[] = [];
    const storage: IStorageDriver = recording(backend.storage, calls);
    const registry: IRegistryDriver = recording(backend.registry, calls);
    const err = await core.loadSegment(REF, [1], { storage, registry }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as Error).message).toMatch(/^loadSegment needs a bitmap codec/);
    expect(calls).toEqual([]);
  });
});
