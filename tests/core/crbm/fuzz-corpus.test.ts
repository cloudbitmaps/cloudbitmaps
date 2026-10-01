import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { CrbmReader, parseIndex } from '@/core/crbm/reader';
import { BufferReader } from '@/core/blob';
import { SafeBitmap } from '@/roaring-codec';
import { assertConsistentDecode } from '@/testing/fuzz-codec';
import { CloudRoaringError } from '@/core/errors';

/**
 * Deterministic replay of coverage-guided-fuzz crash reproducers. The jazzer campaign (`pnpm fuzz:*`,
 * nightly) is a time-budgeted search
 * and is NOT a per-PR gate; when it finds an input that violates the untrusted-bytes contract, that input is
 * committed here and this test — which DOES run in the normal suite on every PR — locks the fix in.
 *
 * The contract mirrors the fuzz targets exactly: arbitrary bytes fed through the real read path either succeed
 * self-consistently or throw a typed `CloudRoaringError`; a `RangeError`/`TypeError`/native crash/hang is a bug,
 * and so is a decode that is not self-consistent (see {@link assertConsistentDecode}). Three corpora mirror the three
 * targets: raw serialized bitmaps (native deserializer), raw index regions, and whole `.crbm` objects.
 */
const MAX_BYTES = 16 * 1024 * 1024;
const HERE = dirname(fileURLToPath(import.meta.url));
const CORPUS = join(HERE, 'fuzz-corpus');

function reproducers(sub: string): Array<{ name: string; bytes: Uint8Array }> {
  const dir = join(CORPUS, sub);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => !f.startsWith('.') && f !== 'README.md')
    .map((f) => ({ name: f, bytes: new Uint8Array(readFileSync(join(dir, f))) }));
}

/** The native-deserializer target's contract (mirrors fuzz/targets/safe-deserialize.mjs). */
function deserialize(bytes: Uint8Array): void {
  assertConsistentDecode(SafeBitmap.safeDeserialize(bytes, MAX_BYTES));
}

/** The index-parser target's contract: raw index bytes → self-consistent entries or a typed error. */
function parseRawIndex(bytes: Uint8Array): void {
  parseIndex(bytes, 1 << 24, MAX_BYTES); // fixed generous payload-region end, matching fuzz/targets/crbm-index.mjs
}

/** The `.crbm` reader target's contract: open → getChunk → safeDeserialize. */
async function readChain(bytes: Uint8Array): Promise<void> {
  let reader: CrbmReader;
  try {
    reader = await CrbmReader.open(new BufferReader(bytes));
  } catch (err) {
    if (!(err instanceof CloudRoaringError)) throw err;
    return;
  }
  for (const k of new Set([...reader.chunkKeys(), 0, 1, 256, 4096, 65535])) {
    try {
      const chunk = await reader.getChunk(k);
      if (chunk !== null) assertConsistentDecode(SafeBitmap.safeDeserialize(chunk, MAX_BYTES));
    } catch (err) {
      if (!(err instanceof CloudRoaringError)) throw err;
    }
  }
}

describe('fuzz crash-reproducer replay (the committed regression corpus)', () => {
  const deser = reproducers('safe-deserialize');
  const crbm = reproducers('crbm-reader');
  const index = reproducers('crbm-index');

  if (deser.length === 0 && crbm.length === 0 && index.length === 0) {
    // No reproducers committed yet — the campaign has found nothing that violates the contract. This
    // placeholder keeps the suite honest (the mechanism is wired) until a crash is promoted here.
    it('has no outstanding fuzz crash reproducers to replay', () => {
      expect(deser.length + crbm.length + index.length).toBe(0);
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

  for (const { name, bytes } of crbm) {
    it(`crbm-reader reproducer ${name} raises only a typed error, or decodes consistently`, async () => {
      await expect(readChain(bytes)).resolves.toBeUndefined();
    });
  }
});
