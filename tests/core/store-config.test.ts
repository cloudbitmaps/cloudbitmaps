import { randomBytes } from 'node:crypto';
import {
  CloudRoaring,
  CrbmColdChunkSource,
  MemoryColdChunkSource,
  MemoryColdDriver,
  MemoryRegistryDriver,
  MemoryWarmDriver,
  bulkLoadCrbmGeneration,
} from '@/index';
import { InProcessKeystore } from '@/drivers/crypto';
import { CapabilityError, KeyUnavailableError, ValidationError } from '@/core/errors';
import type { IColdDriver, SegmentRef } from '@/index';

// PR A: the store takes ONE config shape — `cold` is a raw IColdDriver (wrapped into the .crbm cold source
// here, so drivers are wired once) OR an already-built ColdChunkSource (for source-only / pre-configured
// backends). `registry`/`keystore`/`requireEncryption` move up to the config and apply on the raw-driver path.
// These tests pin the resolution, that each option is actually threaded through the wrap, and the fail-fast guards.
const SEG: SegmentRef = { segment: 's' };
const k = (): Uint8Array => randomBytes(32);
const warm = (): MemoryWarmDriver => new MemoryWarmDriver();

describe('CloudRoaring constructor — one config shape (cold: raw driver | source)', () => {
  it('wraps a raw IColdDriver and pins the registry currentGen (not the max on disk)', async () => {
    const cold = new MemoryColdDriver();
    const registry = new MemoryRegistryDriver();
    // gen 0 published to the registry…
    await bulkLoadCrbmGeneration(cold, { ...SEG, generation: 0 }, [1, 2, 3], { registry });
    // …and a HIGHER gen 1 written but NOT published. A list-scan would resolve gen 1 (→ 5); the registry pins 0.
    await bulkLoadCrbmGeneration(cold, { ...SEG, generation: 1 }, [1, 2, 3, 4, 5]);

    // The point of PR A: pass the RAW driver + registry — no manual CrbmColdChunkSource wrap. If `registry`
    // were dropped when wrapping, this would read the max gen (5) instead of the pinned gen 0 (3).
    const store = new CloudRoaring({ warm: warm(), cold, registry });
    expect(await store.segment('s').count()).toBe(3);
    expect(await store.segment('s').has(2)).toBe(true); // forces a payload getChunk through the wrapped source
    expect(await store.segment('s').has(5)).toBe(false); // 5 lives only in the unpublished gen 1
    expect(await store.segment('s').has(9)).toBe(false);
  });

  it('a raw driver with no registry falls back to the max-generation list-scan (cleartext)', async () => {
    const cold = new MemoryColdDriver();
    await bulkLoadCrbmGeneration(cold, { ...SEG, generation: 0 }, [1, 2, 3]);
    await bulkLoadCrbmGeneration(cold, { ...SEG, generation: 1 }, [1, 2, 3, 4, 5]);
    const store = new CloudRoaring({ warm: warm(), cold }); // no registry → highest generation
    expect(await store.segment('s').count()).toBe(5);
  });

  it('accepts an already-built ColdChunkSource unchanged (source-only backend)', async () => {
    // A pre-built source is used as-is. A warm-only round-trip proves the store is live.
    const store = new CloudRoaring({ warm: warm(), cold: new MemoryColdChunkSource() });
    await store.segment('s').add(42);
    expect(await store.segment('s').has(42)).toBe(true);
    expect(await store.segment('s').count()).toBe(1);
  });

  it('accepts a CrbmColdChunkSource you configured yourself (advanced reader options)', async () => {
    const cold = new MemoryColdDriver();
    const registry = new MemoryRegistryDriver();
    await bulkLoadCrbmGeneration(cold, { ...SEG, generation: 0 }, [7, 8], { registry });
    const source = new CrbmColdChunkSource(cold, { registry, tailBytes: 4096 });
    const store = new CloudRoaring({ warm: warm(), cold: source });
    expect(await store.segment('s').count()).toBe(2);
  });

  it('reads an encrypted segment given a raw driver + registry + keystore (index AND payload)', async () => {
    const cold = new MemoryColdDriver();
    const registry = new MemoryRegistryDriver();
    const keystore = new InProcessKeystore({ keys: { k1: k() }, activeKeyId: 'k1' });
    await bulkLoadCrbmGeneration(cold, { ...SEG, generation: 0 }, [1, 2, 3], {
      registry,
      keystore,
    });

    const store = new CloudRoaring({ warm: warm(), cold, registry, keystore });
    expect(await store.segment('s').count()).toBe(3); // decrypts the .crbm index
    expect(await store.segment('s').has(2)).toBe(true); // decrypts a chunk payload (getChunk)
  });

  it('throws reading an encrypted segment when the keystore is missing', async () => {
    const cold = new MemoryColdDriver();
    const registry = new MemoryRegistryDriver();
    const keystore = new InProcessKeystore({ keys: { k1: k() }, activeKeyId: 'k1' });
    await bulkLoadCrbmGeneration(cold, { ...SEG, generation: 0 }, [1, 2, 3], {
      registry,
      keystore,
    });

    const store = new CloudRoaring({ warm: warm(), cold, registry }); // no keystore
    await expect(store.segment('s').count()).rejects.toThrow(KeyUnavailableError);
  });

  it('threads requireEncryption through the wrap — a cleartext read is refused', async () => {
    const cold = new MemoryColdDriver();
    const registry = new MemoryRegistryDriver();
    // A CLEARTEXT generation (no keystore) published to the registry.
    await bulkLoadCrbmGeneration(cold, { ...SEG, generation: 0 }, [1, 2, 3], { registry });

    // requireEncryption:true must reach the wrapped source; reading cleartext then throws. If the flag were
    // dropped when wrapping, count() would return 3 instead.
    const store = new CloudRoaring({ warm: warm(), cold, registry, requireEncryption: true });
    await expect(store.segment('s').count()).rejects.toThrow(KeyUnavailableError);
  });

  describe('fail-fast wiring guards', () => {
    it('rejects registry/keystore/requireEncryption paired with a pre-built ColdChunkSource', () => {
      const source = (): MemoryColdChunkSource => new MemoryColdChunkSource();
      const keystore = new InProcessKeystore({ keys: { k1: k() }, activeKeyId: 'k1' });
      const registry = new MemoryRegistryDriver();
      expect(() => new CloudRoaring({ warm: warm(), cold: source(), registry })).toThrow(
        ValidationError,
      );
      expect(() => new CloudRoaring({ warm: warm(), cold: source(), keystore })).toThrow(
        ValidationError,
      );
      expect(
        () => new CloudRoaring({ warm: warm(), cold: source(), requireEncryption: true }),
      ).toThrow(ValidationError);
    });

    it('allows requireEncryption:false with a pre-built source (the no-op default)', () => {
      // `false` requests nothing, so it must NOT trip the guard (only an explicit `true` is a wiring mistake).
      expect(
        () =>
          new CloudRoaring({
            warm: warm(),
            cold: new MemoryColdChunkSource(),
            requireEncryption: false,
          }),
      ).not.toThrow();
    });

    it('rejects a keystore on a raw driver with no registry (nowhere to store the wrapped DEK)', () => {
      const keystore = new InProcessKeystore({ keys: { k1: k() }, activeKeyId: 'k1' });
      expect(
        () => new CloudRoaring({ warm: warm(), cold: new MemoryColdDriver(), keystore }),
      ).toThrow(CapabilityError);
    });

    it('rejects requireEncryption on a raw driver with no registry (encryption can’t be enforced)', () => {
      expect(
        () =>
          new CloudRoaring({ warm: warm(), cold: new MemoryColdDriver(), requireEncryption: true }),
      ).toThrow(CapabilityError);
    });

    it('rejects a `cold` that is neither an IColdDriver nor a ColdChunkSource', () => {
      const notCold = {} as unknown as IColdDriver; // e.g. a typo / wrong object
      expect(() => new CloudRoaring({ warm: warm(), cold: notCold })).toThrow(ValidationError);
    });

    it('rejects a nullish `cold` with a typed error (not a raw TypeError)', () => {
      for (const bad of [undefined, null]) {
        expect(
          () => new CloudRoaring({ warm: warm(), cold: bad as unknown as IColdDriver }),
        ).toThrow(ValidationError);
      }
    });

    it('rejects an ambiguous `cold` exposing both getChunk and putImmutable', () => {
      const hybrid = {
        getChunk: () => null,
        putImmutable: () => ({ size: 0, sha256: '' }),
      } as unknown as IColdDriver;
      expect(() => new CloudRoaring({ warm: warm(), cold: hybrid })).toThrow(ValidationError);
    });
  });
});
