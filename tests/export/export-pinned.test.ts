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

  // The window of ranges a read has in flight is 32, each at most 1 MiB, so an object has to be over 32 MiB for a
  // range to be requested after a publish that lands during an earlier one. Nothing shrinks the window or the range,
  // so this segment is 4,400 chunks of 4,096 ids (about 35 MiB), and the run takes several seconds.
  it('writes one generation when a publish lands in the middle of a segment larger than the read window', async () => {
    const BIG_CHUNKS = 4_400;
    const big = (): Uint32Array => {
      const ids = new Uint32Array(BIG_CHUNKS * 4_096);
      for (let c = 0; c < BIG_CHUNKS; c++) {
        for (let i = 0; i < 4_096; i++) ids[c * 4_096 + i] = c * 65_536 + i * 8;
      }
      return ids;
    };
    // The generation published meanwhile: one id, of another residue, in each chunk.
    const later = (): Uint32Array =>
      Uint32Array.from({ length: BIG_CHUNKS }, (_, c) => c * 65_536 + 3);
    const backend = new MemoryStorage();
    const writer = new CloudRoaring({ storage: backend });
    await writer.load(REF, big(), { keep: 5 });
    let ranges = 0;
    let published: Promise<void> | undefined;
    const storage = new Proxy(backend.storage, {
      get(target, prop, receiver) {
        const value: unknown = Reflect.get(target, prop, receiver);
        if (prop !== 'getRange' || typeof value !== 'function') return value;
        return async (...args: unknown[]) => {
          ranges += 1;
          if (ranges === 2) {
            published = writer.load(REF, later(), { keep: 5 }).then(() => pause(10));
            await published;
          }
          return (value as (...a: unknown[]) => Promise<Uint8Array>).apply(target, args);
        };
      },
    });
    const reader = new CloudRoaring({
      storage: brandAsBackend({ storage, registry: backend.registry }),
      retry: false,
      cache: { genTtlMs: 1 },
    });
    const files = new Map<string, number[]>();
    const residues = new Set<number>();
    let count = 0;
    const manifest = await reader.exportSegments(
      {
        open: (ref) => ({
          write(bytes) {
            for (const line of Buffer.from(bytes).toString('utf8').split('\n')) {
              if (line === '') continue;
              residues.add(Number(line) % 8);
              count += 1;
            }
          },
          close() {
            files.set(ref.segment, []);
          },
        }),
      },
      { format: 'ndjson', ndjsonBatchBytes: 1 << 20 },
    );

    expect(published).toBeDefined();
    expect(manifest.failed).toEqual([]);
    expect([...residues]).toEqual([0]);
    expect(count).toBe(BIG_CHUNKS * 4_096);
  }, 120_000);

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
    expect(counts).toEqual({ list: 1, get: 3 });
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

describe('runExport refuses a sink it cannot open, before it reads', () => {
  it('a sink without open() is a ValidationError, not a failure per segment', async () => {
    const backend = new MemoryStorage();
    const store = new CloudRoaring({ storage: backend });
    for (const sink of [{}, null, { open: 5 }] as never[]) {
      await expect(runExport(store, backend.registry, sink)).rejects.toBeInstanceOf(
        ValidationError,
      );
    }
  });

  it('options of null read as none', async () => {
    const backend = new MemoryStorage();
    const store = new CloudRoaring({ storage: backend });
    const sink: ExportSink = {
      open: () => ({ write: () => {}, close: () => {}, abort: () => {} }),
    };
    await expect(runExport(store, backend.registry, sink, null as never)).resolves.toMatchObject({
      failed: [],
    });
  });
});
