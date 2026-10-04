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
import { IntegrityError } from '@/core/errors';
import { MAX_COALESCE_GAP_BYTES, MAX_COALESCED_READ_BYTES } from '@/core/crbm/plan-reads';

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

describe.each(variants)('CrbmReader.getChunks ($name)', ({ encrypted, crypto }) => {
  const open = async (bytes: Uint8Array, spy = new Spy(new BufferReader(bytes))) => {
    const reader = await CrbmReader.open(spy, crypto ? { crypto } : {});
    spy.ranges.length = 0; // count the chunk reads, not the open
    return { reader, spy };
  };

  it('returns, for each key, the bytes a read of that chunk alone returns', async () => {
    const { reader, spy } = await open(await build(crypto));
    const keys = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 20];
    const got = await reader.getChunks(keys);
    for (const [i, key] of keys.entries()) {
      expect(Buffer.from(got[i]!)).toEqual(Buffer.from(PAYLOADS.get(key)!));
      expect(Buffer.from(got[i]!)).toEqual(Buffer.from((await reader.getChunk(key))!));
    }
    expect(spy.ranges.length).toBeGreaterThan(0);
  });

  it('makes one range read per merged range', async () => {
    const { reader, spy } = await open(await build(crypto));
    const len = stored(0, encrypted).length;
    // Keys 0-2 are adjacent, 4 is 100 KiB past 2: one read. 9 is 400 KiB past 4: its own. 20 follows 9 at once.
    await reader.getChunks([0, 1, 2, 4, 9, 20]);
    expect(spy.ranges).toEqual([
      { offset: stored(0, encrypted).offset, length: 5 * len },
      { offset: stored(9, encrypted).offset, length: 2 * len },
    ]);
  });

  it('reads one range when the gap is exactly 256 KiB and two when it is a byte more', async () => {
    // Chunks of this layout are 100 KiB (+28), so a gap of 2 chunks is ~200 KiB (merges) and 3 is ~300 KiB (splits).
    const { reader, spy } = await open(await build(crypto));
    await reader.getChunks([0, 3]);
    expect(spy.ranges).toHaveLength(1);
    spy.ranges.length = 0;
    await reader.getChunks([0, 4]);
    expect(spy.ranges).toHaveLength(2);
    expect(MAX_COALESCE_GAP_BYTES).toBe(256 * KIB);
    expect(MAX_COALESCED_READ_BYTES).toBe(1024 * KIB);
  });

  it('answers in the order asked, once for a repeated key, and null for an absent one', async () => {
    const { reader, spy } = await open(await build(crypto));
    const got = await reader.getChunks([9, 2, 9, 15, 0, 65_535]);
    const same = (i: number, key: number | null) =>
      key === null
        ? expect(got[i]).toBeNull()
        : expect(Buffer.from(got[i]!)).toEqual(Buffer.from(PAYLOADS.get(key)!));
    same(0, 9);
    same(1, 2);
    same(2, 9);
    same(3, null);
    same(4, 0);
    same(5, null);
    // 0 and 2 are one read, 9 another (7 chunks apart); 9 asked twice is read once.
    expect(spy.ranges).toHaveLength(2);
    expect(await reader.getChunks([])).toEqual([]);
    expect(await reader.getChunks([15, 16])).toEqual([null, null]);
    expect(spy.ranges).toHaveLength(2);
  });

  it('refuses a corrupted byte in a needed chunk as a read of that chunk alone does', async () => {
    const bytes = await build(crypto);
    const hit = stored(1, encrypted).offset + 17;
    const bad = bytes.slice();
    bad[hit] = bad[hit]! ^ 0xff;
    const { reader } = await open(bad);
    const alone = await reader.getChunk(1).catch((e: unknown) => e);
    const together = await reader.getChunks([0, 1, 2]).catch((e: unknown) => e);
    expect(alone).toBeInstanceOf(IntegrityError);
    expect(together).toBeInstanceOf(IntegrityError);
    expect((together as Error).message).toBe((alone as Error).message);
    // The chunks around it are fine alone.
    expect(await reader.getChunks([0, 2])).toHaveLength(2);
  });

  it('does not read a corrupted byte in a gap: only the chunks asked for are checked', async () => {
    const bytes = await build(crypto);
    const bad = bytes.slice();
    for (const key of [1, 2]) {
      const at = stored(key, encrypted).offset + 5;
      bad[at] = bad[at]! ^ 0xff;
    }
    const { reader, spy } = await open(bad);
    const got = await reader.getChunks([0, 3]); // 1 and 2 lie between them, inside the one range
    expect(spy.ranges).toHaveLength(1);
    expect(Buffer.from(got[0]!)).toEqual(Buffer.from(PAYLOADS.get(0)!));
    expect(Buffer.from(got[1]!)).toEqual(Buffer.from(PAYLOADS.get(3)!));
    await expect(reader.getChunks([0, 1, 3])).rejects.toBeInstanceOf(IntegrityError);
  });

  it('treats a range that comes back short as an error', async () => {
    const bytes = await build(crypto);
    const { reader } = await open(
      bytes,
      new Spy(new BufferReader(bytes), (b) => b.subarray(0, b.length - 1)),
    );
    await expect(reader.getChunks([0, 1])).rejects.toThrow(/read short/);
  });

  it('never reads outside the chunk region, even for every chunk', async () => {
    const bytes = await build(crypto);
    const { reader, spy } = await open(bytes);
    await reader.getChunks(KEYS);
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

  it('runs every range read through the retry runner it is given', async () => {
    const { reader, spy } = await open(await build(crypto));
    let runs = 0;
    await reader.getChunks([0, 9], (read) => {
      runs++;
      return read();
    });
    expect(runs).toBe(spy.ranges.length);
    expect(runs).toBe(2);
  });
});

describe('CrbmReader.getChunks: payload cap and associated data', () => {
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
    await reader.getChunks([0, 1, 2]);
    expect(asked).toEqual([0, 1, 2]);

    // A reader whose associated data for chunk 1 is chunk 2's cannot open chunk 1, however it was fetched.
    const crossed: CrbmCrypto = {
      aead: new NodeAead(dek),
      aadFor: (scope) => aadFor(SEG, 3, scope === 1 ? 2 : scope),
    };
    const other = await CrbmReader.open(new BufferReader(bytes), { crypto: crossed });
    await expect(other.getChunks([0, 1, 2])).rejects.toBeInstanceOf(IntegrityError);
    expect(await other.getChunks([0, 2])).toHaveLength(2);
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
      await expect(reader.getChunks([1, 2])).rejects.toBeInstanceOf(IntegrityError);
    }
  });
});
