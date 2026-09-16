import { registryConformance } from '@/testing/conformance';
import {
  ObjectStoreRegistry,
  type ObjectRegistryStore,
  type ObjectRow,
} from '@/drivers/_shared/object-registry';
import { WriteConflictError } from '@/core/errors';

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
 */
class FakeObjectStore implements ObjectRegistryStore {
  readonly label = 'fake';
  private readonly objects = new Map<string, { bytes: Uint8Array; version: number }>();
  private nextVersion = 1;

  read(key: string): Promise<ObjectRow | null> {
    const found = this.objects.get(key);
    return Promise.resolve(
      found === undefined ? null : { bytes: found.bytes, version: String(found.version) },
    );
  }

  write(key: string, body: Uint8Array, expect: 'absent' | { version: string }): Promise<void> {
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

// The same contract every other IRegistryDriver passes — memory, LocalFs, S3, GCS, Azure, DynamoDB.
registryConformance(
  'ObjectStoreRegistry (fake object store)',
  () => new ObjectStoreRegistry(new FakeObjectStore(), 'conf', ticking()),
);

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
