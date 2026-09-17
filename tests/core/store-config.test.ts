import { randomBytes } from 'node:crypto';
import {
  CloudRoaring,
  CrbmStorageChunkSource,
  MemoryStorageChunkSource,
  MemoryStorageDriver,
  MemoryRegistryDriver,
  bulkLoadCrbmGeneration,
} from '@/index';
import { InProcessKeystore } from '@/drivers/crypto';
import { CapabilityError, KeyUnavailableError, ValidationError } from '@/core/errors';
import type { IStorageDriver, SegmentRef } from '@/index';
import { seededStore } from '../helpers/loaded';

// PR A: the store takes ONE config shape — `storage` is a raw IStorageDriver (wrapped into the .crbm storage source
// here, so drivers are wired once) OR an already-built StorageChunkSource (for source-only / pre-configured
// backends). `registry`/`keystore`/`requireEncryption` move up to the config and apply on the raw-driver path.
// These tests pin the resolution, that each option is actually threaded through the wrap, and the fail-fast guards.
const SEG: SegmentRef = { segment: 's' };
const k = (): Uint8Array => randomBytes(32);

describe('CloudRoaring constructor — one config shape (storage: raw driver | source)', () => {
  it('wraps a raw IStorageDriver and pins the registry currentGen (not the max on disk)', async () => {
    const storage = new MemoryStorageDriver();
    const registry = new MemoryRegistryDriver();
    // gen 0 published to the registry…
    await bulkLoadCrbmGeneration(storage, { ...SEG, generation: 0 }, [1, 2, 3], { registry });
    // …and a HIGHER gen 1 written but NOT published. A list-scan would resolve gen 1 (→ 5); the registry pins 0.
    await bulkLoadCrbmGeneration(storage, { ...SEG, generation: 1 }, [1, 2, 3, 4, 5]);

    // The point of PR A: pass the RAW driver + registry — no manual CrbmStorageChunkSource wrap. If `registry`
    // were dropped when wrapping, this would read the max gen (5) instead of the pinned gen 0 (3).
    const store = new CloudRoaring({ storage: { storage: storage, registry: registry } });
    expect(await store.segment('s').count()).toBe(3);
    expect(await store.segment('s').has(2)).toBe(true); // forces a payload getChunk through the wrapped source
    expect(await store.segment('s').has(5)).toBe(false); // 5 lives only in the unpublished gen 1
    expect(await store.segment('s').has(9)).toBe(false);
  });

  it('a raw driver with no registry falls back to the max-generation list-scan (cleartext)', async () => {
    const storage = new MemoryStorageDriver();
    await bulkLoadCrbmGeneration(storage, { ...SEG, generation: 0 }, [1, 2, 3]);
    await bulkLoadCrbmGeneration(storage, { ...SEG, generation: 1 }, [1, 2, 3, 4, 5]);
    const store = new CloudRoaring({ storage }); // no registry → highest generation
    expect(await store.segment('s').count()).toBe(5);
  });

  it('accepts an already-built StorageChunkSource unchanged (source-only backend)', async () => {
    // A pre-built source is used as-is: reads route straight at it, with no .crbm wrap in between (this
    // source has no index, so `count` falls back to fetching the chunk — still the source we handed over).
    const { store } = seededStore({ s: [42] });
    expect(await store.segment('s').has(42)).toBe(true);
    expect(await store.segment('s').count()).toBe(1);
  });

  it('accepts a CrbmStorageChunkSource you configured yourself (advanced reader options)', async () => {
    const storage = new MemoryStorageDriver();
    const registry = new MemoryRegistryDriver();
    await bulkLoadCrbmGeneration(storage, { ...SEG, generation: 0 }, [7, 8], { registry });
    const source = new CrbmStorageChunkSource(storage, { registry, tailBytes: 4096 });
    const store = new CloudRoaring({ storage: source });
    expect(await store.segment('s').count()).toBe(2);
  });

  it('reads an encrypted segment given a raw driver + registry + keystore (index AND payload)', async () => {
    const storage = new MemoryStorageDriver();
    const registry = new MemoryRegistryDriver();
    const keystore = new InProcessKeystore({ keys: { k1: k() }, activeKeyId: 'k1' });
    await bulkLoadCrbmGeneration(storage, { ...SEG, generation: 0 }, [1, 2, 3], {
      registry,
      keystore,
    });

    const store = new CloudRoaring({
      storage: { storage: storage, registry: registry },
      encryption: { keystore },
    });
    expect(await store.segment('s').count()).toBe(3); // decrypts the .crbm index
    expect(await store.segment('s').has(2)).toBe(true); // decrypts a chunk payload (getChunk)
  });

  it('throws reading an encrypted segment when the keystore is missing', async () => {
    const storage = new MemoryStorageDriver();
    const registry = new MemoryRegistryDriver();
    const keystore = new InProcessKeystore({ keys: { k1: k() }, activeKeyId: 'k1' });
    await bulkLoadCrbmGeneration(storage, { ...SEG, generation: 0 }, [1, 2, 3], {
      registry,
      keystore,
    });

    const store = new CloudRoaring({ storage: { storage: storage, registry: registry } }); // no keystore
    await expect(store.segment('s').count()).rejects.toThrow(KeyUnavailableError);
  });

  it('threads requireEncryption through the wrap — a cleartext read is refused', async () => {
    const storage = new MemoryStorageDriver();
    const registry = new MemoryRegistryDriver();
    // A CLEARTEXT generation (no keystore) published to the registry.
    await bulkLoadCrbmGeneration(storage, { ...SEG, generation: 0 }, [1, 2, 3], { registry });

    // requireEncryption:true must reach the wrapped source; reading cleartext then throws. If the flag were
    // dropped when wrapping, count() would return 3 instead.
    const store = new CloudRoaring({
      storage: { storage: storage, registry: registry },
      encryption: { required: true },
    });
    await expect(store.segment('s').count()).rejects.toThrow(KeyUnavailableError);
  });

  describe('fail-fast wiring guards', () => {
    // `registry` is no longer an option — a backend carries its own — so the pairing that used to be rejected
    // is now unexpressible. What is left to reject is the pair that is still expressible and still inert.
    it('rejects keystore/requireEncryption paired with a pre-built StorageChunkSource', () => {
      const source = (): MemoryStorageChunkSource => new MemoryStorageChunkSource();
      const keystore = new InProcessKeystore({ keys: { k1: k() }, activeKeyId: 'k1' });
      expect(
        () =>
          new CloudRoaring({
            storage: source(),
            encryption: { keystore },
          }),
      ).toThrow(ValidationError);
      expect(
        () =>
          new CloudRoaring({
            storage: source(),
            encryption: { required: true },
          }),
      ).toThrow(ValidationError);
    });

    it('allows requireEncryption:false with a pre-built source (the no-op default)', () => {
      // `false` requests nothing, so it must NOT trip the guard (only an explicit `true` is a wiring mistake).
      expect(
        () =>
          new CloudRoaring({
            storage: new MemoryStorageChunkSource(),
            encryption: { required: false },
          }),
      ).not.toThrow();
    });

    it('rejects a keystore on a raw driver with no registry (nowhere to store the wrapped DEK)', () => {
      const keystore = new InProcessKeystore({ keys: { k1: k() }, activeKeyId: 'k1' });
      expect(
        () =>
          new CloudRoaring({
            storage: new MemoryStorageDriver(),
            encryption: { keystore },
          }),
      ).toThrow(CapabilityError);
    });

    it('rejects requireEncryption on a raw driver with no registry (encryption can’t be enforced)', () => {
      expect(
        () =>
          new CloudRoaring({
            storage: new MemoryStorageDriver(),
            encryption: { required: true },
          }),
      ).toThrow(CapabilityError);
    });

    it('rejects a `storage` that is neither an IStorageDriver nor a StorageChunkSource', () => {
      const notAStorageDriver = {} as unknown as IStorageDriver; // e.g. a typo / wrong object
      expect(() => new CloudRoaring({ storage: notAStorageDriver })).toThrow(ValidationError);
    });

    it('rejects a nullish `storage` with a typed error (not a raw TypeError)', () => {
      for (const bad of [undefined, null]) {
        expect(() => new CloudRoaring({ storage: bad as unknown as IStorageDriver })).toThrow(
          ValidationError,
        );
      }
    });

    // A driver that WRAPS another driver is the natural thing to build for auditing, metrics, tenant scoping
    // or client-side encryption — and now that the tier is called storage, the natural name for the field it
    // wraps is `storage`. Add a registry alongside it and the object satisfies the StorageBackend duck-test
    // and the IStorageDriver one at the same time. Dispatching on the backend shape first read straight
    // through to the halves: the wrapper's own methods never ran, every answer still looked right, and no
    // diagnostic was produced anywhere. Nothing here needs a cast — the union accepts it and `tsc` is clean,
    // which is why this could only ever be caught at runtime.
    it('rejects a driver that is ALSO shaped like a backend, rather than reading through it', async () => {
      const inner = new MemoryStorageDriver();
      const registry = new MemoryRegistryDriver();
      await bulkLoadCrbmGeneration(inner, { ...SEG, generation: 0 }, [1, 2, 3], { registry });

      const calls: string[] = [];
      class AuditingStorageDriver implements IStorageDriver {
        constructor(
          readonly storage: IStorageDriver,
          readonly registry: MemoryRegistryDriver,
        ) {}
        capabilities: IStorageDriver['capabilities'] = () => {
          calls.push('capabilities');
          return this.storage.capabilities();
        };
        putImmutable: IStorageDriver['putImmutable'] = (...a) => {
          calls.push('putImmutable');
          return this.storage.putImmutable(...a);
        };
        getRange: IStorageDriver['getRange'] = (...a) => {
          calls.push('getRange');
          return this.storage.getRange(...a);
        };
        getTail: IStorageDriver['getTail'] = (...a) => {
          calls.push('getTail');
          return this.storage.getTail(...a);
        };
        delete: IStorageDriver['delete'] = (...a) => {
          calls.push('delete');
          return this.storage.delete(...a);
        };
        list: IStorageDriver['list'] = (...a) => {
          calls.push('list');
          return this.storage.list(...a);
        };
      }

      const audited = new AuditingStorageDriver(inner, registry);
      expect(() => new CloudRoaring({ storage: audited })).toThrow(ValidationError);
      expect(() => new CloudRoaring({ storage: audited })).toThrow(/ambiguous/i);
      // The point of the guard: before it, this construction succeeded, answered 3, and never once called
      // the wrapper. A silently-removed audit layer is the "right answer, wrong path" failure it exists to stop.
      expect(calls).toEqual([]);
    });

    // A hand-rolled backend that is one method short used to get the same generic three-way list as a typo,
    // which says nothing about what is actually wrong with it.
    it('names which half of a near-miss backend failed its check', () => {
      const halfBuilt = {
        storage: new MemoryStorageDriver(),
        registry: {} as unknown as MemoryRegistryDriver, // no compareAndSwap
      };
      expect(() => new CloudRoaring({ storage: halfBuilt })).toThrow(/registry.*compareAndSwap/);
      const noPut = {
        storage: {} as unknown as IStorageDriver,
        registry: new MemoryRegistryDriver(),
      };
      expect(() => new CloudRoaring({ storage: noPut })).toThrow(/storage.*putImmutable/);
    });

    it('rejects an ambiguous `storage` exposing both getChunk and putImmutable', () => {
      const hybrid = {
        getChunk: () => null,
        putImmutable: () => ({ size: 0, sha256: '' }),
      } as unknown as IStorageDriver;
      expect(() => new CloudRoaring({ storage: hybrid })).toThrow(ValidationError);
    });
  });
});
