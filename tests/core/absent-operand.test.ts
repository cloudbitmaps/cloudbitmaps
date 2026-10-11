import { MemoryStorage, CloudRoaring } from '@/index';
import { setSegmentRetention } from '@/core/retention';
import { ValidationError } from '@/core/errors';
import type { SegmentRef } from '@/index';
import { bulkLoadCrbmGeneration } from '../helpers/bulk-load';
import { brandAsBackend } from '@/core/ports';
import { MemoryRegistryDriver, MemoryStorageDriver } from '@/drivers/memory';
import { SegmentEngine } from '@/core/engine';
import { compileCombineMany, runCombineMany } from '@/core/combine-many';
import type { StorageChunkSource } from '@/core/ports';
import { roaringCodec, SafeBitmap } from '@/roaring-codec';
import { joinId } from '@/core/bit-route';

/**
 * A segment that resolves to nothing is ambiguous in a way that matters only as an **operand**.
 *
 * Read it directly and "empty" is right either way. Pass it to a combine and the two states diverge: a
 * suppression list with nobody on it correctly suppresses nothing, while one whose namespace you omitted
 * silently suppresses nothing — and the result is not obviously-empty, it is the full audience and plausibly
 * right. The failure mode is mailing the people who opted out.
 */
const AUDIENCE: SegmentRef = { namespace: 'audiences', segment: 'active-30d' };
const OPTOUT: SegmentRef = { namespace: 'suppression', segment: 'global-opt-out' };

async function collect(it: AsyncIterable<number>): Promise<number[]> {
  const out: number[] = [];
  for await (const v of it) out.push(v);
  return out;
}

async function world() {
  const backend = new MemoryStorage();
  const { storage, registry } = backend;
  await bulkLoadCrbmGeneration(storage, { ...AUDIENCE, generation: 0 }, [1, 2, 3, 4], { registry });
  await bulkLoadCrbmGeneration(storage, { ...OPTOUT, generation: 0 }, [2, 3], { registry });
  const store = new CloudRoaring({ storage: backend });
  return {
    storage,
    registry,
    store,
    audience: store.segment('active-30d', { namespace: 'audiences' }),
  };
}

describe('a combine refuses an operand that names a segment which does not exist', () => {
  it('the mis-namespaced suppression list — the case that mails the opted-out', async () => {
    const w = await world();
    const wrong = w.store.segment('global-opt-out'); // namespace omitted: a DIFFERENT segment
    await expect(collect(w.audience.andNot([wrong]))).rejects.toThrow(ValidationError);
    await expect(collect(w.audience.andNot([wrong]))).rejects.toThrow(/does not exist/);
  });

  it('names the segment and the namespace in the message', async () => {
    const w = await world();
    await expect(
      collect(w.audience.andNot([w.store.segment('opt-out-typo', { namespace: 'suppression' })])),
    ).rejects.toThrow(/"suppression\/opt-out-typo"/);
  });

  it('the correctly addressed list still suppresses', async () => {
    const w = await world();
    const right = w.store.segment('global-opt-out', { namespace: 'suppression' });
    expect(await collect(w.audience.andNot([right]))).toEqual([1, 4]);
  });

  it('applies to `exclude` on the intersect family too', async () => {
    const w = await world();
    const wrong = w.store.segment('global-opt-out');
    await expect(collect(w.audience.intersect([w.audience], { exclude: [wrong] }))).rejects.toThrow(
      ValidationError,
    );
  });

  it('applies to includes as well — both directions are wiring errors', async () => {
    const w = await world();
    await expect(collect(w.audience.intersect([w.store.segment('nope')]))).rejects.toThrow(
      ValidationError,
    );
    await expect(collect(w.audience.union([w.store.segment('nope')]))).rejects.toThrow(
      ValidationError,
    );
  });

  it('a segment that EXISTS but is empty is fine — that is the legitimate case', async () => {
    // A row minted by `setRetention` before the first load: created deliberately, holds nothing yet.
    const w = await world();
    const empty: SegmentRef = { namespace: 'suppression', segment: 'not-loaded-yet' };
    await setSegmentRetention(
      empty,
      { registry: w.registry },
      { expiresAt: Date.now() + 86_400_000 },
    );

    const handle = w.store.segment('not-loaded-yet', { namespace: 'suppression' });
    expect(await collect(w.audience.andNot([handle]))).toEqual([1, 2, 3, 4]); // suppresses nothing, correctly
  });

  it('`allowAbsentOperands: true` is the escape hatch', async () => {
    const w = await world();
    const wrong = w.store.segment('global-opt-out');
    expect(await collect(w.audience.andNot([wrong], { allowAbsentOperands: true }))).toEqual([
      1, 2, 3, 4,
    ]);
  });

  it('reading an absent segment directly is not refused — it answers empty', async () => {
    const w = await world();
    const missing = w.store.segment('never-created', { namespace: 'audiences' });
    expect(await missing.count()).toBe(0);
    expect(await missing.has(1)).toBe(false);
    expect(await collect(missing.iterate())).toEqual([]);
  });

  it('costs nothing when every operand has data', async () => {
    const real = new MemoryStorageDriver();
    const registry = new MemoryRegistryDriver();
    await bulkLoadCrbmGeneration(real, { ...AUDIENCE, generation: 0 }, [1, 2, 3, 4], { registry });
    await bulkLoadCrbmGeneration(real, { ...OPTOUT, generation: 0 }, [2, 3], { registry });

    let registryGets = 0;
    const counting = new Proxy(registry, {
      get(target, prop, receiver) {
        if (prop !== 'get') return Reflect.get(target, prop, receiver) as unknown;
        return async (ref: SegmentRef) => {
          registryGets += 1;
          return registry.get(ref);
        };
      },
    }) as unknown as MemoryRegistryDriver;

    const store = new CloudRoaring({
      storage: brandAsBackend({ storage: real, registry: counting }),
      cache: { genTtlMs: 0 },
    });
    const audience = store.segment('active-30d', { namespace: 'audiences' });
    const optout = store.segment('global-opt-out', { namespace: 'suppression' });
    await collect(audience.andNot([optout]));
    const baseline = registryGets;

    registryGets = 0;
    await collect(audience.andNot([optout]));
    expect(registryGets).toBe(0); // no timed refresh, both operands non-empty: no existence check at all
    expect(baseline).toBeGreaterThan(0);
  });
});

describe('a combine checks its own segment as it checks its operands', () => {
  // A base that names no segment is refused, rather than read as empty.
  function never(w: Awaited<ReturnType<typeof world>>) {
    return w.store.segment('never-loaded', { namespace: 'audiences' });
  }

  it('refuses a base that does not exist, on union and andNot', async () => {
    const w = await world();
    const base = never(w);
    for (const read of [() => base.andNot([w.audience]), () => base.union([w.audience])]) {
      await expect(collect(read())).rejects.toThrow(ValidationError);
      await expect(collect(read())).rejects.toThrow(/"audiences\/never-loaded" names a segment/);
    }
  });

  it('reads it as empty under `allowAbsentOperands: true`', async () => {
    const w = await world();
    expect(await collect(never(w).andNot([w.audience], { allowAbsentOperands: true }))).toEqual([]);
    // A union reads the absent base as empty, and so holds what its operand holds.
    expect(await collect(never(w).union([w.audience], { allowAbsentOperands: true }))).toEqual(
      await collect(w.audience.iterate()),
    );
  });
});

describe('an operand that was dropped or retired is refused like one that never existed', () => {
  it('an exclude whose segment was dropped does not quietly suppress nobody', async () => {
    const w = await world();
    const optout = w.store.segment('global-opt-out', { namespace: 'suppression' });
    // Control: while it exists, it suppresses.
    expect(await collect(w.audience.andNot([optout]))).toEqual([1, 4]);
    await w.store.dropSegment(OPTOUT, { confirmSegment: OPTOUT.segment });
    expect(await w.store.exists(OPTOUT)).toBe(false);
    await expect(collect(w.audience.andNot([optout]))).rejects.toBeInstanceOf(ValidationError);
    await expect(
      collect(w.audience.intersect([w.audience], { exclude: [optout] })),
    ).rejects.toThrow(/does not exist or was dropped/);
    // And a caller that means it says so.
    expect(await collect(w.audience.andNot([optout], { allowAbsentOperands: true }))).toEqual([
      1, 2, 3, 4,
    ]);
  });
});

/** Counts the calls of one kind in flight, and the most there were at once. */
class InFlight {
  now = 0;
  peak = 0;
  readonly asked: string[] = [];
  async run<T>(name: string, answer: () => T | Promise<T>): Promise<T> {
    this.asked.push(name);
    this.now += 1;
    this.peak = Math.max(this.peak, this.now);
    try {
      // One turn of the microtask queue: every call the caller starts at once is in flight before any settles.
      await null;
      return await answer();
    } finally {
      this.now -= 1;
    }
  }
}

/** A promise that settles only when the test says so. */
function held(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => (release = resolve));
  return { promise, release };
}

/**
 * A source whose every segment is empty and absent, counting the listings and the `exists` reads in flight: a combine of
 * many such operands lists and asks after each of them, and must not do either for all of them at once (invariant 6).
 * `answers` overrides what one segment's listing or `exists` does.
 */
class AbsentEverywhere implements StorageChunkSource {
  readonly listing = new InFlight();
  readonly existing = new InFlight();
  constructor(
    private readonly answers: {
      readonly list?: Record<string, () => Promise<number[]>>;
      readonly exists?: Record<string, () => Promise<boolean>>;
    } = {},
  ) {}
  async getChunk(): Promise<Uint8Array | null> {
    return null;
  }
  listChunkKeys(ref: SegmentRef): Promise<number[]> {
    return this.listing.run(ref.segment, this.answers.list?.[ref.segment] ?? (() => []));
  }
  exists(ref: SegmentRef): Promise<boolean> {
    return this.existing.run(ref.segment, this.answers.exists?.[ref.segment] ?? (() => false));
  }
}

/** Every segment holds one id in each of `keys` chunks and is at version `v1`, counting the version lookups in flight. */
class LoadedEverywhere implements StorageChunkSource {
  readonly versions = new InFlight();
  /** Version lookups made once the first chunk was read: the looks of a running read. */
  readonly looks = new InFlight();
  private reading = false;
  private readonly bytes = SafeBitmap.fromValues([1]).serialize();
  constructor(private readonly keys: number) {}
  async getChunk(): Promise<Uint8Array | null> {
    this.reading = true;
    return this.bytes;
  }
  async listChunkKeys(): Promise<number[]> {
    return Array.from({ length: this.keys }, (_, k) => k);
  }
  currentVersion(ref: SegmentRef): Promise<string> {
    return (this.reading ? this.looks : this.versions).run(ref.segment, () => 'v1');
  }
}

const failure = <T>(p: Promise<T>): Promise<unknown> =>
  p.then(
    () => undefined,
    (e: unknown) => e,
  );

describe('a combine reads its operands a bounded number at a time', () => {
  const WIDE = 40;
  const refs = Array.from({ length: WIDE }, (_, i): SegmentRef => ({ segment: `gone-${i}` }));

  it('lists at most 16 operands at once, asks after at most 16, and names every one that is absent', async () => {
    const source = new AbsentEverywhere();
    const engine = new SegmentEngine({ storage: source, codec: roaringCodec });
    const error = await failure(collect(engine.intersect(refs)));
    expect(error).toBeInstanceOf(ValidationError);
    expect(source.listing.asked).toHaveLength(WIDE);
    expect(source.listing.peak).toBe(16);
    expect(source.existing.asked).toHaveLength(WIDE);
    expect(source.existing.peak).toBe(16);
    const message = (error as Error).message;
    expect(message.startsWith('intersect: operand "gone-0", "gone-1",')).toBe(true);
    expect(message).toContain(`"gone-${WIDE - 1}" names a segment`);
  });

  it('lists and asks after an exclude list the same way, includes first', async () => {
    const source = new AbsentEverywhere();
    const engine = new SegmentEngine({ storage: source, codec: roaringCodec });
    await expect(collect(engine.andNot(refs[0]!, refs.slice(1)))).rejects.toThrow(
      /^andNot: operand "gone-0", "gone-1",/,
    );
    expect(source.listing.peak).toBe(16);
    expect(source.listing.asked).toEqual(refs.map((r) => r.segment));
    expect(source.existing.peak).toBe(16);
    expect(source.existing.asked).toEqual(refs.map((r) => r.segment));
  });

  it('looks up at most 16 operand versions at once when a running union looks', async () => {
    const source = new LoadedEverywhere(12);
    const engine = new SegmentEngine({ storage: source, codec: roaringCodec });
    const ops = Array.from({ length: WIDE }, (_, i): SegmentRef => ({ segment: `s${i}` }));
    const ids = await collect(engine.union(ops, { concurrency: 4 }));
    expect(ids).toEqual(Array.from({ length: 12 }, (_, k) => joinId(k, 1)));
    expect(source.versions.peak).toBe(16);
    // A union looks every `concurrency` keys, each time at every operand.
    expect(source.looks.asked.length).toBeGreaterThanOrEqual(2 * WIDE);
    expect(source.looks.asked.length % WIDE).toBe(0);
    expect(source.looks.peak).toBe(16);
  });

  it('rejects with the first failed existence check at once, and asks nothing more', async () => {
    const slow = held();
    const boom = new Error('the registry failed');
    const source = new AbsentEverywhere({
      exists: {
        'gone-0': async () => {
          throw boom;
        },
        'gone-1': async () => {
          await slow.promise;
          return false;
        },
      },
    });
    const engine = new SegmentEngine({ storage: source, codec: roaringCodec });
    // Settles while the read of gone-1 is still in flight: the refusal does not wait for it.
    expect(await failure(collect(engine.intersect(refs)))).toBe(boom);
    expect(source.existing.now).toBeGreaterThan(0);
    const asked = source.existing.asked.length;
    expect(asked).toBeLessThanOrEqual(16);
    slow.release();
    await new Promise((resolve) => setImmediate(resolve));
    expect(source.existing.asked).toHaveLength(asked);
    expect(source.existing.now).toBe(0);
  });

  it('rejects with the first failed listing at once, and lists nothing more', async () => {
    const slow = held();
    const boom = new Error('the listing failed');
    const source = new AbsentEverywhere({
      list: {
        'gone-0': async () => {
          throw boom;
        },
        'gone-1': async () => {
          await slow.promise;
          return [];
        },
      },
    });
    const engine = new SegmentEngine({ storage: source, codec: roaringCodec });
    expect(await failure(collect(engine.intersect(refs)))).toBe(boom);
    expect(source.listing.now).toBeGreaterThan(0);
    const listed = source.listing.asked.length;
    expect(listed).toBeLessThanOrEqual(16);
    slow.release();
    await new Promise((resolve) => setImmediate(resolve));
    expect(source.listing.asked).toHaveLength(listed);
    expect(source.existing.asked).toHaveLength(0);
  });

  it('says, word for word, which operands of a combine are absent and what to do', async () => {
    const engine = new SegmentEngine({ storage: new AbsentEverywhere(), codec: roaringCodec });
    const error = await failure(
      collect(
        engine.intersect([{ namespace: 'suppression', segment: 'opt-out' }, { segment: 'typo' }]),
      ),
    );
    expect((error as Error).message).toBe(
      'intersect: operand "suppression/opt-out", "typo" names a segment that does not exist or was dropped, so it ' +
        'would contribute nothing — an exclude would suppress no ids and an include would contribute none. Check the ' +
        'name and the namespace (a segment addressed without its `namespace` is a DIFFERENT segment). Pass ' +
        '`allowAbsentOperands: true` if you meant it.',
    );
  });

  it("asks after a batch combine's operands at most 16 at once, and names them word for word", async () => {
    const source = new AbsentEverywhere();
    const operands = refs.map((ref) => ({ name: ref.segment, ref }));
    const compiled = compileCombineMany({
      operands,
      outputs: [
        {
          expr: { or: refs.map((r) => r.segment) },
          publish: async () => undefined,
        },
      ],
      keep: 1,
      maxBufferedBytes: 1 << 26,
      publishConcurrency: 1,
      concurrency: 1,
    });
    const error = await failure(
      runCombineMany(compiled, {
        source,
        codec: roaringCodec,
        clock: { now: () => 0, sleep: async () => {} },
      }),
    );
    expect(error).toBeInstanceOf(ValidationError);
    expect(source.existing.peak).toBe(16);
    const named = refs.map((r) => `"${r.segment}"`).join(', ');
    expect((error as Error).message).toBe(
      `materializeMany: operand ${named} names a segment that does not exist or was dropped, so it would contribute ` +
        'nothing — an exclude would suppress no ids and an include would contribute none. Check the name and the ' +
        'namespace (a segment addressed without its `namespace` is a DIFFERENT segment). Pass ' +
        '`allowAbsentOperands: true` if you meant it.',
    );
  });
});
