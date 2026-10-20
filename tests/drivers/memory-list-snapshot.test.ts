import { MemoryRegistryDriver, MemoryStorageDriver } from '@/drivers/memory';

const REF = { namespace: 'n', segment: 's' };

const put = (driver: MemoryStorageDriver, generation: number) =>
  driver.putImmutable({ ...REF, generation }, async (sink) => {
    await sink.write(new Uint8Array([generation]));
  });

describe('MemoryStorageDriver.list', () => {
  it('does not yield an object written after the listing began', async () => {
    const driver = new MemoryStorageDriver();
    await put(driver, 1);
    await put(driver, 2);

    const seen: number[] = [];
    for await (const key of driver.list(REF)) {
      seen.push(key.generation);
      if (seen.length === 1) await put(driver, 3);
    }

    expect(seen).toEqual([1, 2]);
    const after: number[] = [];
    for await (const key of driver.list(REF)) after.push(key.generation);
    expect(after).toEqual([1, 2, 3]);
  });
});

describe('MemoryRegistryDriver.list', () => {
  it('does not yield a row created after the listing began, and still yields one deleted during it', async () => {
    const registry = new MemoryRegistryDriver();
    const row = (segment: string) => ({ namespace: 'n', segment });
    await registry.create(row('a'), { currentGen: 0, status: 'active' });
    await registry.create(row('b'), { currentGen: 0, status: 'active' });

    const seen: string[] = [];
    for await (const record of registry.list('n')) {
      seen.push(record.segment);
      if (seen.length === 1) {
        await registry.create(row('c'), { currentGen: 0, status: 'active' });
        await registry.delete(row('b'));
      }
    }

    expect(seen).toEqual(['a', 'b']);
  });
});
