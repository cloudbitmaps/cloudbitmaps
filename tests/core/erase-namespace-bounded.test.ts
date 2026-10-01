import { BudgetExceededError, MemoryStorage, ValidationError, eraseNamespace } from '@/index';
import { DEFAULT_MAX_SCAN_SEGMENTS, drainRegistry } from '@/core/registry-scan';
import type { IRegistryDriver, RegistryRecord } from '@/core/ports';

// `eraseNamespace` lists its namespace resident and then destroys each segment, irreversibly. Its listing is held
// to the same ceiling as every other fleet scan, and the refusal has to come before the first destroy: a namespace
// that is too large is refused whole, never erased part-way.

const NS = 'tenant';

/** A registry that lists `count` rows and records every call that would change or read one. */
function listingOf(count: number): {
  registry: IRegistryDriver;
  yielded: () => number;
  touched: () => number;
} {
  let yielded = 0;
  let touched = 0;
  const touch = (): never => {
    touched++;
    throw new Error('the registry row was touched');
  };
  const registry = {
    capabilities: () => ({ strongRead: true }),
    list: () =>
      (async function* () {
        for (let i = 0; i < count; i++) {
          yielded++;
          yield {
            segment: `s${i}`,
            namespace: NS,
            currentGen: 1,
            status: 'active',
          } as RegistryRecord;
        }
      })(),
    get: touch,
    create: touch,
    compareAndSwap: touch,
    delete: touch,
  } as unknown as IRegistryDriver;
  return { registry, yielded: () => yielded, touched: () => touched };
}

async function seeded(count: number): Promise<IRegistryDriver> {
  const { registry } = new MemoryStorage();
  for (let i = 0; i < count; i++) {
    await registry.create({ namespace: NS, segment: `s${i}` }, { currentGen: 1 });
  }
  return registry;
}

const statuses = async (registry: IRegistryDriver): Promise<string[]> => {
  const out: string[] = [];
  for await (const rec of registry.list(NS)) out.push(rec.status);
  return out;
};

describe('eraseNamespace bounds its registry scan', () => {
  it('refuses a namespace over a lowered ceiling with nothing destroyed', async () => {
    const registry = await seeded(6);
    await expect(
      eraseNamespace(
        NS,
        { registry },
        { confirmNamespace: NS, allowCleartext: true, maxScanSegments: 5 },
      ),
    ).rejects.toBeInstanceOf(BudgetExceededError);
    // `allowCleartext` makes every one of them destroyable, so an erase that had started would show here.
    expect(await statuses(registry)).toEqual(Array(6).fill('active'));
  });

  it('abandons the listing at the ceiling, and never reads or writes a row', async () => {
    const reg = listingOf(10_000);
    await expect(
      eraseNamespace(NS, reg, { confirmNamespace: NS, maxScanSegments: 5 }),
    ).rejects.toBeInstanceOf(BudgetExceededError);
    expect(reg.yielded()).toBe(6); // five admitted, the sixth trips it
    expect(reg.touched()).toBe(0);
  });

  it('words the refusal like the other scans, minus the advice to narrow', async () => {
    const err = (await eraseNamespace(
      NS,
      { registry: await seeded(3) },
      { confirmNamespace: NS, maxScanSegments: 2 },
    ).catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(BudgetExceededError);
    expect(err.message).toContain('eraseNamespace would enumerate more than 2 segments');
    expect(err.message).toContain('Raise `maxScanSegments` if the namespace really is that large');
    // It is already one namespace, so the refusal must not tell the caller to narrow it.
    expect(err.message).not.toMatch(/narrow/i);
  });

  it('keeps the advice to narrow on the scans that can', async () => {
    const err = (await drainRegistry(await seeded(3), { maxScanSegments: 2, op: 'scan' }).catch(
      (e: unknown) => e,
    )) as Error;
    expect(err).toBeInstanceOf(BudgetExceededError);
    expect(err.message).toContain(
      'Narrow it with `namespace`, or raise `maxScanSegments` if the fleet',
    );
  });

  it('erases a namespace exactly at the ceiling, and a raised ceiling admits what a lower one refused', async () => {
    const atCeiling = await seeded(5);
    const first = await eraseNamespace(
      NS,
      { registry: atCeiling },
      { confirmNamespace: NS, allowCleartext: true, maxScanSegments: 5 },
    );
    expect(first.destroyed.every((d) => d.destroyed)).toBe(true);
    expect(await statuses(atCeiling)).toEqual(Array(5).fill('destroyed'));

    const refused = await seeded(6);
    const opts = { confirmNamespace: NS, allowCleartext: true };
    await expect(
      eraseNamespace(NS, { registry: refused }, { ...opts, maxScanSegments: 5 }),
    ).rejects.toBeInstanceOf(BudgetExceededError);
    const raised = await eraseNamespace(NS, { registry: refused }, { ...opts, maxScanSegments: 6 });
    expect(raised.destroyed).toHaveLength(6);
    expect(await statuses(refused)).toEqual(Array(6).fill('destroyed'));
  });

  it('holds the shared default when no ceiling is passed', async () => {
    const over = listingOf(DEFAULT_MAX_SCAN_SEGMENTS + 1);
    const err = (await eraseNamespace(NS, over, { confirmNamespace: NS }).catch(
      (e: unknown) => e,
    )) as Error;
    expect(err).toBeInstanceOf(BudgetExceededError);
    expect(err.message).toContain(`more than ${DEFAULT_MAX_SCAN_SEGMENTS} segments`);
    expect(over.yielded()).toBe(DEFAULT_MAX_SCAN_SEGMENTS + 1);
    expect(over.touched()).toBe(0);

    const atDefault = listingOf(DEFAULT_MAX_SCAN_SEGMENTS);
    // Exactly at the default is admitted: it is listed in full, and only then does a row get read.
    const result = await eraseNamespace(NS, atDefault, { confirmNamespace: NS });
    expect(atDefault.yielded()).toBe(DEFAULT_MAX_SCAN_SEGMENTS);
    expect(result.destroyed).toHaveLength(DEFAULT_MAX_SCAN_SEGMENTS);
    expect(result.destroyed.every((d) => !d.destroyed)).toBe(true); // every get threw: recorded, not thrown
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects a maxScanSegments of %s before listing or destroying anything',
    async (bad) => {
      const reg = listingOf(3);
      await expect(
        eraseNamespace(NS, reg, { confirmNamespace: NS, maxScanSegments: bad }),
      ).rejects.toBeInstanceOf(ValidationError);
      expect(reg.yielded()).toBe(0);
      expect(reg.touched()).toBe(0);
    },
  );
});
