/**
 * `tailBytes` is the bytes of an object after its chunk payloads: any extension block, the index and the footer. The
 * writer reports it for the object it wrote and the reader for the object it opened, and they must agree, since a
 * cold open sizes its first tail read from it. `footerCrcUnder` reads an object's footer CRC with no key.
 */
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { BufferReader, BufferSink } from '@/core/blob';
import { footerCrcUnder, openRollbackTargetFrom, readRollbackTargetFooter } from '@/core/crbm-open';
import { CrbmReader } from '@/core/crbm/reader';
import { CrbmWriter } from '@/core/crbm/writer';
import { DEFAULT_TAIL_BYTES, FOOTER_BYTES } from '@/core/crbm/format';
import { fingerprintFor } from '@/core/crbm/fingerprint';
import {
  writeCrbmGeneration,
  writeCrbmGenerationStream,
  writeEncodedChunks,
} from '@/core/crbm-write';
import type { CodecBitmap } from '@/core/codec';
import { aadFor } from '@/core/crypto';
import type { CrbmCrypto } from '@/core/crypto';
import { IntegrityError, NotFoundError } from '@/core/errors';
import type { GenKey, IStorageDriver, TailRead } from '@/core/ports';
import { NodeAead } from '@/drivers/crypto';
import { MemoryStorageDriver } from '@/drivers/memory';

const SEG = { segment: 'tail-bytes' };
const dek = new Uint8Array(randomBytes(32));
const cryptoFor = (generation: number): CrbmCrypto => ({
  aead: new NodeAead(dek),
  aadFor: (scope) => aadFor(SEG, generation, scope),
});

/** An object of `chunks` one-byte chunks, so the index, not the payloads, is what grows. */
async function build(
  generation: number,
  chunks: number,
  options: { encrypted: boolean; metadata?: Record<string, string | number> },
): Promise<{ bytes: Uint8Array; identity: CrbmWriter['identity'] }> {
  const sink = new BufferSink();
  const writer = new CrbmWriter(sink, {
    generation,
    ...(options.encrypted ? { crypto: cryptoFor(generation) } : {}),
    ...(options.metadata ? { metadata: options.metadata } : {}),
  });
  for (let k = 0; k < chunks; k++) await writer.addChunk(k, Uint8Array.of(k & 0xff), 1);
  await writer.finish();
  return { bytes: sink.bytes(), identity: writer.identity };
}

const cases = [
  { name: 'narrow', chunks: 5, wide: false },
  { name: 'wide', chunks: 40_000, wide: true },
] as const;
const variants = [
  { encrypted: false, metadata: undefined },
  { encrypted: false, metadata: { source: 'nightly', rows: 42 } },
  { encrypted: true, metadata: undefined },
  { encrypted: true, metadata: { source: 'nightly', rows: 42 } },
] as const;

describe.each(cases)('tailBytes of a $name object', ({ chunks, wide }) => {
  it.each(variants)(
    'is the writer’s and the reader’s alike (encrypted $encrypted, metadata $metadata)',
    async ({ encrypted, metadata }) => {
      const { bytes, identity } = await build(7, chunks, { encrypted, metadata });
      const reader = await CrbmReader.open(new BufferReader(bytes), {
        ...(encrypted ? { crypto: cryptoFor(7) } : {}),
      });
      expect(reader.tailBytes).toBe(identity.tailBytes);
      // Pinned from the format itself: the chunk payloads end where the tail begins.
      expect(bytes.length - reader.tailBytes).toBe(
        8 + chunks * (1 + (encrypted ? 28 : 0)), // preamble, then the payloads
      );
      expect(reader.tailBytes).toBeGreaterThan(FOOTER_BYTES);
      expect(reader.sizeBytes).toBe(identity.size);
      // A tail read of exactly that many bytes holds the whole index and footer.
      expect(wide).toBe(identity.tailBytes > DEFAULT_TAIL_BYTES);
      expect(reader.servedFromTail).toBe(!wide);
    },
  );

  it('is larger with metadata than without, by the extension block', async () => {
    const plain = await build(1, chunks, { encrypted: false });
    const withMeta = await build(1, chunks, { encrypted: false, metadata: { a: 1 } });
    expect(withMeta.identity.tailBytes).toBeGreaterThan(plain.identity.tailBytes);
    expect(withMeta.identity.size - plain.identity.size).toBe(
      withMeta.identity.tailBytes - plain.identity.tailBytes,
    );
  });
});

describe('the write results carry tailBytes', () => {
  it.each([false, true])(
    'writeEncodedChunks reports the reader’s (encrypted %s)',
    async (encrypted) => {
      const storage = new MemoryStorageDriver();
      const key: GenKey = { ...SEG, generation: 4 };
      const written = await writeEncodedChunks(
        storage,
        key,
        [
          { chunkKey: 0, payload: Uint8Array.of(1, 2, 3), cardinality: 2 },
          { chunkKey: 9, payload: Uint8Array.of(4), cardinality: 1 },
        ],
        { ...(encrypted ? { crypto: cryptoFor(4) } : {}), metadata: { n: 1 } },
      );
      const tail = await storage.getTail(key, 1 << 20);
      const reader = await CrbmReader.open(new BufferReader(tail.bytes), {
        ...(encrypted ? { crypto: cryptoFor(4) } : {}),
      });
      expect(written.tailBytes).toBe(reader.tailBytes);
      expect(written.fingerprint).toBe(reader.fingerprint);
    },
  );
});

/** A bitmap as far as a write sees one: its bytes and its size. */
const bitmap = (bytes: number[], size: number): CodecBitmap =>
  ({
    serialize: () => Uint8Array.from(bytes),
    size,
    isEmpty: size === 0,
  }) as unknown as CodecBitmap;

describe('every write path reports the reader’s tailBytes', () => {
  const chunks = [
    { chunkKey: 0, bitmap: bitmap([1, 2, 3], 2) },
    { chunkKey: 4, bitmap: bitmap([9], 1) },
  ];
  it.each(['whole', 'stream'] as const)('%s', async (path) => {
    const storage = new MemoryStorageDriver();
    const key: GenKey = { ...SEG, generation: 8 };
    const options = { metadata: { n: 1 } };
    const written =
      path === 'whole'
        ? await writeCrbmGeneration(storage, key, chunks, options)
        : await writeCrbmGenerationStream(
            storage,
            key,
            (async function* () {
              yield* chunks;
            })(),
            options,
          );
    const tail = await storage.getTail(key, 1 << 20);
    const reader = await CrbmReader.open(new BufferReader(tail.bytes));
    expect(written.tailBytes).toBe(reader.tailBytes);
    expect(written.tailBytes).toBeGreaterThan(FOOTER_BYTES);
  });
});

/** A driver that records each request it is asked. */
function tracing(inner: IStorageDriver): { driver: IStorageDriver; trace: string[] } {
  const trace: string[] = [];
  const driver = Object.create(inner) as IStorageDriver;
  driver.getTail = (key: GenKey, maxBytes: number): Promise<TailRead> => {
    trace.push(`getTail ${key.generation} ${maxBytes}`);
    return inner.getTail(key, maxBytes);
  };
  driver.getRange = (key: GenKey, offset: number, length: number) => {
    trace.push(`getRange ${key.generation} ${offset} ${length}`);
    return inner.getRange(key, offset, length);
  };
  driver.list = (ref) => {
    trace.push('list');
    return inner.list(ref);
  };
  return { driver, trace };
}

async function store(
  storage: IStorageDriver,
  generation: number,
  encrypted: boolean,
): Promise<{ footerCrc: number }> {
  const { bytes, identity } = await build(generation, 12, { encrypted, metadata: { a: 1 } });
  await storage.putImmutable({ ...SEG, generation }, (out) => out.write(bytes));
  return { footerCrc: identity.footerCrc };
}

describe('the footer step of a rollback, and footerCrcUnder', () => {
  it.each([false, true])(
    'reports the footer CRC and the encryption flag with no key, in one request (encrypted %s)',
    async (encrypted) => {
      const memory = new MemoryStorageDriver();
      const { footerCrc } = await store(memory, 3, encrypted);
      const key: GenKey = { ...SEG, generation: 3 };

      const crc = tracing(memory);
      expect(await footerCrcUnder(crc.driver, key)).toBe(footerCrc);
      expect(crc.trace).toEqual([`getTail 3 ${FOOTER_BYTES}`]);

      const step = tracing(memory);
      const footer = await readRollbackTargetFooter(step.driver, key);
      expect(footer.encrypted).toBe(encrypted);
      expect(footer.footerCrc).toBe(footerCrc);
      expect(step.trace).toEqual([`getTail 3 ${DEFAULT_TAIL_BYTES}`]);
    },
  );

  it('names the same object as the reader’s fingerprint does', async () => {
    const memory = new MemoryStorageDriver();
    const { footerCrc } = await store(memory, 2, true);
    const tail = await memory.getTail({ ...SEG, generation: 2 }, DEFAULT_TAIL_BYTES);
    expect(fingerprintFor(tail.size, footerCrc)).toBe(
      fingerprintFor(tail.size, await footerCrcUnder(memory, { ...SEG, generation: 2 })),
    );
  });

  it('passes NotFoundError through, and refuses a footer that fails its checks', async () => {
    const memory = new MemoryStorageDriver();
    await expect(footerCrcUnder(memory, { ...SEG, generation: 99 })).rejects.toThrow(NotFoundError);
    await expect(readRollbackTargetFooter(memory, { ...SEG, generation: 99 })).rejects.toThrow(
      NotFoundError,
    );
    await memory.putImmutable({ ...SEG, generation: 5 }, (out) =>
      out.write(new Uint8Array(200).fill(7)),
    );
    await expect(footerCrcUnder(memory, { ...SEG, generation: 5 })).rejects.toThrow(IntegrityError);
  });

  it('opens from the remembered tail with no further request', async () => {
    const memory = new MemoryStorageDriver();
    await store(memory, 3, true);
    const key: GenKey = { ...SEG, generation: 3 };
    const { driver, trace } = tracing(memory);
    const footer = await readRollbackTargetFooter(driver, key);
    const reader = await openRollbackTargetFrom(footer, key, cryptoFor(3));
    expect(reader?.generation).toBe(3);
    expect(trace).toHaveLength(1);
    // No key for an encrypted object: no reader, and no request either.
    expect(await openRollbackTargetFrom(footer, key, undefined)).toBeUndefined();
    expect(trace).toHaveLength(1);
  });
});
