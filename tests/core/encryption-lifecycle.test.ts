import { randomBytes } from 'node:crypto';
import {
  CloudRoaring,
  CrbmColdChunkSource,
  MemoryColdDriver,
  MemoryRegistryDriver,
  MemoryWarmDriver,
  bulkLoadCrbmGeneration,
  compactSegment,
  destroySegment,
  eraseNamespace,
  publishGeneration,
} from '@/index';
import { InProcessKeystore } from '@/drivers/crypto';
import { KeyUnavailableError, ValidationError, WriteConflictError } from '@/core/errors';
import type { CompactionDeps, IKeystore, SegmentRef } from '@/index';

const SEG: SegmentRef = { segment: 's' };
const OWNER = 'worker-1';
const k = (): Uint8Array => randomBytes(32);

function world(keystore?: IKeystore) {
  const cold = new MemoryColdDriver();
  const warm = new MemoryWarmDriver();
  const registry = new MemoryRegistryDriver();
  const deps: CompactionDeps = { cold, warm, registry, clock: { now: () => Date.now() }, keystore };
  const store = (ks = keystore): CloudRoaring =>
    new CloudRoaring({
      warm,
      cold: new CrbmColdChunkSource(cold, { registry, keystore: ks }),
      retry: false,
    });
  return { cold, warm, registry, deps, store };
}

async function members(store: CloudRoaring): Promise<number[]> {
  const out: number[] = [];
  for await (const id of store.segment('s').iterate()) out.push(id);
  return out;
}

describe('encryption lifecycle — compaction (Phase 4e)', () => {
  it('compaction reuses the segment DEK: decrypts gen g, re-encrypts gen g+1 (I3 preserved)', async () => {
    const keystore = new InProcessKeystore({ keys: { k1: k() }, activeKeyId: 'k1' });
    const w = world(keystore);
    await bulkLoadCrbmGeneration(w.cold, { ...SEG, generation: 0 }, [1, 2, 3, 100_000], {
      registry: w.registry,
      keystore,
    });
    const wrappedBefore = (await w.registry.get(SEG))!.wrappedDeks;

    await w.store().segment('s').add(4);
    await w.store().segment('s').remove(2);

    const res = await compactSegment(SEG, w.deps, { owner: OWNER });
    expect(res).toMatchObject({ compacted: true, fromGen: 0, toGen: 1 });
    // Same DEK reused (the wrapped list is unchanged), and the new generation is still encrypted + correct.
    expect((await w.registry.get(SEG))!.wrappedDeks).toEqual(wrappedBefore);
    expect(await members(w.store())).toEqual([1, 3, 4, 100_000]);
  });

  it('compaction bootstrap mints a DEK for an all-warm segment', async () => {
    const keystore = new InProcessKeystore({ keys: { k1: k() }, activeKeyId: 'k1' });
    const w = world(keystore);
    await w.store().segment('s').addMany([1, 2, 3]);

    const res = await compactSegment(SEG, w.deps, { owner: OWNER });
    expect(res).toMatchObject({ compacted: true, fromGen: null, toGen: 0 });
    expect((await w.registry.get(SEG))!.wrappedDeks).toHaveLength(1);
    expect(await members(w.store())).toEqual([1, 2, 3]);
    // The bootstrapped generation is genuinely encrypted: a source without the keystore can't read it.
    const noKeystore = new CloudRoaring({
      warm: w.warm,
      cold: new CrbmColdChunkSource(w.cold, { registry: w.registry }),
      retry: false,
    });
    await expect(members(noKeystore)).rejects.toBeInstanceOf(KeyUnavailableError);
  });

  it('requireEncryption refuses to compact a cleartext segment without a keystore', async () => {
    const w = world(); // no keystore
    await bulkLoadCrbmGeneration(w.cold, { ...SEG, generation: 0 }, [1, 2], {
      registry: w.registry,
    });
    await w.store().segment('s').add(3);
    await expect(
      compactSegment(SEG, { ...w.deps, requireEncryption: true }, { owner: OWNER }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('reuses the same DEK + correct data across multiple generations (0 → 1 → 2)', async () => {
    const keystore = new InProcessKeystore({ keys: { k1: k() }, activeKeyId: 'k1' });
    const w = world(keystore);
    await bulkLoadCrbmGeneration(w.cold, { ...SEG, generation: 0 }, [1, 2, 3], {
      registry: w.registry,
      keystore,
    });
    const wrapped0 = (await w.registry.get(SEG))!.wrappedDeks;

    await w.store().segment('s').add(4);
    expect((await compactSegment(SEG, w.deps, { owner: OWNER })).toGen).toBe(1);
    await w.store().segment('s').add(5);
    expect((await compactSegment(SEG, w.deps, { owner: OWNER })).toGen).toBe(2);

    expect((await w.registry.get(SEG))!.currentGen).toBe(2);
    // The DEK is reused across every generation (the wrapped list never changes), and each gen decrypts.
    expect((await w.registry.get(SEG))!.wrappedDeks).toEqual(wrapped0);
    expect(await members(w.store())).toEqual([1, 2, 3, 4, 5]);
  });

  it('compacting an encrypted segment without the keystore fails fast (KeyUnavailableError, never a silent decode)', async () => {
    const keystore = new InProcessKeystore({ keys: { k1: k() }, activeKeyId: 'k1' });
    const w = world(keystore);
    // Bootstrap an encrypted gen 0 — the registry row carries the wrapped DEK.
    await bulkLoadCrbmGeneration(w.cold, { ...SEG, generation: 0 }, [1, 2, 3], {
      registry: w.registry,
      keystore,
    });
    await w.store().segment('s').add(4); // a Warm row to fold
    // The daemon now runs WITHOUT the keystore: it must refuse (can't open the DEK), never mis-decode the
    // ciphertext. A lost key is a genuine fault that propagates, not a silent wrong answer.
    await expect(
      compactSegment(SEG, { ...w.deps, keystore: undefined }, { owner: OWNER }),
    ).rejects.toThrow(KeyUnavailableError);
  });
});

describe('crypto-shred — destroySegment / eraseNamespace (Phase 4e, L1–L4)', () => {
  it('shreds the DEK + clears Warm; the segment reads empty and is unrecoverable even WITH the keystore', async () => {
    const keystore = new InProcessKeystore({ keys: { k1: k() }, activeKeyId: 'k1' });
    const w = world(keystore);
    await bulkLoadCrbmGeneration(w.cold, { ...SEG, generation: 0 }, [1, 2, 3], {
      registry: w.registry,
      keystore,
    });
    await w.store().segment('s').add(4); // a live Warm row too
    expect(await members(w.store())).toEqual([1, 2, 3, 4]);

    const res = await destroySegment(SEG, w.deps, { confirmSegment: 's' });
    expect(res.destroyed).toBe(true);
    expect(res.warmRowsDeleted).toBeGreaterThanOrEqual(1);

    const rec = (await w.registry.get(SEG))!;
    expect(rec.status).toBe('destroyed');
    expect(rec.wrappedDeks).toBeUndefined(); // the key is gone — the .crbm bytes are now unreadable forever

    // Reads empty even though we still hold the KEK: there is no DEK left to unwrap.
    expect(await members(w.store())).toEqual([]);
  });

  it('refuses to report a destruction it could not finish — warm rows contended on every pass', async () => {
    // The defect this pins: `eraseWarm` retries contended rows a bounded number of times (MAX_WARM_PASSES) and
    // used to fall out of that loop and simply `return deleted`. `shredSegment` then CAS'd the `destroyed`
    // tombstone regardless, so `destroySegment` answered `destroyed: true` on a segment whose Warm rows — which
    // this module documents as CLEARTEXT — were still readable. On a right-to-erasure command that is a false
    // attestation, and nothing in the result could reveal it: `warmRowsDeleted` counts successes only.
    //
    // Note WHY asserting the throw is not enough on its own, and why the registry assertion below is the real
    // test: the ordering in `shredSegment` clears Warm BEFORE flipping the tombstone, so the fix is only correct
    // if the failure leaves the segment un-destroyed and retryable. A version that threw AFTER the CAS would
    // still pass a throws-assertion while leaving exactly the state we are trying to prevent.
    const keystore = new InProcessKeystore({ keys: { k1: k() }, activeKeyId: 'k1' });
    const w = world(keystore);
    await bulkLoadCrbmGeneration(w.cold, { ...SEG, generation: 0 }, [1, 2, 3], {
      registry: w.registry,
      keystore,
    });
    await w.store().segment('s').add(4); // the live Warm row that will stay contended

    // A warm driver whose conditional delete always loses the race, as if another writer rewrote the row
    // between our list and our delete — every pass, forever.
    // A Proxy rather than a spread-and-override: the driver's methods live on its prototype and touch private
    // fields, so a spread copies none of them and a hand-listed subset silently depends on which methods the
    // interface happens to have today. Forwarding with `receiver = target` keeps `this` the real instance.
    const contended = new Proxy(w.warm, {
      get(target, prop) {
        if (prop === 'deleteConditional') {
          return async (): Promise<never> => {
            throw new WriteConflictError('row rewritten mid-erase');
          };
        }
        const value = Reflect.get(target, prop, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    await expect(
      destroySegment(SEG, { ...w.deps, warm: contended }, { confirmSegment: 's' }),
    ).rejects.toBeInstanceOf(WriteConflictError);

    // The point of the fix: NOT destroyed, and still holding its key, so a retry can finish the job.
    const rec = (await w.registry.get(SEG))!;
    expect(rec.status).toBe('active');
    expect(rec.wrappedDeks).toBeDefined();
    // And the data is demonstrably still there — which is the honest state, and the state the old code
    // reported as `destroyed: true`.
    expect(await members(w.store())).toEqual([1, 2, 3, 4]);
  });

  it('requires the exact segment name as confirmation (guards against accidental shred)', async () => {
    const keystore = new InProcessKeystore({ keys: { k1: k() }, activeKeyId: 'k1' });
    const w = world(keystore);
    await bulkLoadCrbmGeneration(w.cold, { ...SEG, generation: 0 }, [1], {
      registry: w.registry,
      keystore,
    });
    await expect(destroySegment(SEG, w.deps, { confirmSegment: 'wrong' })).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect((await w.registry.get(SEG))!.status).toBe('active'); // untouched
  });

  it('refuses to publish a generation for a segment destroyed WHILE it was being written', async () => {
    // The window: `bulkLoadCrbmGeneration` reads the registry once and refuses if the segment is already
    // destroyed — then spends a KMS call and a whole object write before publishing. A `destroySegment` landing
    // inside that window used to be invisible to `publishGeneration`, which compares only `currentGen`, so the
    // pointer advanced on a destroyed record and left an object encrypted with the DEK destroy had just
    // shredded: unreadable, still stored, attached to a segment the registry says was erased.
    //
    // Simulated by destroying between the write and the publish, which is exactly what the race produces. This
    // is the "later hardening" erasure.ts's header refers to, for the publish step.
    const keystore = new InProcessKeystore({ keys: { k1: k() }, activeKeyId: 'k1' });
    const w = world(keystore);
    await bulkLoadCrbmGeneration(w.cold, { ...SEG, generation: 0 }, [1, 2], {
      registry: w.registry,
      keystore,
    });
    await destroySegment(SEG, w.deps, { confirmSegment: 's' });
    expect((await w.registry.get(SEG))!.status).toBe('destroyed');

    // A late publish for a *newer* generation — what the in-flight bulk load would have attempted.
    await expect(publishGeneration(w.registry, { ...SEG, generation: 1 })).rejects.toBeInstanceOf(
      ValidationError,
    );

    // The pointer did not move, so the destroyed segment did not acquire an unreadable "current" generation.
    const rec = (await w.registry.get(SEG))!;
    expect(rec.status).toBe('destroyed');
    expect(rec.currentGen).toBe(0);
  });

  it('is idempotent — destroying an already-destroyed segment is a no-op success', async () => {
    const keystore = new InProcessKeystore({ keys: { k1: k() }, activeKeyId: 'k1' });
    const w = world(keystore);
    await bulkLoadCrbmGeneration(w.cold, { ...SEG, generation: 0 }, [1], {
      registry: w.registry,
      keystore,
    });
    await destroySegment(SEG, w.deps, { confirmSegment: 's' });
    const again = await destroySegment(SEG, w.deps, { confirmSegment: 's' });
    expect(again).toMatchObject({ destroyed: true, reason: 'already' });
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
      await bulkLoadCrbmGeneration(
        w.cold,
        { namespace: 'ns', segment: seg, generation: 0 },
        [1, 2],
        { registry: w.registry, keystore },
      );
    }
    // Give 'b' a live warm row and make only ITS conditional delete lose the race, every time — so 'b' burns
    // through every erase pass while 'a' and 'c' are untouched.
    await new CloudRoaring({
      warm: w.warm,
      cold: new CrbmColdChunkSource(w.cold, { registry: w.registry, keystore }),
      retry: false,
    })
      .segment('b', { namespace: 'ns' })
      .add(9);
    const warm = new Proxy(w.warm, {
      get(target, prop) {
        const value = Reflect.get(target, prop, target) as unknown;
        if (prop === 'deleteConditional') {
          // A rest parameter, NOT `arguments`: this is an arrow function, so `arguments` would resolve to the
          // enclosing trap's own args and forward the property NAME as the expected token. Every real delete
          // would then fail on a bad token and the test would "pass" while proving nothing about isolation.
          return async (...args: unknown[]): Promise<unknown> => {
            const ref = args[0] as { segment: string };
            if (ref.segment === 'b') throw new WriteConflictError('row rewritten mid-erase');
            return (value as (...a: unknown[]) => Promise<unknown>).apply(target, args);
          };
        }
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    const { destroyed } = await eraseNamespace(
      'ns',
      { ...w.deps, warm },
      { confirmNamespace: 'ns' },
    );

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
      await bulkLoadCrbmGeneration(
        w.cold,
        { namespace: 'ns', segment: seg, generation: 0 },
        [1, 2],
        {
          registry: w.registry,
          keystore,
        },
      );
    }
    const { destroyed } = await eraseNamespace('ns', w.deps, { confirmNamespace: 'ns' });
    expect(destroyed.map((d) => d.segment).sort()).toEqual(['a', 'b']);
    expect(destroyed.every((d) => d.destroyed)).toBe(true);
    for (const seg of ['a', 'b']) {
      expect((await w.registry.get({ namespace: 'ns', segment: seg }))!.status).toBe('destroyed');
    }
  });

  it('refuses to shred a cleartext segment (no key to shred) unless allowCleartext', async () => {
    const w = world(); // no keystore
    await bulkLoadCrbmGeneration(w.cold, { ...SEG, generation: 0 }, [1, 2], {
      registry: w.registry,
    });
    const res = await destroySegment(SEG, w.deps, { confirmSegment: 's' });
    expect(res).toMatchObject({ destroyed: false, reason: 'cleartext' });
    expect((await w.registry.get(SEG))!.status).toBe('active');
  });

  it('refuses to resurrect a destroyed segment: bulk-load throws, compaction skips it', async () => {
    const keystore = new InProcessKeystore({ keys: { k1: k() }, activeKeyId: 'k1' });
    const w = world(keystore);
    await bulkLoadCrbmGeneration(w.cold, { ...SEG, generation: 0 }, [1, 2], {
      registry: w.registry,
      keystore,
    });
    await destroySegment(SEG, w.deps, { confirmSegment: 's' });

    // Bulk-loading a new generation would mint a DEK that could never be reached → refuse outright.
    await expect(
      bulkLoadCrbmGeneration(w.cold, { ...SEG, generation: 1 }, [9], {
        registry: w.registry,
        keystore,
      }),
    ).rejects.toBeInstanceOf(ValidationError);

    // Compaction won't resurrect it either — a destroyed segment is terminal.
    const res = await compactSegment(SEG, w.deps, { owner: OWNER });
    expect(res).toMatchObject({ compacted: false, reason: 'destroyed' });
    // The original Cold data is unrecoverable; the segment reads empty.
    expect(await members(w.store())).toEqual([]);
  });
});
