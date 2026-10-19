import { randomBytes } from 'node:crypto';
import { ValidationError } from '@/core/errors';
import { destroySegment, dropSegment } from '@/core/erasure';
import { loadSegment } from '@/core/load';
import { listGenerations } from '@/core/rollback';
import { setSegmentRetention } from '@/core/retention';
import { InProcessKeystore } from '@/drivers/crypto';
import { MemoryStorage } from '@/index';
import type { SegmentRef } from '@/index';
import { roaringCodec } from '@/roaring-codec';
import { bulkLoadCrbmGeneration } from '../helpers/bulk-load';
import { publishGeneration } from '../helpers/publish';
import { testEntropy } from '../helpers/entropy';

/**
 * A destroyed row is written by three routes: a crypto-shred, a cleartext destroy (its objects stay in the bucket,
 * readable) and a drop. What is true of all three is that no generation resolves through the row and every writer
 * refuses it, so the errors and the generation listing say that, and none calls the row a crypto-shred.
 */

const SEG: SegmentRef = { namespace: 'ns', segment: 's' };

type Route = 'crypto-shred' | 'cleartext destroy' | 'drop';
const ROUTES: Route[] = ['crypto-shred', 'cleartext destroy', 'drop'];

/** A segment with three generations, destroyed by `route`. */
async function destroyed(route: Route) {
  const backend = new MemoryStorage();
  const { storage, registry } = backend;
  const keystore =
    route === 'crypto-shred'
      ? new InProcessKeystore({ keys: { A: randomBytes(32) }, activeKeyId: 'A' })
      : undefined;
  const deps = { storage, registry, entropy: testEntropy, codec: roaringCodec, keystore };
  for (const ids of [[1], [1, 2], [1, 2, 3]]) await loadSegment(SEG, ids, deps, { keep: 9 });
  if (route === 'drop') await dropSegment(SEG, { storage, registry }, { confirmSegment: 's' });
  else
    await destroySegment(
      SEG,
      { registry },
      { confirmSegment: 's', ...(route === 'cleartext destroy' ? { allowCleartext: true } : {}) },
    );
  expect((await registry.get(SEG))!.status).toBe('destroyed');
  return { backend, storage, registry, deps };
}

const refusal = async (p: Promise<unknown>): Promise<string> => {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ValidationError);
  const message = (err as Error).message;
  expect(message).not.toMatch(/crypto-shred|unreadable/i);
  return message;
};

describe.each(ROUTES)('a segment destroyed by a %s', (route) => {
  it('refuses a load, saying the row is destroyed and not how it got there', async () => {
    const w = await destroyed(route);
    expect(await refusal(loadSegment(SEG, [9], w.deps))).toBe(
      'segment "s" is destroyed — refusing to write: no generation resolves through a destroyed row; use a new segment',
    );
  });

  it('refuses a bulk write with the same text', async () => {
    const w = await destroyed(route);
    expect(
      await refusal(
        bulkLoadCrbmGeneration(w.storage, { ...SEG, generation: 7 }, [9], { registry: w.registry }),
      ),
    ).toBe(
      'segment "s" is destroyed — refusing to write: no generation resolves through a destroyed row; use a new segment',
    );
  });

  it('refuses a retention policy', async () => {
    const w = await destroyed(route);
    const message = await refusal(
      setSegmentRetention(
        SEG,
        { registry: w.registry },
        { expiresAt: Date.now() + 86_400_000 * 400 },
      ),
    );
    expect(message).toBe(
      'segment "s" is destroyed — refusing to set a retention policy on a tombstone; there is nothing left to retire. Use a new segment.',
    );
  });

  it('refuses a publish that finds the row destroyed', async () => {
    const w = await destroyed(route);
    expect(await refusal(publishGeneration(w.registry, { ...SEG, generation: 7 }))).toBe(
      'segment "s" was destroyed while generation 7 was being written — refusing to publish it: no generation resolves through a destroyed row. Use a new segment.',
    );
  });

  it('lists no generation as current: the row keeps its pointer, but no read resolves through it', async () => {
    const w = await destroyed(route);
    const row = (await w.registry.get(SEG))!;
    expect(row.currentGen).toBe(2); // the tombstone keeps the pointer it had
    const entries = await listGenerations(SEG, { storage: w.storage, registry: w.registry });
    // A drop deleted its objects; the other two routes left them in the bucket.
    expect(entries.map((e) => e.generation)).toEqual(route === 'drop' ? [] : [0, 1, 2]);
    expect(entries.filter((e) => e.current)).toEqual([]);
    expect(entries.every((e) => e.cardinality === undefined && e.metadata === undefined)).toBe(
      true,
    );
  });
});

it('still marks the current generation of an active segment', async () => {
  const backend = new MemoryStorage();
  const { storage, registry } = backend;
  const deps = { storage, registry, entropy: testEntropy, codec: roaringCodec };
  await loadSegment(SEG, [1], deps, { keep: 9 });
  await loadSegment(SEG, [1, 2], deps, { keep: 9 });
  const entries = await listGenerations(SEG, { storage, registry });
  expect(entries.map((e) => [e.generation, e.current])).toEqual([
    [0, false],
    [1, true],
  ]);
});
