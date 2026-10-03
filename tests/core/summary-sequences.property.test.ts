import { randomBytes } from 'node:crypto';
import fc from 'fast-check';
import { aadFor } from '@/core/crypto';
import { openGenerationReader } from '@/core/crbm-storage-source';
import { eraseIdFromSegment } from '@/core/erase-id';
import { loadSegment } from '@/core/load';
import type { GenerationMetadata, SegmentRef } from '@/core/ports';
import { listGenerations, rollbackSegment } from '@/core/rollback';
import { summaryAgrees, usableSummary } from '@/core/summary';
import { InProcessKeystore } from '@/drivers/crypto';
import { MemoryRegistryDriver, MemoryStorageDriver } from '@/drivers/memory';
import { roaringCodec } from '@/roaring-codec';

/**
 * Random sequences of loads, rollbacks and erasures over one segment, held to a model of what each generation holds:
 * after every step, the row's summary is absent, or names the generation the row names and says what the object it
 * names holds, and the object holds what the model says its generation holds, metadata included. A rollback on a store
 * with no keystore leaves an encrypted row with no summary until the next load writes one.
 */

const SEG: SegmentRef = { namespace: 'ns', segment: 's' };

type Op =
  | { kind: 'load'; ids: number[]; metadata: GenerationMetadata | undefined; guarded: boolean }
  | { kind: 'rollback'; pick: number; keyless: boolean }
  | { kind: 'erase'; pick: number };

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
      guarded: fc.boolean(),
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant('rollback' as const),
      pick: fc.nat(),
      keyless: fc.boolean(),
    }),
  },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant('erase' as const), pick: fc.nat() }) },
);

async function run(ops: Op[], encrypted: boolean): Promise<void> {
  const keystore = encrypted
    ? new InProcessKeystore({ keys: { k: randomBytes(32) }, activeKeyId: 'k' })
    : undefined;
  const storage = new MemoryStorageDriver();
  const registry = new MemoryRegistryDriver();
  const deps = { storage, registry, codec: roaringCodec, keystore };
  /** What each generation holds, by the model. */
  const model = new Map<number, { ids: Set<number>; metadata: GenerationMetadata | undefined }>();

  const check = async (step: string): Promise<void> => {
    const row = await registry.get(SEG);
    if (row === null || row.currentGen === null) return;
    const held = model.get(row.currentGen);
    expect(held, `${step}: the model knows generation ${row.currentGen}`).toBeDefined();
    const aead =
      row.wrappedDeks === undefined ? undefined : await keystore!.openDek(row.wrappedDeks);
    const gen = row.currentGen;
    const reader = await openGenerationReader(
      storage,
      { ...SEG, generation: gen },
      aead === undefined ? undefined : { aead, aadFor: (scope) => aadFor(SEG, gen, scope) },
    );
    expect(reader.count(), `${step}: the object's count`).toBe(held!.ids.size);
    const metadata =
      held!.metadata === undefined || Object.keys(held!.metadata).length === 0
        ? undefined
        : held!.metadata;
    expect(reader.metadata, `${step}: the object's metadata`).toEqual(metadata);
    if (row.summary !== undefined) {
      expect(row.summary.generation, `${step}: the summary names the current generation`).toBe(gen);
      const described = usableSummary(SEG, row, aead);
      expect(described, `${step}: the summary opens`).toBeDefined();
      expect(
        summaryAgrees(described!, { cardinality: reader.count(), metadata: reader.metadata }),
        `${step}: the summary says what the object holds`,
      ).toBe(true);
    }
  };

  let step = 0;
  for (const op of ops) {
    step += 1;
    const label = `step ${step} (${op.kind})`;
    if (op.kind === 'load') {
      const result = await loadSegment(SEG, op.ids, deps, {
        keep: 9,
        ...(op.metadata === undefined ? {} : { metadata: op.metadata }),
        ...(op.guarded ? {} : { allowEmpty: true }),
      });
      if (result.published) {
        model.set(result.generation, { ids: new Set(op.ids), metadata: op.metadata });
      }
    } else if (op.kind === 'rollback') {
      const row = await registry.get(SEG);
      if (row === null || row.currentGen === null) continue;
      const below = (await listGenerations(SEG, { storage, registry })).filter(
        (g) => g.generation < row.currentGen!,
      );
      if (below.length === 0) continue;
      const target = below[op.pick % below.length]!.generation;
      await rollbackSegment(SEG, target, {
        storage,
        registry,
        keystore: op.keyless ? undefined : keystore,
      });
      const after = (await registry.get(SEG))!;
      if (op.keyless && encrypted) {
        expect(after.summary, `${label}: no key, no summary`).toBeUndefined();
      }
    } else {
      const row = await registry.get(SEG);
      if (row === null || row.currentGen === null) continue;
      const held = model.get(row.currentGen)!;
      const ids = [...held.ids];
      if (ids.length === 0) continue; // nothing left to erase
      const id = ids[op.pick % ids.length]!;
      const result = await eraseIdFromSegment(SEG, id, deps);
      if (
        result.erased &&
        result.generation !== undefined &&
        result.fromGeneration === row.currentGen
      ) {
        const rest = new Set(held.ids);
        rest.delete(id);
        model.set(result.generation, { ids: rest, metadata: held.metadata });
      }
    }
    await check(label);
  }
}

describe('the row summary through random sequences of loads, rollbacks and erasures', () => {
  it('cleartext: absent or true of the generation the row names, and the object holds what the model says', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(OP, { minLength: 1, maxLength: 12 }), (ops) => run(ops, false)),
      { numRuns: 60 },
    );
  });

  it('encrypted: the same, sealed, and absent after a rollback with no key', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(OP, { minLength: 1, maxLength: 12 }), (ops) => run(ops, true)),
      { numRuns: 60 },
    );
  });
});
