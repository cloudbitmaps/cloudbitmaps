vi.mock('@/core/crbm/reader', async (original) =>
  (await import('../helpers/chunks-not-kept')).withoutKeptChunks(await original()),
);
/**
 * A warm reader keys what it caches on a generation with the row's `pointerId` (invariant 2). A number is taken again
 * once its object is deleted: a rollback, an erasure of the generation above the pointer that held an id, and a load
 * that numbers past the pointer again. Every write on the way renews the row's `pointerId`, so once the reader's refresh
 * lapses it opens the new object and never returns a chunk it cached from the old one under that number.
 *
 * Two controls show what holds this: a registry that kept `pointerId` across those writes would leave the reader on the
 * old object, unless the row's summary named the new one, which the reader also checks before it keeps a reader.
 */
import type { IRegistryDriver, RegistryRecord, SegmentRef } from '@/core/ports';
import { brandAsBackend } from '@/core/ports';
import type { Clock } from '@/index';
import { CloudRoaring, MemoryStorage } from '@/index';

const NS = 'ns';
const A: SegmentRef = { namespace: NS, segment: 'a' };
const HI = 65_536;
const TTL = 2_000;
/** Generation 2 as the reader caches it: 20 is the id the erasure removes. */
const OLD = [20, HI + 20];
/** What a load writes under number 2 once the erasure has deleted the old object. */
const NEW = [30, HI + 30];

function manualClock(): Clock & { advance(ms: number): void } {
  let t = 1_000_000;
  return { now: () => t, sleep: async () => {}, advance: (ms) => void (t += ms) };
}

/**
 * The registry as the reader sees it: as it is, or (a control) one whose `pointerId` never moves from what the reader
 * first saw, with or without the row's summary.
 */
function seenThrough(
  base: IRegistryDriver,
  control: 'none' | 'frozen pointerId' | 'frozen pointerId, no summary',
): IRegistryDriver {
  if (control === 'none') return base;
  let first: string | undefined;
  const freeze = (r: RegistryRecord | null): RegistryRecord | null => {
    if (r === null) return null;
    first ??= r.pointerId;
    const frozen = { ...r, pointerId: first };
    return control === 'frozen pointerId' ? frozen : { ...frozen, summary: undefined };
  };
  return {
    capabilities: () => base.capabilities(),
    get: async (ref) => freeze(await base.get(ref)),
    create: (ref, rec, o) => base.create(ref, rec, o),
    compareAndSwap: (ref, t, p, o) => base.compareAndSwap(ref, t, p, o),
    list: (ns) => base.list(ns),
    delete: (ref, t) => base.delete(ref, t),
  };
}

async function world(control: Parameters<typeof seenThrough>[1]) {
  const backend = new MemoryStorage();
  const writer = new CloudRoaring({ storage: backend, retry: false });
  const clock = manualClock();
  const reader = new CloudRoaring({
    storage: brandAsBackend({
      storage: backend.storage,
      registry: seenThrough(backend.registry, control),
    }),
    retry: false,
    seams: { clock },
    cache: { genTtlMs: TTL },
  });
  await writer.load(A, [10, HI + 10], { keep: 9 });
  await writer.load(A, [11, HI + 11], { keep: 9 });
  await writer.load(A, OLD, { keep: 9 });
  const a = reader.segment('a', { namespace: NS });
  // Warm: the reader opens generation 2 and caches both its chunks.
  expect(await a.has(20)).toBe(true);
  expect(await a.has(HI + 20)).toBe(true);
  // Number 2 is taken again.
  await writer.rollback(A, 0);
  const erased = await writer.eraseSubject(20, { namespace: NS });
  expect(erased.erasedFrom).toEqual([expect.objectContaining({ segment: 'a', erased: true })]);
  expect(await writer.load(A, NEW, { keep: 9 })).toMatchObject({ generation: 2, published: true });
  return { a, clock };
}

async function ids(a: ReturnType<CloudRoaring['segment']>): Promise<number[]> {
  const out: number[] = [];
  for await (const id of a.iterate()) out.push(id);
  return out;
}

describe('a number taken again under a warm reader (invariant 2)', () => {
  it('inside the refresh window the reader answers one generation, the one it cached; after it, the new object', async () => {
    const { a, clock } = await world('none');
    expect([OLD, NEW]).toContainEqual(await ids(a));
    clock.advance(TTL + 1);
    expect(await ids(a)).toEqual(NEW);
    expect(await a.has(20)).toBe(false);
  });

  it('control: a registry that kept pointerId is still caught by the summary naming the new object', async () => {
    const { a, clock } = await world('frozen pointerId');
    clock.advance(TTL + 1);
    expect(await ids(a)).toEqual(NEW);
    expect(await a.has(20)).toBe(false);
  });

  it('control: a registry that kept pointerId, with no summary to name the object, leaves the reader on the old one', async () => {
    const { a, clock } = await world('frozen pointerId, no summary');
    clock.advance(TTL + 1);
    // What renewing pointerId prevents: the erased id, served from chunks cached from an object that is gone.
    expect(await a.has(20)).toBe(true);
  });
});
