import { randomBytes } from 'node:crypto';
import { destroySegment } from '@/core/erasure';
import { eraseIdFromSegment } from '@/core/erase-id';
import { openGenerationReader } from '@/core/crbm-open';
import { aadFor } from '@/core/crypto';
import type { Aead } from '@/core/crypto';
import { NotFoundError } from '@/core/errors';
import { KNOWN_FILL, MAX_KNOWN_GENERATIONS, usableKnownGens } from '@/core/known-generations';
import { loadSegment } from '@/core/load';
import type {
  GenKey,
  IStorageDriver,
  KnownGeneration,
  RegistryRecord,
  SegmentRef,
} from '@/core/ports';
import { setSegmentRetention } from '@/core/retention';
import { rollbackSegment } from '@/core/rollback';
import { MAX_TAIL_BYTES, usableSummary } from '@/core/summary';
import { InProcessKeystore } from '@/drivers/crypto';
import { MemoryRegistryDriver, MemoryStorageDriver } from '@/drivers/memory';
import { MIN_EXPIRES_AT_MS } from '@/core/retention';
import { storeCodec } from '../helpers/store-codec';
import { bulkLoadCrbmGeneration } from '../helpers/bulk-load';
import { objectFingerprint } from '../helpers/fingerprint';
import { testEntropy } from '../helpers/entropy';

/**
 * What every writer of a row leaves in its ledger, `knownGens`: the generation made current last, each entry's footer
 * checksum the one its object's footer stores, in the order the generations were made current. And what it leaves in
 * its summary: the object's own `tailBytes`, from the one object the writer wrote or opened, so the two never come from
 * different reads. Each writer, clear and sealed.
 */

const SEG: SegmentRef = { namespace: 'ns', segment: 's' };
const idsOf = (n: number): number[] => Array.from({ length: n }, (_, i) => i);

function world(encrypted: boolean) {
  const memory = new MemoryStorageDriver();
  const registry = new MemoryRegistryDriver();
  const keystore = encrypted
    ? new InProcessKeystore({ keys: { k1: randomBytes(32) }, activeKeyId: 'k1' })
    : undefined;
  const deps = { storage: memory, registry, entropy: testEntropy, codec: storeCodec, keystore };
  return { memory, registry, keystore, deps };
}
type World = ReturnType<typeof world>;

const rowOf = async (w: World): Promise<RegistryRecord> => (await w.registry.get(SEG))!;
const numbers = (ledger: readonly KnownGeneration[] | undefined): number[] | undefined =>
  ledger?.map((e) => e.generation);

/** The footer checksum the object under a generation's key stores, read from the object. */
async function crcOfObject(w: World, generation: number): Promise<number> {
  const fingerprint = await objectFingerprint(w.memory, { ...SEG, generation });
  return Number(fingerprint.slice(fingerprint.indexOf(':') + 1));
}

/** The object's `tailBytes` as a reader of it reports, opened with the segment's key when it has one. */
async function tailOfObject(w: World, generation: number): Promise<number> {
  const key: GenKey = { ...SEG, generation };
  let aead: Aead | undefined;
  if (w.keystore !== undefined) aead = await w.keystore.openDek((await rowOf(w)).wrappedDeks!);
  const reader = await openGenerationReader(
    w.memory,
    key,
    aead === undefined ? undefined : { aead, aadFor: (scope) => aadFor(key, generation, scope) },
  );
  return reader.tailBytes;
}

/** The ledger a row should carry, entry by entry, against the objects in the bucket. */
async function expectLedger(w: World, generations: number[]): Promise<void> {
  const ledger = (await rowOf(w)).knownGens;
  expect(numbers(ledger)).toEqual(generations);
  for (const e of ledger!)
    expect(e.footerCrc, `generation ${e.generation}`).toBe(await crcOfObject(w, e.generation));
}

/** The tail size the row's summary records, which a reader of the current object reports. */
async function expectSummaryTail(w: World): Promise<void> {
  const row = await rowOf(w);
  const aead = w.keystore === undefined ? undefined : await w.keystore.openDek(row.wrappedDeks!);
  const described = usableSummary(SEG, row, aead);
  expect(described, 'the row has a usable summary').toBeDefined();
  expect(described!.tailBytes).toBe(await tailOfObject(w, row.currentGen!));
  expect(described!.fingerprint).toBe(
    await objectFingerprint(w.memory, { ...SEG, generation: row.currentGen! }),
  );
}

describe.each([
  { name: 'cleartext', encrypted: false },
  { name: 'encrypted', encrypted: true },
])('the ledger and the summary every writer leaves: $name', ({ encrypted }) => {
  it('a load onto no row writes the ledger of its generation and its summary of the object', async () => {
    const w = world(encrypted);
    await loadSegment(SEG, idsOf(5), w.deps, { metadata: { run: 'one' } });
    await expectLedger(w, [0]);
    await expectSummaryTail(w);
    // In the clear on every row, an encrypted one included: a footer checksum says nothing of the count.
    expect((await rowOf(w)).summary !== undefined && 'sealed' in (await rowOf(w)).summary!).toBe(
      encrypted,
    );
  });

  it('a load onto a row with no pointer writes the same', async () => {
    const w = world(encrypted);
    await setSegmentRetention(SEG, { registry: w.registry }, { expiresAt: MIN_EXPIRES_AT_MS * 2 });
    expect((await rowOf(w)).currentGen).toBeNull();
    await loadSegment(SEG, idsOf(5), w.deps);
    await expectLedger(w, [0]);
    await expectSummaryTail(w);
  });

  it('a load that advances the pointer writes the window and the new generation, oldest made current first', async () => {
    const w = world(encrypted);
    for (let g = 0; g < 4; g++) await loadSegment(SEG, idsOf(5 + g), w.deps, { keep: 2 });
    await expectLedger(w, [1, 2, 3]);
    await expectSummaryTail(w);
    // keep 0 leaves the new generation alone.
    await loadSegment(SEG, idsOf(20), w.deps, { keep: 0 });
    await expectLedger(w, [4]);
  });

  it('an erasure rewrite leaves the rewrite alone in the ledger, with the checksum of its object, and its summary', async () => {
    const w = world(encrypted);
    for (let g = 0; g < 3; g++) await loadSegment(SEG, idsOf(5 + g), w.deps, { keep: 9 });
    expect(numbers((await rowOf(w)).knownGens)).toEqual([0, 1, 2]);
    const erased = await eraseIdFromSegment(SEG, 2, w.deps);
    expect(erased).toMatchObject({ erased: true, generation: 3 });
    // Every older generation is out of the ledger before the collection that deletes it.
    await expectLedger(w, [3]);
    await expectSummaryTail(w);
  });

  it('a rollback moves the target to the end of the ledger it found, and writes the target’s own summary', async () => {
    const w = world(encrypted);
    for (let g = 0; g < 4; g++) await loadSegment(SEG, idsOf(5 + g), w.deps, { keep: 9 });
    await rollbackSegment(SEG, 1, w.deps);
    await expectLedger(w, [0, 2, 3, 1]);
    expect((await rowOf(w)).currentGen).toBe(1);
    await expectSummaryTail(w);
    // Forward onto a generation it left: the ledger knew it, and it is moved to the end in its turn.
    await rollbackSegment(SEG, 3, w.deps);
    await expectLedger(w, [0, 2, 1, 3]);
    await expectSummaryTail(w);
  });

  it('a rollback onto an object the ledger does not name enters it at the end, with the checksum read from the object', async () => {
    const w = world(encrypted);
    for (let g = 0; g < 3; g++) await loadSegment(SEG, idsOf(5 + g), w.deps, { keep: 1 });
    expect(numbers((await rowOf(w)).knownGens)).toEqual([1, 2]);
    // A stray below the pointer, written the way the segment's other objects are.
    await bulkLoadCrbmGeneration(w.memory, { ...SEG, generation: 0 }, [999], {
      registry: w.registry,
      keystore: w.keystore,
      publish: false,
    });
    await rollbackSegment(SEG, 0, w.deps, { allowUnknown: true });
    await expectLedger(w, [1, 2, 0]);
  });

  it('a rollback onto a row with no usable ledger writes none: it never starts one', async () => {
    const w = world(encrypted);
    for (let g = 0; g < 3; g++) await loadSegment(SEG, idsOf(5 + g), w.deps, { keep: 9 });
    const row = await rowOf(w);
    await w.registry.compareAndSwap(SEG, row.token, { knownGens: undefined });
    await rollbackSegment(SEG, 1, w.deps);
    expect((await rowOf(w)).currentGen).toBe(1);
    expect((await rowOf(w)).knownGens).toBeUndefined();
    // The next load seeds one from the bucket: the window a count by keep 9 keeps, then itself.
    await loadSegment(SEG, idsOf(20), w.deps, { keep: 9 });
    await expectLedger(w, [0, 2, 1, 3]);
  });

  it('the undo of a rollback whose target went puts the pointer and the summary back as the row had them, and the ledger without the target', async () => {
    const w = world(encrypted);
    for (let g = 0; g < 4; g++) await loadSegment(SEG, idsOf(5 + g), w.deps, { keep: 9 });
    const before = await rowOf(w);
    // The first tail read is the rollback's look at the target; every one after it is the check that follows the swap,
    // which finds the target collected.
    let tails = 0;
    const storage = new Proxy(w.memory as IStorageDriver, {
      get(t, p, rx) {
        const value: unknown = Reflect.get(t, p, rx);
        if (typeof value !== 'function') return value;
        if (p !== 'getTail') return value.bind(t);
        return (key: GenKey, maxBytes: number) => {
          if (key.generation === 1 && ++tails > 1) {
            return Promise.reject(new NotFoundError('generation 1 was collected'));
          }
          return (value as IStorageDriver['getTail']).call(t, key, maxBytes);
        };
      },
    });
    await expect(rollbackSegment(SEG, 1, { ...w.deps, storage })).rejects.toBeInstanceOf(
      NotFoundError,
    );
    const after = await rowOf(w);
    expect(after.currentGen).toBe(before.currentGen);
    // The target was found collected, so the row no longer knows it; every other entry is as it was.
    expect(after.knownGens).toEqual(before.knownGens!.filter((e) => e.generation !== 1));
    expect(after.summary).toEqual(before.summary);
  });

  it('a row shredded by destroySegment keeps no ledger: a tombstone vouches for nothing', async () => {
    if (!encrypted) return;
    const w = world(true);
    for (let g = 0; g < 3; g++) await loadSegment(SEG, idsOf(5 + g), w.deps, { keep: 2 });
    expect((await rowOf(w)).knownGens).toBeDefined();
    await destroySegment(SEG, { registry: w.registry }, { confirmSegment: SEG.segment });
    const tomb = await rowOf(w);
    expect(tomb.status).toBe('destroyed');
    expect(tomb.knownGens).toBeUndefined();
    expect(tomb.summary).toBeUndefined();
    expect(usableKnownGens(tomb)).toBeUndefined();
  });
});

describe('a rollback onto an object padded before its footer', () => {
  // The reader accepts bytes between an object's index and its footer, so an object this library did not write can
  // report a `tailBytes` that no summary records. The row is legal without a summary, and the rollback lands.
  it('lands, and the row carries the ledger of the footer it read and no summary', async () => {
    const w = world(false);
    for (let g = 0; g < 3; g++) await loadSegment(SEG, idsOf(5 + g), w.deps, { keep: 9 });
    const key: GenKey = { ...SEG, generation: 1 };
    const { bytes, size } = await w.memory.getTail(key, 1 << 20);
    expect(bytes.length).toBe(size);
    const footerAt = size - 104;
    const padding = 9 * 1024 * 1024;
    const padded = new Uint8Array(size + padding);
    padded.set(bytes.subarray(0, footerAt), 0);
    padded.set(bytes.subarray(footerAt), footerAt + padding);
    const unpaddedCrc = await crcOfObject(w, 1);
    await w.memory.delete(key);
    await w.memory.putImmutable(key, async (sink) => sink.write(padded));

    const reader = await openGenerationReader(w.memory, key, undefined);
    expect(reader.tailBytes).toBeGreaterThan(MAX_TAIL_BYTES);
    expect(reader.tailBytes).toBe(
      size - (size - 104 - (reader.tailBytes - padding - 104)) + padding,
    );

    await expect(rollbackSegment(SEG, 1, w.deps)).resolves.toMatchObject({ generation: 1 });
    const row = await rowOf(w);
    expect(row.currentGen).toBe(1);
    expect(row.summary).toBeUndefined();
    // The ledger names the target with the footer checksum of the padded object, which is the unpadded object's.
    expect(row.knownGens?.at(-1)).toEqual({ generation: 1, footerCrc: unpaddedCrc });
    expect(numbers(row.knownGens)).toEqual([0, 2, 1]);
  });
});

describe('the cap, held on every write', () => {
  it('a rollback onto an object a full ledger does not name lands, and keeps the target and the generation it left', async () => {
    const w = world(false);
    // A destination that earlier materialisations kept in full: 130 generations, the ledger at its fill of 128.
    for (let g = 0; g < 130; g++) {
      await loadSegment(SEG, [g], w.deps, { keep: Number.MAX_SAFE_INTEGER });
    }
    const row = await rowOf(w);
    expect(row.knownGens).toHaveLength(KNOWN_FILL);
    expect(numbers(row.knownGens)![0]).toBe(2);
    // Generations 0 and 1 are in the bucket and no longer in the ledger.
    await rollbackSegment(SEG, 0, w.deps);
    const after = await rowOf(w);
    expect(after.currentGen).toBe(0);
    expect(after.knownGens!.length).toBeLessThanOrEqual(MAX_KNOWN_GENERATIONS);
    expect(numbers(after.knownGens)!.at(-1)).toBe(0);
    expect(numbers(after.knownGens)).toContain(129);
    expect(numbers(after.knownGens)).not.toContain(2);
  });
});
