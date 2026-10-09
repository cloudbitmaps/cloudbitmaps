/**
 * `pointerId` over random write sequences, against every kind of shipped registry: the in-memory one, the local-file one
 * and the object-store one every cloud registry is built on. After each step, the row's `pointerId` changed exactly
 * when the write was a create or named a resolved field, and then it is the token that write returned; and no value
 * ever repeats across the run, across deletes and re-creates. Invariant 2: a generation is identified by its number with
 * the row's `pointerId`, so a value that came back would let a cache take one resolution for another.
 */
import fc from 'fast-check';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WriteConflictError } from '@/core/errors';
import type { IRegistryDriver, RegistryPatch, RegistryRecord, SegmentRef } from '@/core/ports';
import { RESOLVED_FIELDS } from '@/core/pointer-id';
import { MemoryRegistryDriver } from '@/drivers/memory';
import { LocalFsRegistryDriver } from '@/drivers/localfs/registry';
import {
  ObjectStoreRegistry,
  type ObjectRegistryStore,
  type ObjectRow,
} from '@/drivers/_shared/object-registry';

const REF: SegmentRef = { namespace: 'n', segment: 's' };

/** An object store with conditional writes and, when asked, a conditional delete. */
class MapStore implements ObjectRegistryStore {
  readonly label = 'map';
  private readonly objects = new Map<string, { bytes: Uint8Array; version: number }>();
  private next = 1;
  constructor(readonly conditionalDelete: boolean) {}
  async read(key: string): Promise<ObjectRow | null> {
    const o = this.objects.get(key);
    return o === undefined ? null : { bytes: o.bytes, version: String(o.version) };
  }
  async write(
    key: string,
    body: Uint8Array,
    expect: 'absent' | { version: string },
  ): Promise<void> {
    const o = this.objects.get(key);
    const ok =
      expect === 'absent'
        ? o === undefined
        : o !== undefined && String(o.version) === expect.version;
    if (!ok) throw new WriteConflictError('precondition');
    this.objects.set(key, { bytes: body, version: this.next++ });
  }
  async *listKeys(prefix: string): AsyncIterable<string> {
    for (const k of this.objects.keys()) if (k.startsWith(prefix)) yield k;
  }
  async delete(key: string, expect: { version: string }): Promise<void> {
    const o = this.objects.get(key);
    if (o === undefined || String(o.version) !== expect.version)
      throw new WriteConflictError('precondition');
    this.objects.delete(key);
  }
}

type Op =
  | { readonly kind: 'patch'; readonly fields: readonly string[]; readonly stale: boolean }
  | { readonly kind: 'recreate' };

const PATCHABLE = [...RESOLVED_FIELDS, 'leases', 'retention', 'residency', 'keptGens'] as const;

/** A patch naming `fields`, each at a value valid against `row`. */
function patchOf(row: RegistryRecord, fields: readonly string[], step: number): RegistryPatch {
  const patch: Record<string, unknown> = {};
  const pointer = row.currentGen;
  for (const f of fields) {
    switch (f) {
      case 'currentGen':
        patch.currentGen = step % 3 === 0 ? pointer : (pointer ?? 0) + 1;
        break;
      case 'status':
        patch.status = 'active';
        break;
      case 'wrappedDeks':
        patch.wrappedDeks = undefined;
        break;
      case 'keyId':
        patch.keyId = `k${step}`;
        break;
      case 'summary':
        patch.summary = undefined;
        break;
      case 'leases':
        patch.leases = undefined;
        break;
      case 'retention':
        patch.retention = { note: `r${step}` };
        break;
      case 'residency':
        patch.residency = { note: `d${step}` };
        break;
      case 'keptGens':
        patch.keptGens = undefined;
        break;
    }
  }
  return patch as RegistryPatch;
}

async function run(driver: IRegistryDriver, ops: readonly Op[]): Promise<void> {
  const seen = new Set<string>();
  let { token } = await driver.create(REF, { currentGen: 0 });
  let row = (await driver.get(REF))!;
  expect(row.pointerId).toBe(token);
  seen.add(row.pointerId);
  let step = 0;
  for (const op of ops) {
    step += 1;
    if (op.kind === 'recreate') {
      await driver.delete(REF, row.token);
      ({ token } = await driver.create(REF, { currentGen: null }));
      row = (await driver.get(REF))!;
      expect(row.pointerId).toBe(token);
      expect(seen.has(row.pointerId), 'a re-created row reuses no pointerId').toBe(false);
      seen.add(row.pointerId);
      continue;
    }
    const before = row;
    const patch = patchOf(before, op.fields, step);
    if (op.stale) {
      // A lost swap changes nothing, the pointerId included.
      await expect(
        driver.compareAndSwap(REF, `${before.token.slice(0, -1)}x`, patch),
      ).rejects.toBeInstanceOf(WriteConflictError);
      expect(await driver.get(REF)).toEqual(before);
      continue;
    }
    ({ token } = await driver.compareAndSwap(REF, before.token, patch));
    row = (await driver.get(REF))!;
    const renews = op.fields.some((f) => (RESOLVED_FIELDS as readonly string[]).includes(f));
    if (renews) {
      expect(row.pointerId).toBe(token);
      expect(seen.has(row.pointerId), 'a renewal is a value never seen before').toBe(false);
      seen.add(row.pointerId);
    } else {
      expect(row.pointerId).toBe(before.pointerId);
    }
    expect(row.token).toBe(token);
  }
}

const opArb: fc.Arbitrary<Op> = fc.oneof(
  {
    weight: 8,
    arbitrary: fc.record({
      kind: fc.constant('patch' as const),
      fields: fc.subarray([...PATCHABLE]),
      stale: fc.integer({ min: 0, max: 4 }).map((n) => n === 0),
    }),
  },
  { weight: 1, arbitrary: fc.constant({ kind: 'recreate' as const }) },
);

let root: string;
let dirs = 0;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'pointer-id-prop-'));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const DRIVERS: ReadonlyArray<readonly [string, () => IRegistryDriver]> = [
  ['memory', () => new MemoryRegistryDriver()],
  ['local files', () => new LocalFsRegistryDriver(join(root, `d${dirs++}`))],
  [
    'object store, tombstoning deletes',
    () => new ObjectStoreRegistry(new MapStore(false), 'p', Date.now),
  ],
  [
    'object store, conditional deletes',
    () => new ObjectStoreRegistry(new MapStore(true), 'p', Date.now),
  ],
];

describe('pointerId over random write sequences (invariant 2)', () => {
  it.each(DRIVERS)(
    '%s: renewed exactly by a create or a resolved field, never repeated',
    async (_, make) => {
      await fc.assert(
        fc.asyncProperty(fc.array(opArb, { minLength: 1, maxLength: 24 }), async (ops) => {
          await run(make(), ops);
        }),
        { numRuns: 40 },
      );
    },
  );
});
