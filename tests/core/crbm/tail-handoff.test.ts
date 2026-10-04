/**
 * A reader whose tail read returned the whole object keeps the chunk region when it fits the limit it was opened with,
 * so reading a chunk of it makes no request. Every case counts the requests a spy blob saw, and reads the bytes back.
 */
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { BufferReader, BufferSink } from '@/core/blob';
import type { BlobReader } from '@/core/blob';
import { openCrbmReaderKeeping } from '@/core/crbm/reader';
import { CrbmWriter } from '@/core/crbm/writer';
import { AEAD_NONCE_BYTES, AEAD_TAG_BYTES, PAYLOAD_START } from '@/core/crbm/format';
import { aadFor } from '@/core/crypto';
import type { CrbmCrypto } from '@/core/crypto';
import { NodeAead } from '@/drivers/crypto';
import { IntegrityError } from '@/core/errors';
import { collect, expectSameBytes } from '../../helpers/chunk-stream';

const SEG = { segment: 'handoff' };
const KEYS = [0, 1, 2, 5];
const SIZE = 3000;
const PAYLOADS = new Map(KEYS.map((k) => [k, new Uint8Array(randomBytes(SIZE))]));
const dek = new Uint8Array(randomBytes(32));
const cryptoFor = (): CrbmCrypto => ({
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

/** A blob that counts the tail and range reads it serves. */
class Spy implements BlobReader {
  ranges = 0;
  tails = 0;
  constructor(private readonly inner: BlobReader) {}
  async getRange(offset: number, length: number): Promise<Uint8Array> {
    this.ranges++;
    return this.inner.getRange(offset, length);
  }
  getTail(maxBytes: number) {
    this.tails++;
    return this.inner.getTail(maxBytes);
  }
}

const variants = [
  { name: 'plain', encrypted: false, crypto: undefined },
  { name: 'encrypted', encrypted: true, crypto: cryptoFor() },
] as const;

describe.each(variants)('a reader that keeps the chunk region ($name)', ({ encrypted, crypto }) => {
  const regionBytes = KEYS.length * (SIZE + (encrypted ? AEAD_NONCE_BYTES + AEAD_TAG_BYTES : 0));
  const opts = crypto ? { crypto } : {};
  const open = async (limit: number | undefined, extra: { tailBytes?: number } = {}) => {
    const bytes = await build(crypto);
    const spy = new Spy(new BufferReader(bytes));
    const reader = await openCrbmReaderKeeping(spy, { ...opts, ...extra }, limit);
    return { bytes, spy, reader };
  };

  it('serves getChunk with no request, the bytes a range read gives', async () => {
    const kept = await open(regionBytes);
    const plain = await open(undefined);
    expect(kept.spy.tails).toBe(1);
    for (const k of KEYS) {
      expectSameBytes(await kept.reader.getChunk(k), PAYLOADS.get(k));
      expectSameBytes(await plain.reader.getChunk(k), PAYLOADS.get(k));
    }
    expect(kept.spy.ranges).toBe(0);
    expect(plain.spy.ranges).toBe(KEYS.length);
    expect(await kept.reader.getChunk(3)).toBeNull();
  });

  it('serves readChunks with no request and no onRequest call, in key order with nulls and repeats', async () => {
    const { reader, spy } = await open(regionBytes);
    const requests: unknown[] = [];
    const items = await collect(
      reader.readChunks([0, 1, 1, 3, 5], { onRequest: (r) => requests.push(r) }),
    );
    expect(items.map((i) => i.key)).toEqual([0, 1, 1, 3, 5]);
    expectSameBytes(items[0]!.bytes, PAYLOADS.get(0));
    expectSameBytes(items[1]!.bytes, PAYLOADS.get(1));
    expect(items[2]!.bytes).toBe(items[1]!.bytes);
    expect(items[3]!.bytes).toBeNull();
    expectSameBytes(items[4]!.bytes, PAYLOADS.get(5));
    expect(spy.ranges).toBe(0);
    expect(requests).toEqual([]);
  });

  it('keeps nothing when the region is a byte over the limit, and reads ranges', async () => {
    const { reader, spy } = await open(regionBytes - 1);
    expectSameBytes(await reader.getChunk(0), PAYLOADS.get(0));
    await collect(reader.readChunks([1, 2]));
    expect(spy.ranges).toBe(2);
  });

  it('keeps nothing when it was opened with no limit or a limit of zero', async () => {
    for (const limit of [undefined, 0]) {
      const { reader, spy } = await open(limit);
      await reader.getChunk(0);
      expect(spy.ranges).toBe(1);
      expect(reader.retainedBytes).toBe(reader.retainedIndexBytes);
    }
  });

  it('keeps nothing when the tail did not reach the front of the object', async () => {
    const bytes = await build(crypto);
    const spy = new Spy(new BufferReader(bytes));
    const reader = await openCrbmReaderKeeping(spy, { ...opts, tailBytes: 1024 }, 1 << 30);
    await reader.getChunk(0);
    await collect(reader.readChunks([1, 2]));
    expect(spy.ranges).toBeGreaterThanOrEqual(2);
    expect(reader.retainedBytes).toBe(reader.retainedIndexBytes);
  });

  it('counts the kept bytes in retainedBytes', async () => {
    const kept = await open(regionBytes);
    expect(kept.reader.retainedBytes).toBe(kept.reader.retainedIndexBytes + regionBytes);
  });

  it('returns a copy: a write to a returned chunk changes nothing of the next read', async () => {
    const { reader } = await open(regionBytes);
    const first = (await reader.getChunk(1))!;
    first.fill(0xee);
    expectSameBytes(await reader.getChunk(1), PAYLOADS.get(1));
    const [streamed] = await collect(reader.readChunks([2]));
    streamed!.bytes!.fill(0xee);
    expectSameBytes((await collect(reader.readChunks([2])))[0]!.bytes, PAYLOADS.get(2));
    expectSameBytes(await reader.getChunk(2), PAYLOADS.get(2));
  });

  it('holds a copy of the region, not a view of the buffer the tail came in', async () => {
    const { reader, bytes } = await open(regionBytes);
    bytes.fill(0, PAYLOAD_START, PAYLOAD_START + regionBytes);
    expectSameBytes(await reader.getChunk(0), PAYLOADS.get(0));
    expectSameBytes((await collect(reader.readChunks([5])))[0]!.bytes, PAYLOADS.get(5));
  });

  it('refuses a corrupted chunk byte with IntegrityError, from getChunk and from readChunks', async () => {
    const bytes = await build(crypto);
    const stride = SIZE + (encrypted ? AEAD_NONCE_BYTES + AEAD_TAG_BYTES : 0);
    bytes[PAYLOAD_START + stride + 7]! ^= 0xff; // a byte of the chunk at key 1
    const spy = new Spy(new BufferReader(bytes));
    const reader = await openCrbmReaderKeeping(spy, opts, regionBytes);
    expectSameBytes(await reader.getChunk(0), PAYLOADS.get(0));
    await expect(reader.getChunk(1)).rejects.toBeInstanceOf(IntegrityError);
    await expect(collect(reader.readChunks([0, 1]))).rejects.toBeInstanceOf(IntegrityError);
    expect(spy.ranges).toBe(0);
  });
});

it('refuses an encrypted chunk moved to another key, as a range read does', async () => {
  const crypto = cryptoFor();
  const bytes = await build(crypto);
  const stride = SIZE + AEAD_NONCE_BYTES + AEAD_TAG_BYTES;
  // Chunk 0's bytes over chunk 1's slot: the CRC of slot 1 no longer matches, so fix nothing: it must still fail.
  bytes.copyWithin(PAYLOAD_START + stride, PAYLOAD_START, PAYLOAD_START + stride);
  const reader = await openCrbmReaderKeeping(new BufferReader(bytes), { crypto }, 1 << 20);
  await expect(reader.getChunk(1)).rejects.toBeInstanceOf(IntegrityError);
});

it('weighs an encrypted region by its stored bytes, nonce and tag included', async () => {
  const crypto = cryptoFor();
  const stored = KEYS.length * (SIZE + AEAD_NONCE_BYTES + AEAD_TAG_BYTES);
  const bytes = await build(crypto);
  const spy = new Spy(new BufferReader(bytes));
  const reader = await openCrbmReaderKeeping(spy, { crypto }, stored - 1);
  await reader.getChunk(0);
  expect(spy.ranges).toBe(1);
});
