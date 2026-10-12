import { RecordingAuditSink } from '@/core/audit';
import { eraseIdFromSegment } from '@/core/erase-id';
import { loadSegment, type LoadResult } from '@/core/load';
import { brandAsBackend } from '@/core/ports';
import type { IRegistryDriver, IStorageDriver } from '@/core/ports';
import { MemoryRegistryDriver, MemoryStorageDriver } from '@/drivers/memory';
import { CloudRoaring } from '@/index';
import { roaringCodec } from '@/roaring-codec';
import { collect } from '../helpers/loaded';
import { REF, clock, gate, generations } from '../helpers/retaken-number-race';

/**
 * A refused load's reclaim proves the object under its number its own by the object's fingerprint, its size and footer
 * CRC. Two loads of the same ids write the same bytes, so the proof cannot tell this load's object from another load's,
 * and once an erasure has deleted this load's object the number is free for that other load to take:
 *
 *   load B     writes 1 (ids 4, 8) ── its publish is refused ──▶ reads the row: pointer 0 ──▶ proves 1, deletes it
 *   erasure    (of 8) finds 1 above the pointer, renews the row, deletes 1 │
 *   load A     (ids 4, 8) reads the renewed row, takes 1 afresh, writes the same bytes ──▶ publishes 1
 *
 * Whichever lands first, A's publish or B's delete, the row ends up naming generation 1 with no object under it, and
 * every read of the segment fails: when A's publish lands first, B's read of the row after its delete reports it; when it
 * lands after B has returned, nothing does. Above the pointer nothing fences B's delete against a publish of the
 * number, so B deletes nothing there. The run is the same every time, its order held by gated promises.
 */

const IDS = [4, 8];
/** The id the erasure erases: B's object holds it, the generation the row names does not. */
const ERASED = 8;

/** What load B found: the row (refused by the erasure's renewal), or none (refused by the row another load created). */
type Found = 'the row' | 'no row';
/** When load A's publish lands: before B's delete, or after B has returned. */
type When = 'before the refused load deletes' | 'after the refused load returns';

/**
 * `registry`, holding the first write that would make generation 1 current until `at` opens, and calling `read` with
 * the number of rows read through it after each read.
 */
function holdingPublishOf1(
  registry: IRegistryDriver,
  at: ReturnType<typeof gate>,
  read?: (count: number) => void,
): IRegistryDriver {
  const held = Object.create(registry) as IRegistryDriver;
  let waited = false;
  let reads = 0;
  held.get = async (ref) => {
    const row = await registry.get(ref);
    read?.((reads += 1));
    return row;
  };
  const hold = async (gen: number | null | undefined): Promise<void> => {
    if (waited || gen !== 1) return;
    waited = true;
    at.reach();
    await at.opened;
  };
  held.compareAndSwap = async (ref, expected, patch, options) => {
    await hold('currentGen' in patch ? patch.currentGen : undefined);
    return registry.compareAndSwap(ref, expected, patch, options);
  };
  held.create = async (ref, record, options) => {
    await hold(record.currentGen);
    return registry.create(ref, record, options);
  };
  return held;
}

/**
 * `storage` for load B: its existence check of generation 0 waits for `numbering` when given, and its first read of
 * generation 1 after writing it (the reclaim's proof) waits for `atProof`.
 */
function loadBStorage(
  storage: IStorageDriver,
  atProof: ReturnType<typeof gate>,
  numbering?: Promise<void>,
): IStorageDriver {
  const out = Object.create(storage) as IStorageDriver;
  let wrote = false;
  let proved = false;
  out.putImmutable = async (key, write) => {
    const put = await storage.putImmutable(key, write);
    if (key.generation === 1) wrote = true;
    return put;
  };
  out.getTail = async (key, maxBytes) => {
    if (numbering !== undefined && key.generation === 0 && maxBytes === 0) await numbering;
    if (wrote && !proved && key.generation === 1) {
      proved = true;
      atProof.reach();
      await atProof.opened;
    }
    return storage.getTail(key, maxBytes);
  };
  return out;
}

async function race(found: Found, when: When) {
  const storage = new MemoryStorageDriver();
  const registry = new MemoryRegistryDriver();
  const deps = { storage, registry, codec: roaringCodec, clock };

  // B's publish of 1 is held, and so is its proof of the object under 1.
  const bAtPublish = gate();
  const bAtProof = gate();
  const bAudit = new RecordingAuditSink();
  let b: Promise<LoadResult>;
  if (found === 'the row') {
    expect(await loadSegment(REF, [9], deps)).toMatchObject({ generation: 0, published: true });
    b = loadSegment(
      REF,
      IDS,
      {
        ...deps,
        storage: loadBStorage(storage, bAtProof),
        registry: holdingPublishOf1(registry, bAtPublish),
      },
      { allowEmpty: true, audit: bAudit },
    );
  } else {
    // B finds no row, and checks generation 0 only once another first load has written it and created the row, so it
    // numbers 1 by a listing; its publish, a create, is refused by that row.
    const created = gate();
    const readTwice = gate();
    b = loadSegment(
      REF,
      IDS,
      {
        ...deps,
        storage: loadBStorage(storage, bAtProof, created.opened),
        registry: holdingPublishOf1(registry, bAtPublish, (n) => {
          if (n === 2) readTwice.reach();
        }),
      },
      { allowEmpty: true, audit: bAudit },
    );
    // A first load reads the row twice before its write: both find none.
    await readTwice.reached;
    expect(await loadSegment(REF, [9], deps)).toMatchObject({ generation: 0, published: true });
    created.open();
  }
  await bAtPublish.reached;
  expect(await generations(storage)).toEqual([0, 1]);

  // The erasure finds B's object above the pointer holding the id, renews the row and deletes it: 1 is free again.
  await eraseIdFromSegment(REF, ERASED, deps);
  expect(await generations(storage)).toEqual([0]);

  // A takes 1 afresh and writes the same ids, so the same bytes; its publish is held.
  const aAtPublish = gate();
  const a = loadSegment(
    REF,
    IDS,
    { ...deps, registry: holdingPublishOf1(registry, aAtPublish) },
    { allowEmpty: true },
  );
  await aAtPublish.reached;
  expect(await generations(storage)).toEqual([0, 1]);

  // B's publish is refused by the row the erasure renewed (or by the row that appeared), and B reclaims.
  bAtPublish.open();
  let bDone = false;
  const bSettled = b.then(
    () => (bDone = true),
    () => (bDone = true),
  );
  if (when === 'before the refused load deletes') {
    // B has read the row (pointer 0) and stops before its proof, if it makes one; A's publish lands there.
    await Promise.race([bAtProof.reached, bSettled]);
    aAtPublish.open();
    expect(await a).toMatchObject({ generation: 1, published: true });
    bAtProof.open();
  } else {
    bAtProof.open();
    await bSettled;
    expect(bDone).toBe(true);
    aAtPublish.open();
    expect(await a).toMatchObject({ generation: 1, published: true });
  }
  return { b: await b, bAudit, storage, registry };
}

describe('a refused load whose number another load took again with the same bytes', () => {
  it.each<[Found, When]>([
    ['the row', 'before the refused load deletes'],
    ['the row', 'after the refused load returns'],
    ['no row', 'before the refused load deletes'],
    ['no row', 'after the refused load returns'],
  ])(
    'found %s, the other publish landing %s: the pointer keeps its object',
    async (found, when) => {
      const { b, bAudit, storage, registry } = await race(found, when);

      // B is refused as a lost race, and says so once.
      expect(b).toMatchObject({ generation: 1, published: false, reason: 'superseded' });
      expect(bAudit.snapshot()).toEqual([
        expect.objectContaining({
          kind: 'segment.load-refused',
          generation: 1,
          reason: 'superseded',
        }),
      ]);

      // The row names A's generation, its object is in the bucket, and the segment reads what A loaded.
      expect((await registry.get(REF))?.currentGen).toBe(1);
      expect(await generations(storage)).toEqual([0, 1]);
      const store = new CloudRoaring({
        storage: brandAsBackend({ storage, registry }),
        retry: false,
      });
      expect(await collect(store.segment(REF.segment).iterate())).toEqual(IDS);
    },
  );
});
