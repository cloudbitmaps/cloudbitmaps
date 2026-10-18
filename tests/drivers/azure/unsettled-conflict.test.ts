import { AzureBlobRegistryDriver } from '@/azure-blob/registry';
import { AzureBlobStorageDriver } from '@/azure-blob/storage';
import { RecordingAuditSink } from '@/core/audit';
import { WriteConflictError, isUnsettledConflict } from '@/core/errors';
import { loadSegment } from '@/core/load';
import { roaringCodec } from '@/roaring-codec';
import { StubBlobService, xmlError } from '../../helpers/azure-blob-stub';
import { testEntropy } from '../../helpers/entropy';

/**
 * Every conflict of an Azure Blob row write is raised as `unsettledConflict`: the client's retry may have sent the
 * write twice, and the read-back of the write id cannot rule out that the first copy landed before another writer
 * swapped in over it. A load refused after one therefore reports `unanswered: true`, which on this backend includes a
 * load that lost an ordinary race, since the driver cannot see its client's retry. A check the registry makes itself
 * before it sends anything is a plain conflict.
 */

const SEG = { segment: 's' };
const ROW = 'registry/_default/s.reg';
const QUICK = { retryOptions: { retryDelayInMs: 1, maxRetryDelayInMs: 2 } };

let stub: StubBlobService;
beforeEach(async () => {
  stub = new StubBlobService();
  await stub.start();
});
afterEach(async () => {
  await stub.stop();
});

const make = () => ({
  storage: new AzureBlobStorageDriver({ containerClient: stub.client(QUICK) }),
  registry: new AzureBlobRegistryDriver({ containerClient: stub.client(QUICK) }),
});
const deps = () => ({ ...make(), entropy: testEntropy, codec: roaringCodec });

async function twoGenerations() {
  const d = deps();
  for (let i = 0; i < 2; i++) await loadSegment(SEG, [i + 1], d, { keep: 9 });
  return d;
}

/** Answer the next row write with `respond`, applying it first when `apply`, and run `after` before the answer. */
function answerNextRowWrite(
  respond: ReturnType<typeof xmlError>,
  options: { apply?: boolean; after?: () => Promise<void> } = {},
): void {
  let seen = false;
  let inside = false;
  stub.plan = (req) => {
    if (req.method !== 'PUT' || req.name !== ROW || seen || inside) return undefined;
    seen = true;
    return {
      respond,
      ...(options.apply === true ? { apply: true } : {}),
      after: async () => {
        inside = true;
        try {
          await options.after?.();
        } finally {
          inside = false;
        }
      },
    };
  };
}

const refusals = (audit: RecordingAuditSink) =>
  audit.snapshot().filter((e) => e.kind === 'segment.load-refused');

describe('an Azure Blob load refused at the registry', () => {
  it('after its write was applied, answered 503, and overtaken by a load: superseded, and the refusal says unanswered', async () => {
    const d = await twoGenerations();
    answerNextRowWrite(xmlError(503, 'ServerBusy'), {
      apply: true,
      after: async () => {
        await loadSegment(SEG, [90], deps(), { keep: 9 });
      },
    });
    const audit = new RecordingAuditSink();
    const r = await loadSegment(SEG, [1, 2, 3], d, { keep: 9, audit });
    expect(r).toMatchObject({ published: false, reason: 'superseded' });
    expect(refusals(audit)).toEqual([expect.objectContaining({ unanswered: true })]);
    expect(stub.count('DELETE')).toBe(0);
  });

  it('after an ordinary lost race it did not retry: the conflict is marked too, so the refusal says unanswered', async () => {
    // The consequence the design accepts: on this backend most superseded refusals carry the flag.
    const d = await twoGenerations();
    // Another load publishes after this one read the row and before its write: the real 412 of a lost race.
    const original = d.registry.compareAndSwap.bind(d.registry);
    let raced = false;
    d.registry.compareAndSwap = async (...args: Parameters<typeof original>) => {
      if (!raced) {
        raced = true;
        await loadSegment(SEG, [90], deps(), { keep: 9 });
      }
      return original(...args);
    };
    const audit = new RecordingAuditSink();
    const r = await loadSegment(SEG, [1, 2, 3], d, { keep: 9, audit });
    expect(r).toMatchObject({ published: false, reason: 'superseded' });
    expect(refusals(audit)).toEqual([expect.objectContaining({ unanswered: true })]);
  });

  it('after its write was applied, answered 503, and a retention write went over it: published, no refusal', async () => {
    const d = await twoGenerations();
    const other = make().registry;
    answerNextRowWrite(xmlError(503, 'ServerBusy'), {
      apply: true,
      after: async () => {
        const row = (await other.get(SEG))!;
        await other.compareAndSwap(SEG, row.token, { retention: { note: 'kept' } });
      },
    });
    const audit = new RecordingAuditSink();
    const r = await loadSegment(SEG, [1, 2, 3], d, { keep: 9, audit });
    expect(r).toMatchObject({ generation: 2, published: true });
    expect(refusals(audit)).toEqual([]);
    expect(await d.registry.get(SEG)).toMatchObject({ currentGen: 2, retention: { note: 'kept' } });
  });
});

describe('the Azure registry driver raises a conflict of a row write as unsettledConflict', () => {
  it('a compare-and-swap that loses to another writer (412)', async () => {
    const d = await twoGenerations();
    const row = (await d.registry.get(SEG))!;
    answerNextRowWrite(xmlError(412, 'ConditionNotMet'));
    const err = await d.registry
      .compareAndSwap(SEG, row.token, { currentGen: 1 }, { held: row })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WriteConflictError);
    expect(isUnsettledConflict(err)).toBe(true);
  });

  it('a compare-and-swap whose row is gone (404)', async () => {
    const d = await twoGenerations();
    const row = (await d.registry.get(SEG))!;
    answerNextRowWrite(xmlError(404, 'BlobNotFound'));
    const err = await d.registry
      .compareAndSwap(SEG, row.token, { currentGen: 1 }, { held: row })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WriteConflictError);
    expect(isUnsettledConflict(err)).toBe(true);
  });

  it('a create whose read-back finds the blob gone', async () => {
    const d = deps();
    answerNextRowWrite(xmlError(409, 'BlobAlreadyExists'));
    const err = await d.registry
      .create(SEG, { currentGen: 0 }, { held: null })
      .catch((e: unknown) => e);
    expect(stub.blobs.has(ROW)).toBe(false);
    expect(err).toBeInstanceOf(WriteConflictError);
    expect(isUnsettledConflict(err)).toBe(true);
  });

  it('a compare-and-swap with a token the row has moved past is refused before anything is sent, and is plain', async () => {
    const d = await twoGenerations();
    const stale = (await d.registry.get(SEG))!.token;
    const row = (await d.registry.get(SEG))!;
    await d.registry.compareAndSwap(SEG, row.token, { currentGen: 0 });
    const puts = stub.count('PUT');
    const err = await d.registry
      .compareAndSwap(SEG, stale, { currentGen: 1 })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WriteConflictError);
    expect(isUnsettledConflict(err)).toBe(false);
    expect(stub.count('PUT')).toBe(puts);
  });

  it('a delete that loses its precondition is plain', async () => {
    const d = await twoGenerations();
    const stale = (await d.registry.get(SEG))!.token;
    const row = (await d.registry.get(SEG))!;
    await d.registry.compareAndSwap(SEG, row.token, { currentGen: 0 });
    const err = await d.registry.delete(SEG, stale).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WriteConflictError);
    expect(isUnsettledConflict(err)).toBe(false);
  });
});
