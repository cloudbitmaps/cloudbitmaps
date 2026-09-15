import { CloudRoaring, MemoryColdDriver, MemoryRegistryDriver } from '@/index';
import { UnsupportedError, ValidationError } from '@/core/errors';

// "How do I know whether a segment already exists?" — the question this answers, and the reason a user should
// NOT keep their own list of segment names beside the store. The registry is already that list.
//
// The distinction that carries the whole feature: a segment that was NEVER LOADED and a segment LOADED WITH NO
// IDS both report `count() === 0`. Only `exists()` tells them apart.

const store = (): CloudRoaring =>
  new CloudRoaring({
    cold: new MemoryColdDriver(),
    registry: new MemoryRegistryDriver(),
  });

const drain = async <T>(it: AsyncIterable<T>): Promise<T[]> => {
  const out: T[] = [];
  for await (const v of it) out.push(v);
  return out;
};

describe('exists()', () => {
  it('is false for a name nothing was ever loaded into', async () => {
    const s = store();
    expect(await s.exists({ segment: 'users' })).toBe(false);
  });

  it('is true after a load, and distinguishes never-loaded from loaded-but-empty', async () => {
    const s = store();
    await s.load({ segment: 'loaded' }, [1, 2, 3]);
    await s.load({ segment: 'emptied' }, [], { allowEmpty: true });

    expect(await s.exists({ segment: 'loaded' })).toBe(true);
    expect(await s.exists({ segment: 'emptied' })).toBe(true);
    expect(await s.exists({ segment: 'never' })).toBe(false);

    // The reason exists() is worth having: count() cannot make this distinction.
    expect(await s.segment('emptied').count()).toBe(0);
    expect(await s.segment('never').count()).toBe(0);
  });

  it('distinguishes segments by (namespace, segment), not by name alone', async () => {
    const s = store();
    await s.load({ segment: 'daily', namespace: 'acme' }, [1]);

    expect(await s.exists({ segment: 'daily', namespace: 'acme' })).toBe(true);
    expect(await s.exists({ segment: 'daily', namespace: 'globex' })).toBe(false);
    expect(await s.exists({ segment: 'daily' })).toBe(false); // the default namespace is its own namespace
  });

  it('is false for a row minted ahead of the first load — a read there answers empty', async () => {
    const s = store();
    await s.setRetention({ segment: 'planned' }, { expiresAt: Date.now() + 86_400_000 });
    // The row exists and is enumerable, but nothing would be read from it yet.
    expect(await s.exists({ segment: 'planned' })).toBe(false);
    expect((await drain(s.segments())).map((x) => x.segment)).toContain('planned');
  });

  it('is false again once the segment is dropped', async () => {
    const s = store();
    await s.load({ segment: 'temp' }, [1, 2]);
    expect(await s.exists({ segment: 'temp' })).toBe(true);
    await s.dropSegment({ segment: 'temp' }, { confirmSegment: 'temp' });
    expect(await s.exists({ segment: 'temp' })).toBe(false);
  });

  it('validates the ref rather than answering false for a bad name', async () => {
    const s = store();
    await expect(s.exists({ segment: ':leading' })).rejects.toBeInstanceOf(ValidationError);
  });

  it('needs a registry', async () => {
    const s = new CloudRoaring({ cold: new MemoryColdDriver() });
    await expect(s.exists({ segment: 'x' })).rejects.toBeInstanceOf(UnsupportedError);
  });
});

describe('segments()', () => {
  it('enumerates what was loaded, with the pointer and status', async () => {
    const s = store();
    await s.load({ segment: 'a' }, [1]);
    await s.load({ segment: 'b', namespace: 'tenant:acme' }, [2, 3]);

    const all = await drain(s.segments());
    expect(all.map((x) => x.segment).sort()).toEqual(['a', 'b']);
    expect(all.find((x) => x.segment === 'a')).toEqual({
      segment: 'a',
      currentGen: 0,
      status: 'active',
    });
    expect(all.find((x) => x.segment === 'b')?.namespace).toBe('tenant:acme');
  });

  it('scopes to one namespace — the difference between one tenant and every tenant', async () => {
    const s = store();
    await s.load({ segment: 'x', namespace: 'acme' }, [1]);
    await s.load({ segment: 'y', namespace: 'globex' }, [2]);
    await s.load({ segment: 'z' }, [3]);

    expect((await drain(s.segments({ namespace: 'acme' }))).map((v) => v.segment)).toEqual(['x']);
    expect((await drain(s.segments())).length).toBe(3);
  });

  it('streams — abandoning the iteration does not require draining the fleet', async () => {
    const s = store();
    for (const n of ['a', 'b', 'c', 'd']) await s.load({ segment: n }, [1]);

    const seen: string[] = [];
    for await (const info of s.segments()) {
      seen.push(info.segment);
      if (seen.length === 2) break;
    }
    expect(seen).toHaveLength(2);
  });

  it('keeps reporting a crypto-shredded tombstone rather than hiding it', async () => {
    const s = store();
    await s.load({ segment: 'gone' }, [1, 2]);
    await s.dropSegment({ segment: 'gone' }, { confirmSegment: 'gone' });

    // `dropSegment` leaves a `destroyed` TOMBSTONE — the row stays, with its last `currentGen` intact, so a
    // retention sweep can still find and clean it. Hiding it here would be the filtered-enumeration mistake:
    // the sweep would have nothing to act on and would look like it had nothing to do.
    const listed = await drain(s.segments());
    expect(listed).toEqual([{ segment: 'gone', currentGen: 0, status: 'destroyed' }]);

    // …and this is exactly why `exists()` asks the narrower question. The pointer is still a number; the data
    // is gone. A caller deciding whether to load must be told `false`.
    expect(await s.exists({ segment: 'gone' })).toBe(false);
  });

  it("never shows internal bookkeeping rows as if they were the user's segments", async () => {
    const s = store();
    await s.load({ segment: 'real' }, [1]);
    // A retention policy mints a due-index POINTER row in a reserved namespace (`cbm.due.<bucket>`). It is
    // bookkeeping, not a segment — surfacing it would put rows in a user's dashboard that they never created
    // and cannot act on, and would inflate every count taken from this call.
    await s.setRetention({ segment: 'real' }, { expiresAt: Date.now() + 86_400_000 });

    const listed = await drain(s.segments());
    expect(listed.map((v) => v.segment)).toEqual(['real']);
    expect(listed.some((v) => (v.namespace ?? '').startsWith('cbm.due.'))).toBe(false);
  });

  it('still shows reserved rows to a caller who scopes to them deliberately', async () => {
    // Hold the registry so the test can discover the due-index namespace rather than hardcode a bucket
    // number, which is clock-dependent.
    const registry = new MemoryRegistryDriver();
    const s = new CloudRoaring({
      cold: new MemoryColdDriver(),
      registry,
    });
    await s.load({ segment: 'real' }, [1]);
    await s.setRetention({ segment: 'real' }, { expiresAt: Date.now() + 86_400_000 });

    const raw = [];
    for await (const r of registry.list()) raw.push(r);
    const dueNamespace = raw.find((r) => (r.namespace ?? '').startsWith('cbm.due.'))?.namespace;
    expect(dueNamespace).toBeDefined(); // the fixture must actually have produced one

    // The exclusion is for the UNSCOPED fleet scan only. Naming the namespace is an explicit request, and the
    // retention sweep's own diagnostics depend on being able to make it.
    const reserved = await drain(s.segments({ namespace: dueNamespace }));
    expect(reserved).toHaveLength(1);
    expect(reserved[0]?.namespace).toBe(dueNamespace);
  });

  it('validates a namespace rather than silently scanning everything', async () => {
    const s = store();
    expect(() => s.segments({ namespace: 'a/b' })).toThrow(ValidationError);
  });

  it('needs a registry', () => {
    const s = new CloudRoaring({ cold: new MemoryColdDriver() });
    expect(() => s.segments()).toThrow(UnsupportedError);
  });
});
