import { NotFoundError, ValidationError } from '@/core/errors';
import { runExport } from '@/export';
import { brandAsBackend } from '@/core/ports';
import { CloudRoaring, MemoryStorage } from '@/index';
import type { ExportSink, ExportWriter, SegmentRef } from '@/index';
import { counting } from '../helpers/counting';

/**
 * Each segment's export is one instant: its generation is resolved once, when its export begins, and only that
 * generation's object is read for the whole segment. A publish during a long segment's export cannot put chunks of two
 * generations in one file, and a generation collected mid-export fails that segment rather than reading the newer one.
 */
const REF: SegmentRef = { segment: 's' };
/**
 * 3,000 ids in each of 100 chunks: about 600 KB, past the 256 KiB tail read, so a pinned read fetches chunks from the
 * object and a collected object is one it cannot read.
 */
const CHUNKS = 100;
const PER_CHUNK = 3_000;
const generation = (offset: number): number[] =>
  Array.from({ length: CHUNKS * PER_CHUNK }, (_, n) => {
    const chunk = Math.floor(n / PER_CHUNK);
    return chunk * 65_536 + (n % PER_CHUNK) * 20 + offset;
  });
const pause = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * A sink that runs `onOpen` once, when the export opens a segment's file: its generation is resolved by then and none
 * of its chunks has been read. It keeps what it is given.
 */
function hookedSink(onOpen: () => Promise<void>) {
  const files = new Map<string, string>();
  const aborted: string[] = [];
  let hooked = false;
  const sink: ExportSink = {
    async open(ref: SegmentRef): Promise<ExportWriter> {
      if (!hooked) {
        hooked = true;
        await onOpen();
      }
      const parts: Uint8Array[] = [];
      return {
        write(bytes) {
          parts.push(Uint8Array.from(bytes));
        },
        close() {
          files.set(ref.segment, Buffer.concat(parts).toString('utf8'));
        },
        abort() {
          aborted.push(ref.segment);
        },
      };
    },
  };
  return { sink, files, aborted };
}

const idsOf = (text: string | undefined): number[] =>
  (text ?? '')
    .split('\n')
    .filter((s) => s.length > 0)
    .map(Number);

/** A reader store that re-resolves at once (a 1 ms generation TTL), so a live read would follow a publish. */
const readerOver = (backend: MemoryStorage): CloudRoaring =>
  new CloudRoaring({ storage: backend, retry: false, cache: { genTtlMs: 1 } });

describe('runExport pins each segment', () => {
  it('writes exactly the generation current when the segment began, whatever is published meanwhile', async () => {
    const backend = new MemoryStorage();
    const writer = new CloudRoaring({ storage: backend });
    await writer.load(REF, generation(0), { keep: 5 });
    const { sink, files } = hookedSink(async () => {
      await writer.load(REF, generation(1), { keep: 5 });
      await pause(10); // past the reader's TTL: a live read re-resolves to the new generation
    });

    const manifest = await readerOver(backend).exportSegments(sink, {
      format: 'ndjson',
      ndjsonBatchBytes: 4_096,
    });

    expect(manifest.failed).toEqual([]);
    // Compared without a diff of 300,000 ids, which a failure would otherwise spend minutes drawing.
    const got = idsOf(files.get('s'));
    const want = generation(0);
    expect(got.length).toBe(want.length);
    expect(got.findIndex((v, i) => v !== want[i])).toBe(-1);
    expect(manifest.segments[0]?.count).toBe(CHUNKS * PER_CHUNK);
  });

  it('fails the segment with the typed error a pinned read gets when its generation is collected mid-export', async () => {
    const backend = new MemoryStorage();
    const writer = new CloudRoaring({ storage: backend });
    await writer.load(REF, generation(0));
    // A pin of the same generation, to show what a pinned read throws once the object is collected.
    const probe = await readerOver(backend).segment('s').pin();
    const { sink, files, aborted } = hookedSink(async () => {
      for (let i = 1; i <= 4; i++) await writer.load(REF, generation(i));
      await pause(10);
    });

    const manifest = await readerOver(backend).exportSegments(sink, {
      format: 'ndjson',
      ndjsonBatchBytes: 4_096,
    });

    let pinned: unknown;
    try {
      for await (const id of probe.iterate()) void id;
    } catch (err) {
      pinned = err;
    }
    expect(pinned).toBeInstanceOf(NotFoundError);
    expect(manifest.failed).toHaveLength(1);
    expect(manifest.failed[0]).toMatchObject({ segment: 's', error: (pinned as Error).message });
    // The partial file is discarded, never committed, and nothing of a newer generation is in it.
    expect(aborted).toEqual(['s']);
    expect(files.has('s')).toBe(false);
  });

  it('costs one registry read and one tail read per segment, and no range read for a small one', async () => {
    const real = new MemoryStorage();
    const writer = new CloudRoaring({ storage: real });
    for (const name of ['a', 'b', 'c']) await writer.load({ segment: name }, [1, 2, 3]);
    const counts: Record<string, number> = {};
    const store = new CloudRoaring({
      storage: brandAsBackend({
        storage: counting(real.storage, counts),
        registry: counting(real.registry, counts),
      }),
    });
    const manifest = await store.exportSegments({ open: () => ({ write() {}, close() {} }) });
    expect(manifest.totalSegments).toBe(3);
    expect(counts).toEqual({ capabilities: 1, list: 1, get: 3, getTail: 3 });
  });

  it('costs one registry read per segment on a warm store, which the live read skipped', async () => {
    const real = new MemoryStorage();
    const writer = new CloudRoaring({ storage: real });
    for (const name of ['a', 'b', 'c']) await writer.load({ segment: name }, [1, 2, 3]);
    const counts: Record<string, number> = {};
    const store = new CloudRoaring({
      storage: brandAsBackend({
        storage: counting(real.storage, counts),
        registry: counting(real.registry, counts),
      }),
    });
    const sink: ExportSink = { open: () => ({ write() {}, close() {} }) };
    await store.exportSegments(sink); // cold: the store learns each segment
    for (const k of Object.keys(counts)) delete counts[k];
    await store.exportSegments(sink);
    expect(counts).toEqual({ capabilities: 1, list: 1, get: 3 });
  });

  it('refuses a reader that cannot pin before it opens any file', async () => {
    const backend = new MemoryStorage();
    await new CloudRoaring({ storage: backend }).load(REF, [1, 2, 3]);
    let opened = 0;
    const sink: ExportSink = {
      open: () => {
        opened += 1;
        return { write() {}, close() {} };
      },
    };
    const iterateOnly = { segment: () => ({ iterate: async function* () {} }) };
    await expect(runExport(iterateOnly as never, backend.registry, sink)).rejects.toThrow(
      /pin\(\)/,
    );
    await expect(runExport(iterateOnly as never, backend.registry, sink)).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(runExport({} as never, backend.registry, sink)).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(opened).toBe(0);
  });
});
