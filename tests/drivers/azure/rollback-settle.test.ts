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

/** Answer 503 to the next row write, after applying it, and run `after` before the answer arrives. */
function overtakeNextRowWrite(after: () => Promise<void>): void {
  let fired = false;
  stub.plan = (req) => {
    if (req.method !== 'PUT' || req.name !== ROW || fired) return undefined;
    fired = true;
    return { respond: xmlError(503, 'ServerBusy'), apply: true, after };
  };
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
    const audit = new RecordingAuditSink();
    const r = await rollbackSegment(SEG, 0, d, { audit });
    expect(r).toEqual({ fromGeneration: 2, generation: 0 });
    expect(audit.snapshot().map((e) => e.kind)).toEqual(['segment.rollback']);
    expect(await d.registry.get(SEG)).toMatchObject({ currentGen: 0, retention: { note: 'kept' } });
  });

  it('is a conflict with no event when a load moved the pointer on top of its landed write', async () => {
    const { d, load } = await threeGenerations();
    overtakeNextRowWrite(async () => {
      await loadSegment(SEG, [90], { ...load, ...make() }, { keep: 9 });
    });
    const audit = new RecordingAuditSink();
    const err = await rollbackSegment(SEG, 0, d, { audit }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WriteConflictError);
    expect((err as Error).message).toMatch(/its pointer is not over this rollback's write/);
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
