import { randomBytes } from 'node:crypto';
import { CloudRoaring, MemoryStorage } from '@/index';
import type { CloudRoaringOptions, SegmentRef } from '@/index';
import { CrbmReader } from '@/core/crbm/reader';
import { BufferReader } from '@/core/blob';
import { FOOTER, FOOTER_BYTES } from '@/core/crbm/format';
import { loadSegment } from '@/core/load';
import { eraseIdFromSegment } from '@/core/erase-id';
import { ValidationError } from '@/core/errors';
import { MemoryRegistryDriver, MemoryStorageDriver } from '@/drivers/memory';
import { InProcessKeystore } from '@/drivers/crypto';
import { roaringCodec } from '@/roaring-codec';
import { collect } from '../helpers/loaded';
import { counterEntropy, fixedEntropy, recordingEntropy } from '../helpers/entropy';

/**
 * Every generation carries a random write identity in its footer's `indexNonce` field: a cleartext one stores 12 bytes
 * its writer drew, an encrypted one its index's AEAD nonce. The footer checksum covers it, so an object's fingerprint
 * names one write.
 */

const IDS = [3, 5, 8, 70_000];
const NONCE_AT = FOOTER.indexNonce;

interface World {
  readonly store: CloudRoaring;
  readonly backend: MemoryStorage;
  /** The length of every draw the store made, in order. */
  readonly draws: number[];
}

function world(options: Omit<CloudRoaringOptions, 'storage'> = {}): World {
  const backend = new MemoryStorage();
  const recorded = recordingEntropy(counterEntropy());
  const store = new CloudRoaring({
    ...options,
    storage: backend,
    seams: { entropy: recorded.entropy, ...options.seams },
    retry: false,
  });
  return { store, backend, draws: recorded.draws };
}

async function objectOf(w: World, ref: SegmentRef, generation: number): Promise<Uint8Array> {
  return (await w.backend.storage.getTail({ ...ref, generation }, 1 << 30)).bytes;
}

const nonceOf = (bytes: Uint8Array): Uint8Array =>
  bytes.slice(bytes.length - FOOTER_BYTES + NONCE_AT, bytes.length - FOOTER_BYTES + NONCE_AT + 12);

describe('two loads of the same ids', () => {
  it('write two objects with two fingerprints, and nothing else in them differs', async () => {
    const w = world();
    await w.store.load({ segment: 'a' }, IDS);
    await w.store.load({ segment: 'b' }, IDS);
    const a = await objectOf(w, { segment: 'a' }, 0);
    const b = await objectOf(w, { segment: 'b' }, 0);
    expect(a).not.toEqual(b);
    expect(a.length).toBe(b.length);
    const ra = await CrbmReader.open(new BufferReader(a));
    const rb = await CrbmReader.open(new BufferReader(b));
    expect(ra.fingerprint).not.toBe(rb.fingerprint);
    expect(nonceOf(a)).not.toEqual(nonceOf(b));
    // Under one source that repeats, they are the same object again: the identity is the whole difference.
    const same = world({ seams: { entropy: fixedEntropy(new Uint8Array(12).fill(9)) } });
    await same.store.load({ segment: 'a' }, IDS);
    await same.store.load({ segment: 'b' }, IDS);
    expect(await objectOf(same, { segment: 'a' }, 0)).toEqual(
      await objectOf(same, { segment: 'b' }, 0),
    );
  });

  it('the identity is in the footer checksum: the fingerprint the row records is the object own', async () => {
    const w = world();
    const ref = { segment: 'a' };
    await w.store.load(ref, IDS);
    const bytes = await objectOf(w, ref, 0);
    const row = await w.backend.registry.get(ref);
    const reader = await CrbmReader.open(new BufferReader(bytes));
    expect(row?.summary).toMatchObject({ fingerprint: reader.fingerprint });
    expect(row?.knownGens).toEqual([
      { generation: 0, footerCrc: Number(reader.fingerprint.split(':')[1]) },
    ]);
    expect(nonceOf(bytes)).not.toEqual(new Uint8Array(12));
  });

  it('draws one identity per load, from the same seam, and reads the object back', async () => {
    const w = world();
    await w.store.load({ segment: 'a' }, IDS);
    await w.store.load({ segment: 'a' }, [1, 2]);
    expect(w.draws).toEqual([12, 12]);
    expect(await collect(w.store.segment('a').iterate())).toEqual([1, 2]);
  });
});

describe('an encrypted generation', () => {
  const keys = { k1: randomBytes(32) };
  const encrypted = () =>
    world({ encryption: { keystore: new InProcessKeystore({ keys, activeKeyId: 'k1' }) } });

  it('keeps its index nonce in the slot, draws nothing from the store source, and decrypts', async () => {
    const w = encrypted();
    const ref = { segment: 'e' };
    await w.store.load(ref, IDS);
    await w.store.load(ref, [...IDS, 9]);
    expect(w.draws).toEqual([]);
    const first = nonceOf(await objectOf(w, ref, 0));
    const second = nonceOf(await objectOf(w, ref, 1));
    expect(first).not.toEqual(new Uint8Array(12));
    expect(first).not.toEqual(second);
    expect(await collect(w.store.segment(ref.segment).iterate())).toEqual([3, 5, 8, 9, 70_000]);
    expect(await w.store.segment(ref.segment).count()).toBe(IDS.length + 1);
  });
});

describe('the write path costs one draw a generation and the read path none', () => {
  it('a warm has, count, iterate and intersect draw nothing', async () => {
    const w = world();
    await w.store.load({ segment: 'a' }, IDS);
    await w.store.load({ segment: 'b' }, [5, 8, 9]);
    const before = w.draws.length;
    const a = w.store.segment('a');
    await a.has(3);
    await a.count();
    await collect(a.iterate());
    await collect(a.intersect([w.store.segment('b')]));
    await a.has(3);
    expect(w.draws.length).toBe(before);
  });

  it('a load, an erasure rewrite, an Into verb and each output of materializeMany draw once', async () => {
    const w = world();
    await w.store.load({ segment: 'a' }, IDS);
    await w.store.load({ segment: 'b' }, [5, 8, 9]);
    expect(w.draws).toEqual([12, 12]);

    await w.store.segment('a').intersectInto(w.store.segment('x'), [w.store.segment('b')]);
    expect(w.draws.length).toBe(3);

    const s = (n: string) => w.store.segment(n);
    await w.store.materializeMany({
      operands: { a: s('a'), b: s('b') },
      outputs: [
        { dest: s('m-and'), expr: { and: ['a', 'b'] } },
        { dest: s('m-or'), expr: { or: ['a', 'b'] } },
      ],
      keep: 2,
    });
    expect(w.draws.length).toBe(5);

    const erased = await w.store.eraseSubject(70_000, { allNamespaces: true });
    expect(erased.erasedFrom.some((e) => e.erased)).toBe(true);
    const rewrites = erased.erasedFrom.filter((e) => e.erased).length;
    expect(w.draws.length).toBe(5 + rewrites);
    expect(w.draws.every((n) => n === 12)).toBe(true);
  });
});

describe('a writer with no entropy source', () => {
  it('is refused before it writes: a load, and an erasure rewrite', async () => {
    const storage = new MemoryStorageDriver();
    const registry = new MemoryRegistryDriver();
    const ref = { segment: 's' };
    await expect(
      loadSegment(ref, IDS, { storage, registry, codec: roaringCodec }),
    ).rejects.toBeInstanceOf(ValidationError);
    const gens: number[] = [];
    for await (const k of storage.list(ref)) gens.push(k.generation);
    expect(gens).toEqual([]);

    await loadSegment(ref, IDS, {
      storage,
      registry,
      codec: roaringCodec,
      entropy: counterEntropy(),
    });
    await expect(
      eraseIdFromSegment(ref, 3, { storage, registry, codec: roaringCodec }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('is refused at construction when the seam is not a function, and at the write when it returns the wrong length', async () => {
    expect(
      () => new CloudRoaring({ storage: new MemoryStorage(), seams: { entropy: 5 as never } }),
    ).toThrow(ValidationError);
    const store = new CloudRoaring({
      storage: new MemoryStorage(),
      seams: { entropy: () => new Uint8Array(4) },
    });
    await expect(store.load({ segment: 'a' }, IDS)).rejects.toBeInstanceOf(ValidationError);
  });
});
