import { vi } from 'vitest';
import * as core from '@cloudbitmaps/core';
import {
  CloudRoaring,
  CrbmStorageChunkSource,
  MemoryStorage,
  UnsupportedError,
  ValidationError,
} from '@/index';
import type { Clock, IRegistryDriver, IStorageDriver, SegmentRef } from '@/index';
import { SystemClock } from '@/system-clock';
import { joinId } from '@/core/bit-route';

/**
 * `store.load` is the load an application calls, and what it adds over core's `loadSegment` is two bindings: the
 * roaring codec, and a real clock, which is what makes a large load yield the event loop. The clock fills an
 * absent `seams.clock` and keeps a supplied one. These tests drive the store, so a binding that is dropped, or
 * that overrides the caller, fails here.
 */
const REF: SegmentRef = { segment: 'bound' };

// One id per chunk across 40,000 chunks: a load that yields many times, fast enough for a unit test.
const IDS = Array.from({ length: 40_000 }, (_, i) => joinId(i % 61_035, i % 65_536));

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

describe("the store's load", () => {
  it('binds a real clock when none is passed, so a large load yields the event loop', async () => {
    const yields = vi.spyOn(SystemClock.prototype, 'yieldNow');
    try {
      const r = await new CloudRoaring({ storage: new MemoryStorage() }).load(REF, IDS);
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
      await new CloudRoaring({ storage: new MemoryStorage(), seams: { clock } }).load(REF, IDS);
      expect(yields).toBeGreaterThan(20);
      expect(bound).not.toHaveBeenCalled();
    } finally {
      bound.mockRestore();
    }
  });

  it('binds the roaring codec, so the segment reads back what was loaded', async () => {
    const backend = new MemoryStorage();
    const store = new CloudRoaring({ storage: backend });
    const r = await store.load(REF, [1, 2, 70_000]);
    expect(r).toMatchObject({ published: true, cardinality: 3 });
    expect(await store.segment(REF.segment).count()).toBe(3);
  });
});

describe('a store built on a pre-built source', () => {
  it('refuses a write by naming the backend classes an application builds on', async () => {
    const backend = new MemoryStorage();
    const store = new CloudRoaring({
      storage: new CrbmStorageChunkSource(backend.storage, { registry: backend.registry }),
    });
    const err = await store.load(REF, [1]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnsupportedError);
    const message = (err as Error).message;
    expect(message).toMatch(
      /S3Storage.*GcsStorage.*AzureBlobStorage.*LocalFsStorage.*MemoryStorage/,
    );
    // The removed pairing function is named nowhere an application reads.
    expect(message).not.toMatch(/createBackend/);
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
