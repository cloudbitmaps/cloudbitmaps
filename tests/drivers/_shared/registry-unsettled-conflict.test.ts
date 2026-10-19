import {
  TransientError,
  WriteConflictError,
  isUnsettledConflict,
  unsettledConflict,
} from '@/core/errors';
import { publishGenerationKept } from '@/core/publish';
import type { SegmentRef } from '@/core/ports';
import { ObjectStoreRegistry } from '@/drivers/_shared/object-registry';
import type { ObjectRegistryStore, ObjectRow } from '@/drivers/_shared/object-registry';

/**
 * A store that throws the conflict the test names on its next write, whether or not the write was applied, so that
 * what `ObjectStoreRegistry` does with the mark on the way out is read directly: it passes a store's marked conflict
 * through a compare-and-swap and a create, keeps it when a create that found no row re-words its refusal, and adds
 * it to none of its own.
 */
class ScriptedStore implements ObjectRegistryStore {
  readonly label = 'scripted';
  private readonly objects = new Map<string, { bytes: Uint8Array; version: number }>();
  private next = 1;
  /** What the next write throws after it applies (when `land`) or instead of applying. */
  fault: { error: Error; land: boolean } | undefined;
  /** When set, the next read throws it. */
  readFault: Error | undefined;

  read(key: string): Promise<ObjectRow | null> {
    const readFault = this.readFault;
    this.readFault = undefined;
    if (readFault !== undefined) return Promise.reject(readFault);
    const found = this.objects.get(key);
    return Promise.resolve(
      found === undefined ? null : { bytes: found.bytes, version: String(found.version) },
    );
  }

  write(key: string, body: Uint8Array, expect: 'absent' | { version: string }): Promise<void> {
    const found = this.objects.get(key);
    if (expect === 'absent' ? found !== undefined : String(found?.version) !== expect.version) {
      return Promise.reject(new WriteConflictError(`lost: ${key}`));
    }
    const fault = this.fault;
    this.fault = undefined;
    if (fault !== undefined && !fault.land) return Promise.reject(fault.error);
    this.objects.set(key, { bytes: body, version: this.next++ });
    return fault === undefined ? Promise.resolve() : Promise.reject(fault.error);
  }

  async *listKeys(): AsyncIterable<string> {
    // The registry lists nothing in these cases.
  }
}

const REF: SegmentRef = { segment: 's' };
const make = () => {
  const store = new ScriptedStore();
  return { store, registry: new ObjectStoreRegistry(store, 'p', () => 1_000) };
};
const marked = (): Error => unsettledConflict('lost over the row');
const plain = (): Error => new WriteConflictError('lost over the row');

describe('ObjectStoreRegistry passes the mark of a store conflict through', () => {
  it.each([
    ['marked', marked, true],
    ['plain', plain, false],
  ] as const)(
    'a compare-and-swap whose store write throws a %s conflict',
    async (_n, error, isMarked) => {
      const { store, registry } = make();
      const { token } = await registry.create(REF, { currentGen: 0 });
      store.fault = { error: error(), land: false };
      const err = await registry
        .compareAndSwap(REF, token, { currentGen: 1 })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(WriteConflictError);
      expect(isUnsettledConflict(err)).toBe(isMarked);
    },
  );

  it.each([
    ['marked', marked, true],
    ['plain', plain, false],
  ] as const)(
    'a create with no held row whose store write throws a %s conflict, and no row is there after',
    async (_n, error, isMarked) => {
      const { store, registry } = make();
      store.fault = { error: error(), land: false };
      const err = await registry
        .create(REF, { currentGen: 0 }, { held: null })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(WriteConflictError);
      expect(isUnsettledConflict(err)).toBe(isMarked);
    },
  );

  it.each([
    ['marked', marked, true],
    ['plain', plain, false],
  ] as const)(
    'a create with no held row whose %s conflict meets a row after: the refusal keeps the mark it had',
    async (_n, error, isMarked) => {
      const { store, registry } = make();
      // The write lands, then reports the conflict, so the read that follows finds the row.
      store.fault = { error: error(), land: true };
      const err = await registry
        .create(REF, { currentGen: 0 }, { held: null })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(WriteConflictError);
      expect((err as Error).message).toContain('already exists');
      expect(isUnsettledConflict(err)).toBe(isMarked);
    },
  );

  it.each([
    ['marked', marked, true],
    ['plain', plain, false],
  ] as const)(
    'a create over a tombstone whose second write throws a %s conflict keeps the mark it had',
    async (_n, error, isMarked) => {
      const { store, registry } = make();
      await registry.create(REF, { currentGen: 0 });
      await registry.delete(REF);
      store.fault = { error: error(), land: false };
      const err = await registry
        .create(REF, { currentGen: 0 }, { held: null })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(WriteConflictError);
      expect(isUnsettledConflict(err)).toBe(isMarked);
    },
  );

  it('a create of its own, over a row that is there, is a plain conflict', async () => {
    const { registry } = make();
    await registry.create(REF, { currentGen: 0 });
    const err = await registry
      .create(REF, { currentGen: 0 }, { held: null })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WriteConflictError);
    expect(isUnsettledConflict(err)).toBe(false);
  });

  it('a compare-and-swap that finds the token moved is a plain conflict', async () => {
    const { registry } = make();
    const { token } = await registry.create(REF, { currentGen: 0 });
    await registry.compareAndSwap(REF, token, { currentGen: 1 });
    const err = await registry
      .compareAndSwap(REF, token, { currentGen: 2 })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WriteConflictError);
    expect(isUnsettledConflict(err)).toBe(false);
  });
});

describe('a create-only write that lost, then a read-back that faults', () => {
  // The read-back only tells a live row from a tombstone, so a fault on it leaves the write's own answer standing.
  const lostThenReadFault = (error: Error) => {
    const { store, registry } = make();
    // The row another writer made, so the store's create-only write loses; the read after it is the one that faults.
    store.fault = { error, land: false };
    return { store, registry };
  };

  it.each([
    ['marked (the Azure shape)', marked, true],
    ['plain (the S3 and GCS shape)', plain, false],
  ] as const)(
    'a create that found no row throws its %s conflict as it was',
    async (_n, error, isMarked) => {
      const { store, registry } = lostThenReadFault(error());
      const readFault = new TransientError('throttled read');
      const write = store.write.bind(store);
      store.write = async (key, body, expect) => {
        const out = await write(key, body, expect).catch((e: unknown) => {
          store.readFault = readFault;
          throw e;
        });
        return out;
      };
      const err = await registry
        .create(REF, { currentGen: 0 }, { held: null })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(WriteConflictError);
      expect(err).not.toBe(readFault);
      expect(isUnsettledConflict(err)).toBe(isMarked);
    },
  );

  it('a first publish refused over it reports no write with no answer on the S3 and GCS shape', async () => {
    const { store, registry } = make();
    // Another writer's row exists, so this publish's create-only write loses, and the read after that faults.
    const other = new ObjectStoreRegistry(store, 'p', () => 1_000);
    await other.create(REF, { currentGen: 4 });
    const write = store.write.bind(store);
    store.write = async (key, body, expect) =>
      write(key, body, expect).catch((e: unknown) => {
        store.readFault = new TransientError('throttled read');
        throw e;
      });
    let unanswered = 0;
    const out = await publishGenerationKept(
      registry,
      { ...REF, generation: 0 },
      { row: null, expectAbsent: true, footerCrc: 1, onUnanswered: () => void (unanswered += 1) },
    ).catch((e: unknown) => e);
    expect(out).toMatchObject({ published: false });
    expect(unanswered).toBe(0);
  });
});
