import { ContainerClient, AnonymousCredential } from '@azure/storage-blob';
import { AzureBlobStorageDriver } from '@/azure-blob/storage';
import { GcsStorageDriver } from '@/gcs/storage';
import { S3StorageDriver } from '@/s3/storage';
import { TransientError, WriteConflictError } from '@/core/errors';
import type { GenKey, IStorageDriver } from '@/core/ports';
import { STUB_GCS_BUCKET, StubGcsService } from '../helpers/gcs-stub';
import { StubBlobService, xmlError, type Answer } from '../helpers/azure-blob-stub';
import { STUB_BUCKET, StubS3Bucket, type FaultKind } from '../helpers/s3-bucket-stub';

/**
 * Which answers a write-once generation object is sent again after, per backend, on the errors each real SDK raises
 * for the service's documented answers (the services themselves are not contacted: the SDKs run over stubs that
 * answer as the services do).
 *
 * The question each row asks is what the commit of one object does when the service answers `X` to its first send:
 *
 * - `resent`: the write is sent a second time. S3 and GCS do it in the driver, after a throttle only; Azure Blob's
 *   client does it under its own retry policy, which the driver cannot switch off per request.
 * - `outcome`: what the caller sees when `X` is the answer to every send, or to the only one.
 *
 * A write that is not sent again is the one a lost response, a timeout or a 5xx other than a throttle leaves
 * unanswered: it is never replayed blind, and the caller learns of it as a `TransientError`.
 */

const GEN: GenKey = { segment: 's', generation: 0 };

const put = (driver: IStorageDriver) =>
  driver.putImmutable(GEN, async (sink) => {
    await sink.write(new Uint8Array([1, 2, 3]));
  });

type Outcome = 'ok' | 'transient' | 'conflict' | 'raw';

async function outcomeOf(run: () => Promise<unknown>): Promise<Outcome> {
  try {
    await run();
    return 'ok';
  } catch (err) {
    if (err instanceof TransientError) return 'transient';
    if (err instanceof WriteConflictError) return 'conflict';
    return 'raw';
  }
}

describe('S3: the answers a write-once object is sent again after', () => {
  interface Row {
    readonly answer: string;
    readonly kind: FaultKind;
    /** PutObject requests the commit makes when the first send is answered this and the next is not. */
    readonly sends: number;
    /** What the caller sees when every send is answered this. */
    readonly outcome: Outcome;
  }
  const rows: readonly Row[] = [
    { answer: '503 SlowDown', kind: 'throttle', sends: 2, outcome: 'transient' },
    {
      answer: '503 ServiceUnavailable',
      kind: { status: 503, code: 'ServiceUnavailable' },
      sends: 2,
      outcome: 'transient',
    },
    // AWS S3 does not send a 429, but some S3-compatible services do. The S3 driver classifies a throttle by the code
    // `SlowDown` or the status 503 alone, so a 429 is neither sent again nor a `TransientError`: the SDK's raw error.
    {
      answer: '429 TooManyRequests',
      kind: { status: 429, code: 'TooManyRequests' },
      sends: 1,
      outcome: 'raw',
    },
    {
      answer: '500 InternalError',
      kind: { status: 500, code: 'InternalError' },
      sends: 1,
      outcome: 'transient',
    },
    {
      answer: '400 RequestTimeout',
      kind: { status: 400, code: 'RequestTimeout' },
      sends: 1,
      outcome: 'transient',
    },
    { answer: 'a lost response', kind: 'lose-response', sends: 1, outcome: 'transient' },
    {
      answer: '412 PreconditionFailed',
      kind: { status: 412, code: 'PreconditionFailed' },
      sends: 1,
      outcome: 'conflict',
    },
    {
      answer: '403 AccessDenied',
      kind: { status: 403, code: 'AccessDenied' },
      sends: 1,
      outcome: 'raw',
    },
  ];

  it.each(rows)('$answer: sent $sends time(s) when only the first is refused', async (row) => {
    const bucket = new StubS3Bucket();
    const driver = new S3StorageDriver({
      client: bucket.client(),
      bucket: STUB_BUCKET,
      clock: { sleep: async () => {} },
    });
    bucket.arm('PutObject', row.kind);
    const first = await outcomeOf(() => put(driver));
    expect(bucket.count('PutObject')).toBe(row.sends);
    // A throttle sent again lands; any other answer to the first send is the caller's.
    expect(first).toBe(row.sends === 2 ? 'ok' : row.outcome);
  });

  it.each(rows)('$answer: the caller sees $outcome when every send is refused', async (row) => {
    const bucket = new StubS3Bucket();
    const driver = new S3StorageDriver({
      client: bucket.client(),
      bucket: STUB_BUCKET,
      clock: { sleep: async () => {} },
    });
    for (let i = 0; i < 4; i++) bucket.arm('PutObject', row.kind);
    expect(await outcomeOf(() => put(driver))).toBe(row.outcome);
    // Four sends at the most, whatever the answer; nothing is deleted.
    expect(bucket.count('PutObject')).toBe(row.sends === 2 ? 4 : 1);
    expect(bucket.count('DeleteObject')).toBe(0);
  });
});

describe('GCS: the answers a single-request upload is sent again after', () => {
  let stub: StubGcsService;
  beforeEach(async () => {
    stub = new StubGcsService();
    await stub.start();
  });
  afterEach(async () => {
    await stub.stop();
  });

  interface Row {
    readonly status: number;
    readonly sends: number;
    readonly outcome: Outcome;
  }
  const rows: readonly Row[] = [
    { status: 429, sends: 2, outcome: 'transient' },
    { status: 503, sends: 2, outcome: 'transient' },
    { status: 408, sends: 1, outcome: 'transient' },
    { status: 500, sends: 1, outcome: 'transient' },
    { status: 502, sends: 1, outcome: 'transient' },
    { status: 504, sends: 1, outcome: 'transient' },
    { status: 412, sends: 1, outcome: 'conflict' },
    { status: 403, sends: 1, outcome: 'raw' },
  ];

  const driver = (): GcsStorageDriver =>
    new GcsStorageDriver({
      storage: stub.client(),
      bucket: STUB_GCS_BUCKET,
      clock: { sleep: async () => {} },
    });

  it.each(rows)('$status: sent $sends time(s) when only the first is refused', async (row) => {
    stub.arm({ status: row.status });
    const first = await outcomeOf(() => put(driver()));
    expect(stub.count('upload')).toBe(row.sends);
    expect(first).toBe(row.sends === 2 ? 'ok' : row.outcome);
  });

  it.each(rows)('$status: the caller sees $outcome when every send is refused', async (row) => {
    for (let i = 0; i < 4; i++) stub.arm({ status: row.status });
    expect(await outcomeOf(() => put(driver()))).toBe(row.outcome);
    expect(stub.count('upload')).toBe(row.sends === 2 ? 4 : 1);
    expect(stub.count('delete')).toBe(0);
  });
});

describe('Azure Blob: the answers the client sends a write again after', () => {
  let stub: StubBlobService;
  beforeEach(async () => {
    stub = new StubBlobService();
    await stub.start();
  });
  afterEach(async () => {
    await stub.stop();
  });

  const TRIES = 3;
  interface Row {
    readonly answer: string;
    readonly respond: Answer;
    /** PUT requests made when every try is answered this. */
    readonly sends: number;
    readonly outcome: Outcome;
  }
  const rows: readonly Row[] = [
    {
      answer: '503 ServerBusy',
      respond: xmlError(503, 'ServerBusy'),
      sends: TRIES,
      outcome: 'transient',
    },
    {
      answer: '500 OperationTimedOut',
      respond: xmlError(500, 'OperationTimedOut'),
      sends: TRIES,
      outcome: 'transient',
    },
    {
      answer: '409 BlobAlreadyExists',
      respond: xmlError(409, 'BlobAlreadyExists'),
      sends: 1,
      outcome: 'conflict',
    },
    {
      answer: '412 ConditionNotMet',
      respond: xmlError(412, 'ConditionNotMet'),
      sends: 1,
      outcome: 'conflict',
    },
    {
      answer: '403 AuthorizationFailure',
      respond: xmlError(403, 'AuthorizationFailure'),
      sends: 1,
      outcome: 'raw',
    },
  ];

  it.each(rows)('$answer: $sends PUT(s) when every try is refused, then $outcome', async (row) => {
    const driver = new AzureBlobStorageDriver({
      containerClient: new ContainerClient(stub.url, new AnonymousCredential(), {
        retryOptions: { maxTries: TRIES, retryDelayInMs: 1, maxRetryDelayInMs: 2 },
      }),
    });
    stub.plan = (req) => (req.method === 'PUT' ? { respond: row.respond } : undefined);
    // A conflict on the first send is read back by write id: the stub holds no blob, so it is another writer's.
    expect(await outcomeOf(() => put(driver))).toBe(row.outcome);
    expect(stub.count('PUT')).toBe(row.sends);
    expect(stub.count('DELETE')).toBe(0);
  });
});
