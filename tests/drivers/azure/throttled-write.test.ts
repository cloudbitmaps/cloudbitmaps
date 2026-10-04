import { AnonymousCredential, ContainerClient } from '@azure/storage-blob';
import { isConditionalConflict, isTransient } from '@/azure-blob/azure-errors';
import { AzureBlobRegistryDriver } from '@/azure-blob/registry';
import { AzureBlobStorageDriver } from '@/azure-blob/storage';
import { loadSegment } from '@/core/load';
import { TransientError } from '@/core/errors';
import type { GenKey } from '@/core/ports';
import { roaringCodec } from '@/roaring-codec';
import { StubBlobService, xmlError, type Answer } from '../../helpers/azure-blob-stub';

/**
 * A throttled write on Azure Blob, through a real `@azure/storage-blob` client over a stub of the Blob service.
 *
 * Nothing in the Azure driver changes for throttling: the client's retry policy sends a write again after a `503
 * ServerBusy` or a `500 OperationTimedOut`, and every write, a generation object's and a registry row's, carries a
 * random write id in blob metadata, so the replay that meets its own blob is recognised by reading the id back. These
 * pin that on the error shapes the SDK really raises, and show the publish then reconciles a row the way it does on S3
 * and GCS.
 */

const GEN: GenKey = { segment: 's', generation: 0 };
const OBJECT = '_default/segments/s.0.crbm';
const ROW = 'registry/_default/s.reg';
const SERVER_BUSY = xmlError(503, 'ServerBusy');
const TIMED_OUT = xmlError(500, 'OperationTimedOut');
/** Quick retries: the policy's delay, not whether it retries. */
const QUICK = { retryOptions: { retryDelayInMs: 1, maxRetryDelayInMs: 2 } };

let stub: StubBlobService;
beforeEach(async () => {
  stub = new StubBlobService();
  await stub.start();
});
afterEach(async () => {
  await stub.stop();
});

/** Plan the `n`th PUT of `name` (counted from 1) to answer `respond`, after applying it when `apply` is set. */
function planPut(
  name: string,
  n: number,
  respond: Answer,
  extra: { apply?: boolean; after?: () => Promise<void> } = {},
): void {
  let seen = 0;
  stub.plan = (req) => {
    if (req.method !== 'PUT' || req.name !== name) return undefined;
    seen += 1;
    return seen === n ? { respond, ...extra } : undefined;
  };
}

const put = (driver: AzureBlobStorageDriver, bytes: Uint8Array) =>
  driver.putImmutable(GEN, async (sink) => {
    await sink.write(bytes);
  });

describe('Azure Blob: the throttle answers, on the error the real SDK raises', () => {
  it.each<[string, Answer, string]>([
    ['503 ServerBusy', SERVER_BUSY, 'ServerBusy'],
    ['500 OperationTimedOut', TIMED_OUT, 'OperationTimedOut'],
  ])('%s, once the client has stopped retrying, is transient', async (_, answer, code) => {
    stub.plan = (req) => (req.method === 'PUT' ? { respond: answer } : undefined);
    const container = new ContainerClient(stub.url, new AnonymousCredential(), {
      retryOptions: { maxTries: 2, retryDelayInMs: 1, maxRetryDelayInMs: 2 },
    });
    const err = (await container
      .getBlockBlobClient('k')
      .upload(new Uint8Array([1]), 1, { conditions: { ifNoneMatch: '*' } })
      .catch((e: unknown) => e)) as { statusCode?: number; code?: string };
    // The shape the classification keys on: pinned, so an SDK that changes it fails here.
    expect(err.statusCode).toBe(answer.status);
    expect(err.code).toBe(code);
    expect(isTransient(err)).toBe(true);
    expect(isConditionalConflict(err)).toBe(false);
    // The client's own policy sent it again before giving up: that is where Azure's throttle retry lives.
    expect(stub.count('PUT')).toBe(2);
  });
});

describe('Azure Blob: a throttled write-once object is sent again by the client, and its write id tells its own', () => {
  it('a commit answered 503 ServerBusy and not applied is sent again by the client, and lands once', async () => {
    const driver = new AzureBlobStorageDriver({ containerClient: stub.client(QUICK) });
    planPut(OBJECT, 1, SERVER_BUSY);
    await put(driver, new Uint8Array([1, 2, 3]));
    expect(stub.count('PUT')).toBe(2);
    expect(stub.count('HEAD')).toBe(0);
    expect([...stub.blobs.get(OBJECT)!.body]).toEqual([1, 2, 3]);
    expect(stub.blobs.get(OBJECT)!.metadata.cbwid).toMatch(/^[0-9a-f]{32}$/);
  });

  it('a commit applied and then answered 500 OperationTimedOut meets itself on the re-send, and is its own', async () => {
    const driver = new AzureBlobStorageDriver({ containerClient: stub.client(QUICK) });
    planPut(OBJECT, 1, TIMED_OUT, { apply: true });
    const res = await put(driver, new Uint8Array([4, 5]));
    expect(res.size).toBe(2);
    expect(stub.count('PUT')).toBe(2); // the client's replay, answered 409 by the blob it made
    expect(stub.count('HEAD')).toBe(1); // the write id read back
    expect(stub.blobs.size).toBe(1);
  });

  it('a commit answered 503 on every try throws TransientError, and nothing is deleted', async () => {
    const driver = new AzureBlobStorageDriver({
      containerClient: stub.client({
        retryOptions: { maxTries: 3, retryDelayInMs: 1, maxRetryDelayInMs: 2 },
      }),
    });
    stub.plan = (req) => (req.method === 'PUT' ? { respond: SERVER_BUSY } : undefined);
    await expect(put(driver, new Uint8Array([1]))).rejects.toBeInstanceOf(TransientError);
    expect(stub.count('PUT')).toBe(3);
    expect(stub.count('DELETE')).toBe(0);
    expect(stub.blobs.size).toBe(0);
  });
});

describe('Azure Blob: a load whose row write is throttled', () => {
  const SEG = { segment: 's' };
  const waits: number[] = [];
  beforeEach(() => {
    waits.length = 0;
  });
  const deps = () => ({
    storage: new AzureBlobStorageDriver({ containerClient: stub.client(QUICK) }),
    registry: new AzureBlobRegistryDriver({ containerClient: stub.client(QUICK) }),
    codec: roaringCodec,
    // What a store wires: the publish waits on it before a fresh write.
    clock: {
      now: () => 0,
      sleep: async (ms: number) => {
        waits.push(ms);
      },
      yieldNow: async (): Promise<void> => {},
    },
  });
  /** Answer the `n`th PUT of the row `answer(n)` (or let it through), and count them. */
  function planRowPuts(answer: (n: number) => Answer | undefined): () => number {
    let n = 0;
    stub.plan = (req) => {
      if (req.method !== 'PUT' || req.name !== ROW) return undefined;
      n += 1;
      const respond = answer(n);
      return respond === undefined ? undefined : { respond };
    };
    return () => n;
  }

  it('a row answered 503 on every try throws TransientError, deletes nothing, and the pointer stays', async () => {
    const d = deps();
    await loadSegment(SEG, [1], d);
    const rowPuts = planRowPuts(() => SERVER_BUSY);
    await expect(loadSegment(SEG, [1, 2], d)).rejects.toBeInstanceOf(TransientError);
    // The client's policy tries each write four times, and the publish sends four writes: the SDK's retry runs under
    // each fresh compare-and-swap, so a registry that never answers costs sixteen requests, not four.
    expect(rowPuts()).toBe(16);
    expect(stub.count('DELETE')).toBe(0);
    expect(stub.blobs.has('_default/segments/s.1.crbm')).toBe(true); // the object stays, above the pointer
    expect((await d.registry.get(SEG))!.currentGen).toBe(0);
  });

  it('with no clock to wait on, a row answered 503 on every try is the client tries alone, then TransientError', async () => {
    const { clock: _unused, ...d } = deps();
    void _unused;
    await loadSegment(SEG, [1], d);
    const rowPuts = planRowPuts(() => SERVER_BUSY);
    await expect(loadSegment(SEG, [1, 2], d)).rejects.toBeInstanceOf(TransientError);
    expect(rowPuts()).toBe(4);
    expect(stub.count('DELETE')).toBe(0);
  });

  it('a row answered 503 on the first try only is settled by the client alone: the publish sends one write', async () => {
    const d = deps();
    await loadSegment(SEG, [1], d);
    const rowPuts = planRowPuts((n) => (n === 1 ? SERVER_BUSY : undefined));
    const r = await loadSegment(SEG, [1, 2], d);
    expect(r).toMatchObject({ generation: 1, published: true });
    expect(rowPuts()).toBe(2); // the client's own retry; the publish waited for nothing
    expect(waits).toEqual([]);
  });

  it('a row applied and answered 503 is recognised on the replay by its write id: published', async () => {
    const d = deps();
    await loadSegment(SEG, [1], d);
    planPut(ROW, 1, SERVER_BUSY, { apply: true });
    const r = await loadSegment(SEG, [1, 2], d);
    expect(r).toMatchObject({ generation: 1, published: true });
    expect((await d.registry.get(SEG))!.currentGen).toBe(1);
  });

  it('a row whose replay meets another write on top reports a conflict, which the publish settles by the pointer', async () => {
    const d = deps();
    await loadSegment(SEG, [1], d);
    const other = new AzureBlobRegistryDriver({ containerClient: stub.client(QUICK) });
    planPut(ROW, 1, SERVER_BUSY, {
      apply: true,
      // Before the answer arrives, another writer swaps in over this write: a retention change, the pointer kept.
      after: async () => {
        const row = (await other.get(SEG))!;
        await other.compareAndSwap(SEG, row.token, { retention: { note: 'kept' } });
      },
    });
    const r = await loadSegment(SEG, [1, 2], d);
    // The registry reads back the other writer's id and reports a conflict; the pointer still names this load's
    // generation over its own object, so the load is published rather than reported superseded.
    expect(r).toMatchObject({ generation: 1, published: true });
    expect((await d.registry.get(SEG))!).toMatchObject({
      currentGen: 1,
      retention: { note: 'kept' },
    });
  });
});
