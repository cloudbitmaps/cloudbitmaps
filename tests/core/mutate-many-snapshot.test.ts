import { CloudRoaring, MemoryWarmDriver, MemoryColdChunkSource } from '@/index';
import { joinId } from '@/core/bit-route';

// A SYNC input to `addMany`/`removeMany` is snapshotted at call time.
//
// This is a contract nobody wrote down, because until 0.4.0 nothing could break it. An async function body runs
// synchronously up to its first `await`, and `mutateMany`'s bucketing loop had none — so by the time
// `addMany(buf)` returned its promise, `buf` had already been fully read. Callers could hand over a scratch
// buffer and immediately reuse it.
//
// Adding a cooperative yield inside that loop silently voided it. With a yield every `YIELD_EVERY_IDS`
// (16,384), a caller who recycled a 40,000-id buffer before awaiting landed **exactly 16,384 ids and got no
// error at all** — no throw, no warning, just a segment quietly missing 59% of its members. Size-dependent
// too: under 16,384 it still drained in one go, so nothing small would ever have shown it.
//
// The fix removes the yield from the sync path only. The async path keeps it: an async source is consumed
// lazily by definition, so no snapshot was ever promised there.
const OVER_THE_YIELD_CADENCE = 40_000; // > YIELD_EVERY_IDS (1 << 14), so the old code yielded mid-loop

const store = () =>
  new CloudRoaring({ warm: new MemoryWarmDriver(), cold: new MemoryColdChunkSource() } as never);

describe('sync inputs to addMany/removeMany are snapshotted', () => {
  it('reads the whole array before returning, even when the caller recycles it', async () => {
    const s = store();
    const buf = Array.from({ length: OVER_THE_YIELD_CADENCE }, (_, i) => i);
    const pending = s.segment('a').addMany(buf);
    buf.length = 0; // the caller reuses its scratch buffer, as it always could
    await pending;
    // 40,000 — not 16,384. The old behaviour lost everything past the first yield, silently.
    await expect(s.segment('a').count()).resolves.toBe(OVER_THE_YIELD_CADENCE);
  });

  it('holds for removeMany too', async () => {
    const s = store();
    const all = Array.from({ length: OVER_THE_YIELD_CADENCE }, (_, i) => i);
    await s.segment('a').addMany(all);
    const doomed = all.slice();
    const pending = s.segment('a').removeMany(doomed);
    doomed.length = 0;
    await pending;
    await expect(s.segment('a').count()).resolves.toBe(0);
  });

  it('holds for a Set another handler mutates', async () => {
    // The realistic shape: not a recycled array, but live state something else is writing to.
    const s = store();
    const live = new Set(
      Array.from({ length: OVER_THE_YIELD_CADENCE }, (_, i) => joinId(i % 600, i % 65_536)),
    );
    const expected = live.size;
    const pending = s.segment('a').addMany(live);
    live.clear();
    await pending;
    await expect(s.segment('a').count()).resolves.toBe(expected);
  });

  it('does NOT promise a snapshot for an async source — that one is lazy by contract', async () => {
    // Stated rather than assumed. An async iterable is pulled over time; a caller cannot expect its contents
    // to have been read before the first await, and the cooperative yield stays on that path.
    const s = store();
    const backing = [1, 2, 3, 4, 5];
    async function* lazily(): AsyncGenerator<number> {
      for (const id of backing) yield id;
    }
    const it = lazily();
    const pending = s.segment('a').addMany(it);
    await pending;
    await expect(s.segment('a').count()).resolves.toBe(backing.length);
  });
});
