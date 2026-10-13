import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { rollbackSegment } from '@/core/rollback';
import { aadFor } from '@/core/crypto';
import { nextGeneration } from '@/core/generation-gc';
import type { GenKey, IStorageDriver, TailRead } from '@/core/ports';
import { InProcessKeystore, NodeAead } from '@/drivers/crypto';
import { MemoryRegistryDriver, MemoryStorageDriver } from '@/drivers/memory';
import type { IKeystore, SegmentRef } from '@/index';
import { bulkLoadCrbmGeneration } from '../helpers/bulk-load';
import { writeCrbm } from '../helpers/crbm-extension';

/**
 * What a rollback asks of storage, request by request, and what it raises, for each kind of target: a target the row
 * knows takes the target's tail and the footer once more after the swap, and one it does not know is refused before any
 * request unless `allowUnknown` is passed.
 */
const SEG: SegmentRef = { segment: 's' };

/** A storage driver that records each request, with the generation it names. */
function tracing(inner: IStorageDriver): { driver: IStorageDriver; trace: string[] } {
  const trace: string[] = [];
  const driver = Object.create(inner) as IStorageDriver;
  driver.getTail = (key: GenKey, maxBytes: number): Promise<TailRead> => {
    trace.push(`getTail g${key.generation} ${maxBytes}`);
    return inner.getTail(key, maxBytes);
  };
  driver.getRange = (key: GenKey, offset: number, length: number) => {
    trace.push(`getRange g${key.generation} ${offset} ${length}`);
    return inner.getRange(key, offset, length);
  };
  driver.list = (ref) => {
    trace.push('list');
    return inner.list(ref);
  };
  driver.delete = (key, options) => {
    trace.push(`delete g${key.generation}`);
    return inner.delete(key, options);
  };
  return { driver, trace };
}

function world(keystore?: IKeystore) {
  const memory = new MemoryStorageDriver();
  const registry = new MemoryRegistryDriver();
  const load = async (ids: number[]): Promise<number> => {
    const generation = await nextGeneration(SEG, { storage: memory, registry });
    await bulkLoadCrbmGeneration(memory, { ...SEG, generation }, ids, { registry, keystore });
    return generation;
  };
  return { memory, registry, load };
}

/** The requests of a rollback to `to`, and the outcome: the new pointer, or the error's name and message. */
async function traced(
  w: ReturnType<typeof world>,
  to: number,
  options: { keystore?: IKeystore; allowUnknown?: boolean } = {},
): Promise<{ trace: string[]; outcome: string }> {
  const { driver, trace } = tracing(w.memory);
  let outcome: string;
  try {
    const done = await rollbackSegment(
      SEG,
      to,
      { storage: driver, registry: w.registry, keystore: options.keystore },
      options.allowUnknown === true ? { allowUnknown: true } : undefined,
    );
    outcome = `rolled to ${done.generation}`;
  } catch (err) {
    outcome = `${(err as Error).name}: ${(err as Error).message}`;
  }
  return { trace, outcome };
}

const keystoreOf = () =>
  new InProcessKeystore({ keys: { k1: randomBytes(32) }, activeKeyId: 'k1' });

describe('the requests and errors of a rollback, by target', () => {
  it('a cleartext target', async () => {
    const w = world();
    const first = await w.load([1, 2]);
    await w.load([3]);
    expect(await traced(w, first)).toMatchInlineSnapshot(`
      {
        "outcome": "rolled to 0",
        "trace": [
          "getTail g0 262144",
          "getTail g0 104",
        ],
      }
    `);
  });

  it('an encrypted target, with the key', async () => {
    const keystore = keystoreOf();
    const w = world(keystore);
    const first = await w.load([1, 2]);
    await w.load([3]);
    expect(await traced(w, first, { keystore })).toMatchInlineSnapshot(`
      {
        "outcome": "rolled to 0",
        "trace": [
          "getTail g0 262144",
          "getTail g0 104",
        ],
      }
    `);
  });

  it('a known target above the pointer, from a rollback the caller undoes', async () => {
    const w = world();
    await w.load([1]);
    const top = await w.load([2]);
    await w.load([3]);
    await rollbackSegment(SEG, 0, { storage: w.memory, registry: w.registry });
    expect(await traced(w, top)).toMatchInlineSnapshot(`
      {
        "outcome": "rolled to 1",
        "trace": [
          "getTail g1 262144",
          "getTail g1 104",
        ],
      }
    `);
  });

  it('a target that is gone', async () => {
    const w = world();
    const first = await w.load([1]);
    await w.load([2]);
    await w.memory.delete({ ...SEG, generation: first });
    expect(await traced(w, first, { allowUnknown: true })).toMatchInlineSnapshot(`
      {
        "outcome": "NotFoundError: rollback: generation 0 of "s" is not in the bucket — present: 1",
        "trace": [
          "getTail g0 262144",
          "list",
        ],
      }
    `);
  });

  it('a target whose footer fails its checks', async () => {
    const w = world();
    await w.memory.putImmutable({ ...SEG, generation: 0 }, async (out) =>
      out.write(new Uint8Array(300).fill(9)),
    );
    await w.load([2]);
    expect(await traced(w, 0, { allowUnknown: true })).toMatchInlineSnapshot(`
      {
        "outcome": "IntegrityError: .crbm end magic mismatch",
        "trace": [
          "getTail g0 262144",
        ],
      }
    `);
  });

  it('a target that is another generation’s object', async () => {
    const w = world();
    const other = await writeCrbm([{ chunkKey: 0, payload: Uint8Array.of(1), cardinality: 1 }], {
      generation: 6,
    });
    await w.memory.putImmutable({ ...SEG, generation: 0 }, async (out) => out.write(other));
    await w.load([2]);
    expect(await traced(w, 0, { allowUnknown: true })).toMatchInlineSnapshot(`
      {
        "outcome": "IntegrityError: segment "s" generation 0: its footer says generation 6",
        "trace": [
          "getTail g0 262144",
        ],
      }
    `);
  });

  it('a cleartext target under a row with keys', async () => {
    const keystore = keystoreOf();
    const w = world(keystore);
    await bulkLoadCrbmGeneration(w.memory, { ...SEG, generation: 0 }, [1, 2], {});
    await w.load([7]);
    expect(await traced(w, 0, { keystore, allowUnknown: true })).toMatchInlineSnapshot(`
      {
        "outcome": "IntegrityError: rollback: generation 0 of "s" is cleartext, but the segment is encrypted, so no read of the segment could use it; it was never one of its generations. Roll back to another generation.",
        "trace": [
          "getTail g0 262144",
        ],
      }
    `);
  });

  it('an encrypted target under a row with no keys', async () => {
    const w = world();
    const sealed = await writeCrbm([{ chunkKey: 0, payload: Uint8Array.of(1), cardinality: 1 }], {
      generation: 0,
      crypto: { aead: new NodeAead(randomBytes(32)), aadFor: (scope) => aadFor(SEG, 0, scope) },
    });
    await w.memory.putImmutable({ ...SEG, generation: 0 }, async (out) => out.write(sealed));
    await w.load([7]);
    expect(await traced(w, 0, { allowUnknown: true })).toMatchInlineSnapshot(`
      {
        "outcome": "IntegrityError: rollback: generation 0 of "s" is encrypted, but the segment is cleartext, so no read of the segment could use it; it was never one of its generations. Roll back to another generation.",
        "trace": [
          "getTail g0 262144",
        ],
      }
    `);
  });

  it('an encrypted target sealed under another key', async () => {
    const keystore = keystoreOf();
    const w = world(keystore);
    const sealed = await writeCrbm([{ chunkKey: 0, payload: Uint8Array.of(1), cardinality: 1 }], {
      generation: 0,
      crypto: { aead: new NodeAead(randomBytes(32)), aadFor: (scope) => aadFor(SEG, 0, scope) },
    });
    await w.memory.putImmutable({ ...SEG, generation: 0 }, async (out) => out.write(sealed));
    await w.load([7]);
    expect(await traced(w, 0, { keystore, allowUnknown: true })).toMatchInlineSnapshot(`
      {
        "outcome": "IntegrityError: AEAD authentication failed (wrong key, tampered data, or wrong context)",
        "trace": [
          "getTail g0 262144",
        ],
      }
    `);
  });
});

describe('the requests and errors of a rollback onto a target the row does not know', () => {
  it('is refused with no request at all, whether or not the target holds an object', async () => {
    const w = world();
    await w.load([1]);
    await w.load([2]);
    // Numbers the row never made current: 7 holds no object, and 5 holds one.
    await bulkLoadCrbmGeneration(w.memory, { ...SEG, generation: 5 }, [9], {
      registry: new MemoryRegistryDriver(),
    });
    for (const target of [5, 7]) {
      const refused = await traced(w, target);
      expect(refused.outcome).toMatch(/^ValidationError: .*not one its row knows it published/);
      expect(refused.trace).toEqual([]);
    }
  });

  it('an unknown encrypted target with no keystore is refused before any read of it', async () => {
    const w = world(keystoreOf());
    await w.load([1]);
    await w.load([2]);
    await bulkLoadCrbmGeneration(w.memory, { ...SEG, generation: 5 }, [9], {
      registry: new MemoryRegistryDriver(),
      keystore: keystoreOf(),
    });
    expect(await traced(w, 5, { allowUnknown: true })).toMatchInlineSnapshot(`
      {
        "outcome": "KeyUnavailableError: rollback: generation 5 of "s" is not one its row knows it published, and the segment is encrypted: only its key, opening the target, shows that it is one of the segment's generations and not an object sealed under another key, and no key is at hand (the store has no keystore). Retry with a keystore that opens the segment's key.",
        "trace": [],
      }
    `);
  });
});

/** One id per chunk, so the index outgrows the 256 KiB tail and the open needs a range read. */
const wideIds = (): number[] => Array.from({ length: 40_000 }, (_, k) => k * 0x1_0000);

describe('the requests and errors of a rollback, by target (more kinds)', () => {
  it('an encrypted target below the pointer, with no keystore', async () => {
    const keystore = keystoreOf();
    const w = world(keystore);
    const first = await w.load([1, 2]);
    await w.load([3]);
    expect(await traced(w, first)).toMatchInlineSnapshot(`
      {
        "outcome": "rolled to 0",
        "trace": [
          "getTail g0 262144",
          "getTail g0 104",
        ],
      }
    `);
  });

  it('a known encrypted target above the pointer, with no keystore', async () => {
    const keystore = keystoreOf();
    const w = world(keystore);
    await w.load([1]);
    const top = await w.load([2]);
    await rollbackSegment(SEG, 0, { storage: w.memory, registry: w.registry, keystore });
    expect(await traced(w, top)).toMatchInlineSnapshot(`
      {
        "outcome": "rolled to 1",
        "trace": [
          "getTail g1 262144",
          "getTail g1 104",
        ],
      }
    `);
  });

  it('a wide target, whose index is past the 256 KiB tail', async () => {
    const w = world();
    const first = await w.load(wideIds());
    await w.load([3]);
    expect(await traced(w, first)).toMatchInlineSnapshot(`
      {
        "outcome": "rolled to 0",
        "trace": [
          "getTail g0 262144",
          "getRange g0 720008 320000",
          "getTail g0 104",
        ],
      }
    `);
  });

  it('the current generation', async () => {
    const w = world();
    await w.load([1]);
    const current = await w.load([2]);
    expect(await traced(w, current)).toMatchInlineSnapshot(`
      {
        "outcome": "rolled to 1",
        "trace": [
          "getTail g1 104",
        ],
      }
    `);
  });
});
