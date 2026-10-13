import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RecordingAuditSink } from '@/core/audit';
import { eraseIdFromSegment } from '@/core/erase-id';
import { TransientError, WriteConflictError } from '@/core/errors';
import { loadSegment, type LoadResult } from '@/core/load';
import type { IRegistryDriver, IStorageDriver, RegistryRecord, SegmentRef } from '@/core/ports';
import { setSegmentRetention } from '@/core/retention';
import { rollbackSegment } from '@/core/rollback';
import { ObjectStoreRegistry } from '@/drivers/_shared/object-registry';
import type { ObjectRegistryStore, ObjectRow } from '@/drivers/_shared/object-registry';
import { LocalFsRegistryDriver } from '@/drivers/localfs/registry';
import { MemoryRegistryDriver, MemoryStorageDriver } from '@/drivers/memory';
import { roaringCodec } from '@/roaring-codec';
import { CloudRoaring, MemoryStorage } from '@/index';
import { brandAsBackend } from '@/core/ports';
import { bulkLoadCrbmGeneration } from '../helpers/bulk-load';
import { withoutTokenReports } from '../helpers/no-token-reports';
import { publishGeneration } from '../helpers/publish';

/**
 * Who published after a conflict or an unanswered write: a registry that reports each write's token before it sends
 * it lets a publish say whether the row's pointer is over its own write, which a footer of the object cannot (it names
 * bytes, and a load of the same ids at the same number writes the same bytes). A load that did not publish says so, audits
 * no publish, and deletes nothing the row names; an erasure's rewrite the same.
 *
 * Every case is a deterministic interleaving: a write is held at the registry, other writers run, and it is released.
 * Each runs over the three registries that report tokens.
 */

const REF: SegmentRef = { segment: 's' };
const clock = { now: () => 1_800_000_000_000, sleep: () => Promise.resolve() };

/** A bare object store with conditional writes, for the shared registry. */
class MapStore implements ObjectRegistryStore {
  readonly label = 'map';
  readonly conditionalDelete = true;
  private readonly objects = new Map<string, { bytes: Uint8Array; version: number }>();
  private next = 1;
  /** Runs after each write is applied and before it answers; its result decides how it answers. */
  afterWrite: (() => Promise<'conflict' | undefined>) | undefined;

  read(key: string): Promise<ObjectRow | null> {
    const found = this.objects.get(key);
    return Promise.resolve(
      found === undefined ? null : { bytes: found.bytes, version: String(found.version) },
    );
  }

  async write(
    key: string,
    body: Uint8Array,
    expect: 'absent' | { version: string },
  ): Promise<void> {
    const found = this.objects.get(key);
    if (expect === 'absent' ? found !== undefined : String(found?.version) !== expect.version) {
      throw new WriteConflictError(`lost: ${key}`);
    }
    this.objects.set(key, { bytes: body, version: this.next++ });
    const hook = this.afterWrite;
    this.afterWrite = undefined;
    if ((await hook?.()) === 'conflict') throw new WriteConflictError(`replay met itself: ${key}`);
  }

  async *listKeys(prefix: string): AsyncIterable<string> {
    for (const key of [...this.objects.keys()].sort()) if (key.startsWith(prefix)) yield key;
  }

  async delete(key: string, expect: { version: string }): Promise<void> {
    if (String(this.objects.get(key)?.version) !== expect.version)
      throw new WriteConflictError(key);
    this.objects.delete(key);
  }
}

interface Kit {
  readonly registry: IRegistryDriver;
  readonly store?: MapStore;
  done(): Promise<void>;
}

const REGISTRIES: ReadonlyArray<readonly [string, () => Promise<Kit>]> = [
  ['memory', async () => ({ registry: new MemoryRegistryDriver(), done: async () => {} })],
  [
    'local files',
    async () => {
      const dir = await mkdtemp(join(tmpdir(), 'crbm-token-'));
      return {
        registry: new LocalFsRegistryDriver(dir),
        done: () => rm(dir, { recursive: true, force: true }),
      };
    },
  ],
  [
    'shared object store',
    async () => {
      const store = new MapStore();
      return {
        registry: new ObjectStoreRegistry(store, 'p', () => 1_000),
        store,
        done: async () => {},
      };
    },
  ],
];

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((r) => (open = r));
  let reach!: () => void;
  const reached = new Promise<void>((r) => (reach = r));
  return { open, opened, reach, reached };
}
type Gate = ReturnType<typeof gate>;

async function gens(storage: IStorageDriver): Promise<number[]> {
  const out: number[] = [];
  for await (const k of storage.list(REF)) out.push(k.generation);
  return out.sort((a, b) => a - b);
}

/** The generations a row names below its pointer. */
function windowBelow(row: RegistryRecord | null): number[] {
  if (row === null || row.currentGen === null) return [];
  return (row.knownGens ?? []).map((e) => e.generation).filter((g) => g < row.currentGen!);
}

type Mode = 'send' | 'transient' | 'landThenConflict';

/**
 * `registry`, whose first create or compare-and-swap naming `currentGen: gen` waits at `g` before it is sent. Then:
 * `send` sends it; `transient` throws `TransientError` and never sends it; `landThenConflict` sends it, runs `between`,
 * and throws `WriteConflictError`, as a replay that met its own landed write does. It forwards `options`, and inherits
 * the flag from `registry`. It wraps with `Object.create`, so it suits registries whose methods read no `#private`
 * field.
 */
function holdWrite(
  registry: IRegistryDriver,
  gen: number,
  g: Gate,
  mode: Mode = 'send',
  between?: () => Promise<void>,
): IRegistryDriver {
  const held = Object.create(registry) as IRegistryDriver;
  let done = false;
  const wrap = async <T>(names: number | null | undefined, send: () => Promise<T>): Promise<T> => {
    if (done || names !== gen) return send();
    done = true;
    g.reach();
    await g.opened;
    if (mode === 'transient') throw new TransientError('no answer, and never sent');
    const out = await send();
    if (mode === 'landThenConflict') {
      await between?.();
      throw new WriteConflictError('a replay met its own landed write');
    }
    return out;
  };
  held.create = (ref, rec, options) =>
    wrap(rec.currentGen, () => registry.create(ref, rec, options));
  held.compareAndSwap = (ref, token, patch, options) =>
    wrap('currentGen' in patch ? patch.currentGen : undefined, () =>
      registry.compareAndSwap(ref, token, patch, options),
    );
  return held;
}

const kinds = (a: RecordingAuditSink): string[] => a.snapshot().map((e) => e.kind);
const outcome = (r: LoadResult) => ({ published: r.published, reason: r.reason });

describe.each(REGISTRIES)('a write token settles who published: %s registry', (_name, make) => {
  let kit: Kit;
  let storage: MemoryStorageDriver;
  let registry: IRegistryDriver;
  let deps: {
    storage: IStorageDriver;
    registry: IRegistryDriver;
    codec: typeof roaringCodec;
    clock: typeof clock;
  };
  beforeEach(async () => {
    kit = await make();
    storage = new MemoryStorageDriver();
    registry = kit.registry;
    deps = { storage, registry, codec: roaringCodec, clock };
  });
  afterEach(() => kit.done());

  it('declares that it reports write tokens', () => {
    expect(registry.reportsWriteTokens).toBe(true);
  });

  /** After B's refusal: the generations C's row names are all still in the bucket, and the pointer is on an object. */
  async function expectNothingOfCDeleted(windowAfterC: number[], bucketAfterC: number[]) {
    const bucket = await gens(storage);
    for (const g of windowAfterC) expect(bucket, `generation ${g}`).toContain(g);
    expect(bucket.filter((g) => bucketAfterC.includes(g))).toEqual(bucketAfterC);
    const row = (await registry.get(REF))!;
    expect(bucket).toContain(row.currentGen);
  }

  describe.each([true, false])('create conflict, guarded: %s', (guarded) => {
    for (const kB of [0, 1, 2]) {
      for (const kC of [0, 1, 2]) {
        it(`B's create meets another load's row: B is superseded, C alone publishes (keep ${kB}, ${kC})`, async () => {
          // P's create is held; B finds no row, numbers 1 by listing, and its create is held; P creates the row at 0; an
          // eager erasure of 8 deletes B's object 1 above the pointer and renews; C loads the same ids, so the same bytes,
          // under 1 and publishes; B's create then meets the row.
          const pGate = gate();
          const p = loadSegment(
            REF,
            [9],
            { ...deps, registry: holdWrite(registry, 0, pGate) },
            { allowEmpty: true },
          );
          await pGate.reached;
          const bGate = gate();
          const bAudit = new RecordingAuditSink();
          const b = loadSegment(
            REF,
            [4, 8],
            { ...deps, registry: holdWrite(registry, 1, bGate) },
            {
              keep: kB,
              audit: bAudit,
              ...(guarded ? {} : { allowEmpty: true }),
            },
          );
          await bGate.reached;
          pGate.open();
          await p;
          await eraseIdFromSegment(REF, 8, deps);
          const cAudit = new RecordingAuditSink();
          expect(
            await loadSegment(REF, [4, 8], deps, { allowEmpty: true, keep: kC, audit: cAudit }),
          ).toMatchObject({ generation: 1, published: true });
          const windowAfterC = windowBelow(await registry.get(REF));
          const bucketAfterC = await gens(storage);
          bGate.open();
          expect(outcome(await b)).toEqual({ published: false, reason: 'superseded' });
          expect(kinds(bAudit)).toEqual(['segment.load-refused']);
          expect(kinds(cAudit)).toEqual(['segment.publish']);
          await expectNothingOfCDeleted(windowAfterC, bucketAfterC);
          // The generation C's keep window names can still be rolled back onto.
          for (const g of windowAfterC) {
            await expect(rollbackSegment(REF, g, deps)).resolves.toMatchObject({ generation: g });
            await rollbackSegment(REF, 1, deps);
          }
        });
      }
    }
  });

  describe.each(['send', 'transient'] as const)("compare-and-swap: B's write is %s", (mode) => {
    for (const kB of [0, 1, 2]) {
      for (const kC of [0, 1, 2]) {
        it(`B meets another load's write at its number: B is superseded, C alone publishes (keep ${kB}, ${kC})`, async () => {
          await loadSegment(REF, [9], deps, { allowEmpty: true });
          const bGate = gate();
          const bAudit = new RecordingAuditSink();
          const b = loadSegment(
            REF,
            [4, 8],
            { ...deps, registry: holdWrite(registry, 1, bGate, mode) },
            {
              allowEmpty: true,
              keep: kB,
              audit: bAudit,
            },
          );
          await bGate.reached;
          await eraseIdFromSegment(REF, 8, deps);
          const cAudit = new RecordingAuditSink();
          await loadSegment(REF, [4, 8], deps, { allowEmpty: true, keep: kC, audit: cAudit });
          const windowAfterC = windowBelow(await registry.get(REF));
          const bucketAfterC = await gens(storage);
          bGate.open();
          expect(outcome(await b)).toEqual({ published: false, reason: 'superseded' });
          expect(kinds(bAudit)).toEqual(['segment.load-refused']);
          expect(kinds(cAudit)).toEqual(['segment.publish']);
          await expectNothingOfCDeleted(windowAfterC, bucketAfterC);
        });
      }
    }
  });

  describe('an erasure rewrite that another load overtook', () => {
    for (const kL2 of [1, 2]) {
      it(`E1's compare-and-swap meets the row L2 made: nothing is erased, reported or audited (keep ${kL2})`, async () => {
        const X = 42;
        const Y = 7;
        await loadSegment(REF, [1, 2, X, Y], deps, { allowEmpty: true, keep: 1 });
        const l1Gate = gate();
        const l1 = loadSegment(
          REF,
          [5, 6],
          { ...deps, registry: holdWrite(registry, 1, l1Gate) },
          {
            allowEmpty: true,
            keep: 1,
          },
        );
        await l1Gate.reached;
        const e1Gate = gate();
        const e1Audit = new RecordingAuditSink();
        const e1 = eraseIdFromSegment(
          REF,
          X,
          { ...deps, registry: holdWrite(registry, 2, e1Gate) },
          {
            audit: e1Audit,
          },
        );
        await e1Gate.reached;
        l1Gate.open();
        await l1;
        expect(await eraseIdFromSegment(REF, Y, deps)).toMatchObject({ erased: true });
        await loadSegment(REF, [1, 2, Y], deps, { allowEmpty: true, keep: kL2 });
        const windowAfterL2 = windowBelow(await registry.get(REF));
        const bucketAfterL2 = await gens(storage);
        e1Gate.open();
        expect(await e1).toMatchObject({ erased: false, reason: 'superseded' });
        expect(kinds(e1Audit)).not.toContain('segment.rewrite');
        await expectNothingOfCDeleted(windowAfterL2, bucketAfterL2);
        await expect(rollbackSegment(REF, 1, deps)).resolves.toMatchObject({ generation: 1 });
      });
    }
  });

  describe('a write of its own that landed and was then reported as a conflict is still published', () => {
    it('a replay that met its own landed write', async () => {
      await loadSegment(REF, [9], deps, { allowEmpty: true });
      const g = gate();
      const audit = new RecordingAuditSink();
      const b = loadSegment(
        REF,
        [4, 8],
        { ...deps, registry: holdWrite(registry, 1, g, 'landThenConflict') },
        {
          allowEmpty: true,
          keep: 1,
          audit,
        },
      );
      await g.reached;
      g.open();
      expect(outcome(await b)).toEqual({ published: true, reason: undefined });
      expect(kinds(audit)).toEqual(['segment.publish']);
    });

    it('with a policy write swapped in over it first: the pointer is still its own write', async () => {
      await loadSegment(REF, [9], deps, { allowEmpty: true });
      const g = gate();
      const audit = new RecordingAuditSink();
      const b = loadSegment(
        REF,
        [4, 8],
        {
          ...deps,
          registry: holdWrite(registry, 1, g, 'landThenConflict', async () => {
            await setSegmentRetention(REF, deps, { expiresAt: 1_900_000_000_000 });
          }),
        },
        { allowEmpty: true, keep: 1, audit },
      );
      await g.reached;
      g.open();
      expect(outcome(await b)).toEqual({ published: true, reason: undefined });
      expect(kinds(audit)).toEqual(['segment.publish']);
      expect((await registry.get(REF))!.currentGen).toBe(1);
    });

    it('with another load published past it first: superseded', async () => {
      await loadSegment(REF, [9], deps, { allowEmpty: true });
      const g = gate();
      const b = loadSegment(
        REF,
        [4, 8],
        {
          ...deps,
          registry: holdWrite(registry, 1, g, 'landThenConflict', async () => {
            await loadSegment(REF, [9, 10], deps, { allowEmpty: true, keep: 1 });
          }),
        },
        { allowEmpty: true, keep: 1 },
      );
      await g.reached;
      g.open();
      expect(outcome(await b)).toEqual({ published: false, reason: 'superseded' });
    });
  });

  describe("an own write that landed, then a write that renews the row's pointerId over it, is read as not its own", () => {
    // The trade this check makes: once a write has renewed the row's `pointerId` over the call's own landed write, the
    // call cannot tell its write from another load's of that number. It reports none published, though its generation
    // may be current, and deletes nothing; a re-run publishes a new generation.

    /** The generations the row names, and the one it points at, are all still in the bucket, and the pointer reads. */
    async function expectIntact(ids: number[]) {
      const row = (await registry.get(REF))!;
      const bucket = await gens(storage);
      for (const g of (row.knownGens ?? []).map((e) => e.generation)) {
        expect(bucket, `generation ${g}`).toContain(g);
      }
      expect(bucket).toContain(row.currentGen);
      const store = new CloudRoaring({
        storage: brandAsBackend({ storage, registry }),
        cache: { genTtlMs: 0 },
        seams: { clock },
      });
      for (const id of ids) expect(await store.segment(REF.segment).has(id), `id ${id}`).toBe(true);
    }

    it("a load, then an erasure's refused rewrite renews the row over it: superseded, nothing deleted, a re-run publishes", async () => {
      await loadSegment(REF, [5, 9], deps, { allowEmpty: true });
      const lGate = gate();
      const eGate = gate();
      const lAudit = new RecordingAuditSink();
      const erasure: { done?: Promise<unknown> } = {};
      let landed = '';
      const l = loadSegment(
        REF,
        [4, 8],
        {
          ...deps,
          registry: holdWrite(registry, 1, lGate, 'landThenConflict', async () => {
            landed = (await registry.get(REF))!.pointerId;
            eGate.open();
            await erasure.done;
          }),
        },
        { allowEmpty: true, keep: 1, audit: lAudit },
      );
      await lGate.reached;
      erasure.done = eraseIdFromSegment(REF, 9, {
        ...deps,
        registry: holdWrite(registry, 2, eGate),
      });
      await eGate.reached;
      lGate.open();
      expect(outcome(await l)).toEqual({ published: false, reason: 'superseded' });
      expect(kinds(lAudit)).toEqual(['segment.load-refused']);
      // The erasure's discard renewed the row over the load's write, and the pointer is still the load's generation.
      const row = (await registry.get(REF))!;
      expect(row.currentGen).toBe(1);
      expect(row.pointerId).not.toBe(landed);
      await expectIntact([4, 8]);
      expect(await loadSegment(REF, [4, 8], deps, { allowEmpty: true, keep: 1 })).toMatchObject({
        published: true,
        generation: 2,
      });
    });

    it('a load, then another load moving the pointer off its generation and a rollback back onto it: superseded, nothing deleted, a re-run publishes', async () => {
      await loadSegment(REF, [5, 9], deps, { allowEmpty: true });
      const lGate = gate();
      const lAudit = new RecordingAuditSink();
      let landed = '';
      const l = loadSegment(
        REF,
        [4, 8],
        {
          ...deps,
          registry: holdWrite(registry, 1, lGate, 'landThenConflict', async () => {
            landed = (await registry.get(REF))!.pointerId;
            await loadSegment(REF, [4, 8, 10], deps, { allowEmpty: true, keep: 1 });
            await rollbackSegment(REF, 1, deps);
          }),
        },
        { allowEmpty: true, keep: 1, audit: lAudit },
      );
      await lGate.reached;
      lGate.open();
      expect(outcome(await l)).toEqual({ published: false, reason: 'superseded' });
      expect(kinds(lAudit)).toEqual(['segment.load-refused']);
      const row = (await registry.get(REF))!;
      expect(row.currentGen).toBe(1);
      expect(row.pointerId).not.toBe(landed);
      await expectIntact([4, 8]);
      expect(await loadSegment(REF, [4, 8], deps, { allowEmpty: true, keep: 1 })).toMatchObject({
        published: true,
      });
    });

    it('an erasure rewrite, then a load moving the pointer off its generation and a rollback back onto it: erased false, no rewrite audited, nothing deleted, a re-run erases', async () => {
      await loadSegment(REF, [5, 9], deps, { allowEmpty: true });
      const g = gate();
      const audit = new RecordingAuditSink();
      let landed = '';
      const e = eraseIdFromSegment(
        REF,
        9,
        {
          ...deps,
          registry: holdWrite(registry, 1, g, 'landThenConflict', async () => {
            landed = (await registry.get(REF))!.pointerId;
            await loadSegment(REF, [5, 6], deps, { allowEmpty: true, keep: 1 });
            await rollbackSegment(REF, 1, deps);
          }),
        },
        { audit },
      );
      await g.reached;
      g.open();
      expect(await e).toMatchObject({ erased: false, reason: 'superseded' });
      expect(kinds(audit)).not.toContain('segment.rewrite');
      const row = (await registry.get(REF))!;
      expect(row.currentGen).toBe(1);
      expect(row.pointerId).not.toBe(landed);
      // Nothing was deleted: the generation that holds the id is still in the bucket, as the rewrite is.
      expect(await gens(storage)).toEqual(expect.arrayContaining([0, 1]));
      await expectIntact([5]);
      expect(await eraseIdFromSegment(REF, 9, deps)).toMatchObject({ erased: true });
      // The re-run deletes the generation that held the id.
      expect(await gens(storage)).not.toContain(0);
    });
  });
});

describe('a registry that reports write tokens, with an Azure-like store', () => {
  it("a write that lands, then loses to another writer's policy write before its read-back, is published", async () => {
    // The store applies the write, then another writer's retention write swaps in over it (leaving the pointer where the
    // load put it), and only then does the write answer, as a conflict: the shape the Azure driver reports when the id it
    // reads back is the other writer's. The token the registry reported is the one the row's pointer still carries.
    const store = new MapStore();
    const registry = new ObjectStoreRegistry(store, 'p', () => 1_000);
    const storage = new MemoryStorageDriver();
    const deps = { storage, registry, codec: roaringCodec, clock };
    await loadSegment(REF, [9], deps, { allowEmpty: true });
    const audit = new RecordingAuditSink();
    store.afterWrite = async () => {
      const row = (await registry.get(REF))!;
      expect(row.currentGen).toBe(1);
      await registry.compareAndSwap(REF, row.token, { retention: { note: 'kept' } });
      return 'conflict';
    };
    const r = await loadSegment(REF, [4, 8], deps, { allowEmpty: true, keep: 1, audit });
    expect(r).toMatchObject({ generation: 1, published: true });
    expect(kinds(audit)).toEqual(['segment.publish']);
    expect(await registry.get(REF)).toMatchObject({ currentGen: 1, retention: { note: 'kept' } });
  });
});

describe('a registry that does not report write tokens keeps the proof by its object', () => {
  const quiet = () => withoutTokenReports(new MemoryRegistryDriver());

  it('is handed no token callback by a publish, with the row it wrote against still passed as held', async () => {
    const registry = quiet();
    const seen: unknown[] = [];
    const spy = Object.create(registry) as IRegistryDriver;
    spy.compareAndSwap = (ref, token, patch, options) => {
      seen.push(options);
      return registry.compareAndSwap(ref, token, patch, options);
    };
    const deps = { storage: new MemoryStorageDriver(), registry: spy, codec: roaringCodec, clock };
    await loadSegment(REF, [9], deps, { allowEmpty: true });
    await loadSegment(REF, [9, 10], deps, { allowEmpty: true });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({ held: expect.objectContaining({ currentGen: 0 }) });
    expect(seen[0]).not.toHaveProperty('onToken');
  });

  it('a write of its own that landed and lost its response is published, by the footer of its object', async () => {
    const registry = quiet();
    const storage = new MemoryStorageDriver();
    const deps = { storage, registry, codec: roaringCodec, clock };
    await loadSegment(REF, [9], deps, { allowEmpty: true });
    const g = gate();
    const b = loadSegment(
      REF,
      [4, 8],
      { ...deps, registry: holdWrite(registry, 1, g, 'landThenConflict') },
      { allowEmpty: true, keep: 1 },
    );
    await g.reached;
    g.open();
    expect(outcome(await b)).toEqual({ published: true, reason: undefined });
  });
});

describe('the shipped registries that report write tokens', () => {
  it('the in-memory, local-filesystem and shared object-store registries say so', () => {
    expect(new MemoryRegistryDriver().reportsWriteTokens).toBe(true);
    expect(new LocalFsRegistryDriver('/nonexistent/crbm-token').reportsWriteTokens).toBe(true);
    expect(new ObjectStoreRegistry(new MapStore(), 'p', () => 1).reportsWriteTokens).toBe(true);
  });
});

describe('every writer that reaches the publish is settled by the write token', () => {
  const DEST: SegmentRef = { segment: 'd' };

  /**
   * A destination at generation 0 whose next publish, a write naming generation 1, is held by the returned gate. While
   * it is held an erasure of 8 deletes the held writer's object above the pointer and renews the row, and another load
   * of the same ids, 4 and 8, takes the number and publishes the same bytes.
   */
  async function overtaken(
    run: (store: CloudRoaring, audit: RecordingAuditSink) => Promise<unknown>,
    operands: { a: readonly number[]; b: readonly number[] } = { a: [4, 8, 50], b: [4, 8, 60] },
  ) {
    const mem = new MemoryStorage();
    const g = gate();
    const held = holdWrite(mem.registry, 1, g, 'send');
    const store = new CloudRoaring({
      storage: brandAsBackend({ storage: mem.storage, registry: held }),
      cache: { genTtlMs: 0 },
      seams: { clock },
    });
    const plain = { storage: mem.storage, registry: mem.registry, codec: roaringCodec, clock };
    await store.load({ segment: 'a' }, operands.a);
    await store.load({ segment: 'b' }, operands.b);
    await loadSegment(DEST, [9], plain, { allowEmpty: true });
    const audit = new RecordingAuditSink();
    const writer = run(store, audit).then(
      (r) => r,
      (error: unknown) => ({ error }),
    );
    await g.reached;
    await eraseIdFromSegment(DEST, 8, plain);
    const cAudit = new RecordingAuditSink();
    await loadSegment(DEST, [4, 8], plain, { allowEmpty: true, keep: 1, audit: cAudit });
    g.open();
    return { result: await writer, audit, cAudit, mem };
  }

  it('intersectInto: superseded, one refusal audited, and the other load alone published', async () => {
    const { result, audit, cAudit, mem } = await overtaken((store, a) =>
      store.segment('a').intersectInto(store.segment('d'), [store.segment('b')], {
        allowEmpty: true,
        audit: a,
        keep: 0,
      }),
    );
    // The facade's verbs throw when what they wrote is not the destination's current generation.
    expect((result as { error: unknown }).error).toBeInstanceOf(WriteConflictError);
    expect(kinds(audit)).toEqual(['segment.load-refused']);
    expect(kinds(cAudit)).toEqual(['segment.publish']);
    expect((await mem.registry.get(DEST))!.currentGen).toBe(1);
  });

  // Each operand pair gives {4, 8}, the ids the other load wrote, so the footer of the object under the number cannot
  // tell the two writers apart: only the token can.
  it.each([
    ['unionInto', { a: [4, 8], b: [4] }],
    ['andNotInto', { a: [4, 8, 50], b: [50] }],
  ] as const)(
    "%s: superseded, though its result is the other load's bytes",
    async (verb, operands) => {
      const { result, audit } = await overtaken(
        (store, a) =>
          store.segment('a')[verb](store.segment('d'), [store.segment('b')], {
            allowEmpty: true,
            audit: a,
          }),
        operands,
      );
      expect((result as { error: unknown }).error).toBeInstanceOf(WriteConflictError);
      expect(kinds(audit)).not.toContain('segment.publish');
    },
  );

  it('materializeMany: its output is superseded, and published nothing', async () => {
    const { result, audit, mem } = await overtaken((store, a) =>
      store.materializeMany({
        operands: { a: store.segment('a'), b: store.segment('b') },
        outputs: [
          { dest: store.segment('d'), expr: { and: ['a', 'b'] }, allowEmpty: true, audit: a },
        ],
        keep: 0,
      }),
    );
    expect((result as { outputs: Array<{ published: boolean }> }).outputs[0]).toMatchObject({
      published: false,
    });
    expect(kinds(audit)).not.toContain('segment.publish');
    expect((await mem.registry.get(DEST))!.currentGen).toBe(1);
  });

  it('a bulk load into a segment with a registry: superseded, not became current', async () => {
    const mem = new MemoryStorage();
    const g = gate();
    const held = holdWrite(mem.registry, 1, g, 'send');
    const plain = { storage: mem.storage, registry: mem.registry, codec: roaringCodec, clock };
    await loadSegment(DEST, [9], plain, { allowEmpty: true });
    const bulk = bulkLoadCrbmGeneration(mem.storage, { ...DEST, generation: 1 }, [4, 8], {
      registry: held,
    });
    await g.reached;
    await eraseIdFromSegment(DEST, 8, plain);
    await loadSegment(DEST, [4, 8], plain, { allowEmpty: true, keep: 1 });
    g.open();
    expect((await bulk).becameCurrent).toBe(false);
    expect((await mem.registry.get(DEST))!.currentGen).toBe(1);
  });
});

describe('a publish whose attempts run out on conflicts', () => {
  const key = { ...REF, generation: 1 };

  /**
   * A registry whose compare-and-swap loses on every attempt, as a wrapper over `base` that overrides it and inherits
   * its flag (`reports`: from `base`, else off). On the last attempt a write puts the pointer at this number, and
   * `onLast` says whose: the call's own (through `options`), or another writer's (without them). An earlier attempt
   * may end without an answer first.
   */
  function exhausting(
    base: IRegistryDriver,
    reports: boolean,
    onLast: 'own' | 'another',
    unansweredFirst = false,
  ): { registry: IRegistryDriver; attempts: () => number } {
    const registry = Object.create(reports ? base : withoutTokenReports(base)) as IRegistryDriver;
    let attempts = 0;
    registry.compareAndSwap = async (ref, token, patch, options) => {
      attempts += 1;
      if (unansweredFirst && attempts === 1) throw new TransientError('no answer, and never sent');
      if (attempts === 5) {
        await base.compareAndSwap(
          ref,
          token,
          { currentGen: 1 },
          onLast === 'own' ? options : undefined,
        );
      }
      throw new WriteConflictError('lost');
    };
    return { registry, attempts: () => attempts };
  }

  it.each([true, false])(
    "finds the pointer at its number over another writer's write: published only when the registry cannot say whose it is (reports tokens: %s)",
    async (reports) => {
      const base = new MemoryRegistryDriver();
      await base.create(REF, { currentGen: 0 });
      const { registry, attempts } = exhausting(base, reports, 'another');
      const published = await publishGeneration(registry, key, {
        holdsOwnObject: async () => true,
      });
      expect(attempts()).toBe(5);
      // With tokens, the pointer is over a write this call never sent. Without, the footer proof stands in for the
      // writer, and an exhausted publish that saw no unanswered write takes the pointer at its number as its own.
      expect(published).toBe(!reports);
    },
  );

  it('with tokens, finds the pointer over a write of its own that landed: published, and the footer is not asked', async () => {
    const base = new MemoryRegistryDriver();
    await base.create(REF, { currentGen: 0 });
    const { registry } = exhausting(base, true, 'own');
    const asked = vi.fn(async () => false);
    expect(await publishGeneration(registry, key, { holdsOwnObject: asked })).toBe(true);
    expect(asked).not.toHaveBeenCalled();
  });

  it.each([
    ['its own write that landed', 'own', true],
    ["another writer's", 'another', false],
  ] as const)(
    'with tokens, after a write that got no answer, finds the pointer over %s: published is %s',
    async (_what, onLast, expected) => {
      const base = new MemoryRegistryDriver();
      await base.create(REF, { currentGen: 0 });
      const { registry, attempts } = exhausting(base, true, onLast, true);
      const published = await publishGeneration(registry, key, {
        holdsOwnObject: async () => true,
        clock,
      });
      expect(attempts()).toBe(5);
      expect(published).toBe(expected);
    },
  );
});

describe('a registry that overrides a write method: forwarding options settles by token, dropping them reads its own write as not its own', () => {
  /**
   * Registries that land a write and then answer it as a conflict, the shape of a replay that met its own write: a
   * subclass and an `Object.create` wrapper of the in-memory registry, each overriding a write method
   * (`compareAndSwap`, or `create` for a publish onto no row). Each forwards `options` to the write it lands (the
   * call's own write, so the row's `pointerId` is a token the call was told) or drops them (a write the call was not
   * told of), and keeps the inherited flag or sets it `false`. A landed write is the call's own when `options` were
   * forwarded and another writer's when not.
   */
  class Dropping extends MemoryRegistryDriver {
    override async compareAndSwap(
      ref: SegmentRef,
      expected: string,
      patch: Parameters<MemoryRegistryDriver['compareAndSwap']>[2],
    ): Promise<{ token: string }> {
      await super.compareAndSwap(ref, expected, patch);
      throw new WriteConflictError('the answer was a conflict');
    }
  }
  class Forwarding extends MemoryRegistryDriver {
    landing: 'own' | 'another' = 'own';
    override async compareAndSwap(
      ref: SegmentRef,
      expected: string,
      patch: Parameters<MemoryRegistryDriver['compareAndSwap']>[2],
      options?: Parameters<MemoryRegistryDriver['compareAndSwap']>[3],
    ): Promise<{ token: string }> {
      await super.compareAndSwap(
        ref,
        expected,
        patch,
        this.landing === 'own' ? options : undefined,
      );
      throw new WriteConflictError('the answer was a conflict');
    }
  }
  /** The same for `create`, the write a publish onto a segment with no row sends. */
  class DroppingCreate extends MemoryRegistryDriver {
    override async create(
      ref: SegmentRef,
      record: Parameters<MemoryRegistryDriver['create']>[1],
    ): Promise<{ token: string }> {
      await super.create(ref, record);
      throw new WriteConflictError('the answer was a conflict');
    }
  }
  class ForwardingCreate extends MemoryRegistryDriver {
    landing: 'own' | 'another' = 'own';
    override async create(
      ref: SegmentRef,
      record: Parameters<MemoryRegistryDriver['create']>[1],
      options?: Parameters<MemoryRegistryDriver['create']>[2],
    ): Promise<{ token: string }> {
      await super.create(ref, record, this.landing === 'own' ? options : undefined);
      throw new WriteConflictError('the answer was a conflict');
    }
  }
  /**
   * A registry of one's own, by composition, that declares the flag as a class field (`readonly reportsWriteTokens =
   * true`, an instance field rather than a getter on the prototype) and forwards `options`.
   */
  class FieldFlag implements IRegistryDriver {
    readonly reportsWriteTokens = true;
    landing: 'own' | 'another' = 'own';
    private readonly inner = new MemoryRegistryDriver();
    capabilities() {
      return this.inner.capabilities();
    }
    get(ref: SegmentRef) {
      return this.inner.get(ref);
    }
    async create(
      ref: SegmentRef,
      record: Parameters<MemoryRegistryDriver['create']>[1],
      options?: Parameters<MemoryRegistryDriver['create']>[2],
    ): Promise<{ token: string }> {
      await this.inner.create(ref, record, this.landing === 'own' ? options : undefined);
      throw new WriteConflictError('the answer was a conflict');
    }
    async compareAndSwap(
      ref: SegmentRef,
      expected: string,
      patch: Parameters<MemoryRegistryDriver['compareAndSwap']>[2],
      options?: Parameters<MemoryRegistryDriver['compareAndSwap']>[3],
    ): Promise<{ token: string }> {
      await this.inner.compareAndSwap(
        ref,
        expected,
        patch,
        this.landing === 'own' ? options : undefined,
      );
      throw new WriteConflictError('the answer was a conflict');
    }
    list(namespace?: string) {
      return this.inner.list(namespace);
    }
    delete(ref: SegmentRef, expected?: string) {
      return this.inner.delete(ref, expected);
    }
  }
  /** An `Object.create` wrapper over a memory registry: it forwards `options` (or not), and inherits the flag (or sets it off). */
  function wrapper(
    forwards: boolean,
    flag: boolean,
    landing: 'own' | 'another',
    method: 'compareAndSwap' | 'create' = 'compareAndSwap',
  ): IRegistryDriver {
    const base = new MemoryRegistryDriver();
    const out = Object.create(base) as IRegistryDriver;
    if (!flag) Object.defineProperty(out, 'reportsWriteTokens', { value: false });
    const pass = <T>(options: T | undefined): T | undefined =>
      forwards && landing === 'own' ? options : undefined;
    if (method === 'create') {
      out.create = async (ref, record, options) => {
        await base.create(ref, record, pass(options));
        throw new WriteConflictError('the answer was a conflict');
      };
    } else {
      out.compareAndSwap = async (ref, expected, patch, options) => {
        await base.compareAndSwap(ref, expected, patch, pass(options));
        throw new WriteConflictError('the answer was a conflict');
      };
    }
    return out;
  }
  /** A registry with the flag set `false` on the instance. */
  const flagOff = <T extends IRegistryDriver>(registry: T): T => {
    Object.defineProperty(registry, 'reportsWriteTokens', { value: false });
    return registry;
  };
  const forwarding = (landing: 'own' | 'another'): IRegistryDriver => {
    const r = new Forwarding();
    r.landing = landing;
    return r;
  };
  const forwardingCreate = (landing: 'own' | 'another'): IRegistryDriver => {
    const r = new ForwardingCreate();
    r.landing = landing;
    return r;
  };
  const fieldFlag = (landing: 'own' | 'another'): IRegistryDriver => {
    const r = new FieldFlag();
    r.landing = landing;
    return r;
  };

  /**
   * How the publish settles a write that landed and was answered as a conflict: `token` (the flag is on and `options`
   * are forwarded, so the row's `pointerId` is a token the call was told), `dropped` (the flag is on and `options` are
   * dropped, so the call was told none and reads its own landed write as not its own), or `footer` (the flag is off,
   * so the object under the number decides).
   */
  type Settles = 'token' | 'dropped' | 'footer';
  /** The variant, how it is made, how its writes are settled, and whether the publish is onto no row. */
  type Variant = readonly [
    string,
    (landing: 'own' | 'another') => IRegistryDriver,
    Settles,
    boolean,
  ];
  const VARIANTS: readonly Variant[] = [
    ['a subclass that forwards options and keeps the flag', forwarding, 'token', false],
    [
      'an Object.create wrapper that forwards options and keeps the flag',
      (l) => wrapper(true, true, l),
      'token',
      false,
    ],
    [
      'a registry of its own with the flag as a class field, forwarding options',
      fieldFlag,
      'token',
      false,
    ],
    ['a subclass that drops options and keeps the flag', () => new Dropping(), 'dropped', false],
    [
      'an Object.create wrapper that drops options and keeps the flag',
      (l) => wrapper(false, true, l),
      'dropped',
      false,
    ],
    [
      'a subclass that drops options and sets the flag false',
      () => flagOff(new Dropping()),
      'footer',
      false,
    ],
    [
      'an Object.create wrapper that drops options and sets the flag false',
      (l) => wrapper(false, false, l),
      'footer',
      false,
    ],
    [
      'create: a subclass that forwards options and keeps the flag',
      forwardingCreate,
      'token',
      true,
    ],
    [
      'create: an Object.create wrapper that forwards options and keeps the flag',
      (l) => wrapper(true, true, l, 'create'),
      'token',
      true,
    ],
    [
      'create: a registry of its own with the flag as a class field, forwarding options',
      fieldFlag,
      'token',
      true,
    ],
    [
      'create: a subclass that drops options and keeps the flag',
      () => new DroppingCreate(),
      'dropped',
      true,
    ],
    [
      'create: an Object.create wrapper that drops options and keeps the flag',
      (l) => wrapper(false, true, l, 'create'),
      'dropped',
      true,
    ],
    [
      'create: a subclass that drops options and sets the flag false',
      () => flagOff(new DroppingCreate()),
      'footer',
      true,
    ],
    [
      'create: an Object.create wrapper that drops options and sets the flag false',
      (l) => wrapper(false, false, l, 'create'),
      'footer',
      true,
    ],
  ];

  /** A publish of generation 1 over a row at 0, or (`noRow`) of generation 0 onto no row. */
  const publishOver = async (
    registry: IRegistryDriver,
    ownObject: boolean,
    noRow: boolean,
  ): Promise<boolean> => {
    if (!noRow) await registry.create(REF, { currentGen: 0 }).catch(() => undefined);
    return publishGeneration(
      registry,
      { ...REF, generation: noRow ? 0 : 1 },
      { holdsOwnObject: async () => ownObject },
    );
  };

  describe.each(VARIANTS)('%s', (_name, make, settles, noRow) => {
    it(
      settles === 'dropped'
        ? 'a write of its own that landed, then answered as a conflict, is read as not its own: not published'
        : 'a write of its own that landed, then answered as a conflict, is published',
      async () => {
        expect(await publishOver(make('own'), true, noRow)).toBe(settles !== 'dropped');
      },
    );

    it(
      settles === 'footer'
        ? "it is settled by the object's footer, which can pass another writer's identical object"
        : "another writer's write that landed is not the call's own, whatever the object's footer says",
      async () => {
        expect(await publishOver(make('another'), true, noRow)).toBe(settles === 'footer');
      },
    );

    it("with a footer that is not its own, another writer's landed write is refused", async () => {
      expect(await publishOver(make('another'), false, noRow)).toBe(false);
    });
  });

  /** A load of ids onto a row at generation 0 through `registry`, and what the bucket and the row hold after it. */
  async function loadOver(registry: IRegistryDriver) {
    const storage = new MemoryStorageDriver();
    const deps = { storage, registry, codec: roaringCodec, clock };
    await loadSegment(REF, [9], deps, { allowEmpty: true });
    const audit = new RecordingAuditSink();
    const result = await loadSegment(REF, [4, 8], deps, { allowEmpty: true, keep: 1, audit });
    return { result, audit, storage };
  }

  it('a load over a subclass that forwards options publishes its own landed write', async () => {
    const { result, audit } = await loadOver(new Forwarding());
    expect(result).toMatchObject({ generation: 1, published: true });
    expect(kinds(audit)).toEqual(['segment.publish']);
  });

  it('a load over a subclass that drops options and sets the flag false publishes its own landed write, by the footer', async () => {
    const { result, audit } = await loadOver(flagOff(new Dropping()));
    expect(result).toMatchObject({ generation: 1, published: true });
    expect(kinds(audit)).toEqual(['segment.publish']);
  });

  it('a load over a subclass that drops options and keeps the flag reads its own landed write as superseded, and deletes nothing', async () => {
    const registry = new Dropping();
    const { result, audit, storage } = await loadOver(registry);
    expect(outcome(result)).toEqual({ published: false, reason: 'superseded' });
    expect(kinds(audit)).toEqual(['segment.load-refused']);
    // The generation it wrote is current, still in the bucket, and reads; the one it superseded was not evicted.
    expect((await registry.get(REF))!.currentGen).toBe(1);
    expect(await gens(storage)).toEqual([0, 1]);
    const store = new CloudRoaring({
      storage: brandAsBackend({ storage, registry }),
      cache: { genTtlMs: 0 },
      seams: { clock },
    });
    expect(await store.segment(REF.segment).has(4)).toBe(true);
    expect(await store.segment(REF.segment).has(8)).toBe(true);
  });
});
