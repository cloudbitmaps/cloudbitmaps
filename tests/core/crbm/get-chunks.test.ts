import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { BufferReader, BufferSink } from '@/core/blob';
import type { BlobReader } from '@/core/blob';
import { CrbmReader } from '@/core/crbm/reader';
import { CrbmWriter } from '@/core/crbm/writer';
import { AEAD_NONCE_BYTES, AEAD_TAG_BYTES, PAYLOAD_START } from '@/core/crbm/format';
import { aadFor } from '@/core/crypto';
import type { CrbmCrypto } from '@/core/crypto';
import { NodeAead } from '@/drivers/crypto';
import { IntegrityError, ValidationError } from '@/core/errors';
import {
  MAX_COALESCE_GAP_BYTES,
  MAX_COALESCED_READ_BYTES,
  MAX_RANGES_IN_FLIGHT,
} from '@/core/crbm/plan-reads';
import { collect, expectSameBytes } from '../../helpers/chunk-stream';
import { Gate, Watched, tick, worstWhileWaiting } from '../../helpers/live-buffers';

/** The bytes of each chunk a stream yields, in order: what an array-returning read would have answered. */
async function getChunks(
  reader: CrbmReader,
  keys: readonly number[],
  readRange?: <T>(read: () => Promise<T>) => Promise<T>,
): Promise<(Uint8Array | null)[]> {
  const items = await collect(
    reader.readChunks(keys, readRange === undefined ? {} : { readRange }),
  );
  return items.map((item) => item.bytes);
}

const KIB = 1024;
const SEG = { segment: 'coalesce' };

/** Ten chunks of 100 KiB, keys 0 to 9 (and 20, past a long run of absent keys), each a different random payload. */
const KEYS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 20];
const SIZE = 100 * KIB;
const PAYLOADS = new Map(KEYS.map((k) => [k, new Uint8Array(randomBytes(SIZE))]));

const cryptoFor = (dek: Uint8Array): CrbmCrypto => ({
  aead: new NodeAead(dek),
  aadFor: (scope) => aadFor(SEG, 3, scope),
});

async function build(crypto?: CrbmCrypto): Promise<Uint8Array> {
  const sink = new BufferSink();
  const writer = new CrbmWriter(sink, { generation: 3, ...(crypto ? { crypto } : {}) });
  for (const k of KEYS) await writer.addChunk(k, PAYLOADS.get(k)!, 1 + k);
  await writer.finish();
  return sink.bytes();
}

/** Where chunk `key` starts and how long it is on disk: chunks are back to back from the preamble. */
const stored = (key: number, encrypted: boolean) => {
  const length = SIZE + (encrypted ? AEAD_NONCE_BYTES + AEAD_TAG_BYTES : 0);
  return { offset: PAYLOAD_START + KEYS.indexOf(key) * length, length };
};

/** A blob that records every range read, and can alter what a read returns. */
class Spy implements BlobReader {
  readonly ranges: { offset: number; length: number }[] = [];
  constructor(
    private readonly inner: BlobReader,
    private readonly alter?: (bytes: Uint8Array) => Uint8Array,
  ) {}
  async getRange(offset: number, length: number): Promise<Uint8Array> {
    this.ranges.push({ offset, length });
    const bytes = await this.inner.getRange(offset, length);
    return this.alter ? this.alter(bytes) : bytes;
  }
  getTail(maxBytes: number) {
    return this.inner.getTail(maxBytes);
  }
}

const dek = new Uint8Array(randomBytes(32));
const variants = [
  { name: 'plain', encrypted: false, crypto: undefined },
  { name: 'encrypted', encrypted: true, crypto: cryptoFor(dek) },
] as const;

describe.each(variants)('CrbmReader.readChunks ($name)', ({ encrypted, crypto }) => {
  const open = async (bytes: Uint8Array, spy = new Spy(new BufferReader(bytes))) => {
    const reader = await CrbmReader.open(spy, crypto ? { crypto } : {});
    spy.ranges.length = 0; // count the chunk reads, not the open
    return { reader, spy };
  };

  it('returns, for each key, the bytes a read of that chunk alone returns', async () => {
    const { reader, spy } = await open(await build(crypto));
    const keys = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 20];
    const got = await getChunks(reader, keys);
    for (const [i, key] of keys.entries()) {
      expectSameBytes(got[i]!, PAYLOADS.get(key)!);
      expectSameBytes(got[i]!, (await reader.getChunk(key))!);
    }
    expect(spy.ranges.length).toBeGreaterThan(0);
  });

  it('makes one range read per merged range', async () => {
    const { reader, spy } = await open(await build(crypto));
    const len = stored(0, encrypted).length;
    // Keys 0-2 are adjacent, 4 is 100 KiB past 2: one read. 9 is 400 KiB past 4: its own. 20 follows 9 at once.
    await getChunks(reader, [0, 1, 2, 4, 9, 20]);
    expect(spy.ranges).toEqual([
      { offset: stored(0, encrypted).offset, length: 5 * len },
      { offset: stored(9, encrypted).offset, length: 2 * len },
    ]);
  });

  it('reads one range when the gap is exactly 256 KiB and two when it is a byte more', async () => {
    // Chunks of this layout are 100 KiB (+28), so a gap of 2 chunks is ~200 KiB (merges) and 3 is ~300 KiB (splits).
    const { reader, spy } = await open(await build(crypto));
    await getChunks(reader, [0, 3]);
    expect(spy.ranges).toHaveLength(1);
    spy.ranges.length = 0;
    await getChunks(reader, [0, 4]);
    expect(spy.ranges).toHaveLength(2);
    expect(MAX_COALESCE_GAP_BYTES).toBe(256 * KIB);
    expect(MAX_COALESCED_READ_BYTES).toBe(1024 * KIB);
  });

  it('answers in the order asked, once for a repeated key, and null for an absent one', async () => {
    const { reader, spy } = await open(await build(crypto));
    const got = await getChunks(reader, [0, 2, 9, 9, 15, 65_535]);
    const same = (i: number, key: number | null) =>
      key === null ? expect(got[i]).toBeNull() : expectSameBytes(got[i]!, PAYLOADS.get(key)!);
    same(0, 0);
    same(1, 2);
    same(2, 9);
    same(3, 9);
    same(4, null);
    same(5, null);
    // 0 and 2 are one read, 9 another (7 chunks apart); 9 asked twice is read once.
    expect(spy.ranges).toHaveLength(2);
    expect(await getChunks(reader, [])).toEqual([]);
    expect(await getChunks(reader, [15, 16])).toEqual([null, null]);
    expect(spy.ranges).toHaveLength(2);
  });

  it('refuses a corrupted byte in a needed chunk as a read of that chunk alone does', async () => {
    const bytes = await build(crypto);
    const hit = stored(1, encrypted).offset + 17;
    const bad = bytes.slice();
    bad[hit] = bad[hit]! ^ 0xff;
    const { reader } = await open(bad);
    const alone = await reader.getChunk(1).catch((e: unknown) => e);
    const together = await getChunks(reader, [0, 1, 2]).catch((e: unknown) => e);
    expect(alone).toBeInstanceOf(IntegrityError);
    expect(together).toBeInstanceOf(IntegrityError);
    expect((together as Error).message).toBe((alone as Error).message);
    // The chunks around it are fine alone.
    expect(await getChunks(reader, [0, 2])).toHaveLength(2);
  });

  it('does not read a corrupted byte in a gap: only the chunks asked for are checked', async () => {
    const bytes = await build(crypto);
    const bad = bytes.slice();
    for (const key of [1, 2]) {
      const at = stored(key, encrypted).offset + 5;
      bad[at] = bad[at]! ^ 0xff;
    }
    const { reader, spy } = await open(bad);
    const got = await getChunks(reader, [0, 3]); // 1 and 2 lie between them, inside the one range
    expect(spy.ranges).toHaveLength(1);
    expectSameBytes(got[0]!, PAYLOADS.get(0)!);
    expectSameBytes(got[1]!, PAYLOADS.get(3)!);
    await expect(getChunks(reader, [0, 1, 3])).rejects.toBeInstanceOf(IntegrityError);
  });

  it('treats a range that comes back short as an error', async () => {
    const bytes = await build(crypto);
    const { reader } = await open(
      bytes,
      new Spy(new BufferReader(bytes), (b) => b.subarray(0, b.length - 1)),
    );
    await expect(getChunks(reader, [0, 1])).rejects.toThrow(/read short/);
  });

  it('never reads outside the chunk region, even for every chunk', async () => {
    const bytes = await build(crypto);
    const { reader, spy } = await open(bytes);
    await getChunks(reader, KEYS);
    const end = stored(20, encrypted).offset + stored(20, encrypted).length;
    expect(spy.ranges.length).toBeGreaterThan(1); // the 1 MiB bound splits the run
    for (const r of spy.ranges) {
      expect(r.offset).toBeGreaterThanOrEqual(PAYLOAD_START);
      expect(r.offset + r.length).toBeLessThanOrEqual(end);
      if (r.length > MAX_COALESCED_READ_BYTES) throw new Error('a range over the bound');
    }
    expect(spy.ranges[0]!.offset).toBe(PAYLOAD_START);
    const last = spy.ranges[spy.ranges.length - 1]!;
    expect(last.offset + last.length).toBe(end);
  });

  it('hands back writable views that share the range they were read in, and one view for a repeated key', async () => {
    const { reader } = await open(await build(crypto));
    const got = await getChunks(reader, [0, 0, 1]);
    expect(got[0]).toBe(got[1]);
    if (!encrypted) {
      // Documented: a plain chunk is a view into its range, so a caller that keeps one copies it.
      expect(got[0]!.buffer.byteLength).toBeGreaterThan(got[0]!.byteLength);
      expect(got[0]!.buffer).toBe(got[2]!.buffer);
    }
  });

  it('runs every range read through the retry runner it is given', async () => {
    const { reader, spy } = await open(await build(crypto));
    let runs = 0;
    await getChunks(reader, [0, 9], (read) => {
      runs++;
      return read();
    });
    expect(runs).toBe(spy.ranges.length);
    expect(runs).toBe(2);
  });
});

describe('CrbmReader.readChunks: payload cap and associated data', () => {
  it('still refuses an index entry over the payload cap when the object is opened', async () => {
    const sink = new BufferSink();
    const writer = new CrbmWriter(sink, { generation: 1 });
    await writer.addChunk(0, new Uint8Array(1024 * KIB + 1), 1);
    await writer.finish();
    await expect(CrbmReader.open(new BufferReader(sink.bytes()))).rejects.toBeInstanceOf(
      IntegrityError,
    );
  });

  it('opens each encrypted chunk under the associated data of its own key', async () => {
    const bytes = await build(cryptoFor(dek));
    const asked: unknown[] = [];
    const spying: CrbmCrypto = {
      aead: new NodeAead(dek),
      aadFor: (scope) => {
        asked.push(scope);
        return aadFor(SEG, 3, scope);
      },
    };
    const reader = await CrbmReader.open(new BufferReader(bytes), { crypto: spying });
    asked.length = 0;
    await getChunks(reader, [0, 1, 2]);
    expect(asked).toEqual([0, 1, 2]);

    // A reader whose associated data for chunk 1 is chunk 2's cannot open chunk 1, however it was fetched.
    const crossed: CrbmCrypto = {
      aead: new NodeAead(dek),
      aadFor: (scope) => aadFor(SEG, 3, scope === 1 ? 2 : scope),
    };
    const other = await CrbmReader.open(new BufferReader(bytes), { crypto: crossed });
    await expect(getChunks(other, [0, 1, 2])).rejects.toBeInstanceOf(IntegrityError);
    expect(await getChunks(other, [0, 2])).toHaveLength(2);
  });

  it('refuses two chunks whose bytes were swapped, plain or encrypted', async () => {
    for (const crypto of [undefined, cryptoFor(dek)]) {
      const bytes = await build(crypto);
      const a = stored(1, crypto !== undefined);
      const b = stored(2, crypto !== undefined);
      const swapped = bytes.slice();
      swapped.set(bytes.subarray(b.offset, b.offset + b.length), a.offset);
      swapped.set(bytes.subarray(a.offset, a.offset + a.length), b.offset);
      const reader = await CrbmReader.open(new BufferReader(swapped), crypto ? { crypto } : {});
      await expect(getChunks(reader, [1, 2])).rejects.toBeInstanceOf(IntegrityError);
    }
  });
});

/** A blob that counts the range reads in flight, the requests made and the bytes asked for, and can fail some. */
class Parking implements BlobReader {
  inFlight = 0;
  peak = 0;
  requests = 0;
  bytesAsked = 0;
  failFrom: number | undefined;
  constructor(private readonly inner: BlobReader) {}
  async getRange(offset: number, length: number): Promise<Uint8Array> {
    const n = ++this.requests;
    this.bytesAsked += length;
    this.inFlight++;
    this.peak = Math.max(this.peak, this.inFlight);
    await new Promise((r) => setTimeout(r, 5));
    this.inFlight--;
    if (this.failFrom !== undefined && n >= this.failFrom) throw new Error(`range ${n} failed`);
    return this.inner.getRange(offset, length);
  }
  getTail(maxBytes: number) {
    return this.inner.getTail(maxBytes);
  }
}

const MIB = 1024 * KIB;

/** `sizes.length` chunks of the given sizes, keys 0 up, each its own range when sizes are a full MiB. */
async function object(sizes: readonly number[], crypto?: CrbmCrypto): Promise<Uint8Array> {
  const sink = new BufferSink();
  const writer = new CrbmWriter(sink, { generation: 1, ...(crypto ? { crypto } : {}) });
  const payload = new Uint8Array(randomBytes(MIB));
  for (const [key, size] of sizes.entries()) {
    await writer.addChunk(key, payload.subarray(0, size), 1);
  }
  await writer.finish();
  return sink.bytes();
}
const keysOf = (n: number): number[] => Array.from({ length: n }, (_, i) => i);

describe('CrbmReader.readChunks: what a stream holds and has in flight', () => {
  it.each([
    { name: 'plain', crypto: undefined, extra: 0 },
    { name: 'encrypted', crypto: cryptoFor(dek), extra: AEAD_NONCE_BYTES + AEAD_TAG_BYTES },
  ])(
    'never holds more than `concurrency` ranges, in flight or landed and not taken, however slowly it is read ($name)',
    async ({ crypto, extra }) => {
      // 70 chunks of a full MiB, each its own range: the worst object a stream can be given.
      const stored = MIB + extra;
      const bytes = await object(
        Array.from({ length: 70 }, () => MIB),
        crypto,
      );
      for (const width of [1, 4, 32, 64]) {
        const parking = new Parking(new BufferReader(bytes));
        const reader = await CrbmReader.open(parking, crypto ? { crypto } : {});
        parking.requests = 0;
        parking.bytesAsked = 0;
        parking.peak = 0;
        let taken = 0;
        for await (const item of reader.readChunks(keysOf(70), { concurrency: width })) {
          expect(item.bytes!.length).toBe(MIB);
          taken++;
          await tick(2); // a slow consumer: the stream must not run on without it
          // ranges requested but not yet consumed, at most the width, so at most width x the largest range held
          expect(parking.requests - taken).toBeLessThanOrEqual(width);
          expect(parking.bytesAsked - taken * stored).toBeLessThanOrEqual(width * stored);
        }
        expect(taken).toBe(70);
        expect(parking.requests).toBe(70);
        expect(parking.peak).toBeLessThanOrEqual(width);
      }
    },
    60_000,
  );

  /**
   * A reader over `count` 1 MiB chunks whose every range read allocates a buffer of its own, and (encrypted) whose
   * every decrypted chunk is a buffer of its own, both watched, with a gate the reads wait on once they have allocated.
   */
  async function watchedReader(crypto: CrbmCrypto | undefined, count: number) {
    const ranges = new Watched();
    const plains = new Watched(true);
    const gate = new Gate();
    const inner = new BufferReader(
      await object(
        Array.from({ length: count }, () => MIB),
        crypto,
      ),
    );
    const blob: BlobReader = {
      getRange: async (offset, length) => {
        const copy = ranges.track(new Uint8Array(await inner.getRange(offset, length)));
        await gate.wait();
        return copy;
      },
      getTail: (max) => inner.getTail(max),
    };
    const watching: CrbmCrypto | undefined = crypto && {
      aadFor: crypto.aadFor,
      aead: {
        seal: (p, a) => crypto.aead.seal(p, a),
        open: (sealed, aad) => plains.track(crypto.aead.open(sealed, aad)),
      },
    };
    const reader = await CrbmReader.open(blob, watching ? { crypto: watching } : {});
    ranges.reset();
    plains.reset(); // opening the object decrypted its index: not a chunk
    return { reader, ranges, plains, gate };
  }

  describe.each([
    { name: 'plain', crypto: undefined },
    { name: 'encrypted', crypto: cryptoFor(dek) },
  ])('a consumer that waits inside the stream ($name)', ({ crypto }) => {
    it.each([1, 4, 8])(
      'holds at most `concurrency` range buffers and no decrypted chunk, at width %i',
      async (width) => {
        const { reader, ranges, plains, gate } = await watchedReader(crypto, 64);
        const it = reader.readChunks(keysOf(64), { concurrency: width });
        const { worst, waits } = await worstWhileWaiting(
          () => it.next(),
          gate,
          async () => [await ranges.live(), await plains.live()],
          4,
        );
        await it.return(undefined);
        expect(waits, 'the stream was caught waiting').toBe(4);
        expect(worst[0]!, 'range buffers held').toBeLessThanOrEqual(width);
        expect(worst[1]!, 'decrypted chunks held').toBe(0);
      },
      60_000,
    );

    it.each([1, 4])(
      'holds nothing of a key it answered several times once the last repeat is out, at width %i',
      async (width) => {
        const { reader, ranges, plains, gate } = await watchedReader(crypto, 64);
        // Every key asked for one to three times over, so the stream waits for the next range just after a repeat.
        const keys = keysOf(64).flatMap((key) => Array.from({ length: (key % 3) + 1 }, () => key));
        const it = reader.readChunks(keys, { concurrency: width });
        const { worst, waits } = await worstWhileWaiting(
          () => it.next(),
          gate,
          async () => [await ranges.live(), await plains.live()],
          6,
        );
        await it.return(undefined);
        expect(waits).toBe(6);
        expect(worst[0]!, 'range buffers held').toBeLessThanOrEqual(width);
        expect(worst[1]!, 'decrypted chunks held').toBe(0);
      },
      60_000,
    );

    it('holds nothing once its last chunk is out and the consumer lets go of it', async () => {
      const { reader, ranges, plains } = await watchedReader(crypto, 8);
      const it = reader.readChunks([0, 3, 3, 3, 7, 7], { concurrency: 2 });
      for (let n = 0; n < 6; n++) await it.next().then(() => undefined);
      expect((await it.next()).done).toBe(true);
      expect(await ranges.live()).toBe(0);
      expect(await plains.live()).toBe(0);
    });
  });

  it('runs as many ranges together as the width allows, and the default width is 32', async () => {
    const parking = new Parking(
      new BufferReader(await object(Array.from({ length: 40 }, () => MIB))),
    );
    const reader = await CrbmReader.open(parking);
    parking.peak = 0;
    await collect(reader.readChunks(keysOf(40)));
    expect(MAX_RANGES_IN_FLIGHT).toBe(32);
    expect(parking.peak).toBe(32);
    parking.peak = 0;
    await collect(reader.readChunks(keysOf(40), { concurrency: 8 }));
    expect(parking.peak).toBe(8);
    // No clamp: a caller that asks for more gets more.
    parking.peak = 0;
    await collect(reader.readChunks(keysOf(40), { concurrency: 40 }));
    expect(parking.peak).toBe(40);
  });

  it('issues a sparse plan of many tiny ranges through the window, and yields every chunk', async () => {
    // 100 needed chunks of 100 bytes, each followed by a 300 KiB chunk nobody asked for: 100 ranges of their own.
    const sink = new BufferSink();
    const writer = new CrbmWriter(sink, { generation: 1 });
    const payload = new Uint8Array(randomBytes(300 * KIB));
    for (let i = 0; i < 100; i++) {
      await writer.addChunk(2 * i, payload.subarray(0, 100), 1);
      await writer.addChunk(2 * i + 1, payload, 1);
    }
    await writer.finish();
    const parking = new Parking(new BufferReader(sink.bytes()));
    const reader = await CrbmReader.open(parking);
    parking.requests = 0;
    parking.peak = 0;
    const got = await getChunks(
      reader,
      Array.from({ length: 100 }, (_, i) => 2 * i),
    );
    expect(parking.requests).toBe(100);
    expect(parking.peak).toBeGreaterThan(1);
    expect(parking.peak).toBeLessThanOrEqual(MAX_RANGES_IN_FLIGHT);
    expect(got.every((c) => c !== null && c.length === 100)).toBe(true);
  });

  it('reads nothing until the first chunk is asked for', async () => {
    const parking = new Parking(new BufferReader(await object(keysOf(5).map(() => MIB))));
    const reader = await CrbmReader.open(parking);
    parking.requests = 0;
    const stream = reader.readChunks(keysOf(5));
    await tick();
    expect(parking.requests).toBe(0);
    await stream.next();
    expect(parking.requests).toBeGreaterThan(0);
    await stream.return(undefined);
  });

  it('opens its window 1, 2, 4 ranges wide with `ramp`, so a reader that stops early has asked for little', async () => {
    const parking = new Parking(new BufferReader(await object(keysOf(40).map(() => MIB))));
    const reader = await CrbmReader.open(parking);
    parking.requests = 0;
    const stream = reader.readChunks(keysOf(40), { ramp: true });
    await stream.next();
    expect(parking.requests).toBe(1);
    await stream.next();
    expect(parking.requests).toBe(3);
    await stream.next();
    expect(parking.requests).toBe(6); // 1, then 2 ahead of the one taken, then 4
    await stream.return(undefined);
  });

  it('stops launching ranges when the consumer stops, and a range that fails afterwards is never raised', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      const parking = new Parking(new BufferReader(await object(keysOf(70).map(() => MIB))));
      const reader = await CrbmReader.open(parking);
      parking.requests = 0;
      parking.failFrom = 2; // every range after the first fails, when it lands
      for await (const item of reader.readChunks(keysOf(70), { concurrency: 4 })) {
        expect(item.key).toBe(0);
        break;
      }
      await tick(60);
      expect(parking.requests).toBe(4); // the window the first take opened, and no more
      expect(parking.inFlight).toBe(0);
      await tick(20);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
    expect(unhandled).toEqual([]);
  });

  it('yields the chunks before a bad one, then ends with its error when its turn comes', async () => {
    const bytes = await object(keysOf(6).map(() => MIB));
    const reader = await CrbmReader.open(new BufferReader(bytes));
    const bad = bytes.slice();
    const at = PAYLOAD_START + 3 * MIB + 9; // chunk 3
    bad[at] = bad[at]! ^ 0xff;
    const damaged = await CrbmReader.open(new BufferReader(bad));
    const seen: number[] = [];
    let thrown: unknown;
    try {
      for await (const item of damaged.readChunks(keysOf(6))) seen.push(item.key);
    } catch (err) {
      thrown = err;
    }
    expect(seen).toEqual([0, 1, 2]);
    expect(thrown).toBeInstanceOf(IntegrityError);
    expect(await getChunks(reader, keysOf(6))).toHaveLength(6);
  });

  it('tells onRequest of each range it sends, once, with what the request moved and how long it took', async () => {
    const reader = await CrbmReader.open(new BufferReader(await build()));
    let t = 0;
    const requests: { bytes: number; ms: number }[] = [];
    await collect(
      reader.readChunks([0, 1, 2, 4, 9, 20], {
        // one reading when a range starts and one when it lands: each takes 7
        now: () => (t += 7),
        onRequest: (r) => requests.push(r),
      }),
    );
    expect(requests.map((r) => r.bytes).sort()).toEqual([2 * SIZE, 5 * SIZE].sort());
    for (const r of requests) expect(r.ms).toBeGreaterThan(0);
    // An absent key sends none, and a repeated key does not count its request twice.
    const again: unknown[] = [];
    await collect(reader.readChunks([0, 0, 15], { onRequest: (r) => again.push(r) }));
    expect(again).toHaveLength(1);
  });

  it('tells onRequest of a range nobody took: every request launched is reported, before and after the stop', async () => {
    const parking = new Parking(new BufferReader(await object(keysOf(40).map(() => MIB))));
    const reader = await CrbmReader.open(parking);
    parking.requests = 0;
    const reported: { bytes: number }[] = [];
    const stream = reader.readChunks(keysOf(40), {
      concurrency: 8,
      onRequest: (r) => reported.push(r),
    });
    await stream.next();
    await stream.return(undefined);
    await tick(40);
    expect(parking.requests).toBeGreaterThan(1);
    expect(reported).toHaveLength(parking.requests);
    expect(reported.every((r) => r.bytes === MIB)).toBe(true);
    const launched = parking.requests;
    await tick(40);
    expect(parking.requests).toBe(launched); // nothing more after the stop, and nothing more reported
    expect(reported).toHaveLength(launched);
  });

  it('reports a range that failed with no bytes, and ignores a sink that throws', async () => {
    const parking = new Parking(new BufferReader(await object(keysOf(6).map(() => MIB))));
    const reader = await CrbmReader.open(parking);
    parking.requests = 0;
    parking.failFrom = 3;
    const reported: { bytes: number }[] = [];
    await expect(
      collect(reader.readChunks(keysOf(6), { concurrency: 6, onRequest: (r) => reported.push(r) })),
    ).rejects.toThrow(/range 3 failed/);
    await tick(40);
    expect(reported).toHaveLength(parking.requests);
    expect(reported.filter((r) => r.bytes === 0).length).toBeGreaterThan(0);
    expect(reported.filter((r) => r.bytes === MIB).length).toBeGreaterThan(0);

    parking.failFrom = undefined;
    parking.requests = 0;
    const got = await collect(
      reader.readChunks(keysOf(3), {
        onRequest: () => {
          throw new Error('a sink that throws');
        },
      }),
    );
    expect(got).toHaveLength(3);
  });

  it('reports a retried range once, when it settles', async () => {
    const reader = await CrbmReader.open(new BufferReader(await build()));
    const reported: { bytes: number }[] = [];
    let attempts = 0;
    await collect(
      reader.readChunks([0, 1], {
        readRange: async (read) => {
          attempts++;
          try {
            return await read();
          } catch {
            return read();
          }
        },
        onRequest: (r) => reported.push(r),
      }),
    );
    expect(attempts).toBe(1);
    expect(reported).toHaveLength(1);
  });

  it('refuses keys out of ascending order and a width that is not a positive integer', async () => {
    const reader = await CrbmReader.open(new BufferReader(await build()));
    await expect(collect(reader.readChunks([2, 1]))).rejects.toBeInstanceOf(ValidationError);
    for (const concurrency of [0, -1, 1.5, Number.NaN]) {
      await expect(collect(reader.readChunks([0], { concurrency }))).rejects.toBeInstanceOf(
        ValidationError,
      );
    }
  });
});

describe('CrbmReader.readChunks: an object with the metadata extension block', () => {
  it('reads every chunk and no byte past the last of them', async () => {
    const sink = new BufferSink();
    const writer = new CrbmWriter(sink, { generation: 3, metadata: { source: 'test' } });
    for (const k of KEYS) await writer.addChunk(k, PAYLOADS.get(k)!, 1 + k);
    await writer.finish();
    const bytes = sink.bytes();
    const spy = new Spy(new BufferReader(bytes));
    const reader = await CrbmReader.open(spy);
    expect(reader.metadata).toEqual({ source: 'test' });
    spy.ranges.length = 0;
    const got = await getChunks(reader, KEYS);
    for (const [i, k] of KEYS.entries()) {
      expectSameBytes(got[i]!, PAYLOADS.get(k)!);
    }
    const last = spy.ranges[spy.ranges.length - 1]!;
    const end = stored(20, false).offset + stored(20, false).length;
    expect(last.offset + last.length).toBe(end);
    // The extension block follows the last chunk, so the object is longer than the chunk region.
    expect(bytes.length - 104).toBeGreaterThan(end);
  });
});
