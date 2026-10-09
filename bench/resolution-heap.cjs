/*
 * The heap the resolution cache's entries take, against the bytes the cache counts for them — MEASURED, for the one
 * figure the sizing guide quotes about it. A reader with a timed refresh keeps each segment's resolution apart from its
 * reader, bounded by `8 × cache.readerMax` entries and `cache.readerMaxBytes / 16` bytes. The byte bound is on the
 * weight the cache counts for an entry (256 bytes plus its row's summary and wrapped keys as JSON), not on the heap the
 * entry takes, and the two differ by what the runtime spends on the objects. Without a measurement, the guide could
 * say only that they differ, not by how much.
 *
 * It fills one `.crbm` source at the default reader-cache settings with resolutions of 8,192 segments (as many as the
 * count bound lets in, or fewer where the byte bound binds first), each from a registry read that answers a row of its
 * own, as a driver that parses what it reads does. It drops the reader cache's snapshots, which are not what is
 * measured, then reads the heap after a forced GC with the resolutions held and again once they are cleared. The
 * difference, per entry and as a multiple of the weight counted, is the figure. Four row shapes: cleartext and
 * encrypted, each with no metadata and with 300 bytes of it.
 *
 * It reaches into the source's private caches to clear them; nothing it does is part of the public API.
 *
 * Run: `pnpm run build && node --expose-gc bench/resolution-heap.cjs`. It prints a line per shape and takes a few
 * seconds. With RESOLUTION_HEAP_INJECT=1 it also writes `bench/resolution-heap-results.json`, which `sizing.cjs` reads
 * for the range it publishes in `docs/guide/sizing.md`. The heap depends on the Node version and the machine, so this is
 * never run by a gate; `pnpm bench:sizing:check` checks the page against the committed results file, not against a new
 * run.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { setImmediate } = require('node:timers');

const SEGMENTS = 8192;
const SHAPES = [
  ['cleartext, no metadata', false, undefined],
  ['encrypted, no metadata', true, undefined],
  ['cleartext, 300 B metadata', false, { def: 'x'.repeat(300) }],
  ['encrypted, 300 B metadata', true, { def: 'x'.repeat(300) }],
];

async function settle() {
  for (let i = 0; i < 4; i++) {
    globalThis.gc();
    await new Promise((resolve) => setImmediate(resolve));
  }
}

async function measure(lib, [shape, encrypted, metadata]) {
  const { CloudRoaring, MemoryStorage, CrbmStorageChunkSource, InProcessKeystore } = lib;
  const keystore = encrypted
    ? new InProcessKeystore({ keys: { k1: randomBytes(32) }, activeKeyId: 'k1' })
    : undefined;
  const backend = new MemoryStorage();
  const writer = new CloudRoaring({
    storage: backend,
    retry: false,
    ...(keystore ? { encryption: { keystore } } : {}),
  });
  const ids = Array.from({ length: 2000 }, (_, c) => c * 65536 + 1);
  await writer.load({ segment: 'template' }, ids, metadata ? { metadata } : {});
  const row = await backend.registry.get({ segment: 'template' });
  const registry = new Proxy(backend.registry, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop !== 'get') return typeof value === 'function' ? value.bind(target) : value;
      return async () => globalThis.structuredClone(row);
    },
  });
  const source = new CrbmStorageChunkSource(backend.storage, {
    registry,
    clock: { now: () => 0 },
    currentGenTtlMs: 1e12,
    ...(keystore ? { keystore } : {}),
  });
  for (let i = 0; i < SEGMENTS; i++) await source.currentGeneration({ segment: `s${i}` });
  source.snapshots.clear();
  await settle();
  const full = process.memoryUsage().heapUsed;
  const counted = source.resolutions.weightBytes;
  const entries = source.resolutions.size;
  source.resolutions.clear();
  await settle();
  const heap = full - process.memoryUsage().heapUsed;
  return {
    shape,
    entries,
    countedBytesEach: Math.round(counted / entries),
    heapBytesEach: Math.round(heap / entries),
    heapPerCounted: Number((heap / counted).toFixed(2)),
  };
}

async function main() {
  if (typeof globalThis.gc !== 'function') {
    throw new Error(
      'resolution-heap: run with node --expose-gc, so the heap is read after a forced GC',
    );
  }
  const lib = require('@cloudbitmaps/roaring');
  const shapes = [];
  for (const shape of SHAPES) {
    const row = await measure(lib, shape);
    shapes.push(row);
    console.log(
      `${row.shape}: ${row.entries} entries, counted ${row.countedBytesEach} B each, ` +
        `heap ${row.heapBytesEach} B each, heap / counted ${row.heapPerCounted}`,
    );
  }
  if (process.env.RESOLUTION_HEAP_INJECT === '1') {
    const results = {
      node: process.version,
      platform: `${process.platform} ${process.arch}`,
      shapes,
    };
    const out = path.join(__dirname, 'resolution-heap-results.json');
    fs.writeFileSync(out, `${JSON.stringify(results, null, 2)}\n`);
    console.log(`wrote ${path.relative(process.cwd(), out)}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
