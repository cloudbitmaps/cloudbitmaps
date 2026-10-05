import fc from 'fast-check';
import { randomBytes } from 'node:crypto';
import { NotFoundError, ValidationError } from '@/core/errors';
import { destroySegment } from '@/core/erasure';
import { gcOrphanGenerations } from '@/core/generation-gc';
import type { IRegistryDriver, IStorageDriver, SegmentRef } from '@/core/ports';
import { brandAsBackend } from '@/core/ports';
import { CloudRoaring, InProcessKeystore, MemoryStorage } from '@/index';
import type { Segment } from '@/index';
import { counting } from '../helpers/counting';
import { bulkLoadCrbmGeneration } from '../helpers/bulk-load';

/**
 * `pinAt` reopens a generation an earlier pin named. A number alone is not an identity (a purged and re-created
 * name starts again at 0), so the fingerprint travels with it, and what is gone or replaced is a `NotFoundError`:
 * it never reads empty.
 */
const REF: SegmentRef = { segment: 's' };

async function ids(seg: Segment): Promise<number[]> {
  const out: number[] = [];
  for await (const v of seg.iterate()) out.push(v);
  return out;
}

async function generationsInBucket(storage: IStorageDriver, ref = REF): Promise<number[]> {
  const out: number[] = [];
  for await (const k of storage.list(ref)) out.push(k.generation);
  return out.sort((a, b) => a - b);
}

/** A writer store and a separate reader store over one backend, so a load does not invalidate the reader's pins. */
function world(options: { keystore?: InProcessKeystore } = {}) {
  const backend = new MemoryStorage();
  const encryption =
    options.keystore === undefined ? {} : { encryption: { keystore: options.keystore } };
  const writer = new CloudRoaring({ storage: backend, ...encryption });
  const reader = () => new CloudRoaring({ storage: backend, ...encryption });
  return { backend, writer, reader };
}

const atOf = (snap: Segment) => ({
  generation: snap.pinnedAt!.generation!,
  fingerprint: snap.pinnedAt!.fingerprint!,
});

describe('pinAt reopens a named generation', () => {
  it('reads the same ids as the earlier pin, after later loads within keep', async () => {
    const w = world();
    await w.writer.load(REF, [1, 2, 3], { keep: 6 });
    const first = await w.reader().segment('s').pin();
    for (let i = 0; i < 5; i++) await w.writer.load(REF, [10 + i, 20 + i], { keep: 6 });

    const again = await w.reader().segment('s').pinAt(atOf(first));
    expect(await ids(again)).toEqual([1, 2, 3]);
    expect(await again.count()).toBe(3);
    expect(atOf(again)).toEqual(atOf(first));
    expect(await ids(await w.reader().segment('s').pin())).toEqual([14, 24]);
  });

  it('refuses a fingerprint that is another object', async () => {
    const w = world();
    await w.writer.load(REF, [1, 2, 3], { keep: 3 });
    const first = await w.reader().segment('s').pin();
    const { generation } = atOf(first);
    for (const fingerprint of ['1:1', `${first.pinnedAt!.fingerprint!.split(':')[0]}:1`]) {
      await expect(
        w.reader().segment('s').pinAt({ generation, fingerprint }),
      ).rejects.toBeInstanceOf(NotFoundError);
    }
  });

  it('refuses a collected generation', async () => {
    const w = world();
    await w.writer.load(REF, [1, 2, 3]);
    const first = await w.reader().segment('s').pin();
    for (let i = 0; i < 4; i++) await w.writer.load(REF, [100 + i]);
    expect(await generationsInBucket(w.backend.storage)).not.toContain(0);
    await expect(w.reader().segment('s').pinAt(atOf(first))).rejects.toBeInstanceOf(NotFoundError);
  });

  it('refuses a generation above the row pointer, and one of a segment with no row', async () => {
    const w = world();
    await w.writer.load(REF, [1, 2, 3]);
    const first = await w.reader().segment('s').pin();
    const fingerprint = first.pinnedAt!.fingerprint!;
    await expect(
      w.reader().segment('s').pinAt({ generation: 7, fingerprint }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      w.reader().segment('nope').pinAt({ generation: 0, fingerprint }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('refuses a generation number reused after a purge and re-create', async () => {
    const w = world();
    await w.writer.load(REF, [1, 2, 3]);
    const first = await w.reader().segment('s').pin();
    for await (const key of w.backend.storage.list(REF)) await w.backend.storage.delete(key);
    await w.backend.registry.delete(REF);
    await w.writer.load(REF, [7, 8, 9, 10, 11]);
    const reborn = await w.reader().segment('s').pin();
    expect(reborn.pinnedAt!.generation).toBe(first.pinnedAt!.generation); // the number is taken again
    await expect(w.reader().segment('s').pinAt(atOf(first))).rejects.toBeInstanceOf(NotFoundError);
    // The reborn name's own fingerprint is accepted.
    expect(await ids(await w.reader().segment('s').pinAt(atOf(reborn)))).toEqual([7, 8, 9, 10, 11]);
  });

  it('refuses a bare number, and a malformed name, with ValidationError', async () => {
    const w = world();
    await w.writer.load(REF, [1, 2, 3]);
    const seg = w.reader().segment('s');
    const bad: unknown[] = [
      { generation: 0 },
      { generation: 0, fingerprint: '' },
      { generation: 0, fingerprint: 'abc' },
      { generation: -1, fingerprint: '1:1' },
      { generation: 1.5, fingerprint: '1:1' },
      { fingerprint: '1:1' },
      0,
      undefined,
      null,
    ];
    for (const at of bad) {
      await expect(
        (seg as unknown as { pinAt(a: unknown): Promise<Segment> }).pinAt(at),
      ).rejects.toBeInstanceOf(ValidationError);
    }
  });

  it('works for an encrypted segment', async () => {
    const keystore = new InProcessKeystore({ keys: { k1: randomBytes(32) }, activeKeyId: 'k1' });
    const w = world({ keystore });
    await w.writer.load(REF, [4, 5, 6], { keep: 3 });
    const first = await w.reader().segment('s').pin();
    await w.writer.load(REF, [40], { keep: 3 });
    const again = await w.reader().segment('s').pinAt(atOf(first));
    expect(await ids(again)).toEqual([4, 5, 6]);
    await expect(
      w.reader().segment('s').pinAt({ generation: 0, fingerprint: '1:1' }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('keeps the segment handle options: an expiring handle pins an expiring handle', async () => {
    const w = world();
    await w.writer.load(REF, [1, 2, 3]);
    const first = await w.reader().segment('s').pin();
    const handle = w.reader().segment('s', { expiresAt: Date.now() + 3_600_000 });
    expect((await handle.pinAt(atOf(first))).expiresAt).toBe(handle.expiresAt);
  });
});

describe('what pinAt costs', () => {
  it('is one row read and one tail read, and a pinned read after it makes none of either', async () => {
    const real = new MemoryStorage();
    const writer = new CloudRoaring({ storage: real });
    await writer.load(REF, [1, 2, 3]);
    await writer.load(REF, [4, 5]);
    const first = await new CloudRoaring({ storage: real }).segment('s').pin();
    await writer.load(REF, [6], { keep: 3 });

    const counts: Record<string, number> = {};
    const storage: IStorageDriver = counting(real.storage, counts);
    const registry: IRegistryDriver = counting(real.registry, counts);
    const store = new CloudRoaring({ storage: brandAsBackend({ storage, registry }) });
    const snap = await store.segment('s').pinAt(atOf(first));
    const requests = () => ({
      get: counts.get,
      getTail: counts.getTail,
      getRange: counts.getRange,
    });
    expect(requests()).toEqual({ get: 1, getTail: 1, getRange: undefined });
    expect(await snap.count()).toBe(2);
    expect(requests()).toEqual({ get: 1, getTail: 1, getRange: undefined });
  });

  it('a store with no registry pays the tail read alone, and still tells another object apart', async () => {
    const backend = new MemoryStorage();
    const writer = new CloudRoaring({ storage: backend });
    await writer.load(REF, [1, 2, 3], { keep: 3 });
    const first = await new CloudRoaring({ storage: backend.storage }).segment('s').pin();
    await writer.load(REF, [4], { keep: 3 });

    const counts: Record<string, number> = {};
    const store = new CloudRoaring({ storage: counting(backend.storage, counts) });
    const snap = await store.segment('s').pinAt(atOf(first));
    expect(counts.getTail).toBe(1);
    expect(counts.get).toBeUndefined();
    expect(await ids(snap)).toEqual([1, 2, 3]);
    await expect(
      store.segment('s').pinAt({ generation: atOf(first).generation, fingerprint: '1:1' }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('a pinAt handle reads as a pin() handle does after a sweep', () => {
  async function swept(ids_: number[]) {
    const w = world();
    await w.writer.load(REF, ids_, { keep: 2 });
    const first = await w.reader().segment('s').pin();
    for (let i = 0; i < 2; i++) await w.writer.load(REF, [1_000_000 + i], { keep: 2 });
    const held = await w.reader().segment('s').pinAt(atOf(first)); // still within keep
    await w.writer.load(REF, [2_000_000], { keep: 2 });
    await w.writer.load(REF, [2_000_001], { keep: 2 });
    expect(await generationsInBucket(w.backend.storage)).not.toContain(0);
    return { first, held };
  }

  it('a small generation answers from what the handle holds, exactly as pin() does', async () => {
    const { first, held } = await swept([1, 2, 3]);
    expect(await ids(held)).toEqual(await ids(first));
    expect(await held.count()).toBe(3);
  });

  it('a large generation throws NotFoundError on a chunk it has not cached, as pin() does', async () => {
    const many = Array.from({ length: 4000 }, (_, i) => i * 70_000);
    const { first, held } = await swept(many);
    const pinResult = await ids(first).then(
      () => 'answered',
      (e: unknown) => (e instanceof NotFoundError ? 'NotFoundError' : String(e)),
    );
    const pinAtResult = await ids(held).then(
      () => 'answered',
      (e: unknown) => (e instanceof NotFoundError ? 'NotFoundError' : String(e)),
    );
    expect(pinAtResult).toBe(pinResult);
    expect(pinAtResult).toBe('NotFoundError');
    expect(await held.count()).toBe(many.length);
  });
});

describe('pinAt never reads empty', () => {
  it('every read over random load, collect and pinAt sequences equals the oracle or throws', async () => {
    type Op =
      | { kind: 'load'; ids: number[] }
      | { kind: 'collect'; keep: number }
      | { kind: 'pinAt'; pick: number; wrong: boolean };
    const op: fc.Arbitrary<Op> = fc.oneof(
      {
        arbitrary: fc.record({
          kind: fc.constant('load' as const),
          ids: fc.uniqueArray(fc.integer({ min: 0, max: 300_000 }), {
            minLength: 1,
            maxLength: 40,
          }),
        }),
        weight: 4,
      },
      {
        arbitrary: fc.record({
          kind: fc.constant('collect' as const),
          keep: fc.integer({ min: 0, max: 3 }),
        }),
        weight: 2,
      },
      {
        arbitrary: fc.record({
          kind: fc.constant('pinAt' as const),
          pick: fc.nat(1000),
          wrong: fc.boolean(),
        }),
        weight: 4,
      },
    );
    await fc.assert(
      fc.asyncProperty(fc.array(op, { minLength: 1, maxLength: 24 }), async (ops) => {
        const w = world();
        const oracle = new Map<number, { ids: number[]; fingerprint: string }>();
        for (const o of ops) {
          if (o.kind === 'load') {
            const result = await w.writer.load(REF, o.ids, { keep: 3 });
            expect(result.published).toBe(true);
            const snap = await w.reader().segment('s').pin();
            oracle.set(snap.pinnedAt!.generation!, {
              ids: [...o.ids].sort((a, b) => a - b),
              fingerprint: snap.pinnedAt!.fingerprint!,
            });
          } else if (o.kind === 'collect') {
            await gcOrphanGenerations(REF, w.backend, { keep: o.keep });
          } else if (oracle.size > 0) {
            const gens = [...oracle.keys()];
            const generation = gens[o.pick % gens.length]!;
            const entry = oracle.get(generation)!;
            const present = (await generationsInBucket(w.backend.storage)).includes(generation);
            const fingerprint = o.wrong ? `${entry.fingerprint}0` : entry.fingerprint;
            let handle: Segment | undefined;
            try {
              handle = await w.reader().segment('s').pinAt({ generation, fingerprint });
            } catch (e) {
              expect(e).toBeInstanceOf(NotFoundError);
              expect(o.wrong || !present).toBe(true);
              continue;
            }
            expect(o.wrong).toBe(false);
            expect(present).toBe(true);
            try {
              expect(await ids(handle)).toEqual(entry.ids);
              expect(await handle.count()).toBe(entry.ids.length);
            } catch (e) {
              expect(e).toBeInstanceOf(NotFoundError);
            }
          }
        }
      }),
      { numRuns: 25 },
    );
  });
});

describe('pinAt and the row', () => {
  it('refuses an encrypted segment once it is crypto-shredded', async () => {
    const keystore = new InProcessKeystore({ keys: { k1: randomBytes(32) }, activeKeyId: 'k1' });
    const w = world({ keystore });
    await w.writer.load(REF, [4, 5, 6], { keep: 3 });
    const first = await w.reader().segment('s').pin();
    expect(await ids(await w.reader().segment('s').pinAt(atOf(first)))).toEqual([4, 5, 6]);
    await destroySegment(REF, { registry: w.backend.registry }, { confirmSegment: 's' });
    await expect(w.reader().segment('s').pinAt(atOf(first))).rejects.toBeInstanceOf(NotFoundError);
  });

  it('refuses a generation above the pointer although its object is still stored', async () => {
    const w = world();
    for (const i of [1, 2, 3]) await w.writer.load(REF, [i, i + 10], { keep: 10 });
    const top = await w.reader().segment('s').pin();
    expect(atOf(top).generation).toBe(2);
    await w.writer.rollback(REF, 0);
    expect(await generationsInBucket(w.backend.storage)).toContain(2);
    await expect(w.reader().segment('s').pinAt(atOf(top))).rejects.toBeInstanceOf(NotFoundError);
  });

  it('after a rollback and one more load, reopens a generation it rolled back from while its object is stored', async () => {
    const w = world();
    for (const i of [1, 2, 3]) await w.writer.load(REF, [i, i + 10], { keep: 10 });
    const top = await w.reader().segment('s').pin();
    await w.writer.rollback(REF, 0);
    await w.writer.load(REF, [99], { keep: 10 });
    const again = await w.reader().segment('s').pinAt(atOf(top));
    expect(await ids(again)).toEqual([3, 13]);
  });

  it('reads an object restored under its key, after a pinAt with the wrong fingerprint found it replaced', async () => {
    const backend = new MemoryStorage();
    await bulkLoadCrbmGeneration(backend.storage, { ...REF, generation: 0 }, [1, 2, 3], {
      registry: backend.registry,
    });
    const whole = async (b: MemoryStorage) =>
      (await b.storage.getTail({ ...REF, generation: 0 }, 1 << 30)).bytes;
    const put = async (bytes: Uint8Array) => {
      await backend.storage.delete({ ...REF, generation: 0 });
      await backend.storage.putImmutable({ ...REF, generation: 0 }, async (sink) => {
        await sink.write(bytes);
      });
    };
    const mine = await whole(backend);
    const scratch = new MemoryStorage();
    await bulkLoadCrbmGeneration(scratch.storage, { ...REF, generation: 0 }, [7, 8, 9, 10], {
      registry: scratch.registry,
    });
    const other = await whole(scratch);

    const store = new CloudRoaring({ storage: backend });
    const first = await store.segment('s').pin();
    await put(other); // replaced from outside, under the same key
    store.invalidate(REF); // the store is told, so the reopen reads what is stored
    await expect(store.segment('s').pinAt(atOf(first))).rejects.toBeInstanceOf(NotFoundError);
    await put(mine); // restored
    const again = await store.segment('s').pinAt(atOf(first));
    expect(await ids(again)).toEqual([1, 2, 3]);
  });

  it('works in one store through pin, loads, a wrong fingerprint, the right one and a later pin', async () => {
    const backend = new MemoryStorage();
    const store = new CloudRoaring({ storage: backend });
    await store.load(REF, [1, 2, 3], { keep: 4 });
    const first = await store.segment('s').pin();
    await store.load(REF, [4, 5], { keep: 4 });
    const at = atOf(first);
    // A load invalidates this store's pins, so the reopen is of an object it must open again.
    await expect(store.segment('s').pinAt({ ...at, fingerprint: '1:1' })).rejects.toBeInstanceOf(
      NotFoundError,
    );
    const again = await store.segment('s').pinAt(at);
    expect(await ids(again)).toEqual([1, 2, 3]);
    expect(await ids(await store.segment('s').pin())).toEqual([4, 5]);
    expect(await ids(await store.segment('s').pinAt(at))).toEqual([1, 2, 3]);
  });
});

describe('pinAt argument', () => {
  it('refuses unanchored, padded and unknown fingerprints and options with ValidationError', async () => {
    const w = world();
    await w.writer.load(REF, [1, 2, 3]);
    const seg = w.reader().segment('s') as unknown as { pinAt(a: unknown): Promise<Segment> };
    for (const fingerprint of [' 1:1', '1:1x', '1:1\n', '1:']) {
      await expect(seg.pinAt({ generation: 0, fingerprint })).rejects.toBeInstanceOf(
        ValidationError,
      );
    }
    const first = await w.reader().segment('s').pin();
    await expect(seg.pinAt({ ...atOf(first), leaseUntil: 1 })).rejects.toThrow(/leaseUntil/);
    await expect(seg.pinAt({ ...atOf(first), leaseUntil: 1 })).rejects.toBeInstanceOf(
      ValidationError,
    );
    // A leading zero is well-formed, and names no object: it is gone, not malformed.
    await expect(seg.pinAt({ generation: 0, fingerprint: '01:1' })).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });
});
