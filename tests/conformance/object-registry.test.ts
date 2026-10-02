import {
  registryConformance,
  registryConcurrency,
  registryDeleteConformance,
} from '@/testing/conformance';
import {
  MAX_ROW_BYTES,
  ObjectStoreRegistry,
  ObjectVersionRaced,
  type ObjectRegistryStore,
  type ObjectRow,
} from '@/drivers/_shared/object-registry';
import { IntegrityError, TransientError, WriteConflictError } from '@/core/errors';
import type { SegmentRef } from '@/core/ports';
import { registryObjectKey } from '@/drivers/_shared/object-registry-keys';
import { tokenAfter, tokenParts } from '../helpers/tokens';

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
 * write would make the suite green while testing nothing.
 *
 * **Strictness alone does not prove the fence, though.** Every sequential case is answered by the in-memory
 * token check in `compareAndSwap` long before the store is asked to fence anything, so the sequential cases
 * pass even against a deliberately weakened fake that ignores its `expect` argument entirely.
 * `registryConcurrency` below is what closes that: it drives two registries over one store at the same time,
 * where the precondition is the only thing that can decide the winner.
 */
class FakeObjectStore implements ObjectRegistryStore {
  readonly label = 'fake';
  private readonly objects = new Map<string, { bytes: Uint8Array; version: number }>();
  private nextVersion = 1;
  /**
   * Whether the registry may rely on {@link delete}. Off by default, like a store that cannot vouch for its
   * backend's precondition: the registry then tombstones, and never calls `delete`.
   */
  readonly conditionalDelete: boolean;
  /** Conditional deletes the registry sent. */
  deletes = 0;
  /** Run just before the next conditional delete is applied: another writer landing between its read and it. */
  beforeDelete: (() => Promise<void>) | undefined;
  /** Reject the next conditional delete with this, applying nothing. */
  deleteFault: Error | undefined;
  /** Apply the next conditional delete, then fail it with this: a delete that lands and loses its response. */
  landThenFailDelete: Error | undefined;

  constructor(options: { conditionalDelete?: boolean } = {}) {
    this.conditionalDelete = options.conditionalDelete === true;
  }

  /** Whether an object is stored at `key`, a tombstone included. */
  has(key: string): boolean {
    return this.objects.has(key);
  }
  /** Reject this many upcoming writes with a conflict, as a cross-process racer would. */
  conflictWrites = 0;
  /** Reject the next write with this instead — a fault that is NOT a lost race. */
  writeFault: Error | undefined;
  /** Apply the next write, then fail it with this: a write that lands and loses its response. */
  landThenFail: Error | undefined;
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
    if (this.landThenFail !== undefined) {
      const fault = this.landThenFail;
      this.landThenFail = undefined;
      return Promise.reject(fault);
    }
    return Promise.resolve();
  }

  async *listKeys(prefix: string): AsyncIterable<string> {
    for (const key of [...this.objects.keys()].sort()) {
      if (key.startsWith(prefix)) yield key;
    }
  }

  /** Delete `key` only while it is still at `expect.version`; a gone or overwritten object is a conflict. */
  async delete(key: string, expect: { version: string }): Promise<void> {
    this.deletes++;
    const hook = this.beforeDelete;
    this.beforeDelete = undefined;
    if (hook !== undefined) await hook();
    if (this.deleteFault !== undefined) {
      const fault = this.deleteFault;
      this.deleteFault = undefined;
      throw fault;
    }
    const found = this.objects.get(key);
    if (found === undefined || String(found.version) !== expect.version) {
      throw new WriteConflictError(`version mismatch on delete: ${key}`);
    }
    this.objects.delete(key);
    if (this.landThenFailDelete !== undefined) {
      const fault = this.landThenFailDelete;
      this.landThenFailDelete = undefined;
      throw fault;
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

// The same, over a store whose conditional delete the registry relies on: a delete then removes the row for good.
registryConformance(
  'ObjectStoreRegistry (fake object store, conditional delete)',
  () =>
    new ObjectStoreRegistry(new FakeObjectStore({ conditionalDelete: true }), 'conf', ticking()),
);
registryConcurrency('ObjectStoreRegistry (fake object store, conditional delete)', () => {
  const store = new FakeObjectStore({ conditionalDelete: true });
  return [
    new ObjectStoreRegistry(store, 'conf', ticking()),
    new ObjectStoreRegistry(store, 'conf', ticking()),
  ];
});

/** A delete-conformance harness over a fake store, its rows planted and probed at the key the registry uses. */
function deleteHarness(conditionalDelete: boolean) {
  const store = new FakeObjectStore({ conditionalDelete });
  return {
    driver: new ObjectStoreRegistry(store, 'conf', ticking()),
    stored: async (ref: SegmentRef) => store.has(registryObjectKey('conf', ref)),
    plantRow: async (ref: SegmentRef, text: string) =>
      store.plant(registryObjectKey('conf', ref), text),
  };
}
registryDeleteConformance('ObjectStoreRegistry (fake object store, conditional delete)', () =>
  deleteHarness(true),
);
registryDeleteConformance('ObjectStoreRegistry (fake object store, no conditional delete)', () =>
  deleteHarness(false),
);

// A write that LANDS and then fails is the one fault a registry can misreport in either direction: as a clean
// failure (the caller believes nothing happened) or, on a replay, as a conflict against its own row. The registry
// must pass the fault through untouched and never retry it, so the caller learns "unknown, check" and the row says
// what actually happened.
describe('ObjectStoreRegistry: a write that lands and then fails', () => {
  const ref = { segment: 's:v1' };
  const lost = (): TransientError => new TransientError('connection reset after the write');
  const fresh = (): { store: FakeObjectStore; reg: ObjectStoreRegistry } => {
    const store = new FakeObjectStore();
    return { store, reg: new ObjectStoreRegistry(store, undefined, ticking()) };
  };

  it('a create reports the fault, not a conflict, and the row is there', async () => {
    const { store, reg } = fresh();
    store.landThenFail = lost();
    await expect(reg.create(ref, { currentGen: 0 })).rejects.toBeInstanceOf(TransientError);
    expect((await reg.get(ref))?.currentGen).toBe(0);
    // The registry did not send it again: the replay is the caller's, and it is told the truth.
    await expect(reg.create(ref, { currentGen: 0 })).rejects.toBeInstanceOf(WriteConflictError);
  });

  it('a compare-and-swap reports the fault once and the swap is applied exactly once', async () => {
    const { store, reg } = fresh();
    const { token } = await reg.create(ref, { currentGen: 0 });
    store.landThenFail = lost();
    await expect(reg.compareAndSwap(ref, token, { currentGen: 1 })).rejects.toBeInstanceOf(
      TransientError,
    );
    const after = await reg.get(ref);
    expect(after?.currentGen).toBe(1);
    expect(after?.token).toMatch(tokenAfter(token)); // advanced once, not twice
    await expect(reg.compareAndSwap(ref, token, { currentGen: 2 })).rejects.toBeInstanceOf(
      WriteConflictError,
    );
  });

  it('a fenced delete reports the fault and the tombstone is written once', async () => {
    const { store, reg } = fresh();
    const { token } = await reg.create(ref, { currentGen: 0 });
    store.landThenFail = lost();
    await expect(reg.delete(ref, token)).rejects.toBeInstanceOf(TransientError);
    expect(await reg.get(ref)).toBeNull();
    // Re-creating proves the tombstone advanced the counter once: token 0 -> tombstone 1 -> recreate 2, under a
    // new incarnation.
    const recreated = (await reg.create(ref, { currentGen: 0 })).token;
    expect(tokenParts(recreated).counter).toBe(2);
    expect(tokenParts(recreated).incarnation).not.toBe(tokenParts(token).incarnation);
  });
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
    // A new incarnation, and a counter carried on past the tombstone's: apart by the id and by construction.
    expect(tokenParts(second.token).incarnation).not.toBe(tokenParts(first.token).incarnation);
    expect(tokenParts(second.token).counter).toBe(tokenParts(first.token).counter + 2);
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

/**
 * A delete that removes the row for good. Its safety rests on one property: it removes only the version it read and
 * judged. A write landing between the read and the delete must make the delete fail, so these cases put one there,
 * through a second registry over the same store, and only the store's precondition can stop the delete.
 */
describe('ObjectStoreRegistry: removing a row for good', () => {
  const ref = { segment: 's:v1' };
  const key = registryObjectKey('conf', ref);
  const pair = (): { store: FakeObjectStore; a: ObjectStoreRegistry; b: ObjectStoreRegistry } => {
    const store = new FakeObjectStore({ conditionalDelete: true });
    return {
      store,
      a: new ObjectStoreRegistry(store, 'conf', ticking()),
      b: new ObjectStoreRegistry(store, 'conf', ticking()),
    };
  };

  it('reports it in its capabilities, and only when the store vouches for its delete', () => {
    expect(pair().a.capabilities()).toEqual({ strongRead: true, conditionalDelete: true });
    const off = new ObjectStoreRegistry(new FakeObjectStore(), 'conf', ticking());
    expect(off.capabilities()).toEqual({ strongRead: true, conditionalDelete: false });
    // A store with a conditional delete but no say-so is not relied on.
    const unvouched: ObjectRegistryStore = {
      label: 'unvouched',
      read: async () => null,
      write: async () => undefined,
      listKeys: async function* () {},
      delete: async () => undefined,
    };
    expect(new ObjectStoreRegistry(unvouched, 'conf', ticking()).capabilities()).toEqual({
      strongRead: true,
      conditionalDelete: false,
    });
  });

  it('a write between its read and its delete fails the delete, and the written row survives', async () => {
    const { store, a, b } = pair();
    const { token } = await a.create(ref, { currentGen: 0, status: 'destroyed' });
    let swapped = '';
    store.beforeDelete = async () => {
      swapped = (await b.compareAndSwap(ref, token, { currentGen: 1 })).token;
    };
    await expect(a.delete(ref, token)).rejects.toBeInstanceOf(WriteConflictError);
    expect(store.has(key)).toBe(true);
    expect(await a.get(ref)).toMatchObject({ currentGen: 1, token: swapped });
  });

  it('a purge and re-create between its read and its delete leave the new incarnation', async () => {
    const { store, a, b } = pair();
    const { token } = await a.create(ref, { currentGen: 3, status: 'destroyed' });
    let reborn = '';
    store.beforeDelete = async () => {
      await b.delete(ref, token); // another sweeper purges it first …
      reborn = (await b.create(ref, { currentGen: 0 })).token; // … and the name is created again
    };
    await expect(a.delete(ref, token)).rejects.toBeInstanceOf(WriteConflictError);
    const live = await a.get(ref);
    expect(live).toMatchObject({ currentGen: 0, status: 'active', token: reborn });
    expect(tokenParts(reborn).incarnation).not.toBe(tokenParts(token).incarnation);
  });

  it('an unfenced delete that meets a write re-reads, and removes the row as it now is', async () => {
    const { store, a, b } = pair();
    const { token } = await a.create(ref, { currentGen: 0 });
    store.beforeDelete = async () => {
      await b.compareAndSwap(ref, token, { currentGen: 1 });
    };
    await a.delete(ref); // unfenced: takes whatever row it finds, as it always has
    expect(store.has(key)).toBe(false);
    expect(store.deletes).toBe(2);
  });

  it('two sweepers fenced on one token: one removes the row, the other is refused', async () => {
    const { store, a, b } = pair();
    const { token } = await a.create(ref, { currentGen: 0, status: 'destroyed' });
    store.beforeDelete = async () => {
      await b.delete(ref, token);
    };
    await expect(a.delete(ref, token)).rejects.toBeInstanceOf(WriteConflictError);
    expect(store.has(key)).toBe(false);
  });

  it('a delete that lands and loses its response reports the fault, and is not sent again', async () => {
    const { store, a } = pair();
    const { token } = await a.create(ref, { currentGen: 0 });
    store.landThenFailDelete = new TransientError('connection reset after the delete');
    await expect(a.delete(ref, token)).rejects.toBeInstanceOf(TransientError);
    expect(store.deletes).toBe(1);
    expect(store.has(key)).toBe(false);
  });

  it('a delete fault that is not a lost race reaches the caller, and the row stays', async () => {
    const { store, a } = pair();
    const { token } = await a.create(ref, { currentGen: 0 });
    store.deleteFault = new IntegrityError('not a race');
    await expect(a.delete(ref, token)).rejects.toBeInstanceOf(IntegrityError);
    expect(await a.get(ref)).toMatchObject({ token });
  });

  it('gives up typed when every delete meets another write', async () => {
    const { store, a, b } = pair();
    await a.create(ref, { currentGen: 0 });
    let n = 0;
    const churn = async (): Promise<void> => {
      const row = await b.get(ref);
      await b.compareAndSwap(ref, row!.token, { currentGen: ++n });
      store.beforeDelete = churn; // and again before the next attempt
    };
    store.beforeDelete = churn;
    await expect(a.delete(ref)).rejects.toBeInstanceOf(WriteConflictError);
    expect(await a.get(ref)).not.toBeNull();
  });

  it('a store that cannot vouch for its delete is never asked to delete: the row is tombstoned', async () => {
    const store = new FakeObjectStore();
    const reg = new ObjectStoreRegistry(store, 'conf', ticking());
    const { token } = await reg.create(ref, { currentGen: 0 });
    await reg.delete(ref, token);
    expect(store.deletes).toBe(0);
    expect(store.has(key)).toBe(true);
    expect(await reg.get(ref)).toBeNull();
  });

  it('a row born before 0.12 is tombstoned even when the store vouches for its delete', async () => {
    const { store, a } = pair();
    store.plant(
      key,
      '{"schemaVersion":1,"deleted":false,"record":{"segment":"s:v1","currentGen":2,"status":"destroyed",' +
        '"createdAt":10,"updatedAt":20,"token":"7"}}',
    );
    await a.delete(ref, '7');
    expect(store.deletes).toBe(0);
    expect(store.has(key)).toBe(true);
    // A re-create over that tombstone carries the counter on, as it always has.
    expect(tokenParts((await a.create(ref, { currentGen: null })).token).counter).toBe(9);
  });

  it('a name removed and created again starts a new incarnation at counter 0', async () => {
    const { a } = pair();
    const { token } = await a.create(ref, { currentGen: null });
    await a.delete(ref, token);
    const { token: again } = await a.create(ref, { currentGen: null });
    expect(tokenParts(again).counter).toBe(0);
    expect(tokenParts(again).incarnation).not.toBe(tokenParts(token).incarnation);
    await expect(a.compareAndSwap(ref, token, { currentGen: 1 })).rejects.toBeInstanceOf(
      WriteConflictError,
    );
  });
});
