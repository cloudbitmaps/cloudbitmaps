import roaring from 'roaring';
import { CloudRoaring, MemoryStorage } from '@/index';
import type { LoadInput } from '@/index';
import { loadSegment } from '@/core/load';
import type { CodecBitmap, CodecInterface } from '@/core/codec';
import { YIELD_EVERY } from '@/core/cooperative';
import { CrbmWriter } from '@/core/crbm/writer';
import { MemoryRegistryDriver, MemoryStorageDriver } from '@/drivers/memory';
import { SafeBitmap, roaringCodec } from '@/roaring-codec';
import { SystemClock } from '@/system-clock';

/**
 * A load of a 12M-member bitmap runs no JavaScript per id: counted, not timed, so it holds on any machine.
 *
 * Every route by which an id could reach JavaScript is counted: each of `RoaringBitmap32`'s iterating and
 * array-producing methods, the codec building a bitmap from values, and core's `splitId`, which the id path calls
 * once per id. What a bitmap load does instead (serialize, the structural check, the native deserialize, the
 * header walk, the CRC32C of the written bytes) is per container or per byte, and is not counted here.
 *
 * The fixture is the worst case for that per-byte work: 65,536 array containers, every chunk of the id space in
 * use, 184 ids in each.
 */
const splitIdCalls = vi.hoisted(() => ({ n: 0 }));
vi.mock('@/core/bit-route', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/core/bit-route')>();
  return {
    ...real,
    splitId: (id: number) => {
      splitIdCalls.n++;
      return real.splitId(id);
    },
  };
});

const { RoaringBitmap32 } = roaring;
const PER_CHUNK = 184;
const SLOT = 356; // 184 slots of 356 values fit a chunk: 183 × 356 + 355 < 65,536
const MEMBERS = 65_536 * PER_CHUNK;

function sparse12M(): InstanceType<typeof RoaringBitmap32> {
  const ids = new Uint32Array(MEMBERS);
  let seed = 7;
  let n = 0;
  for (let chunk = 0; chunk < 65_536; chunk++) {
    for (let slot = 0; slot < PER_CHUNK; slot++) {
      seed = (Math.imul(seed, 1_103_515_245) + 12_345) >>> 0;
      ids[n++] = chunk * 65_536 + slot * SLOT + (seed % SLOT);
    }
  }
  return new RoaringBitmap32(ids);
}

const PER_ID = [
  Symbol.iterator,
  'iterator',
  'keys',
  'values',
  'entries',
  'forEach',
  'toArray',
  'toUint32Array',
  'toSet',
  'rangeUint32Array',
  'toJSON',
  'add',
  'addMany',
] as const;

/** Spy every per-id route; returns a function that reads the total calls made through them. */
function countPerIdCalls(): () => Record<string, number> {
  const proto = RoaringBitmap32.prototype as unknown as Record<PropertyKey, () => unknown>;
  const spies = PER_ID.filter((m) => typeof proto[m] === 'function').map(
    (m) => [String(m), vi.spyOn(proto, m as never)] as const,
  );
  const fromValues = vi.spyOn(SafeBitmap, 'fromValues');
  splitIdCalls.n = 0;
  return () => {
    const out: Record<string, number> = { splitId: splitIdCalls.n };
    out.fromValues = fromValues.mock.calls.length;
    for (const [name, spy] of spies) out[name] = spy.mock.calls.length;
    return out;
  };
}

const nonzero = (counts: Record<string, number>): Record<string, number> =>
  Object.fromEntries(Object.entries(counts).filter(([, n]) => n > 0));

afterEach(() => {
  vi.restoreAllMocks();
});

describe('a 12M-member bitmap load runs no per-id JavaScript', () => {
  const bitmap = sparse12M();

  it.each<[string, () => LoadInput]>([
    ['{ bitmap }', () => ({ bitmap })],
    ['{ serialized }', () => ({ serialized: bitmap.serialize('portable') })],
    ['a bare RoaringBitmap32', () => bitmap],
  ])('%s', async (_, input) => {
    expect(bitmap.size).toBe(MEMBERS);
    const made = input(); // the caller's own serialize is outside the count, as it is outside the load
    const counts = countPerIdCalls();
    const store = new CloudRoaring({ storage: new MemoryStorage() });
    const result = await store.load({ segment: 'big' }, made);
    expect(result).toMatchObject({ published: true, cardinality: MEMBERS, chunkCount: 65_536 });
    expect(nonzero(counts())).toEqual({});
  });

  it('control: the same counters see a load from ids, and a codec that cannot encode its own chunks', async () => {
    const counts = countPerIdCalls();
    const store = new CloudRoaring({ storage: new MemoryStorage() });
    await store.load({ segment: 'small' }, [1, 2, 3, 70_000]);
    expect(counts()).toMatchObject({ splitId: 4, fromValues: 2 });

    // A codec without `encodeChunks` loads a bitmap through its ids: the path a missing seam would fall back to.
    const without: CodecInterface = {
      ...roaringCodec,
      safeDeserialize: (bytes, max) => {
        const decoded = roaringCodec.safeDeserialize(bytes, max);
        return new Proxy(decoded, {
          get: (t, prop) => (prop === 'encodeChunks' ? undefined : Reflect.get(t, prop, t)),
        }) as CodecBitmap;
      },
    };
    const before = splitIdCalls.n;
    const deps = {
      storage: new MemoryStorageDriver(),
      registry: new MemoryRegistryDriver(),
      codec: without,
    };
    await loadSegment({ segment: 'fallback' }, { bitmap: new RoaringBitmap32([1, 2, 3]) }, deps);
    expect(splitIdCalls.n - before).toBe(3);
  });
});

describe('a bitmap load still hands the event loop back', () => {
  it('the writer yields every 1,024 chunks, as it does for ids', async () => {
    class SpyClock extends SystemClock {
      yields = 0;
      override yieldNow(): Promise<void> {
        this.yields += 1;
        return super.yieldNow();
      }
    }
    const chunks = 40_000;
    const bitmap = new RoaringBitmap32(
      Array.from({ length: chunks }, (_, i) => i * 65_536 + (i % 65_536)),
    );
    const clock = new SpyClock();
    const store = new CloudRoaring({ storage: new MemoryStorage(), seams: { clock } });
    await store.load({ segment: 'coop' }, { serialized: bitmap.serialize('portable') });
    expect(clock.yields).toBeGreaterThanOrEqual(Math.floor(chunks / YIELD_EVERY));
  });

  it('between two yields there is one whole-bitmap step, or at most 1,024 containers cut and written', async () => {
    // Bounded in work rather than in milliseconds, so it holds on a busy machine: every event between two yields is
    // logged, and no slice may hold the decode and the re-encode together, either of them with the cut, or more
    // than YIELD_EVERY containers. The decode (the structural check and the native decode) is one step that does not
    // yield, before the load's first request, by design.
    const log: string[] = [];
    class RecordingClock extends SystemClock {
      override yieldNow(): Promise<void> {
        log.push('yield');
        return super.yieldNow();
      }
    }
    const wrap = <T extends object>(target: T, name: keyof T & string, event: string): void => {
      const original = target[name] as unknown as (...a: unknown[]) => unknown;
      vi.spyOn(target, name as never).mockImplementation(function (this: unknown, ...a: unknown[]) {
        log.push(event);
        return original.apply(this, a);
      } as never);
    };
    wrap(SafeBitmap, 'safeDeserialize', 'decode');
    wrap(SafeBitmap.prototype, 'optimize', 'optimize');
    wrap(SafeBitmap.prototype, 'serialize', 'serialize');
    wrap(CrbmWriter.prototype, 'addChunk', 'chunk');

    const chunks = 40_000;
    const bitmap = new RoaringBitmap32(
      Array.from({ length: chunks }, (_, i) => i * 65_536 + (i % 65_536)),
    );
    const serialized = bitmap.serialize('portable');
    const store = new CloudRoaring({
      storage: new MemoryStorage(),
      seams: { clock: new RecordingClock() },
    });
    log.length = 0;
    await store.load({ segment: 'slices' }, { serialized });

    const slices: string[][] = [[]];
    for (const event of log) {
      if (event === 'yield') slices.push([]);
      else slices[slices.length - 1]!.push(event);
    }
    expect(log.filter((e) => e === 'chunk')).toHaveLength(chunks);
    for (const slice of slices) {
      const has = (e: string): boolean => slice.includes(e);
      expect(has('decode') && (has('optimize') || has('serialize') || has('chunk'))).toBe(false);
      expect((has('optimize') || has('serialize')) && has('chunk')).toBe(false);
      expect(slice.filter((e) => e === 'chunk').length).toBeLessThanOrEqual(YIELD_EVERY);
    }
  });
});
