import { describe, expect, it } from 'vitest';
import { TransientError, WriteConflictError } from '@/core/errors';
import type { SegmentRef } from '@/core/ports';
import { ObjectStoreRegistry } from '@/drivers/_shared/object-registry';
import { registryObjectKey } from '@/drivers/_shared/object-registry-keys';
import { CountingObjectStore } from '../../helpers/counting';

/**
 * A caller that already read a row hands that record to the registry write as `held`, and an object registry sends
 * its conditional write without reading the row first. These pin the requests that saves, and that the store's own
 * condition is still the fence: a `held` that is stale loses as a lost race does, on every store, with the row left as
 * it was.
 */

const SEG: SegmentRef = { namespace: 'ns', segment: 's' };
const KEY = registryObjectKey('p', SEG);

const clock = (): (() => number) => {
  let t = 1_000;
  return () => (t += 1);
};

function world(options: { conditionalDelete?: boolean } = {}) {
  const store = new CountingObjectStore(0, options);
  const registry = new ObjectStoreRegistry(store, 'p', clock());
  // Another process over the same store: the only thing that moves a row under this one's feet.
  const other = new ObjectStoreRegistry(store, 'p', clock());
  const requests = () => ({ reads: store.reads, writes: store.writes });
  return { store, registry, other, requests };
}

describe('a held row spares the registry write its read', () => {
  it('a compare-and-swap made against the row get returned is one write and no read', async () => {
    const w = world();
    await w.registry.create(SEG, { currentGen: 0 });
    const held = (await w.registry.get(SEG))!;
    const before = w.requests();

    await w.registry.compareAndSwap(SEG, held.token, { currentGen: 1 }, { held });

    expect({
      reads: w.store.reads - before.reads,
      writes: w.store.writes - before.writes,
    }).toEqual({ reads: 0, writes: 1 });
    expect((await w.registry.get(SEG))!.currentGen).toBe(1);
  });

  it('without it, the same compare-and-swap reads the row first', async () => {
    const w = world();
    await w.registry.create(SEG, { currentGen: 0 });
    const held = (await w.registry.get(SEG))!;
    const before = w.requests();

    await w.registry.compareAndSwap(SEG, held.token, { currentGen: 1 });

    expect({
      reads: w.store.reads - before.reads,
      writes: w.store.writes - before.writes,
    }).toEqual({ reads: 1, writes: 1 });
  });

  it('a create made with `held: null` is one write and no read, and a store with conditional delete makes the same', async () => {
    for (const conditionalDelete of [false, true]) {
      const w = world({ conditionalDelete });
      await w.registry.create(SEG, { currentGen: 0 }, { held: null });
      expect(w.requests()).toEqual({ reads: 0, writes: 1 });
    }
  });

  it('a create without it reads the row first', async () => {
    const w = world();
    await w.registry.create(SEG, { currentGen: 0 });
    expect(w.requests()).toEqual({ reads: 1, writes: 1 });
  });

  it('a record this registry did not return is read for, and so is one another registry returned', async () => {
    const w = world();
    await w.registry.create(SEG, { currentGen: 0 });
    const copy = structuredClone((await w.registry.get(SEG))!);
    const before = w.requests();
    await w.registry.compareAndSwap(SEG, copy.token, { currentGen: 1 }, { held: copy });
    expect(w.store.reads - before.reads).toBe(1);

    const theirs = (await w.other.get(SEG))!;
    const mid = w.requests();
    await w.registry.compareAndSwap(SEG, theirs.token, { currentGen: 2 }, { held: theirs });
    expect(w.store.reads - mid.reads).toBe(1);
  });

  it('a record of one segment does not stand for another', async () => {
    const w = world();
    const b: SegmentRef = { namespace: 'ns', segment: 'b' };
    await w.registry.create(SEG, { currentGen: 0 });
    const { token } = await w.registry.create(b, { currentGen: 0 });
    const heldA = (await w.registry.get(SEG))!;
    await expect(
      w.registry.compareAndSwap(b, token, { currentGen: 1 }, { held: heldA }),
    ).resolves.toBeDefined();
    expect((await w.registry.get(b))!.currentGen).toBe(1);
    expect((await w.registry.get(SEG))!.currentGen).toBe(0);
  });
});

describe('the store keeps the fence', () => {
  it('a compare-and-swap whose held row went stale in another process loses, and the row is as the winner left it', async () => {
    const w = world();
    const { token: t0 } = await w.registry.create(SEG, { currentGen: 0 });
    const held = (await w.registry.get(SEG))!;
    const { token: t1 } = await w.other.compareAndSwap(SEG, t0, { currentGen: 5 });
    const before = w.requests();

    await expect(
      w.registry.compareAndSwap(SEG, held.token, { currentGen: 1 }, { held }),
    ).rejects.toBeInstanceOf(WriteConflictError);

    // It reached the store, which refused it: the registry did not decide from the stale record.
    expect(w.store.writes - before.writes).toBe(1);
    expect(await w.registry.get(SEG)).toMatchObject({ currentGen: 5, token: t1 });
  });

  it('a stale held row loses when the winner wrote a row that carries the same fields', async () => {
    const w = world();
    const { token: t0 } = await w.registry.create(SEG, { currentGen: 0 });
    const held = (await w.registry.get(SEG))!;
    await w.other.compareAndSwap(SEG, t0, { currentGen: 0 }); // a write that changes only the token
    await expect(
      w.registry.compareAndSwap(SEG, held.token, { currentGen: 1 }, { held }),
    ).rejects.toBeInstanceOf(WriteConflictError);
    expect((await w.registry.get(SEG))!.currentGen).toBe(0);
  });

  it('a row deleted since the read loses the write and is not created again by it', async () => {
    for (const conditionalDelete of [false, true]) {
      const w = world({ conditionalDelete });
      await w.registry.create(SEG, { currentGen: 0 });
      const held = (await w.registry.get(SEG))!;
      await w.other.delete(SEG);
      await expect(
        w.registry.compareAndSwap(SEG, held.token, { currentGen: 1 }, { held }),
      ).rejects.toBeInstanceOf(WriteConflictError);
      expect(await w.registry.get(SEG)).toBeNull();
    }
  });

  it('a create with `held: null` over a row another process made loses, and leaves that row', async () => {
    const w = world();
    const { token } = await w.other.create(SEG, { currentGen: 7 });
    await expect(w.registry.create(SEG, { currentGen: 0 }, { held: null })).rejects.toBeInstanceOf(
      WriteConflictError,
    );
    expect(await w.registry.get(SEG)).toMatchObject({ currentGen: 7, token });
  });

  it('a create with `held: null` that loses to a row gone by the time it is read is a conflict, written once', async () => {
    const store = new CountingObjectStore(1); // the first conditional write loses, as to a writer that then went away
    const registry = new ObjectStoreRegistry(store, 'p', clock());
    await expect(registry.create(SEG, { currentGen: 0 }, { held: null })).rejects.toBeInstanceOf(
      WriteConflictError,
    );
    expect({ reads: store.reads, writes: store.writes }).toEqual({ reads: 1, writes: 1 });
    expect(await registry.get(SEG)).toBeNull();
  });

  it('a create with `held: null` goes over a tombstone, as one without it does', async () => {
    const w = world({ conditionalDelete: false });
    const { token: first } = await w.registry.create(SEG, { currentGen: 0 });
    await w.registry.delete(SEG); // no conditional delete: the row stays, as a tombstone
    expect(w.store.size()).toBe(1);

    const { token } = await w.registry.create(SEG, { currentGen: 3 }, { held: null });

    expect(token).not.toBe(first);
    expect(await w.registry.get(SEG)).toMatchObject({ currentGen: 3, token });
  });

  it("a write with no answer throws the store's fault, and a held row does not change that", async () => {
    const w = world();
    await w.registry.create(SEG, { currentGen: 0 });
    const held = (await w.registry.get(SEG))!;
    const fault = new TransientError('throttled');
    const write = w.store.write.bind(w.store);
    w.store.write = () => Promise.reject(fault);
    await expect(
      w.registry.compareAndSwap(SEG, held.token, { currentGen: 1 }, { held }),
    ).rejects.toBe(fault);
    w.store.write = write;
    expect((await w.registry.get(SEG))!.currentGen).toBe(0);
    expect(w.store.text(KEY)).toContain('"currentGen":0');
  });
});
