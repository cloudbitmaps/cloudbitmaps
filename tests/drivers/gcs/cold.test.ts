import { Writable } from 'node:stream';
import type { Storage } from '@google-cloud/storage';
import { GcsColdDriver } from '@/drivers/gcs/cold';
import { TransientError, ValidationError, WriteConflictError } from '@/core/errors';
import type { GenKey } from '@/core/ports';

// Construction-level checks need no network (the client is never called), so they run on the normal lane.
// Full behaviour (write-once, range/tail, list, streaming) is exercised in tests/integration/gcs.test.ts
// against fake-gcs-server — the same split the S3 driver uses.
const fakeStorage = {} as unknown as Storage;

describe('GcsColdDriver construction', () => {
  it('accepts a clean prefix (or none) and advertises conditional-put + range-read', () => {
    for (const prefix of [undefined, '', 'cloudroaring', 'a/b/c', '/leading/trailing/']) {
      const driver = new GcsColdDriver({ storage: fakeStorage, bucket: 'b', prefix });
      const caps = driver.capabilities();
      expect(caps.rangeRead).toBe(true);
      expect(caps.conditionalPut).toBe(true);
      expect(caps.maxObjectBytes).toBeGreaterThan(0);
    }
  });

  it('honors a custom maxObjectBytes', () => {
    const driver = new GcsColdDriver({ storage: fakeStorage, bucket: 'b', maxObjectBytes: 1234 });
    expect(driver.capabilities().maxObjectBytes).toBe(1234);
  });

  it('rejects a prefix with `..` / `.` path segments (containment)', () => {
    for (const prefix of ['..', 'a/../b', './x', 'a/./b', '../escape']) {
      expect(() => new GcsColdDriver({ storage: fakeStorage, bucket: 'b', prefix })).toThrow(
        ValidationError,
      );
    }
  });

  it('rejects a prefix with control characters', () => {
    for (const prefix of ['a\tb', 'a\nb']) {
      expect(() => new GcsColdDriver({ storage: fakeStorage, bucket: 'b', prefix })).toThrow(
        ValidationError,
      );
    }
  });

  it('validates the range arguments before any network call', async () => {
    const driver = new GcsColdDriver({ storage: fakeStorage, bucket: 'b' });
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

// ── write-once, proven WITHOUT the emulator (reviewer FIX-FIRST #3) ─────────────────────────────────────
// A fake `Storage` records the upload options the driver sends and lets us inject the outcome, so we prove
// the driver (a) sends `ifGenerationMatch: 0` and (b) maps 412 → WriteConflictError / 5xx → TransientError on
// BOTH the simple (`save`, small objects) and resumable (`createWriteStream`, large objects) paths — the
// crown-jewel write-once behaviour, independent of whatever fake-gcs-server does.

interface Recorder {
  saveOpts: unknown[];
  streamOpts: unknown[];
}

/** Build a fake `Storage` whose single file's `save`/`createWriteStream` we control + record. */
function fakeStorageWith(rec: Recorder, file: Record<string, unknown>): Storage {
  const f = {
    save: async (_data: unknown, opts: unknown) => {
      rec.saveOpts.push(opts);
      if (typeof file.saveThrow === 'function') await (file.saveThrow as () => Promise<void>)();
    },
    createWriteStream: (opts: unknown) => {
      rec.streamOpts.push(opts);
      return (file.stream as () => Writable)();
    },
  };
  return { bucket: () => ({ file: () => f }) } as unknown as Storage;
}

/** A Writable that discards writes and, on end(), finishes cleanly or fails its `final` callback with `err`. */
function fakeStream(err?: unknown): Writable {
  return new Writable({
    write(_chunk, _enc, cb) {
      cb();
    },
    final(cb) {
      cb(err as Error | undefined); // cb(err) errors the stream (emits 'error', not 'finish')
    },
  });
}

const GEN: GenKey = { segment: 's', generation: 0 };
const put = (driver: GcsColdDriver, bytes: Uint8Array) =>
  driver.putImmutable(GEN, async (sink) => {
    await sink.write(bytes);
  });
const err = (code: number) => Object.assign(new Error(`http ${code}`), { code });

describe('GcsColdDriver write-once (fake Storage, emulator-independent)', () => {
  it('SIMPLE path: sends resumable:false + ifGenerationMatch:0, and succeeds', async () => {
    const rec: Recorder = { saveOpts: [], streamOpts: [] };
    const driver = new GcsColdDriver({ storage: fakeStorageWith(rec, {}), bucket: 'b' });
    const res = await put(driver, new Uint8Array([1, 2, 3]));
    expect(res.size).toBe(3);
    expect(rec.saveOpts).toHaveLength(1);
    expect(rec.streamOpts).toHaveLength(0); // small object → no resumable stream
    expect(rec.saveOpts[0]).toMatchObject({
      resumable: false,
      preconditionOpts: { ifGenerationMatch: 0 },
    });
  });

  it('SIMPLE path: a 412 → WriteConflictError; a 5xx → TransientError', async () => {
    const rec: Recorder = { saveOpts: [], streamOpts: [] };
    const d412 = new GcsColdDriver({
      storage: fakeStorageWith(rec, {
        saveThrow: () => Promise.reject(err(412)),
      }),
      bucket: 'b',
    });
    await expect(put(d412, new Uint8Array([1]))).rejects.toBeInstanceOf(WriteConflictError);

    const d500 = new GcsColdDriver({
      storage: fakeStorageWith(rec, {
        saveThrow: () => Promise.reject(err(500)),
      }),
      bucket: 'b',
    });
    await expect(put(d500, new Uint8Array([1]))).rejects.toBeInstanceOf(TransientError);
  });

  it('RESUMABLE path (object > threshold): sends resumable:true + ifGenerationMatch:0, and commits', async () => {
    const rec: Recorder = { saveOpts: [], streamOpts: [] };
    const driver = new GcsColdDriver({
      storage: fakeStorageWith(rec, { stream: () => fakeStream() }),
      bucket: 'b',
      simpleUploadThresholdBytes: 2, // force the resumable path
    });
    const res = await put(driver, new Uint8Array([1, 2, 3, 4, 5]));
    expect(res.size).toBe(5);
    expect(rec.streamOpts).toHaveLength(1);
    expect(rec.saveOpts).toHaveLength(0); // large object → no simple upload
    expect(rec.streamOpts[0]).toMatchObject({
      resumable: true,
      preconditionOpts: { ifGenerationMatch: 0 },
    });
  });

  it('RESUMABLE path: a 412 on commit → WriteConflictError', async () => {
    const rec: Recorder = { saveOpts: [], streamOpts: [] };
    const driver = new GcsColdDriver({
      storage: fakeStorageWith(rec, { stream: () => fakeStream(err(412)) }),
      bucket: 'b',
      simpleUploadThresholdBytes: 2,
    });
    await expect(put(driver, new Uint8Array([1, 2, 3, 4]))).rejects.toBeInstanceOf(
      WriteConflictError,
    );
  });
});
