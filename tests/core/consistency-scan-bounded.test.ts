import {
  runConsistencyCheck,
  BudgetExceededError,
  CloudRoaring,
  MemoryStorage,
  MIN_EXPIRES_AT_MS,
  createBackend,
  retireExpired,
} from '@/index';
import { DEFAULT_MAX_SCAN_SEGMENTS } from '@/core/registry-scan';
import type { RegistryRecord } from '@/core/ports';

// The DR consistency check bounds its registry scan, like every other enumeration in the library.
//
// Failing fast before the (possibly huge) registry scan is not enough if the scan is then drained into an array
// regardless: memory would scale with total fleet size and the caller would have no way to cap it. The check is
// operator-invoked rather than request-reachable, but "an operator runs it" is not a bound: a DR drill against a
// large fleet from a modest box is exactly the case that hurts.
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
    storage: { head: () => Promise.resolve(null) },
  }) as never;

describe('consistency check bounds its registry scan', () => {
  it('abandons the scan at maxScanSegments instead of draining the fleet', async () => {
    const reg = registryOf(10_000);
    await expect(runConsistencyCheck(depsWith(reg), { maxScanSegments: 5 })).rejects.toBeInstanceOf(
      BudgetExceededError,
    );
    expect(reg.yielded()).toBe(6); // five admitted, the sixth trips it — not 10,000
  });

  it('names the knob and suggests narrowing by namespace first', async () => {
    const reg = registryOf(100);
    const err = (await runConsistencyCheck(depsWith(reg), { maxScanSegments: 2 }).catch(
      (e: unknown) => e,
    )) as Error;
    expect(err.message).toContain('maxScanSegments');
    expect(err.message).toContain('namespace');
  });

  it('rejects a nonsensical ceiling before scanning anything', async () => {
    // Fail fast, like the concurrency validation immediately above it.
    const reg = registryOf(100);
    await expect(runConsistencyCheck(depsWith(reg), { maxScanSegments: 0 })).rejects.toThrow(
      /maxScanSegments/,
    );
    expect(reg.yielded()).toBe(0);
  });

  it('names a call that takes the ceiling, when the store method that ran it does not', async () => {
    // `store.checkConsistency` takes no `maxScanSegments`, so advice to raise it would send the caller to an option
    // that does not exist. The refusal has to name where the ceiling can be raised: `runConsistencyCheck`.
    const backend = new MemoryStorage();
    const reg = registryOf(DEFAULT_MAX_SCAN_SEGMENTS + 1);
    const registry = new Proxy(backend.registry, {
      get: (t, p, rx) => (p === 'list' ? () => reg.list() : (Reflect.get(t, p, rx) as unknown)),
    });
    const store = new CloudRoaring({
      storage: createBackend({ storage: backend.storage, registry }),
      retry: false,
    });
    const err = (await store.checkConsistency().catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(BudgetExceededError);
    expect(err.message).toContain(String(DEFAULT_MAX_SCAN_SEGMENTS));
    expect(err.message).toContain('namespace');
    expect(err.message).toMatch(/raise `maxScanSegments` on `runConsistencyCheck`/);
    expect(err.message).toMatch(/`store\.checkConsistency` takes no ceiling/);
    expect(reg.yielded()).toBe(DEFAULT_MAX_SCAN_SEGMENTS + 1);
  });

  it('still tells a caller that takes the ceiling itself to raise it', async () => {
    // The look-alike: the retention sweep drains through the same bound, and its callers — the free function and
    // `store.retireExpired` — both take `maxScanSegments`, so for them raising it is the right advice.
    const reg = registryOf(3);
    const err = (await retireExpired(depsWith(reg), {
      now: MIN_EXPIRES_AT_MS,
      maxScanSegments: 2,
    }).catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(BudgetExceededError);
    expect(err.message).toMatch(/or raise `maxScanSegments` if the fleet/);
    expect(err.message).not.toContain('runConsistencyCheck');
  });

  it('defaults to a ceiling generous enough not to bother real fleets', () => {
    // Fleets of 100K+ segments are the design target, so the default must sit comfortably above that or it
    // becomes a surprise failure for exactly the deployments that need a DR drill most.
    expect(DEFAULT_MAX_SCAN_SEGMENTS).toBeGreaterThan(100_000);
  });
});
