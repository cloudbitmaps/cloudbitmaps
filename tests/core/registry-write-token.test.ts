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
 * and throws `WriteConflictError`, as a replay that met its own landed write does.
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
    await store.load({ segment: 'a' }, [4, 8, 50]);
    await store.load({ segment: 'b' }, [4, 8, 60]);
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

  it('unionInto and andNotInto: superseded', async () => {
    for (const verb of ['unionInto', 'andNotInto'] as const) {
      const { result, audit } = await overtaken((store, a) =>
        store.segment('a')[verb](store.segment('d'), [store.segment('b')], {
          allowEmpty: true,
          audit: a,
        }),
      );
      // a union holds more than 4 and 8, so its bytes differ from the other load's: refused either way
      expect((result as { error: unknown }).error, verb).toBeInstanceOf(WriteConflictError);
      expect(kinds(audit), verb).not.toContain('segment.publish');
    }
  });

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
  it.each([true, false])(
    "finds the pointer at its number over another writer's write: published only when the registry cannot say whose it is (reports tokens: %s)",
    async (reports) => {
      const base = new MemoryRegistryDriver();
      const registry = reports ? base : withoutTokenReports(base);
      const key = { ...REF, generation: 1 };
      await registry.create(REF, { currentGen: 0 });
      const flaky = Object.create(registry) as IRegistryDriver;
      let conflicts = 0;
      flaky.compareAndSwap = async (ref, token) => {
        conflicts += 1;
        // The fifth attempt loses to another writer, whose own write puts the pointer at this number.
        if (conflicts === 5) await registry.compareAndSwap(ref, token, { currentGen: 1 });
        throw new WriteConflictError('lost');
      };
      const published = await publishGeneration(flaky, key, {
        holdsOwnObject: async () => true,
      });
      expect(conflicts).toBe(5);
      // With tokens, the pointer is over a write this call never sent. Without, the footer proof stands in for the
      // writer, and an exhausted publish that saw no unanswered write takes the pointer at its number as its own.
      expect(published).toBe(!reports);
    },
  );
});
