import { runConsistencyCheck, BudgetExceededError, DEFAULT_MAX_CHECK_SEGMENTS } from '@/index';
import type { RegistryRecord } from '@/core/ports';

// The DR consistency check bounds its registry scan, like every other enumeration in the library.
//
// It was the last one left. The function's own comment said "fail fast before the (possibly huge) registry
// scan" — and then drained that scan into an array regardless, so memory scaled with total fleet size and the
// caller had no way to cap it. It is operator-invoked rather than request-reachable, which is why it was fixed
// after the GDPR paths, but "an operator runs it" is not a bound: a DR drill against a large fleet from a
// modest box is exactly the case that hurts.
//
// As with the other bound tests, the assertion is how far the registry was CONSUMED — not merely that it threw.
function registryOf(count: number): {
  list: () => AsyncIterable<RegistryRecord>;
  yielded: () => number;
} {
  let yielded = 0;
  return {
    yielded: () => yielded,
    list: () =>
      (async function* () {
        for (let i = 0; i < count; i++) {
          yielded++;
          yield {
            segment: `s${i}`,
            namespace: 'ns',
            currentGen: 1,
            status: 'active',
          } as unknown as RegistryRecord;
        }
      })(),
  };
}

const depsWith = (reg: { list: () => AsyncIterable<RegistryRecord> }) =>
  ({
    registry: {
      list: () => reg.list(),
      get: () => Promise.resolve(null),
    },
    cold: { head: () => Promise.resolve(null) },
  }) as never;

describe('consistency check bounds its registry scan', () => {
  it('abandons the scan at maxSegments instead of draining the fleet', async () => {
    const reg = registryOf(10_000);
    await expect(runConsistencyCheck(depsWith(reg), { maxSegments: 5 })).rejects.toBeInstanceOf(
      BudgetExceededError,
    );
    expect(reg.yielded()).toBe(6); // five admitted, the sixth trips it — not 10,000
  });

  it('names the knob and suggests narrowing by namespace first', async () => {
    const reg = registryOf(100);
    const err = (await runConsistencyCheck(depsWith(reg), { maxSegments: 2 }).catch(
      (e: unknown) => e,
    )) as Error;
    expect(err.message).toContain('maxSegments');
    expect(err.message).toContain('namespace');
  });

  it('rejects a nonsensical ceiling before scanning anything', async () => {
    // Fail fast, like the existing concurrency validation immediately above it.
    const reg = registryOf(100);
    await expect(runConsistencyCheck(depsWith(reg), { maxSegments: 0 })).rejects.toThrow(
      /maxSegments/,
    );
    expect(reg.yielded()).toBe(0);
  });

  it('defaults to a ceiling generous enough not to bother real fleets', () => {
    // The compaction docs target 100K+ segment fleets, so the default must sit comfortably above that or it
    // becomes a surprise failure for exactly the deployments that need a DR drill most.
    expect(DEFAULT_MAX_CHECK_SEGMENTS).toBeGreaterThan(100_000);
  });
});
