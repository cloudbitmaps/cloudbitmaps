import { randomBytes } from 'node:crypto';
import {
  CloudRoaring,
  CrbmColdChunkSource,
  MemoryColdDriver,
  MemoryRegistryDriver,
  bulkLoadCrbmGeneration,
  destroySegment,
  eraseIdFromSegment,
  eraseNamespace,
  nextGeneration,
  publishGeneration,
} from '@/index';
import { InProcessKeystore } from '@/drivers/crypto';
import { KeyUnavailableError, ValidationError, WriteConflictError } from '@/core/errors';
import type { EraseIdDeps, IKeystore, SegmentRef } from '@/index';

const SEG: SegmentRef = { segment: 's' };
const k = (): Uint8Array => randomBytes(32);

/**
 * A world of cold objects + a registry, plus the two things that write generations: `load` (a bulk load at the
 * next generation) and the erasure rewrite's deps.
 *
 * `store(ks)` opens a *fresh* reader each call, which is deliberate: a store pins the generation it resolved
 * (`coldGenTtlMs: 0` below), so re-reading through a new store is how a test observes a generation published
 * since — the honest model of a different reader, with no clock to advance.
 */
function world(keystore?: IKeystore) {
  const cold = new MemoryColdDriver();
  const registry = new MemoryRegistryDriver();
  const deps: EraseIdDeps = { cold, registry, keystore };
  const store = (ks = keystore): CloudRoaring =>
    new CloudRoaring({
      cold: new CrbmColdChunkSource(cold, { registry, keystore: ks }),
      retry: false,
      coldGenTtlMs: 0,
    });
  const load = async (ids: number[], ref: SegmentRef = SEG, ks = keystore): Promise<number> => {
    const generation = await nextGeneration(ref, { cold, registry });
    await bulkLoadCrbmGeneration(cold, { ...ref, generation }, ids, { registry, keystore: ks });
    return generation;
  };
  return { cold, registry, deps, store, load };
}

async function members(store: CloudRoaring, ref: SegmentRef = SEG): Promise<number[]> {
  const out: number[] = [];
  for await (const id of store.segment(ref.segment, { namespace: ref.namespace }).iterate()) {
    out.push(id);
  }
  return out;
}

/**
 * The per-segment DEK is minted once and **reused by every later write to that segment** — every load, and the
 * erasure rewrite. That is what makes crypto-shred a single, total act: one key covers every generation the
 * segment has ever had, so discarding it makes all of them unreadable at once. If a write ever minted a second
 * DEK instead, shredding would leave whichever generations used the other key perfectly readable, and
 * `destroySegment`'s attestation ("unreadable everywhere, backups included") would be false.
 *
 * These cases therefore assert the same thing from three directions: the wrapped-DEK list on the row never
 * changes, every generation still decrypts with the one key, and a reader without the keystore can read none
 * of them.
 */
describe('encryption lifecycle — one DEK per segment, across every generation', () => {
  it('a second load reuses the segment DEK: the wrapped list is unchanged and the new generation decrypts', async () => {
    const keystore = new InProcessKeystore({ keys: { k1: k() }, activeKeyId: 'k1' });
    const w = world(keystore);
    await w.load([1, 2, 3, 100_000]);
    const wrappedBefore = (await w.registry.get(SEG))!.wrappedDeks;
    expect(wrappedBefore).toHaveLength(1);

    expect(await w.load([1, 3, 4, 100_000])).toBe(1); // generation 1, same key
    expect((await w.registry.get(SEG))!.wrappedDeks).toEqual(wrappedBefore);
    expect(await members(w.store())).toEqual([1, 3, 4, 100_000]);
  });

  it('the first load mints the DEK, and the generation is genuinely encrypted', async () => {
    const keystore = new InProcessKeystore({ keys: { k1: k() }, activeKeyId: 'k1' });
    const w = world(keystore);
    await w.load([1, 2, 3]);

    expect((await w.registry.get(SEG))!.wrappedDeks).toHaveLength(1);
    expect(await members(w.store())).toEqual([1, 2, 3]);
    // Genuinely encrypted, not merely marked as such: a reader with no keystore cannot decode it.
    const noKeystore = new CloudRoaring({
      cold: new CrbmColdChunkSource(w.cold, { registry: w.registry }),
      retry: false,
    });
    await expect(members(noKeystore)).rejects.toBeInstanceOf(KeyUnavailableError);
  });

  it('reuses the same DEK + correct data across three generations (0 → 1 → 2)', async () => {
    const keystore = new InProcessKeystore({ keys: { k1: k() }, activeKeyId: 'k1' });
    const w = world(keystore);
    await w.load([1, 2, 3]);
    const wrapped0 = (await w.registry.get(SEG))!.wrappedDeks;

    expect(await w.load([1, 2, 3, 4])).toBe(1);
    expect(await w.load([1, 2, 3, 4, 5])).toBe(2);

    expect((await w.registry.get(SEG))!.currentGen).toBe(2);
    expect((await w.registry.get(SEG))!.wrappedDeks).toEqual(wrapped0);
    expect(await members(w.store())).toEqual([1, 2, 3, 4, 5]);
  });

  it('a load onto an encrypted segment without the keystore fails fast, never writing cleartext onto it', async () => {
    const keystore = new InProcessKeystore({ keys: { k1: k() }, activeKeyId: 'k1' });
    const w = world(keystore);
    await w.load([1, 2, 3]);

    // The trap this closes: writing a CLEARTEXT generation onto a row that still advertises wrapped DEKs.
    // `destroySegment` keys `cryptoShredded` off the presence of those wrappings, so shredding that segment
    // would emit `segment.erase` — "unreadable everywhere, backups included" — over bytes that stay readable
    // from any copy. Over-attestation is the one failure an audit trail exists to prevent.
    await expect(
      bulkLoadCrbmGeneration(w.cold, { ...SEG, generation: 1 }, [9], { registry: w.registry }),
    ).rejects.toBeInstanceOf(KeyUnavailableError);
    expect((await w.registry.get(SEG))!.currentGen).toBe(0); // the pointer never moved
    expect(await members(w.store())).toEqual([1, 2, 3]);
  });

  it('the erasure rewrite reuses the DEK too: gen g decrypts, gen g+1 is re-encrypted under the same key', async () => {
    const keystore = new InProcessKeystore({ keys: { k1: k() }, activeKeyId: 'k1' });
    const w = world(keystore);
    await w.load([1, 2, 3, 100_000]);
    const wrappedBefore = (await w.registry.get(SEG))!.wrappedDeks;

    const res = await eraseIdFromSegment(SEG, 2, w.deps);
    expect(res).toMatchObject({ erased: true, fromGeneration: 0, generation: 1 });
    expect((await w.registry.get(SEG))!.wrappedDeks).toEqual(wrappedBefore);
    expect(await members(w.store())).toEqual([1, 3, 100_000]);
    // And the rewrite is encrypted, not quietly downgraded to cleartext on the way through.
    const noKeystore = new CloudRoaring({
      cold: new CrbmColdChunkSource(w.cold, { registry: w.registry }),
      retry: false,
    });
    await expect(members(noKeystore)).rejects.toBeInstanceOf(KeyUnavailableError);
  });

  it('the erasure rewrite without the keystore fails fast (never a silent mis-decode)', async () => {
    const keystore = new InProcessKeystore({ keys: { k1: k() }, activeKeyId: 'k1' });
    const w = world(keystore);
    await w.load([1, 2, 3]);
    // A lost key is a genuine fault that propagates — not a wrong answer, and not a cleartext rewrite.
    await expect(eraseIdFromSegment(SEG, 2, { ...w.deps, keystore: undefined })).rejects.toThrow(
      KeyUnavailableError,
    );
    expect((await w.registry.get(SEG))!.currentGen).toBe(0);
  });

  it('requireEncryption refuses to rewrite a cleartext segment', async () => {
    const w = world(); // no keystore anywhere
    await w.load([1, 2]);
    await expect(
      eraseIdFromSegment(SEG, 1, { ...w.deps, requireEncryption: true }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect((await w.registry.get(SEG))!.currentGen).toBe(0);
  });
});

describe('crypto-shred — destroySegment / eraseNamespace', () => {
  it('shreds the DEK; the segment reads empty and is unrecoverable even WITH the keystore', async () => {
    const keystore = new InProcessKeystore({ keys: { k1: k() }, activeKeyId: 'k1' });
    const w = world(keystore);
    await w.load([1, 2, 3]);
    await w.load([1, 2, 3, 4]); // two generations, one key — both must go together
    expect(await members(w.store())).toEqual([1, 2, 3, 4]);

    const res = await destroySegment(SEG, w.deps, { confirmSegment: 's' });
    expect(res).toMatchObject({ destroyed: true, cryptoShredded: true });

    const rec = (await w.registry.get(SEG))!;
    expect(rec.status).toBe('destroyed');
    expect(rec.wrappedDeks).toBeUndefined(); // the key is gone — the .crbm bytes are unreadable forever

    // Reads empty even though we still hold the KEK: there is no DEK left to unwrap. Note the objects are
    // still in the bucket (that is `dropSegment`'s job) — this is unreadability, not reclamation.
    expect(await members(w.store())).toEqual([]);
    const stillThere: number[] = [];
    for await (const key of w.cold.list(SEG)) stillThere.push(key.generation);
    expect(stillThere).toEqual([0, 1]);
  });

  it('requires the exact segment name as confirmation (guards against accidental shred)', async () => {
    const keystore = new InProcessKeystore({ keys: { k1: k() }, activeKeyId: 'k1' });
    const w = world(keystore);
    await w.load([1]);
    await expect(destroySegment(SEG, w.deps, { confirmSegment: 'wrong' })).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect((await w.registry.get(SEG))!.status).toBe('active'); // untouched
  });

  it('reports contention rather than a destruction it could not finish', async () => {
    // The registry CAS is now the only step a shred takes, and it is bounded. A row that keeps moving under it
    // — a concurrent publish, a policy write — must surface as a `WriteConflictError` with the segment left
    // ACTIVE and still holding its key, so a retry can finish the job. The failure mode being guarded is the
    // opposite: reporting `destroyed: true` while the key (and therefore the data) is still there.
    const keystore = new InProcessKeystore({ keys: { k1: k() }, activeKeyId: 'k1' });
    const w = world(keystore);
    await w.load([1, 2, 3]);

    const contended = new Proxy(w.registry, {
      get(target, prop) {
        if (prop === 'compareAndSwap') {
          return async (): Promise<never> => {
            throw new WriteConflictError('row moved under the shred');
          };
        }
        const value = Reflect.get(target, prop, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    await expect(
      destroySegment(SEG, { ...w.deps, registry: contended }, { confirmSegment: 's' }),
    ).rejects.toBeInstanceOf(WriteConflictError);

    const rec = (await w.registry.get(SEG))!;
    expect(rec.status).toBe('active');
    expect(rec.wrappedDeks).toBeDefined();
    expect(await members(w.store())).toEqual([1, 2, 3]); // demonstrably still there — the honest state
  });

  it('refuses to publish a generation for a segment destroyed WHILE it was being written', async () => {
    // The window: `bulkLoadCrbmGeneration` reads the registry once and refuses if the segment is already
    // destroyed — then spends a KMS call and a whole object write before publishing. A `destroySegment` landing
    // inside that window is invisible to the load, so the fence lives in `publishGeneration` itself, where the
    // record is re-read moments before the CAS. Without it the pointer would advance on a destroyed row,
    // leaving an object encrypted under a DEK that no longer exists: unreadable, still billed, and attached to
    // a segment the registry says was erased.
    const keystore = new InProcessKeystore({ keys: { k1: k() }, activeKeyId: 'k1' });
    const w = world(keystore);
    await w.load([1, 2]);
    await destroySegment(SEG, w.deps, { confirmSegment: 's' });

    await expect(publishGeneration(w.registry, { ...SEG, generation: 1 })).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect((await w.registry.get(SEG))!.status).toBe('destroyed');
  });

  it('is idempotent — destroying an already-destroyed segment is a no-op success', async () => {
    const keystore = new InProcessKeystore({ keys: { k1: k() }, activeKeyId: 'k1' });
    const w = world(keystore);
    await w.load([1]);
    await destroySegment(SEG, w.deps, { confirmSegment: 's' });

    const again = await destroySegment(SEG, w.deps, { confirmSegment: 's' });
    // `destroyed: true` (the state is what was asked for) but NOT a fresh crypto-shred — there was no key left
    // to discard, and an audit trail that recorded a second irreversible destruction would be lying.
    expect(again).toMatchObject({ destroyed: true, cryptoShredded: false, reason: 'already' });
  });

  it('eraseNamespace keeps a complete ledger when one segment cannot be erased', async () => {
    // Before this, a single failing segment aborted the loop: the caller got an exception, no ledger, and no way
    // to learn which segments had ALREADY been destroyed before the throw — the worst answer available on an
    // erasure command, because some data really was destroyed and the record of which is gone.
    //
    // The fix isolates per segment, matching `eraseSubject` ("one failure never aborts the ledger"). Note this
    // trades loud-but-empty for quiet-but-complete, so the assertions below check BOTH halves: the healthy
    // segments really were destroyed, and the failing one is recorded as not-destroyed with a reason rather
    // than omitted or silently counted as a success.
    const keystore = new InProcessKeystore({ keys: { k1: k() }, activeKeyId: 'k1' });
    const w = world(keystore);
    for (const seg of ['a', 'b', 'c']) {
      await w.load([1, 2], { namespace: 'ns', segment: seg });
    }

    // Only 'b' loses its CAS race, every time — so 'b' burns through the shred's attempts while 'a' and 'c'
    // are untouched.
    const registry = new Proxy(w.registry, {
      get(target, prop) {
        const value = Reflect.get(target, prop, target) as unknown;
        if (prop === 'compareAndSwap') {
          // A rest parameter, NOT `arguments`: this is an arrow function, so `arguments` would resolve to the
          // enclosing trap's own args and forward the property NAME as the expected token. Every real CAS
          // would then fail on a bad token and the test would "pass" while proving nothing about isolation.
          return async (...args: unknown[]): Promise<unknown> => {
            const ref = args[0] as { segment: string };
            if (ref.segment === 'b') throw new WriteConflictError('row moved under the shred');
            return (value as (...a: unknown[]) => Promise<unknown>).apply(target, args);
          };
        }
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    const { destroyed } = await eraseNamespace('ns', { registry }, { confirmNamespace: 'ns' });

    // The ledger is COMPLETE — every segment appears, including the one that failed.
    expect(destroyed.map((d) => d.segment).sort()).toEqual(['a', 'b', 'c']);
    const byName = new Map(destroyed.map((d) => [d.segment, d]));
    expect(byName.get('a')!.destroyed).toBe(true);
    expect(byName.get('c')!.destroyed).toBe(true);
    // And the failure is honest rather than absent or counted as a success.
    expect(byName.get('b')).toMatchObject({ destroyed: false, reason: 'contended' });

    // The registry agrees with the ledger, which is the claim that actually matters.
    expect((await w.registry.get({ namespace: 'ns', segment: 'a' }))!.status).toBe('destroyed');
    expect((await w.registry.get({ namespace: 'ns', segment: 'c' }))!.status).toBe('destroyed');
    expect((await w.registry.get({ namespace: 'ns', segment: 'b' }))!.status).toBe('active');
  });

  it('eraseNamespace shreds every encrypted segment in the namespace', async () => {
    const keystore = new InProcessKeystore({ keys: { k1: k() }, activeKeyId: 'k1' });
    const w = world(keystore);
    for (const seg of ['a', 'b']) {
      await w.load([1, 2], { namespace: 'ns', segment: seg });
    }
    const { destroyed } = await eraseNamespace('ns', w.deps, { confirmNamespace: 'ns' });
    expect(destroyed.map((d) => d.segment).sort()).toEqual(['a', 'b']);
    expect(destroyed.every((d) => d.destroyed && d.cryptoShredded)).toBe(true);
    for (const seg of ['a', 'b']) {
      expect((await w.registry.get({ namespace: 'ns', segment: seg }))!.status).toBe('destroyed');
    }
  });

  it('refuses to shred a cleartext segment (no key to shred) unless allowCleartext', async () => {
    const w = world(); // no keystore
    await w.load([1, 2]);
    const res = await destroySegment(SEG, w.deps, { confirmSegment: 's' });
    expect(res).toMatchObject({ destroyed: false, reason: 'cleartext' });
    expect((await w.registry.get(SEG))!.status).toBe('active');

    // Opting in writes the tombstone, but is honest that no key was discarded: the bytes stay readable from
    // any copy, so this is not the irreversible erasure `cryptoShredded` attests to.
    const opted = await destroySegment(SEG, w.deps, { confirmSegment: 's', allowCleartext: true });
    expect(opted).toMatchObject({ destroyed: true, cryptoShredded: false });
  });

  it('refuses to resurrect a destroyed segment: a load throws, and a rewrite declines', async () => {
    const keystore = new InProcessKeystore({ keys: { k1: k() }, activeKeyId: 'k1' });
    const w = world(keystore);
    await w.load([1, 2]);
    await destroySegment(SEG, w.deps, { confirmSegment: 's' });

    // Loading a new generation would mint a DEK that could never be reached → refuse outright.
    await expect(
      bulkLoadCrbmGeneration(w.cold, { ...SEG, generation: 1 }, [9], {
        registry: w.registry,
        keystore,
      }),
    ).rejects.toBeInstanceOf(ValidationError);

    // The erasure rewrite won't resurrect it either — a destroyed segment is terminal, and already unreadable.
    const res = await eraseIdFromSegment(SEG, 1, w.deps);
    expect(res).toMatchObject({ erased: false, reason: 'destroyed' });
    expect(await members(w.store())).toEqual([]);
  });
});
