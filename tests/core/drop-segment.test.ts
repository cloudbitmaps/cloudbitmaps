import { randomBytes } from 'node:crypto';
import {
  CloudRoaring,
  CrbmColdChunkSource,
  MemoryColdDriver,
  MemoryRegistryDriver,
  MemoryWarmDriver,
  bulkLoadCrbmGeneration,
  dropSegment,
} from '@/index';
import { InProcessKeystore } from '@/drivers/crypto';
import { NotFoundError, ValidationError } from '@/core/errors';
import type { IKeystore, SegmentRef } from '@/index';

/**
 * `dropSegment` — the operational sibling of crypto-shred: it deletes the objects.
 *
 * The reason this function exists is that the ORDER of its three steps is easy to get catastrophically wrong,
 * and the wrong order fails silently. So the tests below are mostly about order and about the states each
 * ordering produces, not about the happy path:
 *
 *   Warm first    — a `destroyed` tombstone with live Warm deltas still answers `true`, because Warm is read
 *                   separately from and earlier than Cold.
 *   Registry next — after the tombstone nothing resolves a generation, so no reader can reach bytes that are
 *                   about to vanish.
 *   Cold last     — and best-effort, so a partial failure leaves orphaned bytes (a billing problem) rather
 *                   than a live pointer into a hole (a correctness problem).
 *
 * The `leaves no torn pointer` test is the one that would have caught the workaround this function replaces:
 * an object-store lifecycle rule deleting the bytes while the registry still points at them.
 */

// NOTE the shape: a colon is NOT legal in a name (`/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/`), so the obvious
// `active:2026-08-01` throws. The dated-bucket pattern belongs in the NAMESPACE/segment split instead, which is
// also strictly more useful — `registry.list(namespace)` then enumerates exactly the buckets a retention sweep
// should consider.
const SEG: SegmentRef = { namespace: 'active-daily', segment: '2026-08-01' };
const CONFIRM = { confirmSegment: SEG.segment };

function world(keystore?: IKeystore) {
  const cold = new MemoryColdDriver();
  const warm = new MemoryWarmDriver();
  const registry = new MemoryRegistryDriver();
  const store = new CloudRoaring({
    warm,
    cold: new CrbmColdChunkSource(cold, { registry, keystore }),
    retry: false,
  });
  return { cold, warm, registry, store, deps: { cold, warm, registry } };
}

async function seed(
  w: ReturnType<typeof world>,
  ids: number[],
  keystore?: IKeystore,
  generation = 0,
): Promise<void> {
  await bulkLoadCrbmGeneration(w.cold, { ...SEG, generation }, ids, {
    registry: w.registry,
    keystore,
  });
}

/** The segment handle — namespace INCLUDED, because it is part of the identity and omitting it silently
 *  addresses a different segment in the default namespace. (Which it did, while writing these tests.) */
const handle = (w: ReturnType<typeof world>) =>
  w.store.segment(SEG.segment, { namespace: SEG.namespace });

async function generationsInCold(w: ReturnType<typeof world>): Promise<number[]> {
  const gens: number[] = [];
  for await (const key of w.cold.list(SEG)) gens.push(key.generation);
  return gens.sort((a, b) => a - b);
}

describe('dropSegment', () => {
  it('deletes the Cold objects — which crypto-shred does not', async () => {
    const w = world();
    await seed(w, [1, 2, 3, 70_000]);
    expect(await generationsInCold(w)).toHaveLength(1);

    const result = await dropSegment(SEG, w.deps, CONFIRM);

    expect(result.dropped).toBe(true);
    expect(result.generationsDeleted).toHaveLength(1);
    // The whole point: the bytes are gone from the store, not merely unreadable.
    expect(await generationsInCold(w)).toEqual([]);
  });

  it('works on a CLEARTEXT segment — crypto-shred refuses one', async () => {
    // destroySegment rejects a cleartext segment (no key to discard) unless you pass allowCleartext, and even
    // then leaves the Cold bytes readable. Disposal has no such requirement, and most segments are cleartext.
    const w = world();
    await seed(w, [5, 6]);
    const result = await dropSegment(SEG, w.deps, CONFIRM);
    expect(result.dropped).toBe(true);
    expect(result.cryptoShredded).toBe(false);
    expect(await generationsInCold(w)).toEqual([]);
  });

  it('ALSO crypto-shreds an encrypted segment, so it is a strict superset there', async () => {
    // Deleting an object does not reach a noncurrent version, a replica or a PITR snapshot; discarding the key
    // does. On an encrypted segment we want both, and the result has to say which happened.
    const keystore = new InProcessKeystore({ keys: { k1: randomBytes(32) }, activeKeyId: 'k1' });
    const w = world(keystore);
    await seed(w, [7, 8], keystore);
    const result = await dropSegment(SEG, w.deps, CONFIRM);
    expect(result.cryptoShredded).toBe(true);
    expect(result.generationsDeleted).toHaveLength(1);
  });

  it('leaves NO torn pointer — the segment reads as empty, not as an error', async () => {
    // THE load-bearing test. The workaround this replaces (a lifecycle rule deleting objects while the registry
    // still points at them) produces `missing-cold-generation`: reads throw NotFoundError, intermittently,
    // because the hot cache masks it until eviction. Ordering the tombstone BEFORE the delete is what converts
    // that into a benign empty read, so assert the benign outcome rather than the ordering directly.
    const w = world();
    await seed(w, [1, 2, 3]);
    await dropSegment(SEG, w.deps, CONFIRM);

    const seg = handle(w);
    await expect(seg.has(1)).resolves.toBe(false);
    await expect(seg.count()).resolves.toBe(0);
    const listed: number[] = [];
    for await (const id of seg.iterate()) listed.push(id);
    expect(listed).toEqual([]);
  });

  it('proves the inverse order is what breaks: delete Cold first and reads throw', async () => {
    // A control for the test above. Without this, "reads are empty" could be true for reasons unrelated to
    // ordering, and the ordering guarantee would be asserted by comment only. Deleting the object while the
    // registry row is intact must produce the failure the real function is arranged to avoid.
    const w = world();
    await seed(w, [1, 2, 3]);
    for (const generation of await generationsInCold(w)) {
      await w.cold.delete({ ...SEG, generation });
    }
    // Registry still points at the deleted generation → the torn state.
    await expect(handle(w).has(1)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('deletes the Warm deltas, so a tombstone cannot still answer true', async () => {
    // Warm is consulted separately from and earlier than Cold, so a `destroyed` row with live Warm adds would
    // report membership for ids in those deltas — a deleted segment answering `true`. Warm must go first.
    const w = world();
    await seed(w, [1]);
    await handle(w).addMany([500, 501, 502]); // warm adds, not yet compacted

    const result = await dropSegment(SEG, w.deps, CONFIRM);

    expect(result.warmRowsDeleted).toBeGreaterThan(0);
    await expect(handle(w).has(500)).resolves.toBe(false);
  });

  it('dryRun reports what would go and changes nothing', async () => {
    // The confirmSegment guard protects a hand-typed literal. In the loop this function is for, the same
    // variable appears twice and the guard is ceremony — a dry run is the guard that survives automation.
    const w = world();
    await seed(w, [1, 2]);

    const preview = await dropSegment(SEG, w.deps, { ...CONFIRM, dryRun: true });

    expect(preview.dropped).toBe(false);
    expect(preview.wouldDelete).toHaveLength(1);
    expect(preview.generationsDeleted).toEqual([]);
    // Nothing touched: the data still reads, and the objects are still there.
    expect(await generationsInCold(w)).toHaveLength(1);
    await expect(handle(w).has(1)).resolves.toBe(true);
  });

  it('is idempotent — a second drop is a no-op that says so', async () => {
    const w = world();
    await seed(w, [1]);
    await dropSegment(SEG, w.deps, CONFIRM);
    const again = await dropSegment(SEG, w.deps, CONFIRM);
    expect(again.dropped).toBe(true);
    expect(again.reason).toBe('already');
    expect(again.generationsDeleted).toEqual([]);
  });

  it('reports an absent segment rather than throwing', async () => {
    // A retention loop will inevitably name a bucket that was already collected. That is not an error.
    const w = world();
    const result = await dropSegment(SEG, w.deps, CONFIRM);
    expect(result.dropped).toBe(false);
    expect(result.reason).toBe('absent');
  });

  it('refuses a mismatched confirmSegment', async () => {
    const w = world();
    await seed(w, [1]);
    await expect(
      dropSegment(SEG, w.deps, { confirmSegment: 'something-else' }),
    ).rejects.toBeInstanceOf(ValidationError);
    // And refusing means refusing: the data is untouched.
    expect(await generationsInCold(w)).toHaveLength(1);
  });

  it('deletes every generation, not just the current one', async () => {
    // A segment that has been compacted holds superseded generations too. Disposal that left them behind would
    // keep billing for the bytes it claimed to remove — the exact complaint that motivated this function.
    const w = world();
    await seed(w, [1, 2]);
    await seed(w, [3, 4], undefined, 1);
    expect((await generationsInCold(w)).length).toBeGreaterThan(1);

    const result = await dropSegment(SEG, w.deps, CONFIRM);

    expect(result.generationsDeleted.length).toBeGreaterThan(1);
    expect(await generationsInCold(w)).toEqual([]);
  });

  it('tolerates a Cold delete failure, leaving orphaned bytes rather than a torn pointer', async () => {
    // Cold deletion is last and best-effort on purpose. Once the tombstone is written the segment reads as
    // empty and is CORRECT, so a failure here is a billing problem; failing the whole call instead would leave
    // callers retrying a drop that already succeeded semantically.
    const w = world();
    await seed(w, [1, 2]);
    w.cold.delete = (): Promise<void> => Promise.reject(new Error('S3 is having a day'));

    const result = await dropSegment(SEG, w.deps, CONFIRM);

    expect(result.dropped).toBe(true); // the segment IS disposed of, semantically
    expect(result.generationsDeleted).toEqual([]); // ...but the bytes leaked
    await expect(handle(w).has(1)).resolves.toBe(false); // and reads stay benign
  });

  it('does NOT emit `segment.erase` for a cleartext drop — that event means crypto-shred', async () => {
    // Caught by an adversarial docs review, and it was a real bug: the first version fired on
    // `cryptoShredded || generationsDeleted.length > 0`, so a cleartext drop emitted the event that four
    // documents — dashboards.md calls it the compliance *receipt* — define as proof of irreversible destruction.
    // Deleting an object is weaker than discarding a key: a noncurrent version, a replica or a PITR snapshot
    // still holds the cleartext. A dashboard built on our own docs would have over-attested.
    const w = world();
    await seed(w, [1, 2]);
    const events: unknown[] = [];
    const audit = { onEvent: (e: unknown): void => void events.push(e) };

    const result = await dropSegment(SEG, w.deps, { ...CONFIRM, audit });

    expect(result.generationsDeleted).toHaveLength(1); // bytes really went
    expect(result.cryptoShredded).toBe(false);
    expect(events).toEqual([]); // ...and claimed nothing about them
  });

  it('DOES emit `segment.erase` when the drop genuinely crypto-shreds', async () => {
    // The positive control for the test above. Without it, "no event" could be true because the audit sink is
    // never called at all, and the assertion above would pass against a `dropSegment` that audits nothing ever.
    const keystore = new InProcessKeystore({ keys: { k1: randomBytes(32) }, activeKeyId: 'k1' });
    const w = world(keystore);
    await seed(w, [1, 2], keystore);
    const events: Array<{ kind: string }> = [];

    await dropSegment(SEG, w.deps, { ...CONFIRM, audit: { onEvent: (e) => void events.push(e) } });

    expect(events.map((e) => e.kind)).toEqual(['segment.erase']);
  });

  it('is only eventually empty to a reader that had already cached the segment', async () => {
    // The docs said "afterwards the segment reads as empty", full stop. False for up to `coldGenTtlMs`
    // (default 2s): a resolved generation is cached and decoded chunks sit in the hot LRU, so a store that
    // touched the segment BEFORE the drop keeps answering from cache. My original tests all passed only because
    // none of them read first — the blind spot was in the fixture, not the assertion.
    //
    // Asserted as a bound rather than a timing: a FRESH store over the same drivers must see empty at once,
    // which pins the cause on caching rather than on the drop having failed.
    const w = world();
    await seed(w, [1, 2, 3]);
    await expect(handle(w).has(1)).resolves.toBe(true); // warms the snapshot + LRU

    await dropSegment(SEG, w.deps, CONFIRM);

    // Same store: may still answer from cache. Whatever it says, it must not throw.
    await expect(handle(w).has(1)).resolves.toBeTypeOf('boolean');

    // A reader that never cached it sees the truth immediately — so the data really is gone.
    const fresh = new CloudRoaring({
      warm: w.warm,
      cold: new CrbmColdChunkSource(w.cold, { registry: w.registry }),
      retry: false,
    });
    await expect(fresh.segment(SEG.segment, { namespace: SEG.namespace }).has(1)).resolves.toBe(
      false,
    );
  });
});

describe('store.dropSegment (facade)', () => {
  it('needs no drivers passed — the store already holds them', async () => {
    // The point of the facade wrapper: a user should not re-wire registry/warm/cold to delete a segment.
    const cold = new MemoryColdDriver();
    const warm = new MemoryWarmDriver();
    const registry = new MemoryRegistryDriver();
    await bulkLoadCrbmGeneration(cold, { ...SEG, generation: 0 }, [1, 2, 3], { registry });

    const store = new CloudRoaring({ warm, cold, registry, retry: false });
    const result = await store.dropSegment(SEG, CONFIRM);

    expect(result.dropped).toBe(true);
    expect(result.generationsDeleted).toHaveLength(1);
    await expect(store.segment(SEG.segment, { namespace: SEG.namespace }).has(1)).resolves.toBe(
      false,
    );
  });

  it('dry-runs through the facade too', async () => {
    const cold = new MemoryColdDriver();
    const warm = new MemoryWarmDriver();
    const registry = new MemoryRegistryDriver();
    await bulkLoadCrbmGeneration(cold, { ...SEG, generation: 0 }, [1], { registry });

    const store = new CloudRoaring({ warm, cold, registry, retry: false });
    const preview = await store.dropSegment(SEG, { ...CONFIRM, dryRun: true });

    expect(preview.wouldDelete).toHaveLength(1);
    await expect(store.segment(SEG.segment, { namespace: SEG.namespace }).has(1)).resolves.toBe(
      true,
    );
  });
});
