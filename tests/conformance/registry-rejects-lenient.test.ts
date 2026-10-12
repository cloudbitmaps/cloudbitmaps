import { ValidationError } from '@/core/errors';
import type { IRegistryDriver } from '@/core/ports';
import { MemoryRegistryDriver } from '@/drivers/memory';
import { registryConformance } from '@/testing/conformance';

/**
 * The conformance suite must fail a registry that breaks the ledger and `tailBytes` rules. It holds four here: a
 * malformed ledger is refused, a `tailBytes` no object has is refused, a current entry whose checksum disagrees with a
 * clear summary's fingerprint is refused, and the ledger round-trips in the order given. The other ledger cases (one not
 * in number order is accepted, the ledger follows the pointer, and so on) are not held by this test. The suite registers its cases
 * through `describe` and `it`; here they are collected instead of registered and run by hand against a good registry
 * (every case passes) and against registries that each break one rule (the case that holds the rule fails). Removing a
 * new check from the suite, or weakening it, makes the matching registry pass it and this test fail.
 */

const collected = vi.hoisted(() => ({
  cases: [] as { name: string; fn: () => unknown }[],
}));
vi.mock('vitest', async (importOriginal) => {
  const real = await importOriginal<typeof import('vitest')>();
  const it = Object.assign(
    (name: string, fn: () => unknown) => {
      collected.cases.push({ name, fn });
    },
    { skip: () => undefined },
  );
  return { ...real, describe: (_name: string, body: () => void) => body(), it };
});

const ticking = (): (() => number) => {
  let t = 1_000;
  return () => (t += 1);
};
const good = (): IRegistryDriver => new MemoryRegistryDriver({ now: ticking() });

/** Rows a write names, as `create(ref, record)` or `compareAndSwap(ref, token, patch)` takes them. */
type Fields = { knownGens?: unknown; summary?: unknown };

/** `inner`, with each argument of a write that carries a record or a patch passed through `change`. */
function altered(
  inner: IRegistryDriver,
  change: (fields: Fields) => Fields,
  onRefusal?: boolean,
): IRegistryDriver {
  const through = (args: unknown[]): unknown[] =>
    args.map((a) =>
      typeof a === 'object' && a !== null && !Array.isArray(a) ? change(a as Fields) : a,
    );
  return new Proxy(inner, {
    get(target, prop) {
      const value: unknown = Reflect.get(target, prop, target);
      if (typeof value !== 'function') return value;
      const fn = value as (...a: unknown[]) => Promise<unknown>;
      if (prop !== 'create' && prop !== 'compareAndSwap') return fn.bind(target);
      return async (...args: unknown[]) => {
        if (onRefusal !== true) return fn.apply(target, through(args));
        try {
          return await fn.apply(target, args);
        } catch (err) {
          if (!(err instanceof ValidationError)) throw err;
          return fn.apply(target, through(args));
        }
      };
    },
  });
}

/** A registry that accepts what it should refuse by dropping the fields it would have refused. */
const acceptsAnything = (): IRegistryDriver =>
  altered(
    good(),
    (fields) => {
      const rest = { ...fields };
      delete rest.knownGens;
      delete rest.summary;
      return rest;
    },
    true,
  );

/** A registry that sorts the ledger by number, as one that stores it in a sorted set would. */
const sortsTheLedger = (): IRegistryDriver =>
  altered(good(), (fields) =>
    Array.isArray(fields.knownGens)
      ? {
          ...fields,
          knownGens: [...(fields.knownGens as { generation: number }[])].sort(
            (a, b) => a.generation - b.generation,
          ),
        }
      : fields,
  );

async function failuresOf(make: () => IRegistryDriver): Promise<string[]> {
  collected.cases.length = 0;
  registryConformance('under test', make);
  const cases = [...collected.cases];
  expect(cases.length).toBeGreaterThan(50);
  const failed: string[] = [];
  for (const c of cases) {
    try {
      await c.fn();
    } catch {
      failed.push(c.name);
    }
  }
  return failed;
}

describe('the registry conformance suite holds the ledger and tailBytes rules', () => {
  it('a registry that follows them fails no case', async () => {
    expect(await failuresOf(good)).toEqual([]);
  });

  it('fails a registry that accepts a malformed ledger or a tailBytes no object has', async () => {
    const failed = await failuresOf(acceptsAnything);
    expect(failed).toContain('refuses a malformed ledger and leaves the row unchanged');
    expect(failed).toContain(
      'refuses a clear summary whose tailBytes no object of its size can have, and a sealed one too short for it',
    );
    expect(failed).toContain(
      "refuses a current entry whose checksum disagrees with a clear summary's fingerprint, given in the same write or kept from the row",
    );
  });

  it('fails a registry that sorts the ledger, losing the order generations were made current', async () => {
    expect(await failuresOf(sortsTheLedger)).toContain(
      'round-trips knownGens through create, get, list and compare-and-swap, in the order given',
    );
  });
});
