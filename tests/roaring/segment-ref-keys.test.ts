import { CloudRoaring, MemoryStorage, ValidationError, destroySegment } from '@/index';
import { segmentExists } from '@/core/discover';
import { eraseIdFromSegment } from '@/core/erase-id';
import { dropSegment } from '@/core/erasure';
import { judgeLoad, loadSegment } from '@/core/load';
import { clearSegmentRetention, getSegmentRetention, setSegmentRetention } from '@/core/retention';
import { listGenerations, rollbackSegment } from '@/core/rollback';
import type { SegmentRef } from '@/index';
import type { SegmentInfo } from '@/core/discover';
import { REF_KEYS } from '@/core/validate';

/**
 * A segment ref that holds a key it does not take is refused. Read as `{ segment: 'x' }`, `{ segment: 'x', namspace:
 * 'eu' }` would act on the segment of that name in the default namespace: a drop, a rollback or a crypto-shred of the
 * wrong segment, which TypeScript catches only in an object literal. Every public call that takes a ref refuses it, naming the key the caller wrote and the keys a ref takes.
 */

const TYPO = { segment: 'a', namspace: 'eu' } as unknown as SegmentRef;
const MESSAGE = /unknown key "namspace" in the segment ref; a ref takes \{ segment, namespace \}/;

async function world() {
  const backend = new MemoryStorage();
  const store = new CloudRoaring({ storage: backend });
  await store.load({ segment: 'a' }, [1, 2, 3]);
  await store.load({ segment: 'a', namespace: 'eu' }, [9]);
  await store.setRetention({ segment: 'a' }, { expiresAt: Date.now() + 2 * 365 * 86_400_000 });
  return { backend, store };
}

/** The default-namespace segment, as a caller reads it: nothing here may change when a call is refused. */
async function snapshot(store: CloudRoaring) {
  const seg = store.segment('a');
  return {
    count: await seg.count(),
    generations: await store.generations({ segment: 'a' }),
    retention: await store.getRetention({ segment: 'a' }),
    eu: await store.segment('a', { namespace: 'eu' }).count(),
  };
}

describe('every public call that takes a segment ref refuses a key it does not take', () => {
  const facade: Array<[string, (s: CloudRoaring) => unknown]> = [
    ['load', (s) => s.load(TYPO, [1])],
    ['exists', (s) => s.exists(TYPO)],
    ['generations', (s) => s.generations(TYPO)],
    ['rollback', (s) => s.rollback(TYPO, 0)],
    ['dropSegment', (s) => s.dropSegment(TYPO, { confirmSegment: 'a' })],
    ['setRetention', (s) => s.setRetention(TYPO, { expiresAt: Date.now() + 2 * 365 * 86_400_000 })],
    ['getRetention', (s) => s.getRetention(TYPO)],
    ['clearRetention', (s) => s.clearRetention(TYPO)],
    ['invalidate', (s) => s.invalidate(TYPO)],
  ];

  it.each(facade)('store.%s', async (verb, call) => {
    const { store } = await world();
    const before = await snapshot(store);
    await expect(Promise.resolve().then(() => call(store))).rejects.toBeInstanceOf(ValidationError);
    await expect(Promise.resolve().then(() => call(store))).rejects.toThrow(MESSAGE);
    await expect(Promise.resolve().then(() => call(store))).rejects.toThrow(`${verb}: `);
    expect(await snapshot(store)).toEqual(before);
  });

  const deps = {} as never;
  const free: Array<[string, () => unknown]> = [
    ['destroySegment', () => destroySegment(TYPO, deps, { confirmSegment: 'a' })],
    ['dropSegment', () => dropSegment(TYPO, deps, { confirmSegment: 'a' })],
    ['rollback', () => rollbackSegment(TYPO, 0, deps)],
    ['generations', () => listGenerations(TYPO, deps)],
    ['exists', () => segmentExists(TYPO, deps)],
    ['getRetention', () => getSegmentRetention(TYPO, deps)],
    ['setRetention', () => setSegmentRetention(TYPO, deps, { expiresAt: Date.now() })],
    ['clearRetention', () => clearSegmentRetention(TYPO, deps)],
    ['load', () => loadSegment(TYPO, [1], deps)],
    ['judgeLoad', () => judgeLoad(TYPO, 1, deps)],
    ['eraseIdFromSegment', () => eraseIdFromSegment(TYPO, 1, deps, {})],
  ];

  it.each(free)('the free function behind %s', async (verb, call) => {
    await expect(Promise.resolve().then(call)).rejects.toThrow(MESSAGE);
    await expect(Promise.resolve().then(call)).rejects.toBeInstanceOf(ValidationError);
    await expect(Promise.resolve().then(call)).rejects.toThrow(`${verb}: `);
  });

  it('a segment handle, a pinned handle and an array are told what a ref is', async () => {
    const { store } = await world();
    const seg = store.segment('a');
    const handle = /a segment handle is not a ref; pass \{ segment, namespace \}/;
    await expect(store.generations(seg as never)).rejects.toThrow(handle);
    await expect(store.exists((await seg.pin()) as never)).rejects.toThrow(handle);
    await expect(store.dropSegment(seg as never, { confirmSegment: 'a' })).rejects.toThrow(handle);
    await expect(
      destroySegment(seg as never, {} as never, { confirmSegment: 'a' }),
    ).rejects.toThrow(handle);
    await expect(store.exists(['a'] as never)).rejects.toThrow('not an array');
  });

  it('a result row of another call is not a ref', async () => {
    const { store } = await world();
    const issue = { segment: 'a', currentGen: 0, issue: 'x', generation: 1 } as never;
    await expect(store.rollback(issue, 0)).rejects.toThrow('unknown keys "issue", "generation"');
  });

  it('names every unknown key the caller wrote', async () => {
    const { store } = await world();
    const ref = { segment: 'a', namspace: 'eu', foo: 1 } as unknown as SegmentRef;
    await expect(store.exists(ref)).rejects.toThrow('unknown keys "namspace", "foo"');
  });
});

describe('a destructive call on a misspelt ref touches no segment', () => {
  it('dropSegment leaves the default-namespace segment and its objects', async () => {
    const { backend, store } = await world();
    await expect(
      store.dropSegment({ segment: 'a', namspace: 'eu' } as never, { confirmSegment: 'a' }),
    ).rejects.toThrow(MESSAGE);
    expect(await store.segment('a').count()).toBe(3);
    expect((await store.generations({ segment: 'a' })).length).toBeGreaterThan(0);
    expect(await segmentExists({ segment: 'a' }, backend.registry)).toBe(true);
  });

  it('destroySegment does not crypto-shred the default-namespace segment', async () => {
    const { backend, store } = await world();
    await expect(
      destroySegment(TYPO, { registry: backend.registry } as never, {
        confirmSegment: 'a',
        allowCleartext: true,
      }),
    ).rejects.toThrow(MESSAGE);
    expect(await store.segment('a').count()).toBe(3);
    expect(await store.exists({ segment: 'a' })).toBe(true);
  });

  it('rollback leaves the pointer where it was', async () => {
    const { store } = await world();
    await store.load({ segment: 'a' }, [1, 2, 3, 4]);
    await expect(store.rollback(TYPO, 0)).rejects.toThrow(MESSAGE);
    expect(await store.segment('a').count()).toBe(4);
  });
});

describe('a ref that is a listing row, or carries no namespace, is still taken', () => {
  it('a row from segments() goes straight back into a call', async () => {
    const { store } = await world();
    const rows = [];
    for await (const row of store.segments()) rows.push(row);
    const row = rows.find((r) => r.segment === 'a' && r.namespace === undefined)!;
    expect(await store.exists(row)).toBe(true);
    expect(await store.getRetention(row)).not.toBeNull();
    const eu = rows.find((r) => r.namespace === 'eu')!;
    expect((await store.dropSegment(eu, { confirmSegment: 'a' })).dropped).toBe(true);
    expect(await store.segment('a').count()).toBe(3);
  });

  it('a ref with an undefined namespace is the default namespace', async () => {
    const { store } = await world();
    expect(await store.exists({ segment: 'a', namespace: undefined })).toBe(true);
  });
});

describe('the keys a ref takes follow a listing row', () => {
  it('are exactly the fields of SegmentInfo, so a field added there is listed or this fails', () => {
    const fields: Record<keyof SegmentInfo, true> = {
      segment: true,
      namespace: true,
      currentGen: true,
      status: true,
    };
    expect([...REF_KEYS].sort()).toEqual(Object.keys(fields).sort());
  });
});
