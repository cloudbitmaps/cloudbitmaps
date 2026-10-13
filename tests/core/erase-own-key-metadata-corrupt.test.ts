import { randomBytes } from 'node:crypto';
import { crc32c } from '@/core/crbm/crc32c';
import { FOOTER, FOOTER_BYTES, EXT_TRAILER_BYTES } from '@/core/crbm/format';
import { eraseIdFromSegment } from '@/core/erase-id';
import { IntegrityError } from '@/core/errors';
import { loadSegment } from '@/core/load';
import type { IStorageDriver, SegmentRef } from '@/core/ports';
import { rollbackSegment } from '@/core/rollback';
import { InProcessKeystore } from '@/drivers/crypto';
import { MemoryRegistryDriver, MemoryStorageDriver } from '@/drivers/memory';
import { roaringCodec } from '@/roaring-codec';

const REF: SegmentRef = { segment: 's' };
const X = 9;
const KEEP = { keep: 5, metadata: { src: 'q' } };

async function generations(storage: IStorageDriver): Promise<number[]> {
  const out: number[] = [];
  for await (const k of storage.list(REF)) out.push(k.generation);
  return out.sort((a, b) => a - b);
}

/** A byte of the sealed metadata section flipped and the extension block's checksum made again: the object's own
 * key opens its index and fails only on the metadata. */
function flipSealedMetadata(bytes: Uint8Array): Uint8Array {
  const at = bytes.length - FOOTER_BYTES;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const indexOffset = Number(view.getBigUint64(at + FOOTER.indexOffset, true));
  const trailer = indexOffset - EXT_TRAILER_BYTES;
  const length = view.getUint32(trailer, true);
  const start = trailer - length;
  bytes[start + 5 + 12 + 1]! ^= 0x01; // past the section header and the nonce: inside the ciphertext
  view.setUint32(trailer + 4, crc32c(bytes.subarray(start, trailer + 4)), true);
  return bytes;
}

describe("an object of the row's own key whose metadata does not open is corrupt, not sealed elsewhere", () => {
  it.each(['above', 'below'])(
    '%s the pointer: IntegrityError, and nothing is deleted',
    async (where) => {
      const storage = new MemoryStorageDriver();
      const registry = new MemoryRegistryDriver();
      const keystore = new InProcessKeystore({ keys: { A: randomBytes(32) }, activeKeyId: 'A' });
      const deps = { storage, registry, codec: roaringCodec, keystore };
      let at: number;
      if (where === 'above') {
        await loadSegment(REF, [1, 2], deps, KEEP);
        await loadSegment(REF, [1, 2, X], deps, KEEP);
        await rollbackSegment(REF, 0, deps);
        at = 1;
      } else {
        await loadSegment(REF, [1, X], deps, KEEP);
        await loadSegment(REF, [1, 2], deps, KEEP);
        at = 0;
      }
      const key = { ...REF, generation: at };
      const whole = Uint8Array.from((await storage.getTail(key, 1 << 30)).bytes);
      const damaged = flipSealedMetadata(whole);
      await storage.delete(key);
      await storage.putImmutable(key, async (out) => out.write(damaged));
      const present = await generations(storage);
      await expect(eraseIdFromSegment(REF, X, deps)).rejects.toBeInstanceOf(IntegrityError);
      expect(await generations(storage)).toEqual(present);
    },
  );
});
