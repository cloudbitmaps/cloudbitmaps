import type { ContainerClient } from '@azure/storage-blob';
import { AzureBlobColdDriver, type AzureBlobColdDriverOptions } from '@/drivers/azure/cold';
import { TransientError, ValidationError, WriteConflictError } from '@/core/errors';
import type { GenKey } from '@/core/ports';

// Construction-level checks need no network (the client is never called), so they run on the normal lane.
// Full behaviour (write-once, range/tail, list, streaming) is exercised in tests/integration/azure.test.ts
// against Azurite — the same split the S3 + GCS drivers use.
const fakeContainer = {} as unknown as ContainerClient;

describe('AzureBlobColdDriver construction', () => {
  it('accepts a clean prefix (or none) and advertises conditional-put + range-read', () => {
    for (const prefix of [undefined, '', 'cloudroaring', 'a/b/c', '/leading/trailing/']) {
      const driver = new AzureBlobColdDriver({ containerClient: fakeContainer, prefix });
      const caps = driver.capabilities();
      expect(caps.rangeRead).toBe(true);
      expect(caps.conditionalPut).toBe(true);
      expect(caps.maxObjectBytes).toBeGreaterThan(0);
    }
  });

  it('honors a custom maxObjectBytes', () => {
    const driver = new AzureBlobColdDriver({
      containerClient: fakeContainer,
      maxObjectBytes: 1234,
    });
    expect(driver.capabilities().maxObjectBytes).toBe(1234);
  });

  it('rejects a non-positive / non-integer maxObjectBytes or blockBytes (fail-fast)', () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      expect(
        () => new AzureBlobColdDriver({ containerClient: fakeContainer, maxObjectBytes: bad }),
      ).toThrow(ValidationError);
      expect(
        () => new AzureBlobColdDriver({ containerClient: fakeContainer, blockBytes: bad }),
      ).toThrow(ValidationError);
    }
  });

  it('rejects a prefix with `..` / `.` path segments (containment)', () => {
    for (const prefix of ['..', 'a/../b', './x', 'a/./b', '../escape']) {
      expect(() => new AzureBlobColdDriver({ containerClient: fakeContainer, prefix })).toThrow(
        ValidationError,
      );
    }
  });

  it('rejects a prefix with control characters', () => {
    for (const prefix of ['a\tb', 'a\nb']) {
      expect(() => new AzureBlobColdDriver({ containerClient: fakeContainer, prefix })).toThrow(
        ValidationError,
      );
    }
  });

  it('validates the range arguments before any network call', async () => {
    const driver = new AzureBlobColdDriver({ containerClient: fakeContainer });
    await expect(driver.getRange({ segment: 's', generation: 0 }, -1, 10)).rejects.toThrow(
      ValidationError,
    );
    await expect(driver.getRange({ segment: 's', generation: 0 }, 0, -5)).rejects.toThrow(
      ValidationError,
    );
    // A zero-length range short-circuits to an empty buffer (no client call — safe with the fake).
    await expect(driver.getRange({ segment: 's', generation: 0 }, 5, 0)).resolves.toEqual(
      new Uint8Array(0),
    );
  });
});

// ── write-once, proven WITHOUT the emulator (mirrors the GCS driver's emulator-independent proof) ───────────
// A fake `ContainerClient` records the options the driver sends and lets us inject the outcome, so we prove
// the driver (a) sends `ifNoneMatch: '*'` and (b) maps 409 → WriteConflictError / 5xx → TransientError on BOTH
// the single-`upload` (small object) and staged `commitBlockList` (large object) paths — the crown-jewel
// write-once behaviour, independent of whatever Azurite does.

interface Recorder {
  uploadOpts: unknown[];
  commitOpts: unknown[];
  stagedBlocks: number;
}

/** Build a fake `ContainerClient` whose single block-blob's `upload`/`stageBlock`/`commitBlockList` we control. */
function fakeContainerWith(rec: Recorder, ctl: Record<string, unknown>): ContainerClient {
  const blob = {
    upload: async (_data: unknown, _len: number, opts: unknown) => {
      rec.uploadOpts.push(opts);
      if (typeof ctl.uploadThrow === 'function') await (ctl.uploadThrow as () => Promise<void>)();
    },
    stageBlock: async () => {
      rec.stagedBlocks += 1;
    },
    commitBlockList: async (_ids: string[], opts: unknown) => {
      rec.commitOpts.push(opts);
      if (typeof ctl.commitThrow === 'function') await (ctl.commitThrow as () => Promise<void>)();
    },
  };
  return { getBlockBlobClient: () => blob } as unknown as ContainerClient;
}

const GEN: GenKey = { segment: 's', generation: 0 };
const put = (driver: AzureBlobColdDriver, bytes: Uint8Array) =>
  driver.putImmutable(GEN, async (sink) => {
    await sink.write(bytes);
  });
const restErr = (statusCode: number, code: string) =>
  Object.assign(new Error(`http ${statusCode}`), { statusCode, code });

describe('AzureBlobColdDriver write-once (fake ContainerClient, emulator-independent)', () => {
  it('SMALL object → single upload: sends ifNoneMatch:"*" and succeeds', async () => {
    const rec: Recorder = { uploadOpts: [], commitOpts: [], stagedBlocks: 0 };
    const driver = new AzureBlobColdDriver({ containerClient: fakeContainerWith(rec, {}) });
    const res = await put(driver, new Uint8Array([1, 2, 3]));
    expect(res.size).toBe(3);
    expect(rec.uploadOpts).toHaveLength(1);
    expect(rec.commitOpts).toHaveLength(0); // small object → no staged block list
    expect(rec.stagedBlocks).toBe(0);
    expect(rec.uploadOpts[0]).toMatchObject({ conditions: { ifNoneMatch: '*' } });
  });

  it('SMALL object: a 409 → WriteConflictError; a 5xx → TransientError', async () => {
    const rec: Recorder = { uploadOpts: [], commitOpts: [], stagedBlocks: 0 };
    const d409 = new AzureBlobColdDriver({
      containerClient: fakeContainerWith(rec, {
        uploadThrow: () => Promise.reject(restErr(409, 'BlobAlreadyExists')),
      }),
    });
    await expect(put(d409, new Uint8Array([1]))).rejects.toBeInstanceOf(WriteConflictError);

    const d500 = new AzureBlobColdDriver({
      containerClient: fakeContainerWith(rec, {
        uploadThrow: () => Promise.reject(restErr(500, 'InternalError')),
      }),
    });
    await expect(put(d500, new Uint8Array([1]))).rejects.toBeInstanceOf(TransientError);
  });

  it('LARGE object (> blockBytes) → staged commit: stages blocks + sends ifNoneMatch:"*" on commit', async () => {
    const rec: Recorder = { uploadOpts: [], commitOpts: [], stagedBlocks: 0 };
    const driver = new AzureBlobColdDriver({
      containerClient: fakeContainerWith(rec, {}),
      blockBytes: 2, // force the staged path
      maxObjectBytes: 1024,
    });
    const res = await put(driver, new Uint8Array([1, 2, 3, 4, 5]));
    expect(res.size).toBe(5);
    expect(rec.uploadOpts).toHaveLength(0); // large object → no single-shot upload
    expect(rec.commitOpts).toHaveLength(1);
    expect(rec.stagedBlocks).toBeGreaterThanOrEqual(1);
    expect(rec.commitOpts[0]).toMatchObject({ conditions: { ifNoneMatch: '*' } });
  });

  it('LARGE object: a 409 on commit → WriteConflictError', async () => {
    const rec: Recorder = { uploadOpts: [], commitOpts: [], stagedBlocks: 0 };
    const driver = new AzureBlobColdDriver({
      containerClient: fakeContainerWith(rec, {
        commitThrow: () => Promise.reject(restErr(409, 'BlobAlreadyExists')),
      }),
      blockBytes: 2,
      maxObjectBytes: 1024,
    });
    await expect(put(driver, new Uint8Array([1, 2, 3, 4]))).rejects.toBeInstanceOf(
      WriteConflictError,
    );
  });

  it('enforces maxObjectBytes with a typed ValidationError before finishing', async () => {
    const rec: Recorder = { uploadOpts: [], commitOpts: [], stagedBlocks: 0 };
    const driver = new AzureBlobColdDriver({
      containerClient: fakeContainerWith(rec, {}),
      maxObjectBytes: 4,
    });
    await expect(put(driver, new Uint8Array([1, 2, 3, 4, 5]))).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  // The block-size ← maxObjectBytes auto-grow is the ONE piece of logic unique to Azure (S3/GCS have no
  // 50,000-block ceiling). The `AZURE_MAX_BLOCKS` guard is commented "unreachable" only *because* of this math
  // (blockBytes = max(requested, ceil(maxObjectBytes / 50000))), so pin both operators. A helper stages ten
  // 1-byte writes and returns how many blocks that produced — the flush threshold is directly observable as
  // (blocks during write) + (1 trailing flush in finish).
  const countBlocksForTenBytes = async (
    opts: Partial<AzureBlobColdDriverOptions>,
  ): Promise<number> => {
    const rec: Recorder = { uploadOpts: [], commitOpts: [], stagedBlocks: 0 };
    const driver = new AzureBlobColdDriver({
      containerClient: fakeContainerWith(rec, {}),
      ...opts,
    });
    await driver.putImmutable(GEN, async (sink) => {
      for (let i = 0; i < 10; i++) await sink.write(new Uint8Array([i]));
    });
    expect(rec.commitOpts).toHaveLength(1);
    return rec.stagedBlocks;
  };

  it('auto-grows the flush threshold via ceil() so maxObjectBytes stays reachable within the 50,000-block limit', async () => {
    // maxObjectBytes=100001 is NON-exact over 50000: ceil(2.00002)=3 (grown), floor would be 2. A 3-byte
    // threshold stages 4 blocks (3+3+3 + trailing 1); a 2-byte one (floor bug) would stage 5; ungrown
    // blockBytes=1 would stage 10. Asserting 4 pins ceil() AND that the grow happens at all.
    const driver = new AzureBlobColdDriver({
      containerClient: fakeContainer,
      blockBytes: 1,
      maxObjectBytes: 100_001,
    });
    expect(driver.capabilities().maxObjectBytes).toBe(100_001);
    expect(await countBlocksForTenBytes({ blockBytes: 1, maxObjectBytes: 100_001 })).toBe(4);
  });

  it('keeps the requested block size when it already exceeds the ceiling (the max() branch)', async () => {
    // blockBytes=10 > ceil(100001/50000)=3, so max() must keep 10 → ten 1-byte writes flush once (a single
    // 10-byte block). Dropping max() (bare ceil → 3) would stage 4. Asserting 1 pins the max().
    expect(await countBlocksForTenBytes({ blockBytes: 10, maxObjectBytes: 100_001 })).toBe(1);
  });
});
