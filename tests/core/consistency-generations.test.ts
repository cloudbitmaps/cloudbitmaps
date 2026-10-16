import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MIN_EXPIRES_AT_MS,
  CloudRoaring,
  MemoryStorage,
  TransientError,
  ValidationError,
} from '@/index';
import { brandAsBackend } from '@/core/ports';
import type {
  GenKey,
  IRegistryDriver,
  IStorageDriver,
  RegistryRecord,
  SegmentRef,
} from '@/core/ports';
import { runConsistencyCheck } from '@/core/consistency';
import { loadSegment } from '@/core/load';
import { rollbackSegment } from '@/core/rollback';
import { setSegmentRetention } from '@/core/retention';
import { roaringCodec } from '@/roaring-codec';
import { InProcessKeystore } from '@/drivers/crypto';
import { MemoryRegistryDriver, MemoryStorageDriver } from '@/drivers/memory';
import { LocalFsRegistryDriver } from '@/drivers/localfs/registry';
import { ObjectStoreRegistry } from '@/drivers/_shared/object-registry';
import { CountingObjectStore } from '../helpers/counting';
import { testEntropy } from '../helpers/entropy';

/**
 * `checkConsistency({ generations: true })` holds every generation a row's ledger of known generations names, and the
 * bucket has, to the footer checksum the ledger records. It is off by default, reads only footers, needs no key, never
 * reports a generation the bucket no longer has, and counts the rows whose ledger it cannot use.
 */

const SEG: SegmentRef = { namespace: 'ns', segment: 's' };
const FAR = MIN_EXPIRES_AT_MS * 2;
const FOOTER = 104;

let root: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'cbm-consistency-gens-'));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

let dirs = 0;
const registries: ReadonlyArray<readonly [string, () => IRegistryDriver]> = [
  ['MemoryRegistryDriver', () => new MemoryRegistryDriver({ now: () => FAR })],
  [
    'LocalFsRegistryDriver',
    () => new LocalFsRegistryDriver(join(root, `d${dirs++}`), { now: () => FAR }),
  ],
  [
    'ObjectStoreRegistry',
    () => new ObjectStoreRegistry(new CountingObjectStore(0), undefined, () => FAR),
  ],
];

/** One storage request, as the driver saw it. */
interface Call {
  readonly method: string;
  readonly segment: string;
  readonly generation: number;
  readonly bytes?: number;
}

/**
 * `storage`, recording each read of an object by its key and size, and failing a read where `fail` says so.
 */
function recording(
  storage: IStorageDriver,
  calls: Call[],
  fail: (call: Call, attempt: number) => Error | undefined = () => undefined,
): IStorageDriver {
  const attempts = new Map<string, number>();
  const seen = async <T>(call: Call, read: () => Promise<T>): Promise<T> => {
    const id = `${call.method}:${call.segment}:${call.generation}:${call.bytes}`;
    const attempt = (attempts.get(id) ?? 0) + 1;
    attempts.set(id, attempt);
    calls.push(call);
    const error = fail(call, attempt);
    if (error !== undefined) throw error;
    return read();
  };
  return {
    capabilities: () => storage.capabilities(),
    putImmutable: (key, write) => storage.putImmutable(key, write),
    getRange: (key, offset, length) =>
      seen(
        { method: 'getRange', segment: key.segment, generation: key.generation, bytes: length },
        () => storage.getRange(key, offset, length),
      ),
    getTail: (key, maxBytes) =>
      seen(
        { method: 'getTail', segment: key.segment, generation: key.generation, bytes: maxBytes },
        () => storage.getTail(key, maxBytes),
      ),
    delete: (key, options) => storage.delete(key, options),
    list: (ref) => {
      calls.push({ method: 'list', segment: ref.segment, generation: -1 });
      return storage.list(ref);
    },
  };
}

/** The registry as `view` rewrites each row it hands back: a row as another registry of your own could return it. */
function viewing(
  registry: IRegistryDriver,
  view: (row: RegistryRecord) => RegistryRecord,
): IRegistryDriver {
  return {
    capabilities: () => registry.capabilities(),
    get: async (ref) => {
      const row = await registry.get(ref);
      return row === null ? row : view(row);
    },
    create: (ref, rec, o) => registry.create(ref, rec, o),
    compareAndSwap: (ref, t, patch, o) => registry.compareAndSwap(ref, t, patch, o),
    list: async function* (ns) {
      for await (const row of registry.list(ns)) yield view(row);
    },
    delete: (ref, t) => registry.delete(ref, t),
  };
}

/** The whole object under `key`. */
async function bytesOf(storage: IStorageDriver, key: GenKey): Promise<Uint8Array> {
  const { bytes } = await storage.getTail(key, Number.MAX_SAFE_INTEGER);
  return bytes.slice();
}

/** Put `bytes` under `key`, in place of what is there: a restore that put back another object. */
async function putOver(storage: IStorageDriver, key: GenKey, bytes: Uint8Array): Promise<void> {
  await storage.delete(key);
  await storage.putImmutable(key, async (sink) => {
    await sink.write(bytes);
  });
}

/** `segment`'s `count` generations, each a larger set than the last, the way a daily load makes them. */
async function loadMany(
  deps: { storage: IStorageDriver; registry: IRegistryDriver },
  segment: SegmentRef,
  count: number,
  keep?: number,
): Promise<void> {
  const have = (await deps.registry.get(segment))?.currentGen ?? -1;
  for (let g = have + 1; g < have + 1 + count; g++) {
    const r = await loadSegment(
      segment,
      Array.from({ length: g + 1 }, (_, i) => i),
      { ...deps, entropy: testEntropy, codec: roaringCodec },
      keep === undefined ? {} : { keep },
    );
    expect(r).toMatchObject({ generation: g, published: true });
  }
}

const numbers = (row: RegistryRecord | null): number[] =>
  (row?.knownGens ?? []).map((e) => e.generation);

/**
 * `calls` grouped by segment, each segment's own order kept. Segments are checked at once, and a registry lists them in
 * its own order (a directory's, for local files), so the order across segments says nothing; the order within one does.
 */
const bySegment = (calls: readonly Call[]): Call[] =>
  [...calls].sort((a, b) => (a.segment < b.segment ? -1 : a.segment > b.segment ? 1 : 0));

const footerReads = (calls: readonly Call[]): Call[] =>
  calls.filter((c) => c.method === 'getTail' && c.bytes === FOOTER);

const mismatch = (generation: number, currentGen: number) => ({
  segment: 's',
  namespace: 'ns',
  currentGen,
  issue: 'known-generation-mismatch',
  generation,
});

describe.each(registries)('checkConsistency with generations over %s', (_name, makeRegistry) => {
  function world() {
    const memory = new MemoryStorageDriver();
    const registry = makeRegistry();
    const calls: Call[] = [];
    const storage = recording(memory, calls);
    return { memory, registry, calls, storage, deps: { storage, registry } };
  }

  it('a coherent segment reports nothing, and the report says no row was left unchecked', async () => {
    const w = world();
    await loadMany(w.deps, SEG, 3);
    expect(numbers(await w.registry.get(SEG))).toEqual([1, 2]);
    const report = await runConsistencyCheck(w.deps, { generations: true });
    expect(report).toEqual({ checked: 1, inconsistent: [], errored: [], generationsUnchecked: 0 });
  });

  it('another object under a known number is a known-generation-mismatch with its generation', async () => {
    const w = world();
    await loadMany(w.deps, SEG, 3);
    // Generation 1 is a known one below the pointer. Put generation 2's bytes under its number.
    await putOver(
      w.memory,
      { ...SEG, generation: 1 },
      await bytesOf(w.memory, { ...SEG, generation: 2 }),
    );
    const report = await runConsistencyCheck(w.deps, { generations: true });
    expect(report.inconsistent).toEqual([mismatch(1, 2)]);
    expect(report.errored).toEqual([]);
    // Without asking, the check does not look.
    expect((await runConsistencyCheck(w.deps)).inconsistent).toEqual([]);
    expect((await runConsistencyCheck(w.deps, { generations: false })).inconsistent).toEqual([]);
  });

  it('a known generation that is not in the bucket is not reported', async () => {
    const w = world();
    await loadMany(w.deps, SEG, 3);
    await w.memory.delete({ ...SEG, generation: 1 });
    expect(numbers(await w.registry.get(SEG))).toEqual([1, 2]);
    const report = await runConsistencyCheck(w.deps, { generations: true });
    expect(report).toEqual({ checked: 1, inconsistent: [], errored: [], generationsUnchecked: 0 });
  });

  it.each([[400], [10]])(
    'an object of %i bytes that is not a .crbm under a known number is not the one recorded',
    async (size) => {
      const w = world();
      await loadMany(w.deps, SEG, 3);
      await putOver(w.memory, { ...SEG, generation: 1 }, new Uint8Array(size).fill(7));
      const report = await runConsistencyCheck(w.deps, { generations: true });
      expect(report.inconsistent).toEqual([mismatch(1, 2)]);
      expect(report.errored).toEqual([]);
    },
  );

  it('an object under a number the ledger does not name is neither read nor reported', async () => {
    const w = world();
    await loadMany(w.deps, SEG, 3);
    expect(numbers(await w.registry.get(SEG))).toEqual([1, 2]);
    // Generation 0 was collected, and generation 7 was never published: put other bytes under both.
    const other = await bytesOf(w.memory, { ...SEG, generation: 2 });
    await putOver(w.memory, { ...SEG, generation: 0 }, new Uint8Array(50).fill(3));
    await putOver(w.memory, { ...SEG, generation: 7 }, other);
    w.calls.length = 0;
    const report = await runConsistencyCheck(w.deps, { generations: true });
    expect(report).toEqual({ checked: 1, inconsistent: [], errored: [], generationsUnchecked: 0 });
    expect(w.calls.filter((c) => c.generation === 0 || c.generation === 7)).toEqual([]);
  });

  it('after a rollback the entries above the pointer are read and held, and a swap of one is reported', async () => {
    const w = world();
    await loadMany(w.deps, SEG, 3, 10);
    await rollbackSegment(SEG, 0, w.deps);
    const row = (await w.registry.get(SEG))!;
    expect(row.currentGen).toBe(0);
    expect(numbers(row).sort()).toEqual([0, 1, 2]);
    w.calls.length = 0;
    const clean = await runConsistencyCheck(w.deps, { generations: true });
    expect(clean).toEqual({ checked: 1, inconsistent: [], errored: [], generationsUnchecked: 0 });
    expect(
      footerReads(w.calls)
        .map((c) => c.generation)
        .sort(),
    ).toEqual([0, 1, 2]);
    await putOver(
      w.memory,
      { ...SEG, generation: 2 },
      await bytesOf(w.memory, { ...SEG, generation: 1 }),
    );
    const report = await runConsistencyCheck(w.deps, { generations: true });
    expect(report.inconsistent).toEqual([mismatch(2, 0)]);
  });

  it('the current generation swapped is reported, and with summaries both issues are in the report', async () => {
    const w = world();
    await loadMany(w.deps, SEG, 3);
    await putOver(
      w.memory,
      { ...SEG, generation: 2 },
      await bytesOf(w.memory, { ...SEG, generation: 1 }),
    );
    const only = await runConsistencyCheck(w.deps, { generations: true });
    expect(only.inconsistent).toEqual([mismatch(2, 2)]);
    // The same object is what the summary names, so with both asked the row is in the report twice, once for each
    // check, and the one with a `generation` says which known generation it is.
    const both = await runConsistencyCheck(w.deps, { summaries: true, generations: true });
    expect(both.inconsistent).toEqual([
      { segment: 's', namespace: 'ns', currentGen: 2, issue: 'summary-mismatch' },
      mismatch(2, 2),
    ]);
    expect(both).toMatchObject({ summariesUnchecked: 0, generationsUnchecked: 0 });
    const summaryOnly = await runConsistencyCheck(w.deps, { summaries: true });
    expect(summaryOnly.inconsistent).toEqual([
      { segment: 's', namespace: 'ns', currentGen: 2, issue: 'summary-mismatch' },
    ]);
  });

  it('a missing current object is reported as ever, and the older generations are still held', async () => {
    const w = world();
    await loadMany(w.deps, SEG, 3);
    await putOver(
      w.memory,
      { ...SEG, generation: 1 },
      await bytesOf(w.memory, { ...SEG, generation: 2 }),
    );
    await w.memory.delete({ ...SEG, generation: 2 });
    const report = await runConsistencyCheck(w.deps, { generations: true });
    expect(report.inconsistent).toEqual([
      { segment: 's', namespace: 'ns', currentGen: 2, issue: 'missing-storage-generation' },
      mismatch(1, 2),
    ]);
  });

  it('a ledger that is dropped, or fails validation, is counted, and none of its objects is read', async () => {
    const w = world();
    await loadMany(w.deps, { namespace: 'ns', segment: 'dropped' }, 3);
    await loadMany(w.deps, { namespace: 'ns', segment: 'stale' }, 3);
    await loadMany(w.deps, { namespace: 'ns', segment: 'good' }, 3);
    // Another registry of your own: one row has no ledger, another has one whose last entry's checksum is not the one the
    // row's own summary carries.
    const registry = viewing(w.registry, (row) => {
      if (row.segment === 'dropped') return { ...row, knownGens: undefined } as RegistryRecord;
      if (row.segment === 'stale') {
        const known = row.knownGens!;
        const last = known[known.length - 1]!;
        return {
          ...row,
          knownGens: [...known.slice(0, -1), { ...last, footerCrc: (last.footerCrc ^ 1) >>> 0 }],
        } as RegistryRecord;
      }
      return row;
    });
    w.calls.length = 0;
    const report = await runConsistencyCheck(
      { storage: w.storage, registry },
      { generations: true },
    );
    expect(report).toEqual({ checked: 3, inconsistent: [], errored: [], generationsUnchecked: 2 });
    // Only the usable ledger's two objects had their footers read.
    expect(footerReads(w.calls).map((c) => `${c.segment}:${c.generation}`)).toEqual([
      'good:1',
      'good:2',
    ]);
    expect(w.calls.filter((c) => c.segment !== 'good' && c.bytes !== 0)).toEqual([]);
  });

  it('a row with no pointer is skipped, as the check skips it today, and is not counted', async () => {
    const w = world();
    await loadMany(w.deps, SEG, 2);
    await setSegmentRetention(
      { namespace: 'ns', segment: 'unloaded' },
      { registry: w.registry },
      { expiresAt: FAR },
    );
    expect((await w.registry.get({ namespace: 'ns', segment: 'unloaded' }))?.currentGen).toBeNull();
    w.calls.length = 0;
    const report = await runConsistencyCheck(w.deps, { generations: true });
    expect(report).toEqual({ checked: 2, inconsistent: [], errored: [], generationsUnchecked: 0 });
    expect(w.calls.filter((c) => c.segment === 'unloaded')).toEqual([]);
  });

  it('the default call makes one zero-length tail read per segment and nothing else', async () => {
    const w = world();
    await loadMany(w.deps, SEG, 3);
    await loadMany(w.deps, { namespace: 'ns', segment: 't' }, 3);
    w.calls.length = 0;
    const report = await runConsistencyCheck(w.deps, { concurrency: 1 });
    expect(report).toEqual({ checked: 2, inconsistent: [], errored: [] });
    expect(report).not.toHaveProperty('generationsUnchecked');
    expect(bySegment(w.calls)).toEqual([
      { method: 'getTail', segment: 's', generation: 2, bytes: 0 },
      { method: 'getTail', segment: 't', generation: 2, bytes: 0 },
    ]);
  });

  it('at keep 1 it is two footer reads of 104 bytes per segment, and no listing', async () => {
    const w = world();
    await loadMany(w.deps, SEG, 3);
    await loadMany(w.deps, { namespace: 'ns', segment: 't' }, 3);
    w.calls.length = 0;
    await runConsistencyCheck(w.deps, { generations: true, concurrency: 1 });
    expect(bySegment(w.calls)).toEqual([
      { method: 'getTail', segment: 's', generation: 2, bytes: 0 },
      { method: 'getTail', segment: 's', generation: 1, bytes: FOOTER },
      { method: 'getTail', segment: 's', generation: 2, bytes: FOOTER },
      { method: 'getTail', segment: 't', generation: 2, bytes: 0 },
      { method: 'getTail', segment: 't', generation: 1, bytes: FOOTER },
      { method: 'getTail', segment: 't', generation: 2, bytes: FOOTER },
    ]);
  });

  it('a wide ledger, as an *Into destination writes, is one footer read per entry', async () => {
    const w = world();
    // The `keep` an `*Into` call publishes with: no generation is collected, and the ledger holds 128.
    await loadMany(w.deps, SEG, 140, Number.MAX_SAFE_INTEGER);
    const row = await w.registry.get(SEG);
    expect(numbers(row)).toHaveLength(128);
    w.calls.length = 0;
    const report = await runConsistencyCheck(w.deps, { generations: true });
    expect(report).toEqual({ checked: 1, inconsistent: [], errored: [], generationsUnchecked: 0 });
    expect(footerReads(w.calls)).toHaveLength(128);
    expect(w.calls).toHaveLength(129);
    // One swapped among them is found, and the 128 reads are still the whole cost.
    await putOver(
      w.memory,
      { ...SEG, generation: 20 },
      await bytesOf(w.memory, { ...SEG, generation: 21 }),
    );
    w.calls.length = 0;
    const swapped = await runConsistencyCheck(w.deps, { generations: true });
    expect(swapped.inconsistent).toEqual([mismatch(20, 139)]);
    expect(footerReads(w.calls)).toHaveLength(128);
  });

  it('a footer read never has more requests in flight than the concurrency', async () => {
    const w = world();
    for (const s of ['a', 'b', 'c', 'd']) {
      await loadMany(w.deps, { namespace: 'ns', segment: s }, 3);
    }
    await loadMany(w.deps, { namespace: 'ns', segment: 'wide' }, 40, Number.MAX_SAFE_INTEGER);
    let inFlight = 0;
    let peak = 0;
    const slow: IStorageDriver = {
      ...w.storage,
      capabilities: () => w.storage.capabilities(),
      getTail: async (key, maxBytes) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 2));
        try {
          return await w.storage.getTail(key, maxBytes);
        } finally {
          inFlight -= 1;
        }
      },
    };
    const run = (concurrency: number) =>
      runConsistencyCheck(
        { storage: slow, registry: w.registry },
        { generations: true, concurrency },
      );
    await run(2);
    expect(peak).toBe(2);
    // One segment with 40 known generations alone does not fan out past the one request the check allows.
    peak = 0;
    await runConsistencyCheck(
      { storage: slow, registry: w.registry },
      { generations: true, concurrency: 1, namespace: 'ns' },
    );
    expect(peak).toBe(1);
  });

  it('a footer read that fails transiently is the segment error, not retried, and keeps the mismatches before it', async () => {
    const memory = new MemoryStorageDriver();
    const registry = makeRegistry();
    await loadMany({ storage: memory, registry }, SEG, 3);
    await putOver(
      memory,
      { ...SEG, generation: 1 },
      await bytesOf(memory, { ...SEG, generation: 2 }),
    );
    const calls: Call[] = [];
    const flaky = recording(memory, calls, (c) =>
      c.bytes === FOOTER && c.generation === 2 ? new TransientError('throttled') : undefined,
    );
    const report = await runConsistencyCheck({ storage: flaky, registry }, { generations: true });
    expect(report.inconsistent).toEqual([mismatch(1, 2)]);
    expect(report.errored).toEqual([{ segment: 's', namespace: 'ns', error: 'throttled' }]);
    expect(footerReads(calls).filter((c) => c.generation === 2)).toHaveLength(1);
  });

  it('a footer read that fails for another reason is the segment error, and is not retried', async () => {
    const memory = new MemoryStorageDriver();
    const registry = makeRegistry();
    await loadMany({ storage: memory, registry }, SEG, 3);
    await loadMany({ storage: memory, registry }, { namespace: 'ns', segment: 'ok' }, 3);
    const calls: Call[] = [];
    const denied = recording(memory, calls, (c) =>
      c.bytes === FOOTER && c.segment === 's' && c.generation === 1
        ? new Error('access denied')
        : undefined,
    );
    const report = await runConsistencyCheck({ storage: denied, registry }, { generations: true });
    expect(report.errored).toEqual([{ segment: 's', namespace: 'ns', error: 'access denied' }]);
    expect(report.inconsistent).toEqual([]);
    expect(report.checked).toBe(2);
    expect(footerReads(calls).filter((c) => c.segment === 's')).toHaveLength(1);
    expect(footerReads(calls).filter((c) => c.segment === 'ok')).toHaveLength(2);
  });
});

describe.each(registries)(
  'a ledger a registry of your own hands back, over %s',
  (_name, makeRegistry) => {
    const entry = (generation: unknown, footerCrc: unknown) => ({ generation, footerCrc });
    // The row's own last entry, so only the entries before it make the ledger wrong.
    const last = (r: RegistryRecord) => r.knownGens!.at(-1)!;
    const bad: ReadonlyArray<readonly [string, (row: RegistryRecord) => unknown]> = [
      ['null', () => null],
      ['5', () => 5],
      ['{}', () => ({})],
      ['[null]', () => [null]],
      ['[undefined]', () => [undefined]],
      ['an entry that is an array', () => [[1, 2]]],
      [
        '5,000 entries',
        (r) => [...Array.from({ length: 4999 }, (_, i) => entry(i + 100, 0)), last(r)],
      ],
      [
        '385 entries',
        (r) => [...Array.from({ length: 384 }, (_, i) => entry(i + 100, 0)), last(r)],
      ],
      ['a checksum of 2^33', (r) => [entry(1, 2 ** 33), last(r)]],
      ['a checksum of -1', (r) => [entry(1, -1), last(r)]],
      ['a checksum that is a string', (r) => [entry(1, '5'), last(r)]],
      ['a checksum that is missing', (r) => [{ generation: 1 }, last(r)]],
      ['a generation of -1', (r) => [entry(-1, 0), last(r)]],
      ['a generation that is a fraction', (r) => [entry(1.5, 0), last(r)]],
      ['an undeclared key', (r) => [{ ...entry(1, 0), extra: 1 }, last(r)]],
      ['a repeated number', (r) => [entry(1, 0), entry(1, 0), last(r)]],
    ];

    it.each(bad)(
      '%s is counted, nothing of it is read, and the other segments are checked',
      async (_label, ledger) => {
        const memory = new MemoryStorageDriver();
        const registry = makeRegistry();
        const calls: Call[] = [];
        const storage = recording(memory, calls);
        await loadMany({ storage, registry }, SEG, 3);
        await loadMany({ storage, registry }, { namespace: 'ns', segment: 't' }, 3);
        await putOver(
          memory,
          { namespace: 'ns', segment: 't', generation: 1 },
          await bytesOf(memory, { namespace: 'ns', segment: 't', generation: 2 }),
        );
        const viewed = viewing(registry, (row) =>
          row.segment === 's'
            ? ({ ...row, knownGens: ledger(row) } as unknown as RegistryRecord)
            : row,
        );
        calls.length = 0;
        const report = await runConsistencyCheck(
          { storage, registry: viewed },
          { generations: true },
        );
        expect(report.errored).toEqual([]);
        expect(report.generationsUnchecked).toBe(1);
        expect(report.inconsistent).toEqual([{ ...mismatch(1, 2), segment: 't' }]);
        expect(footerReads(calls).filter((c) => c.segment === 's')).toEqual([]);
      },
    );

    it("a row that fails while its ledger is read is that segment's error, and the check goes on", async () => {
      const memory = new MemoryStorageDriver();
      const registry = makeRegistry();
      await loadMany({ storage: memory, registry }, SEG, 3);
      await loadMany({ storage: memory, registry }, { namespace: 'ns', segment: 't' }, 3);
      await putOver(
        memory,
        { namespace: 'ns', segment: 't', generation: 1 },
        await bytesOf(memory, { namespace: 'ns', segment: 't', generation: 2 }),
      );
      // A summary that is null makes the ledger's agreement test throw.
      const viewed = viewing(registry, (row) =>
        row.segment === 's' ? ({ ...row, summary: null } as unknown as RegistryRecord) : row,
      );
      const report = await runConsistencyCheck(
        { storage: memory, registry: viewed },
        { generations: true },
      );
      expect(report.errored.map((e) => e.segment)).toEqual(['s']);
      expect(report.inconsistent).toEqual([{ ...mismatch(1, 2), segment: 't' }]);
      expect(report.generationsUnchecked).toBe(0);
    });

    it('a size the driver answers that is not a byte count is an error of the segment, not a mismatch', async () => {
      const memory = new MemoryStorageDriver();
      const registry = makeRegistry();
      await loadMany({ storage: memory, registry }, SEG, 3);
      const lying: IStorageDriver = {
        ...recording(memory, []),
        getTail: async (key, maxBytes) => {
          const tail = await memory.getTail(key, maxBytes);
          return maxBytes === FOOTER ? { ...tail, size: 'big' as unknown as number } : tail;
        },
      };
      const report = await runConsistencyCheck({ storage: lying, registry }, { generations: true });
      expect(report.inconsistent).toEqual([]);
      expect(report.errored).toHaveLength(1);
      expect(report.errored[0]!.error).toMatch(/not a byte count/);
    });
  },
);

describe('the option', () => {
  it('is a boolean, in the core check and in the store', async () => {
    const backend = new MemoryStorage();
    const store = new CloudRoaring({ storage: backend, retry: false });
    await expect(
      runConsistencyCheck(backend, { generations: 'yes' as unknown as boolean }),
    ).rejects.toThrow('generations must be a boolean; got yes');
    await expect(
      runConsistencyCheck(backend, { generations: 'yes' as unknown as boolean }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(store.checkConsistency({ generations: 1 as unknown as boolean })).rejects.toThrow(
      'checkConsistency: `generations` must be a boolean; got a number',
    );
  });

  it('is off unless asked for, in the store too', async () => {
    const backend = new MemoryStorage();
    const store = new CloudRoaring({ storage: backend, retry: false });
    await store.load(SEG, [1]);
    await store.load(SEG, [1, 2]);
    await store.load(SEG, [1, 2, 3]);
    await putOver(
      backend.storage,
      { ...SEG, generation: 1 },
      await bytesOf(backend.storage, { ...SEG, generation: 2 }),
    );
    expect(await store.checkConsistency()).toEqual({ checked: 1, inconsistent: [], errored: [] });
    expect(await store.checkConsistency({ generations: false })).toEqual({
      checked: 1,
      inconsistent: [],
      errored: [],
    });
    const report = await store.checkConsistency({ generations: true });
    expect(report.inconsistent).toEqual([mismatch(1, 2)]);
    expect(report.generationsUnchecked).toBe(0);
  });
});

describe('the store', () => {
  it('a footer read that fails transiently is the segment error, whatever the store retries', async () => {
    const memory = new MemoryStorageDriver();
    const registry = new MemoryRegistryDriver();
    await loadMany({ storage: memory, registry }, SEG, 3);
    await putOver(
      memory,
      { ...SEG, generation: 1 },
      await bytesOf(memory, { ...SEG, generation: 2 }),
    );
    const calls: Call[] = [];
    const flaky = recording(memory, calls, (c) =>
      c.bytes === FOOTER && c.generation === 2 ? new TransientError('throttled') : undefined,
    );
    const store = new CloudRoaring({
      storage: brandAsBackend({ storage: flaky, registry }),
      retry: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0, backoffFactor: 1, jitter: 'none' },
    });
    const report = await store.checkConsistency({ generations: true });
    expect(report.inconsistent).toEqual([mismatch(1, 2)]);
    expect(report.errored).toEqual([{ segment: 's', namespace: 'ns', error: 'throttled' }]);
    expect(footerReads(calls).filter((c) => c.generation === 2)).toHaveLength(1);
  });
});

describe('encrypted rows', () => {
  function sealed() {
    const keystore = new InProcessKeystore({ keys: { k: randomBytes(32) }, activeKeyId: 'k' });
    const opened: string[] = [];
    const counted = new Proxy(keystore, {
      get(t, p, rx) {
        const v: unknown = Reflect.get(t, p, rx);
        if (typeof v !== 'function') return v;
        return (...a: unknown[]) => {
          opened.push(String(p));
          return (v as (...args: unknown[]) => unknown).apply(t, a);
        };
      },
    });
    const backend = new MemoryStorage();
    const store = new CloudRoaring({ storage: backend, retry: false, encryption: { keystore } });
    return { backend, store, keystore: counted, opened };
  }

  it('is held with no key, and no key is fetched', async () => {
    const w = sealed();
    await w.store.load(SEG, [1]);
    await w.store.load(SEG, [1, 2]);
    await w.store.load(SEG, [1, 2, 3]);
    const row = (await w.backend.registry.get(SEG))!;
    expect(row.wrappedDeks?.length).toBeGreaterThan(0);
    expect(numbers(row)).toEqual([1, 2]);
    w.opened.length = 0;
    const calls: Call[] = [];
    const storage = recording(w.backend.storage, calls);
    const clean = await runConsistencyCheck(
      { storage, registry: w.backend.registry, keystore: w.keystore },
      { generations: true },
    );
    expect(clean).toEqual({ checked: 1, inconsistent: [], errored: [], generationsUnchecked: 0 });
    expect(w.opened).toEqual([]);
    expect(footerReads(calls).map((c) => c.generation)).toEqual([1, 2]);
    // Swap a known generation for another sealed object, and check from a store with no key at all.
    await putOver(
      w.backend.storage,
      { ...SEG, generation: 1 },
      await bytesOf(w.backend.storage, { ...SEG, generation: 2 }),
    );
    const keyless = await new CloudRoaring({ storage: w.backend, retry: false }).checkConsistency({
      generations: true,
    });
    expect(keyless.inconsistent).toEqual([mismatch(1, 2)]);
    expect(keyless.errored).toEqual([]);
    expect(w.opened).toEqual([]);
  });

  it('a sealed summary and the ledger are both held, and the key is fetched only for the summary', async () => {
    const w = sealed();
    await w.store.load(SEG, [1]);
    await w.store.load(SEG, [1, 2]);
    w.opened.length = 0;
    const withoutSummaries = await runConsistencyCheck(
      { storage: w.backend.storage, registry: w.backend.registry, keystore: w.keystore },
      { generations: true },
    );
    expect(withoutSummaries.inconsistent).toEqual([]);
    expect(w.opened).toEqual([]);
    const both = await runConsistencyCheck(
      { storage: w.backend.storage, registry: w.backend.registry, keystore: w.keystore },
      { generations: true, summaries: true },
    );
    expect(both).toMatchObject({
      summariesUnchecked: 0,
      generationsUnchecked: 0,
      inconsistent: [],
    });
    expect(w.opened).toEqual(['openDek']);
  });
});
