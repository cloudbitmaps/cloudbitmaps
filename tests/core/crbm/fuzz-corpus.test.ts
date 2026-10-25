import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { CrbmReader, parseExtension, parseIndex } from '@/core/crbm/reader';
import { BufferReader } from '@/core/blob';
import { DEFAULT_MAX_BITMAP_BYTES, DEFAULT_MAX_PAYLOAD_BYTES } from '@/core/crbm/format';
import {
  assertConsistentDecode,
  checkPublicDoor,
  runBitmapOps,
  tsRoaringCodec,
} from '@/testing/fuzz-codec';
import { CloudRoaringError, IntegrityError, ValidationError } from '@/core/errors';
import { RoaringBitmap } from '@/bitmap';
import type { BlobReader } from '@/core/blob';
import type { CrbmCrypto } from '@/core/crypto';

/**
 * Deterministic replay of coverage-guided-fuzz crash reproducers. The jazzer campaign (`pnpm fuzz:*`,
 * nightly) is a time-budgeted search
 * and is NOT a per-PR gate; when it finds an input that violates the untrusted-bytes contract, that input is
 * committed here and this test — which DOES run in the normal suite on every PR — locks the fix in.
 *
 * The contract mirrors the fuzz targets exactly: arbitrary bytes fed through the real read path either succeed
 * self-consistently or throw a typed `CloudRoaringError`; a `RangeError`/`TypeError`/hang is a bug,
 * and so is a decode that is not self-consistent (see {@link assertConsistentDecode}). Five corpora mirror the five
 * targets: raw serialized bitmaps (the TypeScript decoder and the public door), byte-driven operation sequences on a decoded
 * bitmap (checked against a plain `Set`), raw index regions, raw extension-block sections, and whole
 * `.crbm` objects.
 */
const MAX_BYTES = DEFAULT_MAX_BITMAP_BYTES; // the decode cap the fuzz targets run under
const HERE = dirname(fileURLToPath(import.meta.url));
const CORPUS = join(HERE, 'fuzz-corpus');

function reproducers(sub: string): Array<{ name: string; bytes: Uint8Array }> {
  const dir = join(CORPUS, sub);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => !f.startsWith('.') && f !== 'README.md')
    .map((f) => ({ name: f, bytes: new Uint8Array(readFileSync(join(dir, f))) }));
}

/** The bitmap-decoder target's contract (mirrors fuzz/targets/safe-deserialize.mjs, whole-buffer read and public door included). */
function deserialize(bytes: Uint8Array): void {
  checkPublicDoor(bytes);
  assertConsistentDecode(tsRoaringCodec.safeDeserialize(bytes, MAX_BYTES));
  try {
    assertConsistentDecode(tsRoaringCodec.safeDeserialize(bytes, MAX_BYTES, { whole: true }));
  } catch (err) {
    if (!(err instanceof CloudRoaringError)) throw err;
  }
}

/** The index-parser target's contract: raw index bytes → self-consistent entries or a typed error. */
function parseRawIndex(bytes: Uint8Array): void {
  parseIndex(bytes, 1 << 24, DEFAULT_MAX_PAYLOAD_BYTES); // fixed generous payload-region end, matching fuzz/targets/crbm-index.mjs
}

/** A key whose every open fails, as the extension-block target uses for its encrypted pass. */
const failingCrypto: CrbmCrypto = {
  aead: {
    seal: () => {
      throw new IntegrityError('the fuzz target seals nothing');
    },
    open: () => {
      throw new IntegrityError('AEAD authentication failed');
    },
  },
  aadFor: () => new Uint8Array(0),
};

/** The extension-block target's contract: raw sections, read clear and sealed → a record (or none) or typed errors. */
function parseRawExtension(bytes: Uint8Array): void {
  for (const crypto of [undefined, failingCrypto]) {
    try {
      parseExtension(bytes, crypto);
    } catch (err) {
      if (!(err instanceof CloudRoaringError)) throw err;
    }
  }
}

/** A reader whose range reads come back `short` bytes short (mirrors fuzz/targets/crbm-reader.mjs). */
function shortReader(bytes: Uint8Array, short: number): BlobReader {
  const inner = new BufferReader(bytes);
  return {
    getTail: (n) => inner.getTail(n),
    getRange: async (offset, length) => {
      const got = await inner.getRange(offset, length);
      return got.subarray(0, Math.max(0, got.length - short));
    },
  };
}

/** Tails at, and a byte either side of, the starts the input's footer gives (mirrors the reader target). */
function edgeTails(bytes: Uint8Array): number[] {
  const tails: number[] = [];
  if (bytes.length < 104) return tails;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const indexOffset = Number(view.getBigUint64(bytes.length - 104, true));
  const trailer = indexOffset - 12;
  if (trailer < 0 || indexOffset > bytes.length - 104) return tails;
  const block = trailer - view.getUint32(trailer, true);
  for (const start of [indexOffset, trailer, block]) {
    for (const d of [-1, 0, 1]) {
      const tail = bytes.length - (start + d);
      if (tail > 104 && tail < bytes.length) tails.push(tail);
    }
  }
  return tails;
}

async function openOnce(blob: BlobReader, tailBytes?: number): Promise<CrbmReader | undefined> {
  try {
    return await CrbmReader.open(blob, { tailBytes });
  } catch (err) {
    if (!(err instanceof CloudRoaringError)) throw err;
    return undefined;
  }
}

/** The `.crbm` reader target's contract: open → getChunk → safeDeserialize. */
async function readChain(bytes: Uint8Array): Promise<void> {
  for (const tailBytes of [104, ...edgeTails(bytes)])
    await openOnce(new BufferReader(bytes), tailBytes);
  await openOnce(shortReader(bytes, 1), 104);
  const reader = await openOnce(new BufferReader(bytes));
  if (reader === undefined) return;
  for (const k of new Set([...reader.chunkKeys(), 0, 1, 256, 4096, 65535])) {
    try {
      const chunk = await reader.getChunk(k);
      if (chunk !== null) assertConsistentDecode(tsRoaringCodec.safeDeserialize(chunk, MAX_BYTES));
    } catch (err) {
      if (!(err instanceof CloudRoaringError)) throw err;
    }
  }
}

describe('fuzz crash-reproducer replay (the committed regression corpus)', () => {
  const deser = reproducers('safe-deserialize');
  const ops = reproducers('bitmap-ops');
  const crbm = reproducers('crbm-reader');
  const index = reproducers('crbm-index');
  const ext = reproducers('crbm-ext');

  if (deser.length + ops.length + crbm.length + index.length + ext.length === 0) {
    // No reproducers committed yet — the campaign has found nothing that violates the contract. This
    // placeholder keeps the suite honest (the mechanism is wired) until a crash is promoted here.
    it('has no outstanding fuzz crash reproducers to replay', () => {
      expect(deser.length + ops.length + crbm.length + index.length + ext.length).toBe(0);
    });
  }

  for (const { name, bytes } of deser) {
    it(`safe-deserialize reproducer ${name} raises only a typed error, or decodes consistently`, () => {
      expect(() => {
        try {
          deserialize(bytes);
        } catch (err) {
          if (!(err instanceof CloudRoaringError)) throw err;
        }
      }).not.toThrow();
    });
  }

  for (const { name, bytes } of ops) {
    it(`bitmap-ops reproducer ${name} keeps every answer equal to the model`, () => {
      expect(() => runBitmapOps(bytes)).not.toThrow();
    });
  }

  for (const { name, bytes } of index) {
    it(`crbm-index reproducer ${name} raises only a typed error`, () => {
      expect(() => {
        try {
          parseRawIndex(bytes);
        } catch (err) {
          if (!(err instanceof CloudRoaringError)) throw err;
        }
      }).not.toThrow();
    });
  }

  for (const { name, bytes } of ext) {
    it(`crbm-ext reproducer ${name} raises only a typed error`, () => {
      expect(() => {
        try {
          parseRawExtension(bytes);
        } catch (err) {
          if (!(err instanceof CloudRoaringError)) throw err;
        }
      }).not.toThrow();
    });
  }

  for (const { name, bytes } of crbm) {
    it(`crbm-reader reproducer ${name} raises only a typed error, or decodes consistently`, async () => {
      await expect(readChain(bytes)).resolves.toBeUndefined();
    });
  }
});

describe('the fuzz targets surface a typed error that is the wrong one', () => {
  const ids = new RoaringBitmap([1, 2, 3, 2 ** 31, 0xffff_ffff]).serialize();

  it('checkPublicDoor: a round trip the door refuses is a plain Error, which a target that tolerates typed errors cannot swallow', () => {
    vi.spyOn(RoaringBitmap.prototype, 'serialize').mockReturnValue(new Uint8Array(0));
    try {
      checkPublicDoor(ids);
      expect.unreachable('the refused round trip was not reported');
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(CloudRoaringError);
      expect((err as Error).cause).toBeInstanceOf(ValidationError);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('runBitmapOps: a ValidationError from add on a valid id escapes, the replay of ids-at-the-top.bin included', () => {
    const real = RoaringBitmap.prototype.add;
    vi.spyOn(RoaringBitmap.prototype, 'add').mockImplementation(function (
      this: RoaringBitmap,
      id: number,
    ) {
      if (id >= 2 ** 31) throw new ValidationError('an id this bitmap refuses');
      return real.call(this, id);
    });
    try {
      const replay = reproducers('bitmap-ops').find((r) => r.name === 'ids-at-the-top.bin');
      expect(replay).toBeDefined();
      expect(() => runBitmapOps(replay!.bytes)).toThrow(ValidationError);
    } finally {
      vi.restoreAllMocks();
    }
  });
});
