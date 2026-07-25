import { BoundedLru } from '@/core/lru';
import { ValidationError } from '@/core/errors';
import type { Clock } from '@/core/determinism';

/** A controllable clock — no `Date.now()` (determinism seam). */
function fakeClock(): Clock & { advance: (ms: number) => void } {
  let t = 0;
  return { now: () => t, sleep: () => Promise.resolve(), advance: (ms: number) => (t += ms) };
}

describe('BoundedLru', () => {
  it('rejects invalid options', () => {
    const clock = fakeClock();
    expect(() => new BoundedLru({ maxEntries: 0, clock })).toThrow(ValidationError);
    expect(() => new BoundedLru({ maxEntries: 2, ttlMs: 0, clock })).toThrow(ValidationError);
  });

  it('evicts the least-recently-used past the ceiling', () => {
    const clock = fakeClock();
    const lru = new BoundedLru<string, number>({ maxEntries: 2, clock });
    lru.set('a', 1);
    lru.set('b', 2);
    lru.get('a'); // 'a' is now most-recently-used → 'b' is the LRU
    lru.set('c', 3); // evicts 'b'
    expect(lru.get('a')).toBe(1);
    expect(lru.get('b')).toBeUndefined();
    expect(lru.get('c')).toBe(3);
  });

  it('expires entries past their TTL (C6)', () => {
    const clock = fakeClock();
    const lru = new BoundedLru<string, number>({ maxEntries: 10, ttlMs: 100, clock });
    lru.set('x', 42);
    clock.advance(99);
    expect(lru.get('x')).toBe(42);
    clock.advance(2); // now 101ms > ttl
    expect(lru.get('x')).toBeUndefined();
    expect(lru.has('x')).toBe(false);
  });

  describe('byte bound (gap #1 — reader-cache index footprint)', () => {
    it('rejects an invalid maxBytes', () => {
      const clock = fakeClock();
      expect(() => new BoundedLru({ maxEntries: 2, maxBytes: 0, clock })).toThrow(ValidationError);
      expect(() => new BoundedLru({ maxEntries: 2, maxBytes: Infinity, clock })).toThrow(
        ValidationError,
      );
    });

    it('evicts the LRU entry when reported weights exceed maxBytes (count not binding)', () => {
      const clock = fakeClock();
      // Count ceiling is generous (10); the byte ceiling (200) is what binds at 96 B/entry.
      const lru = new BoundedLru<string, number>({ maxEntries: 10, maxBytes: 200, clock });
      lru.set('a', 1);
      lru.setWeight('a', 96);
      lru.set('b', 2);
      lru.setWeight('b', 96); // total 192 ≤ 200 — both fit
      expect(lru.weightBytes).toBe(192);
      expect(lru.get('a')).toBe(1);
      expect(lru.get('b')).toBe(2);

      lru.get('a'); // 'a' now MRU → 'b' is the LRU
      lru.set('c', 3);
      lru.setWeight('c', 96); // total would be 288 > 200 → evict LRU ('b')
      expect(lru.get('b')).toBeUndefined();
      expect(lru.get('a')).toBe(1);
      expect(lru.get('c')).toBe(3);
      expect(lru.weightBytes).toBe(192);
    });

    it('keeps a single entry larger than the whole budget (it cannot be shrunk)', () => {
      const clock = fakeClock();
      const lru = new BoundedLru<string, number>({ maxEntries: 10, maxBytes: 100, clock });
      lru.set('big', 1);
      lru.setWeight('big', 500); // alone exceeds the budget — protected, not dropped
      expect(lru.get('big')).toBe(1);
      // A second entry cannot coexist: adding it drops back to just the newest.
      lru.set('small', 2);
      lru.setWeight('small', 10);
      expect(lru.get('big')).toBeUndefined();
      expect(lru.get('small')).toBe(2);
    });

    it('adjusts the running total on delete and on re-set of an existing key', () => {
      const clock = fakeClock();
      const lru = new BoundedLru<string, number>({ maxEntries: 10, maxBytes: 1000, clock });
      lru.set('a', 1);
      lru.setWeight('a', 300);
      lru.set('b', 2);
      lru.setWeight('b', 300);
      expect(lru.weightBytes).toBe(600);
      lru.delete('a');
      expect(lru.weightBytes).toBe(300);
      lru.set('b', 22); // re-set clears the prior weight until re-reported
      expect(lru.weightBytes).toBe(0);
      lru.setWeight('b', 50);
      expect(lru.weightBytes).toBe(50);
    });

    it('peek returns a value without changing recency', () => {
      const clock = fakeClock();
      const lru = new BoundedLru<string, number>({ maxEntries: 2, clock });
      lru.set('a', 1);
      lru.set('b', 2);
      expect(lru.peek('a')).toBe(1); // does NOT make 'a' most-recently-used
      lru.set('c', 3); // 'a' is still the LRU → evicted
      expect(lru.get('a')).toBeUndefined();
      expect(lru.get('b')).toBe(2);
      expect(lru.get('c')).toBe(3);
    });

    it('subtracts an entry weight from the running total when it expires by TTL (no phantom bytes)', () => {
      // The one accounting invariant that combines both bounds: a TTL-expiry removal must decrement totalBytes,
      // else the total leaks upward and triggers phantom byte-eviction of live entries.
      const clock = fakeClock();
      const lru = new BoundedLru<string, number>({
        maxEntries: 10,
        maxBytes: 1000,
        ttlMs: 100,
        clock,
      });
      lru.set('a', 1);
      lru.setWeight('a', 400);
      expect(lru.weightBytes).toBe(400);
      clock.advance(101); // 'a' is now expired
      expect(lru.get('a')).toBeUndefined(); // get() purges the expired entry
      expect(lru.weightBytes).toBe(0); // …and its bytes were subtracted
      // has() must purge + subtract too.
      lru.set('b', 2);
      lru.setWeight('b', 300);
      clock.advance(101);
      expect(lru.has('b')).toBe(false);
      expect(lru.weightBytes).toBe(0);
    });

    it('setWeight on an absent/evicted key is a no-op (no negative total)', () => {
      const clock = fakeClock();
      const lru = new BoundedLru<string, number>({ maxEntries: 10, maxBytes: 1000, clock });
      lru.setWeight('ghost', 500); // never inserted
      expect(lru.weightBytes).toBe(0);
      lru.set('a', 1);
      lru.setWeight('a', 100);
      lru.delete('a');
      lru.setWeight('a', 100); // late resolve after eviction — must not go negative or re-add
      expect(lru.weightBytes).toBe(0);
    });

    it('rejects a NaN/negative weight rather than corrupting the total', () => {
      const clock = fakeClock();
      const lru = new BoundedLru<string, number>({ maxEntries: 10, maxBytes: 1000, clock });
      lru.set('a', 1);
      expect(() => lru.setWeight('a', -1)).toThrow(ValidationError);
      expect(() => lru.setWeight('a', NaN)).toThrow(ValidationError);
    });
  });
});
