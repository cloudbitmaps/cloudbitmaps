import { MemoryStorageDriver } from '@/drivers/memory';

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
