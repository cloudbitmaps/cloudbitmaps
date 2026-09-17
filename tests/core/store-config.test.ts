import { randomBytes } from 'node:crypto';
import {
  isStorageBackend,
  createBackend,
  MemoryStorage,
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
    const backend = new MemoryStorage();
    const { storage, registry } = backend;
    // gen 0 published to the registry…
    await bulkLoadCrbmGeneration(storage, { ...SEG, generation: 0 }, [1, 2, 3], { registry });
    // …and a HIGHER gen 1 written but NOT published. A list-scan would resolve gen 1 (→ 5); the registry pins 0.
    await bulkLoadCrbmGeneration(storage, { ...SEG, generation: 1 }, [1, 2, 3, 4, 5]);

    // The point of PR A: pass the RAW driver + registry — no manual CrbmStorageChunkSource wrap. If `registry`
    // were dropped when wrapping, this would read the max gen (5) instead of the pinned gen 0 (3).
    const store = new CloudRoaring({ storage: backend });
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
    const backend = new MemoryStorage();
    const { storage, registry } = backend;
    await bulkLoadCrbmGeneration(storage, { ...SEG, generation: 0 }, [7, 8], { registry });
    const source = new CrbmStorageChunkSource(storage, { registry, tailBytes: 4096 });
    const store = new CloudRoaring({ storage: source });
    expect(await store.segment('s').count()).toBe(2);
  });

  it('reads an encrypted segment given a raw driver + registry + keystore (index AND payload)', async () => {
    const backend = new MemoryStorage();
    const { storage, registry } = backend;
    const keystore = new InProcessKeystore({ keys: { k1: k() }, activeKeyId: 'k1' });
    await bulkLoadCrbmGeneration(storage, { ...SEG, generation: 0 }, [1, 2, 3], {
      registry,
      keystore,
    });

    const store = new CloudRoaring({
      storage: backend,
      encryption: { keystore },
    });
    expect(await store.segment('s').count()).toBe(3); // decrypts the .crbm index
    expect(await store.segment('s').has(2)).toBe(true); // decrypts a chunk payload (getChunk)
  });

  it('throws reading an encrypted segment when the keystore is missing', async () => {
    const backend = new MemoryStorage();
    const { storage, registry } = backend;
    const keystore = new InProcessKeystore({ keys: { k1: k() }, activeKeyId: 'k1' });
    await bulkLoadCrbmGeneration(storage, { ...SEG, generation: 0 }, [1, 2, 3], {
      registry,
      keystore,
    });

    const store = new CloudRoaring({ storage: backend }); // no keystore
    await expect(store.segment('s').count()).rejects.toThrow(KeyUnavailableError);
  });

  it('threads requireEncryption through the wrap — a cleartext read is refused', async () => {
    const backend = new MemoryStorage();
    const { storage, registry } = backend;
    // A CLEARTEXT generation (no keystore) published to the registry.
    await bulkLoadCrbmGeneration(storage, { ...SEG, generation: 0 }, [1, 2, 3], { registry });

    // requireEncryption:true must reach the wrapped source; reading cleartext then throws. If the flag were
    // dropped when wrapping, count() would return 3 instead.
    const store = new CloudRoaring({
      storage: backend,
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

    // A driver that WRAPS another driver — for auditing, metrics, tenant scoping, client-side encryption —
    // is the natural thing to build, and now that the tier is called storage the natural name for the field it
    // wraps is `storage`. Before the brand that made it indistinguishable from a backend, so the store read
    // straight THROUGH it to the halves and the wrapper's own methods never ran: the layer silently removed,
    // every answer still correct-looking. The brand settles it — an unbranded object is not a backend, so a
    // wrapper is unambiguously a driver and actually gets used.
    it('uses a driver that wraps another, rather than reading through it', async () => {
      const inner = new MemoryStorageDriver();
      await bulkLoadCrbmGeneration(inner, { ...SEG, generation: 0 }, [1, 2, 3]);

      const calls: string[] = [];
      class AuditingStorageDriver implements IStorageDriver {
        constructor(readonly storage: IStorageDriver) {}
        capabilities: IStorageDriver['capabilities'] = () => this.storage.capabilities();
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
        delete: IStorageDriver['delete'] = (...a) => this.storage.delete(...a);
        list: IStorageDriver['list'] = (...a) => {
          calls.push('list');
          return this.storage.list(...a);
        };
      }

      const store = new CloudRoaring({ storage: new AuditingStorageDriver(inner) });
      expect(await store.segment('s').count()).toBe(3);
      // The point: the wrapper is on the read path, not bypassed.
      expect(calls.length).toBeGreaterThan(0);
    });

    // …and to keep a registry alongside an instrumented half, you say so.
    it('`createBackend` is how an instrumented half keeps its registry', async () => {
      const backend = new MemoryStorage();
      await bulkLoadCrbmGeneration(backend.storage, { ...SEG, generation: 0 }, [1, 2, 3], {
        registry: backend.registry,
      });
      let tails = 0;
      const counted: IStorageDriver = {
        capabilities: () => backend.storage.capabilities(),
        putImmutable: (...a) => backend.storage.putImmutable(...a),
        getRange: (...a) => backend.storage.getRange(...a),
        getTail: (...a) => {
          tails += 1;
          return backend.storage.getTail(...a);
        },
        delete: (...a) => backend.storage.delete(...a),
        list: (...a) => backend.storage.list(...a),
      };
      const store = new CloudRoaring({
        storage: createBackend({ storage: counted, registry: backend.registry }),
      });
      expect(await store.segment('s').count()).toBe(3);
      expect(tails).toBeGreaterThan(0);
    });

    // A half-built backend is now caught where it is built, by `createBackend`, rather than at the store.
    it('names which half of a near-miss backend failed its check', () => {
      expect(() =>
        createBackend({
          storage: new MemoryStorageDriver(),
          registry: {} as unknown as MemoryRegistryDriver, // no compareAndSwap
        }),
      ).toThrow(/registry.*IRegistryDriver/);
      expect(() =>
        createBackend({
          storage: {} as unknown as IStorageDriver,
          registry: new MemoryRegistryDriver(),
        }),
      ).toThrow(/storage.*IStorageDriver/);
    });

    // …and an unbranded object with both halves is refused by the STORE, pointing at the classes rather than
    // telling the caller to add a field. The lesson is not "your literal is one property short".
    it('refuses a hand-assembled `{ storage, registry }` and names the backend classes', () => {
      const literal = {
        storage: new MemoryStorageDriver(),
        registry: new MemoryRegistryDriver(),
      } as unknown as MemoryStorage;
      expect(() => new CloudRoaring({ storage: literal })).toThrow(ValidationError);
      expect(() => new CloudRoaring({ storage: literal })).toThrow(/must be a backend/);
      expect(() => new CloudRoaring({ storage: literal })).toThrow(/MemoryStorage/);
    });

    // The bug the brand exists for: halves from two UNRELATED stores. Before it, this constructed happily and
    // answered 0 for a segment holding 3 ids — data in one place, pointer read from another.
    //
    // Three spellings, because the first version of this test asserted only the object literal — and the
    // brand was an ENUMERABLE class field, so `{ ...backend, registry: other }` copied it and sailed through.
    // Spread is the idiomatic way to vary an object in JS, so that was not an exotic bypass: it is the form
    // the audience for `createBackend` would reach for first, and the test named "unconstructible" said
    // nothing about it.
    it.each(['literal', 'spread', 'Object.assign'])(
      'makes the mismatched-halves store unconstructible — %s',
      async (how) => {
        const a = new MemoryStorage();
        const b = new MemoryStorage();
        await bulkLoadCrbmGeneration(a.storage, { ...SEG, generation: 0 }, [1, 2, 3], {
          registry: a.registry,
        });
        const franken = (how === 'literal'
          ? { storage: a.storage, registry: b.registry }
          : how === 'spread'
            ? { ...a, registry: b.registry }
            : Object.assign({}, a, { registry: b.registry })) as unknown as MemoryStorage;
        expect(() => new CloudRoaring({ storage: franken })).toThrow(/must be a backend/);
      },
    );

    // The brand must not be copyable by the ordinary object operations.
    it('the brand is not enumerable, so it cannot be spread off a real backend', () => {
      const brand = Symbol.for('cloudbitmaps.storage-backend');
      const backend = new MemoryStorage();
      expect(Object.getOwnPropertyDescriptor(backend, brand)?.enumerable).toBe(false);
      expect(isStorageBackend(backend)).toBe(true);
      expect(isStorageBackend({ ...backend })).toBe(false);
      expect(isStorageBackend(Object.assign({}, backend))).toBe(false);
    });

    // A driver that wraps another AND carries a registry used to be refused as ambiguous. Branding made it
    // unambiguously a driver — which is right — but it then fell through to the BARE-driver path, where there
    // is no pointer at all: generations resolve by list-scan, so the store serves the highest object in the
    // bucket. A generation written but never published would be read as if it had been, silently, with the
    // wrapper's own registry sitting unused.
    it('refuses a driver that also carries a registry, rather than ignoring the pointer', async () => {
      const backend = new MemoryStorage();
      await bulkLoadCrbmGeneration(backend.storage, { ...SEG, generation: 0 }, [1, 2, 3], {
        registry: backend.registry,
      });
      // A HIGHER generation written but never published — a list-scan would serve this one.
      await bulkLoadCrbmGeneration(backend.storage, { ...SEG, generation: 1 }, [1, 2, 3, 4, 5]);

      const wrapper = {
        capabilities: () => backend.storage.capabilities(),
        putImmutable: (...a: unknown[]) =>
          (backend.storage.putImmutable as (...x: unknown[]) => unknown)(...a),
        getRange: (...a: unknown[]) =>
          (backend.storage.getRange as (...x: unknown[]) => unknown)(...a),
        getTail: (...a: unknown[]) =>
          (backend.storage.getTail as (...x: unknown[]) => unknown)(...a),
        delete: (...a: unknown[]) => (backend.storage.delete as (...x: unknown[]) => unknown)(...a),
        list: (...a: unknown[]) => (backend.storage.list as (...x: unknown[]) => unknown)(...a),
        storage: backend.storage,
        registry: backend.registry,
      } as unknown as IStorageDriver;

      expect(() => new CloudRoaring({ storage: wrapper })).toThrow(/also carries a .registry/);
      expect(() => new CloudRoaring({ storage: wrapper })).toThrow(/createBackend/);
      // …and the named door works, resolving the PUBLISHED generation rather than the highest object.
      const store = new CloudRoaring({
        storage: createBackend({ storage: wrapper, registry: backend.registry }),
      });
      expect(await store.segment('s').count()).toBe(3);
    });

    // A near-miss half must say which half and what is missing, not lecture about buckets.
    it('names the half that is not a driver', () => {
      const backend = new MemoryStorage();
      expect(
        () => new CloudRoaring({ storage: { storage: {}, registry: backend.registry } as never }),
      ).toThrow(/`storage` half is not an IStorageDriver/);
      expect(
        () => new CloudRoaring({ storage: { storage: backend.storage, registry: {} } as never }),
      ).toThrow(/`registry` half is not an IRegistryDriver/);
    });

    // The wall must route the caller to the door, or it teaches "this library cannot do what I need".
    it('the refusal names `createBackend`', () => {
      const a = new MemoryStorage();
      expect(
        () => new CloudRoaring({ storage: { storage: a.storage, registry: a.registry } as never }),
      ).toThrow(/createBackend/);
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
