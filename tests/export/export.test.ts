import { randomBytes } from 'node:crypto';
import {
  CloudRoaring,
  MemoryColdChunkSource,
  MemoryColdDriver,
  MemoryRegistryDriver,
  SafeBitmap,
  bulkLoadCrbmGeneration,
} from '@/index';
import type { ExportSink, ExportWriter, IKeystore, SegmentRef } from '@/index';
import { InProcessKeystore } from '@/drivers/crypto';
import { UnsupportedError } from '@/core/errors';

// `store.exportSegments` — dump every registered segment's effective set to a portable file via an injected sink. These
// tests use an in-memory sink so they assert the actual bytes (roaring decodes back; ndjson parses back).
const k = (): Uint8Array => randomBytes(32);

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

/** A sink that captures each segment's concatenated output + how many write() calls it took (batching signal). */
function captureSink(): {
  sink: ExportSink;
  files: Map<string, { bytes: Uint8Array; writes: number }>;
} {
  const files = new Map<string, { bytes: Uint8Array; writes: number }>();
  const sink: ExportSink = {
    open(ref: SegmentRef, ext: string): ExportWriter {
      const key = `${ref.namespace ?? '_default'}/${ref.segment}${ext}`;
      const chunks: Uint8Array[] = [];
      return {
        write(bytes) {
          chunks.push(Uint8Array.from(bytes));
        },
        close() {
          files.set(key, { bytes: concat(chunks), writes: chunks.length });
        },
      };
    },
  };
  return { sink, files };
}

const roaringIds = (bytes: Uint8Array): number[] =>
  SafeBitmap.safeDeserialize(bytes, 1 << 30)
    .toArray()
    .sort((a, b) => a - b);
const ndjsonIds = (bytes: Uint8Array): number[] =>
  Buffer.from(bytes)
    .toString('utf8')
    .split('\n')
    .filter((s) => s.length > 0)
    .map(Number);

/** A store over a raw MemoryColdDriver + registry (so `export` works), with the seeded cold already in place. */
function freshStore(
  registry: MemoryRegistryDriver,
  cold: MemoryColdDriver,
  keystore?: IKeystore,
): CloudRoaring {
  // `coldGenTtlMs: 0` pins the generation for this store's lifetime, which is what an export wants: the run
  // reads one snapshot rather than drifting onto a generation published while it was streaming.
  return new CloudRoaring({ cold, registry, keystore, retry: false, coldGenTtlMs: 0 });
}

describe('store.exportSegments', () => {
  it('roaring: exports each segment’s current generation, round-trips + manifest', async () => {
    const cold = new MemoryColdDriver();
    const registry = new MemoryRegistryDriver();
    await bulkLoadCrbmGeneration(cold, { segment: 'a', generation: 0 }, [1, 2, 3], { registry });
    // Include a u32-boundary id (2³²−1) to exercise portable serialization across a high chunk key.
    await bulkLoadCrbmGeneration(cold, { segment: 'b', generation: 0 }, [10, 20, 4_294_967_295], {
      registry,
    });
    // A second generation of `a`: the export must follow the pointer, not the first object it finds.
    await bulkLoadCrbmGeneration(cold, { segment: 'a', generation: 1 }, [1, 3, 4], { registry });

    const store = freshStore(registry, cold);
    const { sink, files } = captureSink();
    const manifest = await store.exportSegments(sink);

    expect(manifest.version).toBe(1);
    expect(manifest.format).toBe('roaring');
    expect(manifest.totalSegments).toBe(2);
    expect(roaringIds(files.get('_default/a.roaring')!.bytes)).toEqual([1, 3, 4]); // generation 1
    expect(roaringIds(files.get('_default/b.roaring')!.bytes)).toEqual([10, 20, 4_294_967_295]);
    const aEntry = manifest.segments.find((s) => s.segment === 'a')!;
    expect(aEntry.count).toBe(3);
    expect(aEntry.bytes).toBe(files.get('_default/a.roaring')!.bytes.length); // manifest bytes = actual output
    expect(manifest.totalIds).toBe(6);
    expect(manifest.failed).toEqual([]); // happy path: nothing failed
  });

  it('ndjson: exports the current generation, streamed in batches', async () => {
    const cold = new MemoryColdDriver();
    const registry = new MemoryRegistryDriver();
    await bulkLoadCrbmGeneration(cold, { segment: 'a', generation: 0 }, [1, 2, 3], { registry });
    await bulkLoadCrbmGeneration(cold, { segment: 'a', generation: 1 }, [1, 3, 4, 5], { registry });
    const store = freshStore(registry, cold);

    const { sink, files } = captureSink();
    // A tiny batch cap forces multiple write() calls, exercising the streaming/flush path.
    const manifest = await store.exportSegments(sink, { format: 'ndjson', ndjsonBatchBytes: 4 });

    expect(manifest.format).toBe('ndjson');
    const file = files.get('_default/a.ndjson')!;
    expect(ndjsonIds(file.bytes)).toEqual([1, 3, 4, 5]); // generation 1, ascending
    expect(file.writes).toBeGreaterThan(1); // batched, not one giant write
    expect(manifest.segments[0]?.count).toBe(4);
    expect(manifest.segments[0]?.bytes).toBe(file.bytes.length);
  });

  it('scopes to a namespace when given one', async () => {
    const cold = new MemoryColdDriver();
    const registry = new MemoryRegistryDriver();
    await bulkLoadCrbmGeneration(cold, { namespace: 'ns', segment: 'a', generation: 0 }, [1], {
      registry,
    });
    await bulkLoadCrbmGeneration(cold, { namespace: 'other', segment: 'a', generation: 0 }, [9], {
      registry,
    });

    const { sink, files } = captureSink();
    const manifest = await freshStore(registry, cold).exportSegments(sink, { namespace: 'ns' });
    expect(manifest.totalSegments).toBe(1);
    expect([...files.keys()]).toEqual(['ns/a.roaring']);
    expect(roaringIds(files.get('ns/a.roaring')!.bytes)).toEqual([1]);
  });

  it('skips crypto-shredded (destroyed) segments', async () => {
    const cold = new MemoryColdDriver();
    const registry = new MemoryRegistryDriver();
    await bulkLoadCrbmGeneration(cold, { segment: 'live', generation: 0 }, [1, 2], { registry });
    await bulkLoadCrbmGeneration(cold, { segment: 'gone', generation: 0 }, [3, 4], { registry });
    // Mark 'gone' destroyed (crypto-shred tombstone) directly in the registry.
    const rec = (await registry.get({ segment: 'gone' }))!;
    await registry.compareAndSwap({ segment: 'gone' }, rec.token, { status: 'destroyed' });

    const { sink, files } = captureSink();
    const manifest = await freshStore(registry, cold).exportSegments(sink);
    expect(manifest.segments.map((s) => s.segment)).toEqual(['live']);
    expect([...files.keys()]).toEqual(['_default/live.roaring']);
  });

  it('exports an empty segment as an empty (but valid) bitmap', async () => {
    const cold = new MemoryColdDriver();
    const registry = new MemoryRegistryDriver();
    await bulkLoadCrbmGeneration(cold, { segment: 'a', generation: 0 }, [1], { registry });
    // An empty generation is a legal, publishable state (a source that produced no rows), so the export has to
    // render it as a valid empty bitmap rather than as a failure or a missing file.
    await bulkLoadCrbmGeneration(cold, { segment: 'a', generation: 1 }, [], { registry });
    const store = freshStore(registry, cold);

    const { sink, files } = captureSink();
    const manifest = await store.exportSegments(sink);
    expect(manifest.segments[0]?.count).toBe(0);
    expect(roaringIds(files.get('_default/a.roaring')!.bytes)).toEqual([]); // valid, empty
  });

  it('decrypts an encrypted segment transparently (export is cleartext) when the keystore is wired', async () => {
    const cold = new MemoryColdDriver();
    const registry = new MemoryRegistryDriver();
    const keystore = new InProcessKeystore({ keys: { k1: k() }, activeKeyId: 'k1' });
    await bulkLoadCrbmGeneration(cold, { segment: 'pii', generation: 0 }, [7, 8, 9], {
      registry,
      keystore,
    });

    const { sink, files } = captureSink();
    await freshStore(registry, cold, keystore).exportSegments(sink);
    expect(roaringIds(files.get('_default/pii.roaring')!.bytes)).toEqual([7, 8, 9]); // decrypted, cleartext
  });

  it('throws UnsupportedError when the store has no registry', async () => {
    const store = new CloudRoaring({ cold: new MemoryColdChunkSource() });
    const { sink } = captureSink();
    await expect(store.exportSegments(sink)).rejects.toBeInstanceOf(UnsupportedError);
  });

  it('isolates a segment whose write throws: aborts its partial, records it in failed[], continues', async () => {
    const cold = new MemoryColdDriver();
    const registry = new MemoryRegistryDriver();
    await bulkLoadCrbmGeneration(cold, { segment: 'bad', generation: 0 }, [1], { registry });
    await bulkLoadCrbmGeneration(cold, { segment: 'good', generation: 0 }, [2], { registry });

    let badAborted = false;
    let badClosed = false;
    const goodFiles = new Map<string, Uint8Array>();
    const sink: ExportSink = {
      open(ref): ExportWriter {
        if (ref.segment === 'bad') {
          return {
            write() {
              throw new Error('injected write fault');
            },
            close() {
              badClosed = true;
            },
            abort() {
              badAborted = true;
            },
          };
        }
        const chunks: Uint8Array[] = [];
        return {
          write(b) {
            chunks.push(Uint8Array.from(b));
          },
          close() {
            goodFiles.set(ref.segment, concat(chunks));
          },
        };
      },
    };

    const manifest = await freshStore(registry, cold).exportSegments(sink); // resolves — one bad seg doesn't throw
    expect(badAborted).toBe(true); // partial discarded
    expect(badClosed).toBe(false); // commit NOT called on the failure path
    expect(manifest.failed.map((f) => f.segment)).toEqual(['bad']);
    expect(manifest.failed[0]?.error).toContain('injected write fault');
    expect(manifest.segments.map((s) => s.segment)).toEqual(['good']); // the healthy one still exported
    expect(roaringIds(goodFiles.get('good')!)).toEqual([2]);
  });

  it('records the ORIGINAL fault even if abort() also throws, and still finishes the run', async () => {
    const cold = new MemoryColdDriver();
    const registry = new MemoryRegistryDriver();
    await bulkLoadCrbmGeneration(cold, { segment: 'a', generation: 0 }, [1], { registry });

    const sink: ExportSink = {
      open(): ExportWriter {
        return {
          write() {
            throw new Error('original fault');
          },
          close() {},
          abort() {
            throw new Error('cleanup fault'); // must NOT mask the original, must NOT crash the run
          },
        };
      },
    };
    const manifest = await freshStore(registry, cold).exportSegments(sink); // resolves despite both faults
    expect(manifest.failed).toHaveLength(1);
    expect(manifest.failed[0]?.error).toContain('original fault');
    expect(manifest.failed[0]?.error).not.toContain('cleanup fault');
  });

  it('isolates a segment whose close() throws — records it, does NOT call abort() (no double-finalize)', async () => {
    const cold = new MemoryColdDriver();
    const registry = new MemoryRegistryDriver();
    await bulkLoadCrbmGeneration(cold, { segment: 'a', generation: 0 }, [1], { registry });

    let aborted = false;
    const sink: ExportSink = {
      open(): ExportWriter {
        return {
          write() {},
          close() {
            throw new Error('injected close fault');
          },
          abort() {
            aborted = true;
          },
        };
      },
    };
    const manifest = await freshStore(registry, cold).exportSegments(sink);
    expect(manifest.segments).toHaveLength(0); // not committed
    expect(manifest.failed.map((f) => f.segment)).toEqual(['a']);
    expect(manifest.failed[0]?.error).toContain('injected close fault');
    expect(aborted).toBe(false); // close/abort are mutually exclusive — abort must NOT run after a close attempt
  });

  it('empty registry → a valid empty manifest (finished, nothing to export)', async () => {
    const registry = new MemoryRegistryDriver();
    const cold = new MemoryColdDriver();
    const { sink, files } = captureSink();
    const manifest = await freshStore(registry, cold).exportSegments(sink);
    expect(manifest).toMatchObject({ totalSegments: 0, totalIds: 0, segments: [], failed: [] });
    expect(files.size).toBe(0);
  });

  it('ndjson: accounts bytes for the final partial batch (default large cap ⇒ a single flush)', async () => {
    const cold = new MemoryColdDriver();
    const registry = new MemoryRegistryDriver();
    await bulkLoadCrbmGeneration(cold, { segment: 'a', generation: 0 }, [1, 2, 3], { registry });
    const { sink, files } = captureSink();
    // The default 64 KiB cap ⇒ the whole segment lands in the single FINAL flush (the `buf.length > 0` path).
    const manifest = await freshStore(registry, cold).exportSegments(sink, { format: 'ndjson' });
    const file = files.get('_default/a.ndjson')!;
    expect(file.writes).toBe(1); // one final flush, no mid-loop flushes
    expect(manifest.segments[0]?.bytes).toBe(file.bytes.length); // bytes NOT dropped for the final batch
    expect(manifest.segments[0]?.bytes).toBeGreaterThan(0);
  });

  it('enumerates the registry, so a segment loaded without one is absent rather than half-exported', async () => {
    // What replaced the `candidates` option. Every load that is given a registry publishes a row, so the
    // registry is a complete index of the loaded segments and enumeration cannot miss one. A load with NO
    // registry writes an object nothing points at: still readable by any roaring library (the format's own
    // promise), but not part of this store's set, so it is omitted — and omitted *cleanly*, not recorded as a
    // failure, because it was never enumerated in the first place.
    const cold = new MemoryColdDriver();
    const registry = new MemoryRegistryDriver();
    await bulkLoadCrbmGeneration(cold, { segment: 'registered', generation: 0 }, [1, 2], {
      registry,
    });
    await bulkLoadCrbmGeneration(cold, { segment: 'orphan', generation: 0 }, [1000, 2000]); // no registry

    const { sink, files } = captureSink();
    const manifest = await freshStore(registry, cold).exportSegments(sink);
    expect(manifest.segments.map((s) => s.segment)).toEqual(['registered']);
    expect([...files.keys()]).toEqual(['_default/registered.roaring']);
    expect(manifest.failed).toEqual([]);
    expect(manifest.totalIds).toBe(2);
  });
});
