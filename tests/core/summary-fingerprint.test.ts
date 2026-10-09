import { randomBytes } from 'node:crypto';
import { CloudRoaring, InProcessKeystore, MemoryStorage } from '@/index';
import type { SegmentRef } from '@/index';
import type { RegistryRecord } from '@/core/ports';
import { usableSummary } from '@/core/summary';

/**
 * Every write that writes a row's summary writes the fingerprint of the object it describes (its size and footer
 * checksum, as `pinnedAt.fingerprint` spells it): a load, a materialisation into another segment, `materializeMany`, an
 * erasure's rewrite and a rollback, which writes its target's. On an encrypted segment it is sealed with the rest of the
 * summary, so the row shows neither the count nor the size.
 */

const NS = 'ns';
const at = (segment: string): SegmentRef => ({ namespace: NS, segment });
const HI = 65_536;

async function world(encrypted = false) {
  const keystore = encrypted
    ? new InProcessKeystore({ keys: { k1: randomBytes(32) }, activeKeyId: 'k1' })
    : undefined;
  const backend = new MemoryStorage();
  const store = new CloudRoaring({
    storage: backend,
    retry: false,
    ...(keystore === undefined ? {} : { encryption: { keystore } }),
  });
  /** What the row's summary says of the object, opened with the segment's key where it is sealed. */
  const described = async (ref: SegmentRef) => {
    const row = (await backend.registry.get(ref))!;
    const aead =
      row.wrappedDeks === undefined ? undefined : await keystore!.openDek(row.wrappedDeks);
    return { row, summary: usableSummary(ref, row, aead) };
  };
  /** The fingerprint of the object the row's pointer names, as a pin records it. */
  const objectOf = async (ref: SegmentRef): Promise<string> =>
    (await store.segment(ref.segment, { namespace: NS }).pin()).pinnedAt!.fingerprint!;
  return { backend, store, keystore, described, objectOf };
}

type World = Awaited<ReturnType<typeof world>>;

async function expectNamesItsObject(w: World, ref: SegmentRef): Promise<RegistryRecord> {
  const { row, summary } = await w.described(ref);
  expect(summary, `${ref.segment}: a usable summary`).toBeDefined();
  expect(summary!.fingerprint).toBe(await w.objectOf(ref));
  return row;
}

describe.each([
  ['cleartext', false],
  ['encrypted', true],
])('the summary names the object it describes: %s', (_, encrypted) => {
  it('a load', async () => {
    const w = await world(encrypted);
    await w.store.load(at('a'), [1, 2, HI + 3]);
    const row = await expectNamesItsObject(w, at('a'));
    if (encrypted) {
      expect(row.summary).not.toHaveProperty('fingerprint');
      expect(row.summary).not.toHaveProperty('cardinality');
      // A nonce, the count, the size and the checksum, and a tag: no metadata.
      expect(Buffer.from((row.summary as { sealed: string }).sealed, 'base64')).toHaveLength(48);
    } else {
      expect(row.summary).toMatchObject({ fingerprint: expect.stringMatching(/^\d+:\d+$/) });
    }
  });

  it('a materialisation into another segment, and materializeMany', async () => {
    const w = await world(encrypted);
    await w.store.load(at('a'), [1, 2, HI + 3]);
    await w.store.load(at('b'), [2, HI + 3, 9]);
    const a = w.store.segment('a', { namespace: NS });
    const b = w.store.segment('b', { namespace: NS });
    await a.intersectInto(w.store.segment('ab', { namespace: NS }), [b]);
    await expectNamesItsObject(w, at('ab'));
    await w.store.materializeMany({
      operands: { a, b },
      outputs: [{ dest: w.store.segment('m', { namespace: NS }), expr: { or: ['a', 'b'] } }],
      keep: 1,
    });
    await expectNamesItsObject(w, at('m'));
  });

  it("an erasure's rewrite", async () => {
    const w = await world(encrypted);
    await w.store.load(at('a'), [1, 2, HI + 3]);
    const erased = await w.store.eraseSubject(2, { namespace: NS });
    expect(erased.erasedFrom).toEqual([expect.objectContaining({ segment: 'a', erased: true })]);
    const row = await expectNamesItsObject(w, at('a'));
    expect(row.currentGen).toBe(1);
  });

  it("a rollback writes its target's", async () => {
    const w = await world(encrypted);
    await w.store.load(at('a'), [1, 2, HI + 3], { keep: 3 });
    await w.store.load(at('a'), [7], { keep: 3 });
    await w.store.rollback(at('a'), 0);
    const row = await expectNamesItsObject(w, at('a'));
    expect(row.currentGen).toBe(0);
  });
});
