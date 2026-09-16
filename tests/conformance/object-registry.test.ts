import { registryConformance, registryConcurrency } from '@/testing/conformance';
import {
  MAX_ROW_BYTES,
  ObjectStoreRegistry,
  ObjectVersionRaced,
  type ObjectRegistryStore,
  type ObjectRow,
} from '@/drivers/_shared/object-registry';
import { IntegrityError, TransientError, WriteConflictError } from '@/core/errors';

/**
 * The shared object-store registry protocol, proven WITHOUT a cloud.
 *
 * `S3RegistryDriver`, `GcsRegistryDriver` and `AzureBlobRegistryDriver` are each three I/O calls over this
 * one class, which owns everything that is actually hard: the ABA-safe OCC counter, the tombstoning delete,
 * the bounded retry, and the key layout. Those are exercised against real backends in the integration lane —
 * but that lane needs Docker and does not run in `pnpm test`, so a protocol regression could sit unnoticed
 * through every ordinary run.
 *
 * This fake implements the store port with the one property that matters: conditional writes that actually
 * fence. It is deliberately strict — a write whose precondition does not match the current version throws,
 * exactly as S3's 412, GCS's failed `ifGenerationMatch` and Azure's 409/412 do. A fake that accepted the
 * write would make the suite green while testing nothing, which is the failure mode this repo has hit before.
 *
 * **Strictness alone does not prove the fence, though, and that distinction cost us a blocker.** Every
 * sequential case is answered by the in-memory token check in `compareAndSwap` long before the store is
 * asked to fence anything, so this whole file once passed against a deliberately weakened fake that ignored
 * its `expect` argument entirely. `registryConcurrency` below is what closes that: it drives two registries
 * over one store at the same time, where the precondition is the only thing that can decide the winner.
 */
class FakeObjectStore implements ObjectRegistryStore {
  readonly label = 'fake';
  private readonly objects = new Map<string, { bytes: Uint8Array; version: number }>();
  private nextVersion = 1;
  /** Reject this many upcoming writes with a conflict, as a cross-process racer would. */
  conflictWrites = 0;
  /** Reject the next write with this instead — a fault that is NOT a lost race. */
  writeFault: Error | undefined;
  /** Raise {@link ObjectVersionRaced} on this many upcoming reads, as a two-round-trip store does. */
  racedReads = 0;

  /** Put an arbitrary body at an arbitrary key — a corrupt row, an oversized one, a foreign object. */
  plant(key: string, body: string | Uint8Array): void {
    const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : body;
    this.objects.set(key, { bytes, version: this.nextVersion++ });
  }

  /** Remove an object outright, as an operator clearing a corrupt row would. */
  remove(key: string): void {
    this.objects.delete(key);
  }

  read(key: string): Promise<ObjectRow | null> {
    if (this.racedReads > 0) {
      this.racedReads--;
      return Promise.reject(new ObjectVersionRaced(key));
    }
    const found = this.objects.get(key);
    return Promise.resolve(
      found === undefined ? null : { bytes: found.bytes, version: String(found.version) },
    );
  }

  write(key: string, body: Uint8Array, expect: 'absent' | { version: string }): Promise<void> {
    if (this.writeFault !== undefined) {
      const fault = this.writeFault;
      this.writeFault = undefined;
      return Promise.reject(fault);
    }
    if (this.conflictWrites > 0) {
      this.conflictWrites--;
      return Promise.reject(new WriteConflictError(`injected race: ${key}`));
    }
    const found = this.objects.get(key);
    if (expect === 'absent') {
      if (found !== undefined) {
        return Promise.reject(new WriteConflictError(`exists: ${key}`));
      }
    } else if (found === undefined || String(found.version) !== expect.version) {
      return Promise.reject(new WriteConflictError(`version mismatch: ${key}`));
    }
    this.objects.set(key, { bytes: body, version: this.nextVersion++ });
    return Promise.resolve();
  }

  async *listKeys(prefix: string): AsyncIterable<string> {
    for (const key of [...this.objects.keys()].sort()) {
      if (key.startsWith(prefix)) yield key;
    }
  }
}

const ticking = (): (() => number) => {
  let t = 1_000;
  return () => (t += 1);
};

// The same contract every other IRegistryDriver passes — memory, LocalFs, S3, GCS, Azure.
registryConformance(
  'ObjectStoreRegistry (fake object store)',
  () => new ObjectStoreRegistry(new FakeObjectStore(), 'conf', ticking()),
);

// Two registries over ONE store — the only configuration in which the store's precondition, rather than the
// in-process token check, decides who wins.
registryConcurrency('ObjectStoreRegistry (fake object store)', () => {
  const store = new FakeObjectStore();
  return [
    new ObjectStoreRegistry(store, 'conf', ticking()),
    new ObjectStoreRegistry(store, 'conf', ticking()),
  ];
});

describe('ObjectStoreRegistry: reading a row the store is racing', () => {
  const ref = { segment: 's:v1' };

  it('re-reads when the store loses its version pin, rather than reporting the row absent', async () => {
    const store = new FakeObjectStore();
    const reg = new ObjectStoreRegistry(store, undefined, ticking());
    await reg.create(ref, { currentGen: 5 });
    store.racedReads = 3; // three overwrites land mid-read before one gets through
    const got = await reg.get(ref);
    expect(got).not.toBeNull();
    expect(got!.currentGen).toBe(5);
    expect(store.racedReads).toBe(0);
  });

  it('gives up typed, not silently, when every attempt loses the pin', async () => {
    const store = new FakeObjectStore();
    const reg = new ObjectStoreRegistry(store, undefined, ticking());
    await reg.create(ref, { currentGen: 5 });
    store.racedReads = 500; // permanently saturated
    // A TransientError says "retry"; returning null here would say "this segment does not exist".
    await expect(reg.get(ref)).rejects.toBeInstanceOf(TransientError);
  });
});

describe('ObjectStoreRegistry: delete under contention', () => {
  const ref = { segment: 's:v1' };

  it('retries the read→tombstone when it loses the race, and converges', async () => {
    const store = new FakeObjectStore();
    const reg = new ObjectStoreRegistry(store, undefined, ticking());
    await reg.create(ref, { currentGen: 0 });
    store.conflictWrites = 5; // lose five times, then win
    await reg.delete(ref);
    expect(await reg.get(ref)).toBeNull();
    expect(store.conflictWrites).toBe(0);
  });

  it('fails typed rather than looping forever when contention never clears', async () => {
    const store = new FakeObjectStore();
    const reg = new ObjectStoreRegistry(store, undefined, ticking());
    await reg.create(ref, { currentGen: 0 });
    store.conflictWrites = 500;
    await expect(reg.delete(ref)).rejects.toBeInstanceOf(WriteConflictError);
    expect(await reg.get(ref)).not.toBeNull(); // and it did NOT report a false success
  });

  it('propagates a write fault that is not a lost race, instead of retrying it', async () => {
    const store = new FakeObjectStore();
    const reg = new ObjectStoreRegistry(store, undefined, ticking());
    await reg.create(ref, { currentGen: 0 });
    // Retrying an auth failure or a corrupt-object error eight times just delays the report and then
    // mislabels it as contention.
    store.writeFault = new IntegrityError('not a race');
    await expect(reg.delete(ref)).rejects.toBeInstanceOf(IntegrityError);
  });
});

describe('ObjectStoreRegistry: untrusted bytes from the store', () => {
  const ref = { segment: 's:v1' };
  const keyOf = (segment: string): string => `registry/_default/${segment}.reg`;

  it('rejects a row one byte over the cap, and accepts one exactly at it', async () => {
    const store = new FakeObjectStore();
    const reg = new ObjectStoreRegistry(store, undefined, ticking());

    store.plant(keyOf('over'), new Uint8Array(MAX_ROW_BYTES + 1));
    await expect(reg.get({ segment: 'over' })).rejects.toBeInstanceOf(IntegrityError);

    // At the cap the size check must PASS — the row then fails on its content, not its length, which is
    // what proves the boundary is `>` and not `>=`.
    store.plant(keyOf('at'), 'x'.repeat(MAX_ROW_BYTES));
    await expect(reg.get({ segment: 'at' })).rejects.toBeInstanceOf(IntegrityError);
    await expect(reg.get({ segment: 'at' })).rejects.toThrow(/JSON|envelope|parse/i);
  });

  it('refuses a store that returns no version fence', async () => {
    const noFence: ObjectRegistryStore = {
      label: 'no-fence',
      read: async () => ({ bytes: new TextEncoder().encode('{}'), version: '' }),
      write: async () => undefined,
      listKeys: async function* () {},
    };
    const reg = new ObjectStoreRegistry(noFence, undefined, ticking());
    // Without a version there is nothing to compare-and-swap against; such a backend is unusable, and
    // proceeding would silently degrade every OCC guarantee to last-write-wins.
    await expect(reg.get(ref)).rejects.toBeInstanceOf(IntegrityError);
  });

  /**
   * `list()` is **fail-closed** on a corrupt row: one unparseable object under the registry prefix aborts
   * the whole enumeration, for every namespace, until an operator removes it.
   *
   * That is deliberate, and it is the safer of the two options rather than the more convenient one.
   * Skipping the bad row would be friendlier right up to the moment it ran: `list()` is what tells orphan
   * generation collection which segments exist, so a row that silently vanishes from the enumeration makes
   * its storage `.crbm` generations look unreferenced — and the next GC pass would delete them. A parse error
   * would become data loss. Refusing to enumerate at all keeps every sweep off a set it cannot vouch for
   * (invariant 5: bytes from the tier are untrusted), and the error names the offending object key so the
   * operator can inspect and remove it.
   */
  it('list() refuses to enumerate rather than silently skipping a corrupt row', async () => {
    const store = new FakeObjectStore();
    const reg = new ObjectStoreRegistry(store, undefined, ticking());
    await reg.create({ segment: 'good-a' }, { currentGen: 1 });
    await reg.create({ segment: 'good-b' }, { currentGen: 2 });
    store.plant(keyOf('corrupt'), 'not json at all');

    // Addressed directly, the corrupt row is an error — never silently treated as absent.
    await expect(reg.get({ segment: 'corrupt' })).rejects.toBeInstanceOf(IntegrityError);

    // And enumeration fails closed, naming the object an operator has to deal with.
    const drain = async (): Promise<void> => {
      for await (const _rec of reg.list()) void _rec;
    };
    await expect(drain()).rejects.toBeInstanceOf(IntegrityError);
    await expect(drain()).rejects.toThrow(/corrupt\.reg/);

    // Once the bad object is gone, discovery recovers on its own — no other state was damaged.
    store.remove(keyOf('corrupt'));
    const seen: string[] = [];
    for await (const rec of reg.list()) seen.push(rec.segment);
    expect(seen.sort()).toEqual(['good-a', 'good-b']);
  });
});

describe('ObjectStoreRegistry: what the shared protocol guarantees', () => {
  const build = (): ObjectStoreRegistry =>
    new ObjectStoreRegistry(new FakeObjectStore(), undefined, ticking());

  it('never re-issues a token across delete-and-recreate (ABA safety)', async () => {
    // The reason `delete` tombstones instead of removing. If a recreate restarted the counter at 0, a stale
    // holder of the old token could win a compare-and-swap against a segment that is no longer the one it
    // read — which is invariant 1's "identity is the token, never the generation number".
    const reg = build();
    const ref = { segment: 'reused' };
    const first = await reg.create(ref, { currentGen: null });
    await reg.delete(ref);
    const second = await reg.create(ref, { currentGen: null });
    expect(Number(second.token)).toBeGreaterThan(Number(first.token));
  });

  it('refuses a compare-and-swap carrying the pre-delete token', async () => {
    const reg = build();
    const ref = { segment: 'fenced' };
    const stale = (await reg.create(ref, { currentGen: null })).token;
    await reg.delete(ref);
    await reg.create(ref, { currentGen: null });
    await expect(reg.compareAndSwap(ref, stale, { currentGen: 7 })).rejects.toBeInstanceOf(
      WriteConflictError,
    );
  });

  it('treats a tombstoned row as absent for get and list, and delete stays idempotent', async () => {
    const reg = build();
    const ref = { segment: 'gone' };
    await reg.create(ref, { currentGen: null });
    await reg.delete(ref);
    await reg.delete(ref); // idempotent — must not throw
    expect(await reg.get(ref)).toBeNull();
    const listed = [];
    for await (const row of reg.list()) listed.push(row.segment);
    expect(listed).not.toContain('gone');
  });

  it('enumerates across more rows than one read page, and scopes by namespace', async () => {
    // `list()` reads in bounded parallel pages; fewer rows than the page size would never exercise the
    // boundary, so go past it deliberately.
    const reg = build();
    for (let i = 0; i < 40; i++) await reg.create({ segment: `s${i}` }, { currentGen: null });
    await reg.create({ segment: 'other', namespace: 'ns' }, { currentGen: null });
    const all = [];
    for await (const row of reg.list()) all.push(row.segment);
    expect(all).toHaveLength(41);
    const scoped = [];
    for await (const row of reg.list('ns')) scoped.push(row.segment);
    expect(scoped).toEqual(['other']);
  });

  it('ignores a foreign object sitting under the registry prefix', async () => {
    // A stray file in the bucket must not be reported as a segment, and must not break enumeration.
    const store = new FakeObjectStore();
    const reg = new ObjectStoreRegistry(store, undefined, ticking());
    await reg.create({ segment: 'real' }, { currentGen: null });
    await store.write('registry/_default/not-a-row.txt', new TextEncoder().encode('{}'), 'absent');
    const listed = [];
    for await (const row of reg.list()) listed.push(row.segment);
    expect(listed).toEqual(['real']);
  });
});
