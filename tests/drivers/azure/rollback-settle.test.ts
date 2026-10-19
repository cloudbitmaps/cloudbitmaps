import { AzureBlobRegistryDriver } from '@/azure-blob/registry';
import { AzureBlobStorageDriver } from '@/azure-blob/storage';
import { RecordingAuditSink } from '@/core/audit';
import { TransientError, WriteConflictError } from '@/core/errors';
import { loadSegment } from '@/core/load';
import { rollbackSegment } from '@/core/rollback';
import { roaringCodec } from '@/roaring-codec';
import { StubBlobService, xmlError } from '../../helpers/azure-blob-stub';
import { testEntropy } from '../../helpers/entropy';

/**
 * A rollback over Azure Blob, through a real `@azure/storage-blob` client over a stub of the Blob service. A row write
 * the client sends again after a `503` meets the blob it already made, or another writer's on top; the registry reads
 * the write id back and reports a conflict when the id is another's. The rollback settles that by the row's pointerId:
 * its own landed swap is reported and audited, and one a load moved past is a conflict with no event.
 */

const SEG = { segment: 's' };
const ROW = 'registry/_default/s.reg';
const CONFLICT_MESSAGE =
  "rollback: the segment's row changed while the rollback ran, and this rollback could not confirm that its swap is " +
  'the one the row shows; check store.generations(ref) and run it again';
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

/** The row writes the stub has received since the plan below was set. */
let rowPuts = 0;

/**
 * Answer 503 to the next row write, after applying it, and run `after` before the answer arrives. With `exhaust`, every
 * later try of the client is answered 503 too and not applied, so the registry never gets an answer.
 */
function overtakeNextRowWrite(after: () => Promise<void>, exhaust = false): void {
  rowPuts = 0;
  let other = false;
  stub.plan = (req) => {
    // The other writer's own writes, made inside `after`, are not the rollback's tries.
    if (req.method !== 'PUT' || req.name !== ROW || other) return undefined;
    rowPuts += 1;
    if (rowPuts === 1) {
      return {
        respond: xmlError(503, 'ServerBusy'),
        apply: true,
        after: async () => {
          other = true;
          try {
            await after();
          } finally {
            other = false;
          }
        },
      };
    }
    return exhaust ? { respond: xmlError(503, 'ServerBusy') } : undefined;
  };
}

/** What each compare-and-swap of `registry` threw, as the rollback received it. */
function swapErrors(registry: AzureBlobRegistryDriver): unknown[] {
  const errors: unknown[] = [];
  const original = registry.compareAndSwap.bind(registry);
  registry.compareAndSwap = async (...args: Parameters<typeof original>) => {
    try {
      return await original(...args);
    } catch (err) {
      errors.push(err);
      throw err;
    }
  };
  return errors;
}

async function threeGenerations() {
  const d = make();
  const load = { ...d, entropy: testEntropy, codec: roaringCodec };
  for (let i = 0; i < 3; i++) await loadSegment(SEG, [i + 1], load, { keep: 9 });
  return { d, load };
}

describe('a rollback whose row write the Azure client sent again', () => {
  it('is settled when another writer changed only the retention on top of its landed write: reported, audited once', async () => {
    const { d } = await threeGenerations();
    const other = make().registry;
    overtakeNextRowWrite(async () => {
      const row = (await other.get(SEG))!;
      await other.compareAndSwap(SEG, row.token, { retention: { note: 'kept' } });
    });
    const errors = swapErrors(d.registry);
    const audit = new RecordingAuditSink();
    const r = await rollbackSegment(SEG, 0, d, { audit });
    expect(r).toEqual({ fromGeneration: 2, generation: 0 });
    expect(audit.snapshot().map((e) => e.kind)).toEqual(['segment.rollback']);
    expect(await d.registry.get(SEG)).toMatchObject({ currentGen: 0, retention: { note: 'kept' } });
    // The client sent the write again after the 503, and the replay met the other writer's: a conflict reached the rollback.
    expect(rowPuts).toBe(2);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(WriteConflictError);
  });

  it('is settled when another writer changed only the retention on top of its landed write and no try was answered', async () => {
    const { d } = await threeGenerations();
    const other = make().registry;
    overtakeNextRowWrite(async () => {
      const row = (await other.get(SEG))!;
      await other.compareAndSwap(SEG, row.token, { retention: { note: 'kept' } });
    }, true);
    const errors = swapErrors(d.registry);
    const audit = new RecordingAuditSink();
    expect(await rollbackSegment(SEG, 0, d, { audit })).toEqual({
      fromGeneration: 2,
      generation: 0,
    });
    expect(audit.snapshot().map((e) => e.kind)).toEqual(['segment.rollback']);
    expect(await d.registry.get(SEG)).toMatchObject({ currentGen: 0, retention: { note: 'kept' } });
    // The client tried again and again; the registry's no-answer error reached the rollback.
    expect(rowPuts).toBeGreaterThan(2);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(TransientError);
  });

  it('is a conflict with no event when a load moved the pointer on top of its landed write', async () => {
    const { d, load } = await threeGenerations();
    overtakeNextRowWrite(async () => {
      await loadSegment(SEG, [90], { ...load, ...make() }, { keep: 9 });
    });
    const errors = swapErrors(d.registry);
    const audit = new RecordingAuditSink();
    const err = await rollbackSegment(SEG, 0, d, { audit }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WriteConflictError);
    expect((err as Error).message).toBe(CONFLICT_MESSAGE);
    expect(rowPuts).toBe(2);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(WriteConflictError);
    expect(audit.snapshot()).toEqual([]);
    expect((await d.registry.get(SEG))!.currentGen).toBe(3);
    expect(stub.count('DELETE')).toBe(0);
  });

  it('is settled when the row write was applied and answered 503 once: the replay meets its own blob', async () => {
    const { d } = await threeGenerations();
    let hits = 0;
    stub.plan = (req) => {
      if (req.method !== 'PUT' || req.name !== ROW) return undefined;
      hits += 1;
      return hits === 1 ? { respond: xmlError(503, 'ServerBusy'), apply: true } : undefined;
    };
    const audit = new RecordingAuditSink();
    // The client's replay meets its own blob and answers; the swap is its own, so the move is audited once.
    await expect(rollbackSegment(SEG, 0, d, { audit })).resolves.toEqual({
      fromGeneration: 2,
      generation: 0,
    });
    expect(audit.snapshot()).toHaveLength(1);
  });

  it('throws the TransientError, and deletes nothing, when no try is answered and none landed', async () => {
    const { d } = await threeGenerations();
    stub.plan = (req) =>
      req.method === 'PUT' && req.name === ROW
        ? { respond: xmlError(503, 'ServerBusy') }
        : undefined;
    const audit = new RecordingAuditSink();
    await expect(rollbackSegment(SEG, 0, d, { audit })).rejects.toBeInstanceOf(TransientError);
    expect(audit.snapshot()).toEqual([]);
    expect(stub.count('DELETE')).toBe(0);
    expect((await d.registry.get(SEG))!.currentGen).toBe(2);
  });
});
