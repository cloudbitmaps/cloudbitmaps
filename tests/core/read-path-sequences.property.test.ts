import { randomBytes } from 'node:crypto';
import fc from 'fast-check';
import { aadFor } from '@/core/crypto';
import { openGenerationReader } from '@/core/crbm-storage-source';
import { eraseIdFromSegment } from '@/core/erase-id';
import { loadSegment } from '@/core/load';
import type { GenerationMetadata, SegmentRef } from '@/core/ports';
import { listGenerations, rollbackSegment } from '@/core/rollback';
import { InProcessKeystore } from '@/drivers/crypto';
import { CloudRoaring, MemoryStorage } from '@/index';
import { roaringCodec } from '@/roaring-codec';

/**
 * Random sequences of loads, materialisations, rollbacks, erasures and retention writes over one segment. After
 * every step a store that has read nothing gives the same count three ways (the row's summary, the length of
 * `iterate()` and the sum of the object's index), says through `stat()` what the current generation was loaded with,
 * and the row's summary, when it has one, names the generation the row names.
 */

const SEG: SegmentRef = { namespace: 'ns', segment: 's' };
const OTHER: SegmentRef = { namespace: 'ns', segment: 'o' };
const OTHER_IDS = [3, 70_000, 140_000];

type Op =
  | { kind: 'load'; ids: number[]; metadata: GenerationMetadata | undefined }
  | { kind: 'union'; metadata: GenerationMetadata | undefined }
  | { kind: 'rollback'; pick: number }
  | { kind: 'erase'; pick: number }
  | { kind: 'retention' };

const META = fc.option(
  fc.dictionary(
    fc.constantFrom('def', 'run', 'owner', 'n'),
    fc.oneof(fc.string({ maxLength: 8 }), fc.integer()),
  ),
  { nil: undefined, freq: 2 },
);
const OP: fc.Arbitrary<Op> = fc.oneof(
  {
    weight: 4,
    arbitrary: fc.record({
      kind: fc.constant('load' as const),
      ids: fc.uniqueArray(fc.integer({ min: 0, max: 200_000 }), { minLength: 1, maxLength: 12 }),
      metadata: META,
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({ kind: fc.constant('union' as const), metadata: META }),
  },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant('rollback' as const), pick: fc.nat() }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant('erase' as const), pick: fc.nat() }) },
  { weight: 1, arbitrary: fc.constant({ kind: 'retention' as const }) },
);

const none = (m: GenerationMetadata | undefined): GenerationMetadata | undefined =>
  m === undefined || Object.keys(m).length === 0 ? undefined : m;

async function run(ops: Op[], encrypted: boolean): Promise<void> {
  const keystore = encrypted
    ? new InProcessKeystore({ keys: { k: randomBytes(32) }, activeKeyId: 'k' })
    : undefined;
  const backend = new MemoryStorage();
  const { storage, registry } = backend;
  const deps = { storage, registry, codec: roaringCodec, keystore };
  const writer = new CloudRoaring({ storage: backend, retry: false, encryption: { keystore } });
  const model = new Map<number, { ids: Set<number>; metadata: GenerationMetadata | undefined }>();
  await loadSegment(OTHER, OTHER_IDS, deps);

  const check = async (step: string): Promise<void> => {
    const row = await registry.get(SEG);
    if (row === null || row.currentGen === null) return;
    const gen = row.currentGen;
    const held = model.get(gen);
    expect(held, `${step}: the model knows generation ${gen}`).toBeDefined();
    const fresh = new CloudRoaring({ storage: backend, retry: false, encryption: { keystore } });
    const seg = fresh.segment('s', { namespace: 'ns' });
    const viaRow = await seg.count();
    const stat = await seg.stat();
    let iterated = 0;
    for await (const id of seg.iterate()) {
      void id;
      iterated += 1;
    }
    const aead =
      row.wrappedDeks === undefined ? undefined : await keystore!.openDek(row.wrappedDeks);
    const reader = await openGenerationReader(
      storage,
      { ...SEG, generation: gen },
      aead === undefined ? undefined : { aead, aadFor: (scope) => aadFor(SEG, gen, scope) },
    );
    let indexed = 0;
    for (const n of reader.cardinalities().values()) indexed += n;
    expect(viaRow, `${step}: the count`).toBe(iterated);
    expect(indexed, `${step}: the index sum`).toBe(iterated);
    expect(iterated, `${step}: what the model holds`).toBe(held!.ids.size);
    expect(stat.generation, `${step}: stat names the generation`).toBe(gen);
    expect(stat.cardinality, `${step}: stat's count`).toBe(iterated);
    expect(stat.metadata, `${step}: stat's metadata`).toEqual(none(held!.metadata));
    if (row.summary !== undefined) {
      expect(row.summary.generation, `${step}: the summary names the current generation`).toBe(gen);
    }
  };

  let step = 0;
  for (const op of ops) {
    step += 1;
    const label = `step ${step} (${op.kind})`;
    const row = await registry.get(SEG);
    const current = row?.currentGen ?? null;
    if (op.kind === 'load') {
      const r = await loadSegment(SEG, op.ids, deps, {
        keep: 9,
        ...(op.metadata === undefined ? {} : { metadata: op.metadata }),
      });
      if (r.published) model.set(r.generation, { ids: new Set(op.ids), metadata: op.metadata });
    } else if (op.kind === 'union') {
      if (current === null) continue;
      const r = await writer
        .segment('s', { namespace: 'ns' })
        .unionInto(
          writer.segment('s', { namespace: 'ns' }),
          [writer.segment('o', { namespace: 'ns' })],
          {
            keep: 9,
            allowEmpty: true,
            ...(op.metadata === undefined ? {} : { metadata: op.metadata }),
          },
        );
      const base = model.get(current)!;
      if (r.published) {
        model.set(r.generation, {
          ids: new Set([...base.ids, ...OTHER_IDS]),
          metadata: op.metadata,
        });
      }
    } else if (op.kind === 'rollback') {
      if (current === null) continue;
      const below = (await listGenerations(SEG, { storage, registry })).filter(
        (g) => g.generation < current,
      );
      if (below.length === 0) continue;
      await rollbackSegment(SEG, below[op.pick % below.length]!.generation, {
        storage,
        registry,
        keystore,
      });
    } else if (op.kind === 'erase') {
      if (current === null) continue;
      const held = model.get(current)!;
      const ids = [...held.ids];
      if (ids.length === 0) continue;
      const id = ids[op.pick % ids.length]!;
      const result = await eraseIdFromSegment(SEG, id, deps);
      if (result.erased && result.generation !== undefined && result.fromGeneration === current) {
        const rest = new Set(held.ids);
        rest.delete(id);
        model.set(result.generation, { ids: rest, metadata: held.metadata });
      }
    } else if (current !== null) {
      await writer.setRetention(SEG, { expiresAt: 4_102_444_800_000 });
    }
    await check(label);
  }
}

describe('the read path through random sequences of loads, materialisations, rollbacks, erasures and retention', () => {
  it('cleartext: a fresh store counts, iterates and sums alike, and stat says what was loaded', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(OP, { minLength: 1, maxLength: 12 }), (ops) => run(ops, false)),
      { numRuns: 40 },
    );
  });

  it('encrypted: the same, through sealed summaries', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(OP, { minLength: 1, maxLength: 12 }), (ops) => run(ops, true)),
      { numRuns: 40 },
    );
  });
});
