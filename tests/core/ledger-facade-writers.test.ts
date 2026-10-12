import { openGenerationReader } from '@/core/crbm-open';
import { usableSummary } from '@/core/summary';
import type { GenKey } from '@/core/ports';
import { CloudRoaring, MemoryStorage } from '@/index';
import { objectFingerprint } from '../helpers/fingerprint';

/**
 * The facade's writers that publish through core's bulk path (`intersectInto`, `unionInto`, `andNotInto` and
 * `materializeMany`) leave the row's ledger and summary as every other writer does: each generation made current is
 * named in `knownGens`, oldest first, with the footer checksum of its object, and the summary carries the object's own
 * `tailBytes`. They publish with a `keep` that is not a window, so the ledger carries every generation made current.
 */

const SEG = (segment: string): GenKey => ({ segment, generation: 0 });

async function expectRowMatchesObjects(
  backend: MemoryStorage,
  segment: string,
  generations: number[],
): Promise<void> {
  const row = (await backend.registry.get({ segment }))!;
  expect(row.knownGens!.map((e) => e.generation)).toEqual(generations);
  for (const e of row.knownGens!) {
    const fingerprint = await objectFingerprint(backend.storage, {
      segment,
      generation: e.generation,
    });
    expect(e.footerCrc, `${segment} generation ${e.generation}`).toBe(
      Number(fingerprint.slice(fingerprint.indexOf(':') + 1)),
    );
  }
  const summary = usableSummary({ segment }, row, undefined);
  expect(summary, `${segment} has a usable summary`).toBeDefined();
  const reader = await openGenerationReader(
    backend.storage,
    { ...SEG(segment), generation: row.currentGen! },
    undefined,
  );
  expect(summary!.tailBytes).toBe(reader.tailBytes);
}

describe('the ledger and the summary the facade’s bulk writers leave', () => {
  it('intersectInto, unionInto and andNotInto, three publishes into one destination', async () => {
    const backend = new MemoryStorage();
    const store = new CloudRoaring({ storage: backend, cache: { genTtlMs: 0 } });
    await store.load({ segment: 'a' }, [1, 2, 3, 70_000]);
    await store.load({ segment: 'b' }, [2, 3, 70_001]);
    const dest = store.segment('dest');
    await store.segment('a').intersectInto(dest, [store.segment('b')]);
    await store.segment('a').unionInto(dest, [store.segment('b')]);
    await store.segment('a').andNotInto(dest, [store.segment('b')]);
    await expectRowMatchesObjects(backend, 'dest', [0, 1, 2]);
  });

  it('materializeMany, two outputs', async () => {
    const backend = new MemoryStorage();
    const store = new CloudRoaring({ storage: backend, cache: { genTtlMs: 0 } });
    await store.load({ segment: 'a' }, [1, 2, 3, 70_000]);
    await store.load({ segment: 'b' }, [2, 3, 70_001]);
    for (let round = 0; round < 2; round++) {
      const run = await store.materializeMany({
        operands: { a: store.segment('a'), b: store.segment('b') },
        outputs: [
          { dest: store.segment('x'), expr: { and: ['a', 'b'] } },
          { dest: store.segment('y'), expr: { or: ['a', 'b'] } },
        ],
        keep: Number.MAX_SAFE_INTEGER,
      });
      expect(run.outputs.map((o) => o.published)).toEqual([true, true]);
    }
    await expectRowMatchesObjects(backend, 'x', [0, 1]);
    await expectRowMatchesObjects(backend, 'y', [0, 1]);
  });
});
