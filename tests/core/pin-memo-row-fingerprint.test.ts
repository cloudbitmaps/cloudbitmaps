import { randomBytes } from 'node:crypto';
import { CloudRoaring, InProcessKeystore, MemoryStorage } from '@/index';
import type { SegmentRef } from '@/index';
import { aadFor } from '@/core/crypto';
import type { Aead, IKeystore, WrappedDek } from '@/core/crypto';
import { writeCrbmGenerationStream } from '@/core/crbm-storage-source';
import { SafeBitmap } from '@/roaring-codec';
import type { IStorageDriver } from '@/core/ports';
import { brandAsBackend } from '@/core/ports';
import { openGenerationReader } from '@/core/crbm-storage-source';
import { isNotFoundError } from '@/core/errors';
import { counting } from '../helpers/counting';
import { bulkLoadCrbmGeneration } from '../helpers/bulk-load';

/**
 * A pin of the current generation shares the reader an earlier pin of the same version opened (invariant 2), and that
 * reader can have been opened by `pinAt`, which holds the object to the fingerprint its caller names and not to the row.
 * A live pin holds the memoised reader to the fingerprint the row's summary records before it takes it: a reader of
 * another object under the number is not shared, and the pin opens what is under the key as a live read does.
 */

const NS = 'ns';
const A: SegmentRef = { namespace: NS, segment: 'a' };
const HI = 65_536;
const PUBLISHED = [1, 2, HI + 3];
/** An id only the object put under the number from outside the library holds. */
const MARK = 999;

async function world() {
  const backend = new MemoryStorage();
  await new CloudRoaring({ storage: backend, retry: false }).load(A, PUBLISHED);
  const calls: Record<string, number> = {};
  const store = new CloudRoaring({
    storage: brandAsBackend({
      storage: counting<IStorageDriver>(backend.storage, calls),
      registry: backend.registry,
    }),
    retry: false,
  });
  /** Put `ids` under generation 0, under its unchanged row, and return the new object's fingerprint. */
  const swap = async (ids: number[]): Promise<string> => {
    await backend.storage.delete({ ...A, generation: 0 });
    await bulkLoadCrbmGeneration(backend.storage, { ...A, generation: 0 }, ids);
    return (await openGenerationReader(backend.storage, { ...A, generation: 0 }, undefined))
      .fingerprint;
  };
  return { backend, store, calls, swap, seg: () => store.segment('a', { namespace: NS }) };
}

describe("a live pin holds a memoised reader to the row's fingerprint (invariant 2)", () => {
  it('does not share a reader pinAt opened on another object than the row names', async () => {
    const w = await world();
    const stray = await w.swap([MARK, HI + MARK]);
    // pinAt holds the object to the fingerprint it is given, and memoises the reader under the live version.
    const byHand = await w.seg().pinAt({ generation: 0, fingerprint: stray });
    expect(await byHand.has(MARK)).toBe(true);

    // A live pin opens what is under the key against the row, which names another object: refused, as a read is.
    await expect(w.seg().pin()).rejects.toSatisfy(isNotFoundError);
  });

  it('control: a reader pinAt opened on the object the row names is shared, with no open of its own', async () => {
    const w = await world();
    const first = await new CloudRoaring({ storage: w.backend, retry: false })
      .segment('a', { namespace: NS })
      .pin();
    const at = first.pinnedAt!;
    const byHand = await w
      .seg()
      .pinAt({ generation: at.generation!, fingerprint: at.fingerprint! });
    expect(await byHand.has(1)).toBe(true);
    const tails = w.calls.getTail ?? 0;

    const live = await w.seg().pin();
    expect(live.pinnedAt).toMatchObject({ generation: 0, fingerprint: at.fingerprint });
    expect(await live.has(2)).toBe(true);
    expect(w.calls.getTail ?? 0).toBe(tails);
  });
});

/**
 * A keystore whose next `openDek` waits until the test lets it go: the one point a live pin awaits between taking a
 * memoised reader and holding it to the row, so another reader can be memoised under its version in between.
 */
function gatedKeystore(inner: IKeystore) {
  let armed: { entered: () => void; release: Promise<void> } | undefined;
  const keystore: IKeystore = {
    createDek: () => inner.createDek(),
    openDek: async (wrapped: readonly WrappedDek[]): Promise<Aead> => {
      const held = armed;
      armed = undefined;
      if (held !== undefined) {
        held.entered();
        await held.release;
      }
      return inner.openDek(wrapped);
    },
  };
  /** Hold the next `openDek`; `entered` settles when it is called, and `release` lets it go. */
  const hold = () => {
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const reached = new Promise<void>((r) => (entered = r));
    armed = { entered, release: gate };
    return { reached, release };
  };
  return { keystore, hold };
}

describe('a live pin that finds another reader memoised under its version while it checks the first', () => {
  // Pin A takes a reader `pinAt` memoised, of an object the row does not name, and while it unwraps the key to read the
  // row's summary, that reader is evicted and a second `pinAt` memoises another reader of the same object. A finds the
  // first reader is not the row's and the second already there: it holds the second to the row too, and opens afresh.
  it('holds that reader to the row as well, and does not pin the object the row does not name', async () => {
    const inner = new InProcessKeystore({ keys: { k1: randomBytes(32) }, activeKeyId: 'k1' });
    const backend = new MemoryStorage();
    const writer = new CloudRoaring({
      storage: backend,
      retry: false,
      encryption: { keystore: inner },
    });
    await writer.load(A, PUBLISHED);
    await writer.load({ namespace: NS, segment: 'b' }, [1]);
    // An object under generation 0 sealed with the segment's own key, that the row does not name.
    const row = (await backend.registry.get(A))!;
    const aead = await inner.openDek(row.wrappedDeks!);
    await backend.storage.delete({ ...A, generation: 0 });
    const stray = (
      await writeCrbmGenerationStream(
        backend.storage,
        { ...A, generation: 0 },
        (async function* () {
          yield { chunkKey: 0, bitmap: SafeBitmap.fromValues([MARK]) };
        })(),
        { crypto: { aead, aadFor: (scope) => aadFor(A, 0, scope) } },
      )
    ).fingerprint;

    const gated = gatedKeystore(inner);
    const store = new CloudRoaring({
      storage: backend,
      retry: false,
      encryption: { keystore: gated.keystore },
      cache: { readerMax: 1 },
    });
    const a = () => store.segment('a', { namespace: NS });
    expect(await (await a().pinAt({ generation: 0, fingerprint: stray })).has(MARK)).toBe(true);

    const held = gated.hold();
    const pinning = a()
      .pin()
      .then(
        (pin) => ({ pinned: pin.pinnedAt?.fingerprint }),
        (err: unknown) => ({ err }),
      );
    await held.reached;
    // While the pin waits on the key: another segment's read evicts the memoised reader, and a second pinAt memoises
    // another reader of the same object under the same version.
    expect(await store.segment('b', { namespace: NS }).has(1)).toBe(true);
    expect(await (await a().pinAt({ generation: 0, fingerprint: stray })).has(MARK)).toBe(true);
    held.release();

    const outcome = await pinning;
    expect(outcome).not.toHaveProperty('pinned', stray);
    expect('err' in outcome && isNotFoundError(outcome.err)).toBe(true);
  });
});

describe('a reader a live pin has held to the row is not held to it again', () => {
  it("a pinAt reader that matches the row's summary is checked by the first live pin only: one unwrap", async () => {
    const inner = new InProcessKeystore({ keys: { k1: randomBytes(32) }, activeKeyId: 'k1' });
    const backend = new MemoryStorage();
    await new CloudRoaring({
      storage: backend,
      retry: false,
      encryption: { keystore: inner },
    }).load(A, PUBLISHED);
    const pinnedAt = (
      await new CloudRoaring({ storage: backend, retry: false, encryption: { keystore: inner } })
        .segment('a', { namespace: NS })
        .pin()
    ).pinnedAt!;
    let unwraps = 0;
    const keystore: IKeystore = {
      createDek: () => inner.createDek(),
      openDek: (wrapped) => {
        unwraps += 1;
        return inner.openDek(wrapped);
      },
    };
    const store = new CloudRoaring({ storage: backend, retry: false, encryption: { keystore } });
    const seg = () => store.segment('a', { namespace: NS });
    await seg().pinAt({ generation: pinnedAt.generation!, fingerprint: pinnedAt.fingerprint! });
    const before = unwraps;
    // The first live pin unwraps the key to open the row's sealed summary and holds the pinAt reader to it.
    expect((await seg().pin()).pinnedAt?.fingerprint).toBe(pinnedAt.fingerprint);
    expect(unwraps).toBe(before + 1);
    // The next ones share the reader as it is.
    for (let i = 0; i < 3; i++) await seg().pin();
    expect(unwraps).toBe(before + 1);
  });
});
