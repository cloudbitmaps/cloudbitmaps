import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { BufferReader } from '@/core/blob';
import { decodeChunkBytes } from '@/core/chunk-checks';
import { CrbmReader } from '@/core/crbm/reader';
import { aadFor } from '@/core/crypto';
import type { CrbmCrypto } from '@/core/crypto';
import { IntegrityError } from '@/core/errors';
import { NodeAead } from '@/drivers/crypto';
import { tsRoaringCodec } from '@/ts-roaring/bitmap';
import { CloudRoaring } from '@/index';
import { joinId } from '@/core/bit-route';
import { writeCrbm } from '../helpers/crbm-extension';
import { MemoryStorageChunkSource } from '../helpers/memory-chunk-source';

/**
 * A stored chunk is exactly one serialized bitmap. Bytes after it are refused when the chunk is decoded, so an object
 * cannot carry free bytes inside a payload (cleartext or sealed) and still read as the set it names.
 */
const MAX = 1 << 20;
const clean = tsRoaringCodec.fromValues([1, 5, 70, 4000]).serialize();
const withTail = (tail: readonly number[]): Uint8Array => Uint8Array.of(...clean, ...tail);

describe('decodeChunkBytes', () => {
  it('decodes exactly one bitmap', () => {
    expect(decodeChunkBytes(tsRoaringCodec, clean, MAX).has(70)).toBe(true);
  });

  it.each([[[0]], [[1, 2, 3]], [[...clean]]])('refuses bytes after the bitmap (%j)', (tail) => {
    expect(() => decodeChunkBytes(tsRoaringCodec, withTail(tail), MAX)).toThrow(IntegrityError);
  });

  it('refuses them in a stored cleartext chunk read back from an object', async () => {
    const bytes = await writeCrbm([{ chunkKey: 0, payload: withTail([0]), cardinality: 4 }], {
      generation: 1,
    });
    const reader = await CrbmReader.open(new BufferReader(bytes));
    const stored = (await reader.getChunk(0))!;
    expect(() => decodeChunkBytes(tsRoaringCodec, stored, MAX)).toThrow(IntegrityError);
  });
});

describe('a sealed chunk', () => {
  const dek = randomBytes(32);
  const crypto: CrbmCrypto = {
    aead: new NodeAead(dek),
    aadFor: (scope) => aadFor({ segment: 's' }, 1, scope),
  };
  const opened = async (payload: Uint8Array): Promise<Uint8Array> => {
    const bytes = await writeCrbm([{ chunkKey: 0, payload, cardinality: 4 }], {
      generation: 1,
      crypto,
    });
    const reader = await CrbmReader.open(new BufferReader(bytes), { crypto });
    return (await reader.getChunk(0))!;
  };

  it('is refused when it opens to bytes after its bitmap, and read when it does not', async () => {
    const bad = await opened(withTail([9]));
    expect(() => decodeChunkBytes(tsRoaringCodec, bad, MAX)).toThrow(IntegrityError);
    const good = await opened(clean);
    expect(decodeChunkBytes(tsRoaringCodec, good, MAX).has(5)).toBe(true);
  });
});

describe('a store reading a stored chunk with bytes after its bitmap', () => {
  it('refuses it with an IntegrityError on has and on count, and reads the clean chunk beside it', async () => {
    const storage = new MemoryStorageChunkSource();
    storage.seed({ segment: 'tailed', chunkKey: 3 }, withTail([0]));
    storage.seed({ segment: 'clean', chunkKey: 3 }, clean);
    const store = new CloudRoaring({ storage });
    await expect(store.segment('tailed').has(joinId(3, 5))).rejects.toBeInstanceOf(IntegrityError);
    await expect(store.segment('tailed').count()).rejects.toBeInstanceOf(IntegrityError);
    expect(await store.segment('clean').has(joinId(3, 5))).toBe(true);
    expect(await store.segment('clean').count()).toBe(4);
  });
});
