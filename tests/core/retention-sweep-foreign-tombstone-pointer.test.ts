import { randomBytes } from 'node:crypto';
import { destroySegment } from '@/index';
import { dropSegment } from '@cloudbitmaps/core';
import { InProcessKeystore } from '@/drivers/crypto';
import type { SegmentRef } from '@/index';
import { dueBucket, dueNamespace } from '@/core/due-index';
import { loadedStore } from '../helpers/loaded';

/**
 * A segment destroyed or dropped by hand after it was given a retention policy keeps a tombstone the sweep did not
 * write, so the sweep never retires or purges it. Its due-index pointer names nothing the sweep can act on, and the
 * sweep removes it when a scan reads it. The tombstone itself stays.
 */
const DAY = 86_400_000;
const T0 = 1_754_000_000_000;

async function pointersIn(
  registry: { list(ns?: string): AsyncIterable<{ segment: string }> },
  expiresAt: number,
): Promise<string[]> {
  const found: string[] = [];
  for await (const row of registry.list(dueNamespace(dueBucket(expiresAt))))
    found.push(row.segment);
  return found;
}

for (const scan of ['fleet', 'index'] as const) {
  for (const how of ['dropped', 'destroyed'] as const) {
    it(`removes the due pointer of a segment ${how} by hand (scan: ${scan}) and keeps its tombstone`, async () => {
      const w = await loadedStore(
        {},
        { seams: { clock: { now: () => T0, sleep: () => Promise.resolve() } } },
      );
      const soon = T0 + DAY;
      const ref: SegmentRef = { namespace: 'active', segment: 'a' };
      const other: SegmentRef = { namespace: 'active', segment: 'b' };
      if (how === 'dropped') {
        await w.load(ref, [1, 2, 3]);
      } else {
        const keystore = new InProcessKeystore({
          keys: { k1: randomBytes(32) },
          activeKeyId: 'k1',
        });
        const minted = await keystore.createDek();
        await w.registry.create(ref, { currentGen: 0, wrappedDeks: minted.wrapped });
      }
      await w.load(other, [4]);
      await w.store.setRetention(ref, { expiresAt: soon });
      await w.store.setRetention(other, { expiresAt: soon + 90 * DAY });
      expect(await pointersIn(w.registry, soon)).toHaveLength(1);

      if (how === 'dropped') {
        await dropSegment(
          ref,
          { registry: w.registry, storage: w.storage },
          { confirmSegment: 'a' },
        );
      } else {
        await destroySegment(ref, { registry: w.registry }, { confirmSegment: 'a' });
      }
      expect((await w.registry.get(ref))!.status).toBe('destroyed');

      const swept = await w.store.retireExpired({ scan, now: soon + 1 });

      expect(swept.retired).toBe(0);
      expect(await pointersIn(w.registry, soon)).toEqual([]);
      expect((await w.registry.get(ref))!.status).toBe('destroyed'); // the attestation stays
      expect(await pointersIn(w.registry, soon + 90 * DAY)).toHaveLength(1); // a live segment's pointer stays
    });
  }
}
