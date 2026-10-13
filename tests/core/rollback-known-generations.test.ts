import { randomBytes } from 'node:crypto';
import { eraseIdFromSegment } from '@/core/erase-id';
import { destroySegment } from '@/core/erasure';
import {
  IntegrityError,
  KeyUnavailableError,
  NotFoundError,
  ValidationError,
  TransientError,
  WriteConflictError,
} from '@/core/errors';
import type { IKeystore } from '@/core/crypto';
import { MAX_KNOWN_GENERATIONS, usableKnownGens } from '@/core/known-generations';
import { takeLease } from '@/core/leases';
import { listGenerations, rollbackSegment } from '@/core/rollback';
import { generationsOf } from '@/core/generation-list';
import { loadSegment } from '@/core/load';
import type {
  GenKey,
  IStorageDriver,
  KnownGeneration,
  RegistryRecord,
  SegmentRef,
} from '@/core/ports';
import { openSummary } from '@/core/summary';
import { InProcessKeystore } from '@/drivers/crypto';
import { MemoryRegistryDriver, MemoryStorageDriver } from '@/drivers/memory';
import { MIN_EXPIRES_AT_MS, RecordingAuditSink } from '@/index';
import type { AuditEvent } from '@/index';
import { roaringCodec } from '@/roaring-codec';
import { bulkLoadCrbmGeneration } from '../helpers/bulk-load';
import { counting } from '../helpers/counting';

/**
 * A rollback moves only onto a generation the row knows it published, and only if the object under the number is the one
 * whose footer checksum the row recorded. One case per row of what a rollback does for each kind of target, run on a
 * cleartext and on an encrypted segment. Each case says what a rollback did on a build that kept no record of its
 * generations (the control): a case that says "before: moves" is one a rollback accepted then.
 */

const SEG: SegmentRef = { namespace: 'ns', segment: 's' };
const T0 = MIN_EXPIRES_AT_MS * 2;
const keyService = (): IKeystore & { opened: () => number } => {
  const inner = new InProcessKeystore({ keys: { k1: randomBytes(32) }, activeKeyId: 'k1' });
  let opened = 0;
  return {
    createDek: () => inner.createDek(),
    openDek: (wrapped) => {
      opened += 1;
      return inner.openDek(wrapped);
    },
    opened: () => opened,
  };
};

function world(encrypted: boolean) {
  let now = T0;
  const clock = { now: () => now, sleep: () => Promise.resolve() };
  const memory = new MemoryStorageDriver();
  const registry = new MemoryRegistryDriver({ now: () => now });
  const keystore = encrypted ? keyService() : undefined;
  const deps = { storage: memory, registry, codec: roaringCodec, keystore, clock };
  /** The deps of a rollback: this store's keystore, or none (a store that holds no key). */
  const rollbackDeps = (withKey = true) => ({
    storage: memory,
    registry,
    clock,
    ...(withKey && keystore !== undefined ? { keystore } : {}),
  });
  return { memory, registry, keystore, deps, rollbackDeps, advance: (ms: number) => (now += ms) };
}
type World = ReturnType<typeof world>;

const rowOf = async (w: World): Promise<RegistryRecord> => (await w.registry.get(SEG))!;
const names = async (w: World): Promise<number[] | undefined> =>
  (await rowOf(w)).knownGens?.map((e) => e.generation);
const ids = (n: number): number[] => Array.from({ length: n }, (_, i) => i);

/** `n` loads, each of one more id than the last, that keep every generation. */
async function loads(w: World, n: number, keep = 99): Promise<void> {
  for (let g = 0; g < n; g++) await loadSegment(SEG, ids(3 + g), w.deps, { keep });
}

/** What the objects hold, for a summary check: the ids a generation was loaded with. */
const countOf = async (w: World): Promise<number | undefined> => {
  const row = await rowOf(w);
  if (row.summary === undefined) return undefined;
  if ('sealed' in row.summary) {
    const aead = await w.keystore!.openDek(row.wrappedDeks!);
    return openSummary(aead, SEG, row.summary).cardinality;
  }
  return row.summary.cardinality;
};

/**
 * An object written under a number the row does not publish: written the way the segment's own objects are (the row's key
 * on an encrypted segment, so it opens), never published.
 */
async function writeStray(
  w: World,
  generation: number,
  content: number[],
  metadata?: Record<string, string>,
): Promise<void> {
  await bulkLoadCrbmGeneration(w.memory, { ...SEG, generation }, content, {
    registry: w.registry,
    keystore: w.keystore,
    publish: false,
    ...(metadata === undefined ? {} : { metadata }),
  });
}

/** A stray sealed under a key of its own, which no row holds. */
async function writeForeign(w: World, generation: number, content: number[]): Promise<void> {
  await bulkLoadCrbmGeneration(w.memory, { ...SEG, generation }, content, {
    registry: new MemoryRegistryDriver(),
    keystore: w.keystore === undefined ? undefined : keyService(),
    publish: false,
  });
}

/** Another object under a number that is taken: the one there deleted, `writeStray` in its place. */
async function swap(w: World, generation: number, content = [900, 901]): Promise<void> {
  await w.memory.delete({ ...SEG, generation });
  await writeStray(w, generation, content);
}

/** `storage`, with `run` awaited after the first tail read of the target: another writer landing between the rollback's
 * read of the target and its swap. */
function afterFirstTail(storage: IStorageDriver, run: () => Promise<void>): IStorageDriver {
  let fired = false;
  const proxy = Object.create(storage) as IStorageDriver;
  proxy.getTail = async (key: GenKey, maxBytes: number) => {
    const out = await storage.getTail(key, maxBytes);
    if (!fired) {
      fired = true;
      await run();
    }
    return out;
  };
  return proxy;
}

const events = (audit: RecordingAuditSink): AuditEvent[] => audit.snapshot();
const rolled = (e: AuditEvent): Record<string, unknown> => e as unknown as Record<string, unknown>;

describe.each([
  { name: 'cleartext', encrypted: false },
  { name: 'encrypted', encrypted: true },
])('a rollback checks the row’s ledger: $name', ({ encrypted }) => {
  describe('the current generation', () => {
    it('a no-op reads its footer once, and nothing else (before: a zero-byte read)', async () => {
      const w = world(encrypted);
      await loads(w, 2);
      const calls: Record<string, number> = {};
      const tails: number[] = [];
      const storage = counting<IStorageDriver>(w.memory, calls);
      const watched = Object.create(storage) as IStorageDriver;
      watched.getTail = (key, maxBytes) => {
        tails.push(maxBytes);
        return storage.getTail(key, maxBytes);
      };
      const audit = new RecordingAuditSink();
      const r = await rollbackSegment(SEG, 1, { ...w.rollbackDeps(), storage: watched }, { audit });
      expect(r).toEqual({ fromGeneration: 1, generation: 1 });
      expect(tails).toEqual([104]);
      expect(calls.list ?? 0).toBe(0);
      expect(events(audit)).toEqual([]);
    });

    it('whose object is gone is a NotFoundError naming what is there (before: the same)', async () => {
      const w = world(encrypted);
      await loads(w, 2);
      await w.memory.delete({ ...SEG, generation: 1 });
      await expect(rollbackSegment(SEG, 1, w.rollbackDeps())).rejects.toBeInstanceOf(NotFoundError);
      await expect(rollbackSegment(SEG, 1, w.rollbackDeps())).rejects.toThrow(/present: 0/);
    });

    it('with another object under it is an IntegrityError, and nothing moves (before: a no-op)', async () => {
      const w = world(encrypted);
      await loads(w, 2);
      const before = await rowOf(w);
      await swap(w, 1);
      await expect(rollbackSegment(SEG, 1, w.rollbackDeps())).rejects.toBeInstanceOf(
        IntegrityError,
      );
      // Nothing moves, so the override has nothing to override.
      await expect(
        rollbackSegment(SEG, 1, w.rollbackDeps(), { allowUnknown: true }),
      ).rejects.toBeInstanceOf(IntegrityError);
      expect((await rowOf(w)).token).toBe(before.token);
    });
  });

  describe('a generation the row knows', () => {
    it('below the pointer, the same object, moves and writes the target’s own summary (before: the same)', async () => {
      const w = world(encrypted);
      for (const n of [3, 4, 5]) await loadSegment(SEG, ids(n), w.deps, { keep: 9 });
      const audit = new RecordingAuditSink();
      await rollbackSegment(SEG, 0, w.rollbackDeps(), { audit });
      expect((await rowOf(w)).currentGen).toBe(0);
      expect(await countOf(w)).toBe(3);
      expect(events(audit)).toHaveLength(1);
      expect(events(audit)[0]).not.toHaveProperty('unknown');
    });

    it('below the pointer, with no key at hand, moves with no summary, and its checksum is checked (before: moves; no check)', async () => {
      const w = world(encrypted);
      await loads(w, 3);
      await rollbackSegment(SEG, 0, w.rollbackDeps(false));
      const row = await rowOf(w);
      expect(row.currentGen).toBe(0);
      // A cleartext target is opened with no key, so it has its summary; an encrypted one is not opened.
      expect(row.summary === undefined).toBe(encrypted);
      // Another object under the number is refused though no key was held to open it.
      await rollbackSegment(SEG, 2, w.rollbackDeps(false));
      await swap(w, 1);
      await expect(rollbackSegment(SEG, 1, w.rollbackDeps(false))).rejects.toBeInstanceOf(
        IntegrityError,
      );
      expect((await rowOf(w)).currentGen).toBe(2);
    });

    it('above the pointer, a generation a rollback left, the same object, moves with no flag (before: needed allowForward)', async () => {
      const w = world(encrypted);
      await loads(w, 3);
      await rollbackSegment(SEG, 0, w.rollbackDeps());
      const audit = new RecordingAuditSink();
      await rollbackSegment(SEG, 2, w.rollbackDeps(), { audit });
      expect((await rowOf(w)).currentGen).toBe(2);
      expect(await countOf(w)).toBe(5);
      expect(events(audit)[0]).not.toHaveProperty('unknown');
    });

    it('above the pointer, with no key at hand, moves with no summary (before: KeyUnavailableError on an encrypted segment)', async () => {
      const w = world(encrypted);
      await loads(w, 3);
      await rollbackSegment(SEG, 0, w.rollbackDeps());
      await rollbackSegment(SEG, 2, w.rollbackDeps(false));
      const row = await rowOf(w);
      expect(row.currentGen).toBe(2);
      expect(row.summary === undefined).toBe(encrypted);
    });

    it('whose number holds another object is an IntegrityError, with no call to the keystore (before: moves)', async () => {
      const w = world(encrypted);
      await loads(w, 3);
      await swap(w, 0);
      const before = await rowOf(w);
      const opened = w.keystore?.opened() ?? 0;
      for (const withKey of [true, false]) {
        const err = await rollbackSegment(SEG, 0, w.rollbackDeps(withKey)).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(IntegrityError);
        expect((err as Error).message).toMatch(/another object was stored under the number/);
      }
      // The footer decided it: no key was asked for, so no object was opened under any key.
      expect(w.keystore?.opened() ?? 0).toBe(opened);
      expect((await rowOf(w)).token).toBe(before.token);
    });

    it('whose number holds another object moves with allowUnknown, takes the object’s checksum, and is audited unknown', async () => {
      const w = world(encrypted);
      await loads(w, 3);
      await swap(w, 0, [5, 6, 7, 8]);
      const audit = new RecordingAuditSink();
      await rollbackSegment(SEG, 0, w.rollbackDeps(), { audit, allowUnknown: true });
      const row = await rowOf(w);
      expect(row.currentGen).toBe(0);
      expect(await countOf(w)).toBe(4);
      expect(row.knownGens!.map((e) => e.generation)).toEqual([1, 2, 0]);
      expect(rolled(events(audit)[0]!)).toMatchObject({ generation: 0, unknown: true });
      // The row now vouches for the object it moved onto.
      await rollbackSegment(SEG, 2, w.rollbackDeps());
      await rollbackSegment(SEG, 0, w.rollbackDeps());
    });

    it('whose object is gone is a NotFoundError naming what is present (before: the same)', async () => {
      const w = world(encrypted);
      await loads(w, 3);
      await w.memory.delete({ ...SEG, generation: 0 });
      await expect(rollbackSegment(SEG, 0, w.rollbackDeps())).rejects.toBeInstanceOf(NotFoundError);
      await expect(rollbackSegment(SEG, 0, w.rollbackDeps())).rejects.toThrow(/present: 1, 2/);
    });

    it('because a live lease holds it, though the window evicted it, moves with no flag (before: moves)', async () => {
      const w = world(encrypted);
      await loadSegment(SEG, ids(3), w.deps, { keep: 1 });
      const row = await rowOf(w);
      const taken = await takeLease(SEG, w.deps, {
        holder: '0000000000000001',
        generation: 0,
        until: T0 + 3_600_000,
        row,
        current: true,
      });
      expect(taken).not.toBe('moved');
      for (const n of [4, 5, 6]) await loadSegment(SEG, ids(n), w.deps, { keep: 1 });
      expect(await names(w)).toEqual([0, 2, 3]);
      const audit = new RecordingAuditSink();
      await rollbackSegment(SEG, 0, w.rollbackDeps(), { audit });
      expect((await rowOf(w)).currentGen).toBe(0);
      expect(events(audit)[0]).not.toHaveProperty('unknown');
    });
  });

  describe('a generation the row does not know, over a usable ledger', () => {
    /** Generations 0 to 2 published at `keep` 0, so the ledger names 2 alone; the stray at `at` is a freed number or above. */
    async function withStray(at: number): Promise<World> {
      const w = world(encrypted);
      await loads(w, 3, 0);
      expect(await names(w)).toEqual([2]);
      await writeStray(w, at, [70, 71]);
      return w;
    }

    it.each([
      ['below the pointer (a number a load freed)', 0],
      ['above the pointer (a crashed load’s object)', 7],
    ])(
      '%s: ValidationError before any request (before: below moved; above needed a flag)',
      async (_label, at) => {
        const w = await withStray(at);
        const calls: Record<string, number> = {};
        const before = await rowOf(w);
        const err = await rollbackSegment(SEG, at, {
          ...w.rollbackDeps(),
          storage: counting<IStorageDriver>(w.memory, calls),
        }).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(ValidationError);
        expect((err as Error).message).toMatch(/not one its row knows it published/);
        expect(Object.keys(calls)).toEqual([]);
        expect((await rowOf(w)).token).toBe(before.token);
      },
    );

    it('a stale loader’s refused object is refused too (before: moves)', async () => {
      const w = world(encrypted);
      await loads(w, 3, 0); // 0, then 1 and 2 collected as each is superseded: the ledger names 2 only
      await writeStray(w, 1, [4, 5]); // a stalled loader's object, written under a number freed
      await expect(rollbackSegment(SEG, 1, w.rollbackDeps())).rejects.toBeInstanceOf(
        ValidationError,
      );
      expect((await rowOf(w)).currentGen).toBe(2);
    });

    it('with allowUnknown, today’s checks apply, it moves, enters the ledger last, and is audited unknown', async () => {
      const w = world(encrypted);
      await loads(w, 3, 1);
      await writeStray(w, 7, [3, 4, 5, 6, 7, 8]);
      const audit = new RecordingAuditSink();
      await rollbackSegment(SEG, 7, w.rollbackDeps(), { audit, allowUnknown: true });
      const row = await rowOf(w);
      expect(row.currentGen).toBe(7);
      expect(await countOf(w)).toBe(6);
      expect(row.knownGens!.at(-1)!.generation).toBe(7);
      expect(row.knownGens!.map((e) => e.generation)).toContain(1);
      expect(rolled(events(audit)[0]!)).toMatchObject({
        kind: 'segment.rollback',
        fromGeneration: 2,
        generation: 7,
        unknown: true,
      });
      // It is known now: a rollback away and back needs no flag.
      await rollbackSegment(SEG, 2, w.rollbackDeps());
      await rollbackSegment(SEG, 7, w.rollbackDeps());
    });

    it('with allowUnknown, an object that does not agree with the segment is still refused', async () => {
      const w = world(encrypted);
      await loads(w, 2, 1);
      // A stray of the other kind: encrypted under a cleartext row, or cleartext under an encrypted one.
      await bulkLoadCrbmGeneration(w.memory, { ...SEG, generation: 6 }, [1], {
        registry: new MemoryRegistryDriver(),
        keystore: encrypted ? undefined : keyService(),
        publish: false,
      });
      await expect(
        rollbackSegment(SEG, 6, w.rollbackDeps(), { allowUnknown: true }),
      ).rejects.toThrow(/but the segment is (en|clear)/);
      expect((await rowOf(w)).currentGen).toBe(1);
    });
  });

  describe('a row with no usable ledger', () => {
    async function dropLedger(w: World): Promise<void> {
      await w.registry.compareAndSwap(SEG, (await rowOf(w)).token, { knownGens: undefined });
      expect((await rowOf(w)).knownGens).toBeUndefined();
    }

    it('takes a rollback below its pointer with no flag, key-less included, audited unknown (before: moves, not audited as unknown)', async () => {
      const w = world(encrypted);
      await loads(w, 3);
      await dropLedger(w);
      const audit = new RecordingAuditSink();
      await rollbackSegment(SEG, 0, w.rollbackDeps(false), { audit });
      expect((await rowOf(w)).currentGen).toBe(0);
      expect(rolled(events(audit)[0]!)).toMatchObject({ generation: 0, unknown: true });
      // A rollback never starts a ledger.
      expect((await rowOf(w)).knownGens).toBeUndefined();
    });

    it('does not make allowUnknown stricter: it still lands key-less below the pointer', async () => {
      const w = world(encrypted);
      await loads(w, 3);
      await dropLedger(w);
      await rollbackSegment(SEG, 1, w.rollbackDeps(false), { allowUnknown: true });
      expect((await rowOf(w)).currentGen).toBe(1);
    });

    it('needs allowUnknown above its pointer (before: allowForward), and then the key on an encrypted segment', async () => {
      const w = world(encrypted);
      await loads(w, 3);
      await rollbackSegment(SEG, 0, w.rollbackDeps());
      await dropLedger(w);
      await expect(rollbackSegment(SEG, 2, w.rollbackDeps())).rejects.toBeInstanceOf(
        ValidationError,
      );
      if (encrypted) {
        await expect(
          rollbackSegment(SEG, 2, w.rollbackDeps(false), { allowUnknown: true }),
        ).rejects.toBeInstanceOf(KeyUnavailableError);
      }
      await rollbackSegment(SEG, 2, w.rollbackDeps(), { allowUnknown: true });
      expect((await rowOf(w)).currentGen).toBe(2);
    });

    it('on a ledger that disagrees with its row is the same: the row counts as one with none', async () => {
      const w = world(encrypted);
      await loads(w, 3);
      const row = await rowOf(w);
      // A ledger whose last entry is not the pointer is read and not used (a registry of your own that keeps a stale one).
      const stale = row.knownGens!.slice(0, -1);
      const registry = Object.create(w.registry) as MemoryRegistryDriver;
      registry.get = async (ref) => {
        const got = await w.registry.get(ref);
        return got === null ? null : { ...got, knownGens: stale };
      };
      expect(usableKnownGens({ ...row, knownGens: stale })).toBeUndefined();
      const audit = new RecordingAuditSink();
      await rollbackSegment(SEG, 0, { ...w.rollbackDeps(false), registry }, { audit });
      expect(rolled(events(audit)[0]!)).toMatchObject({ generation: 0, unknown: true });
    });
  });

  describe('a row that is gone', () => {
    it('is a NotFoundError (before: the same)', async () => {
      const w = world(encrypted);
      await expect(rollbackSegment(SEG, 0, w.rollbackDeps())).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  describe('the row changing between the read and the swap', () => {
    it('is a WriteConflictError, and a load that evicted the target does not leave the pointer on it (before: the same)', async () => {
      const w = world(encrypted);
      await loadSegment(SEG, ids(3), w.deps, { keep: 1 });
      await loadSegment(SEG, ids(4), w.deps, { keep: 1 });
      expect(await names(w)).toEqual([0, 1]);
      // The load that numbers 2 evicts 0 between the rollback's read of the row and its swap: its publish writes the row
      // without 0, so the rollback's swap, fenced on the token it read, loses.
      const storage = afterFirstTail(w.memory, async () => {
        await loadSegment(SEG, ids(5), w.deps, { keep: 1 });
      });
      await expect(
        rollbackSegment(SEG, 0, { ...w.rollbackDeps(), storage }),
      ).rejects.toBeInstanceOf(WriteConflictError);
      expect((await rowOf(w)).currentGen).toBe(2);
    });
  });
});

describe('an object sealed under a key no row holds', () => {
  it('with no key, below and above the pointer, ValidationError; with allowUnknown, KeyUnavailableError (before: moved, or KeyUnavailableError above)', async () => {
    const w = world(true);
    await loads(w, 3, 0);
    await writeForeign(w, 1, [8]); // below the pointer (2)
    await writeForeign(w, 5, [9]); // above it
    for (const at of [1, 5]) {
      await expect(rollbackSegment(SEG, at, w.rollbackDeps(false))).rejects.toBeInstanceOf(
        ValidationError,
      );
    }
    // With allowUnknown and no key: nothing opens it, and nothing vouches for it.
    for (const at of [1, 5]) {
      const err = await rollbackSegment(SEG, at, w.rollbackDeps(false), {
        allowUnknown: true,
      }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(KeyUnavailableError);
    }
    expect((await rowOf(w)).currentGen).toBe(2);
  });
});

describe('a destroyed (crypto-shredded) row', () => {
  it('is a ValidationError, whatever the target (before: the same)', async () => {
    const w = world(true);
    await loads(w, 2);
    await destroySegment(SEG, { registry: w.registry }, { confirmSegment: SEG.segment });
    expect((await rowOf(w)).status).toBe('destroyed');
    for (const target of [0, 1, 9]) {
      await expect(rollbackSegment(SEG, target, w.rollbackDeps())).rejects.toBeInstanceOf(
        ValidationError,
      );
    }
  });
});

describe('the check after the swap', () => {
  it('puts the pointer and the ledger back when the object went, and the target leaves the ledger', async () => {
    const w = world(false);
    await loads(w, 3);
    const before = await rowOf(w);
    let tails = 0;
    const storage = Object.create(w.memory) as IStorageDriver;
    storage.getTail = (key, maxBytes) => {
      if (key.generation === 0 && ++tails > 1) {
        return Promise.reject(new NotFoundError('collected'));
      }
      return w.memory.getTail(key, maxBytes);
    };
    await expect(rollbackSegment(SEG, 0, { ...w.rollbackDeps(), storage })).rejects.toThrow(
      /was collected while the pointer was moving — the pointer was put back/,
    );
    const after = await rowOf(w);
    expect(after.currentGen).toBe(before.currentGen);
    expect(after.knownGens).toEqual(before.knownGens!.filter((e) => e.generation !== 0));
  });

  it('is one footer read, and puts the pointer back when another object holds the number (before: a listing, and a footer read only above the pointer)', async () => {
    const w = world(false);
    await loads(w, 3);
    // Another object takes the number after the rollback read the target and before its swap's check.
    let tails = 0;
    const storage = Object.create(w.memory) as IStorageDriver;
    storage.getTail = async (key, maxBytes) => {
      const out = await w.memory.getTail(key, maxBytes);
      if (key.generation === 0 && ++tails === 1) await swap(w, 0);
      return out;
    };
    await expect(rollbackSegment(SEG, 0, { ...w.rollbackDeps(), storage })).rejects.toThrow(
      /was replaced while the pointer was moving — the pointer was put back/,
    );
    expect((await rowOf(w)).currentGen).toBe(2);
  });
});

describe('request counts', () => {
  it('a known target below the pointer is 4 requests and a refused unknown one is 1 (before: 5 and none, since it moved)', async () => {
    const w = world(false);
    await loads(w, 3);
    const registryCalls: string[] = [];
    const registry = new Proxy(w.registry, {
      get(t, p, rx) {
        const value: unknown = Reflect.get(t, p, rx);
        if (typeof value !== 'function') return value;
        return (...args: unknown[]) => {
          if (p === 'get' || p === 'compareAndSwap') registryCalls.push(String(p));
          return (value as (...a: unknown[]) => unknown).apply(t, args);
        };
      },
    });
    const calls: Record<string, number> = {};
    const storage = counting<IStorageDriver>(w.memory, calls);
    await rollbackSegment(SEG, 0, { storage, registry });
    // The row, the target's tail, the swap, and the target's footer once more.
    expect(registryCalls).toEqual(['get', 'compareAndSwap']);
    expect(calls).toEqual({ getTail: 2 });
    expect(Object.values(calls).reduce((a, b) => a + b, 0) + registryCalls.length).toBe(4);

    registryCalls.length = 0;
    for (const k of Object.keys(calls)) delete calls[k];
    await writeStray(w, 9, [1]);
    await expect(rollbackSegment(SEG, 9, { storage, registry })).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(registryCalls).toEqual(['get']);
    expect(calls).toEqual({});
  });
});

describe('a refused load’s object, and the ledger', () => {
  it('is no rollback target without allowUnknown, and a publish after it does not record it', async () => {
    const w = world(false);
    await loads(w, 3, 1);
    // A stalled loader's object under a number a collection freed: written, never published, below the pointer.
    await writeStray(w, 0, [9, 9, 9]);
    await expect(rollbackSegment(SEG, 0, w.rollbackDeps())).rejects.toBeInstanceOf(ValidationError);
    // A publish after it records only its own generation and the window it draws from the ledger.
    await loadSegment(SEG, ids(9), w.deps, { keep: 2 });
    expect(await names(w)).not.toContain(0);
    await expect(rollbackSegment(SEG, 0, w.rollbackDeps())).rejects.toBeInstanceOf(ValidationError);
    // With the override it lands, and is then known.
    await rollbackSegment(SEG, 0, w.rollbackDeps(), { allowUnknown: true });
    expect((await rowOf(w)).currentGen).toBe(0);
  });

  it('a row with no ledger accepts it: with no record to check against, a target below the pointer moves', async () => {
    const w = world(false);
    await loads(w, 3, 1);
    await writeStray(w, 0, [9, 9, 9]);
    await w.registry.compareAndSwap(SEG, (await rowOf(w)).token, { knownGens: undefined });
    await rollbackSegment(SEG, 0, w.rollbackDeps());
    expect((await rowOf(w)).currentGen).toBe(0);
  });

  it('an orphan under a number the ledger knows, with the same footer, is accepted; with another footer it is an IntegrityError', async () => {
    const w = world(false);
    await loads(w, 3);
    // The same object written again under its number: the bytes, so the footer checksum, are the same.
    const bytes = (await w.memory.getTail({ ...SEG, generation: 0 }, 1 << 20)).bytes.slice();
    await w.memory.delete({ ...SEG, generation: 0 });
    await w.memory.putImmutable({ ...SEG, generation: 0 }, (sink) => sink.write(bytes));
    await rollbackSegment(SEG, 0, w.rollbackDeps());
    expect((await rowOf(w)).currentGen).toBe(0);
    await rollbackSegment(SEG, 2, w.rollbackDeps());
    await swap(w, 0);
    await expect(rollbackSegment(SEG, 0, w.rollbackDeps())).rejects.toBeInstanceOf(IntegrityError);
  });
});

describe('a destination that keeps every generation (a ledger of 128)', () => {
  const KEEP_ALL = Number.MAX_SAFE_INTEGER;
  const publish = async (w: World, n: number): Promise<void> => {
    for (let i = 0; i < n; i++) await loadSegment(SEG, [i % 50], w.deps, { keep: KEEP_ALL });
  };

  it('takes an allowUnknown rollback onto a generation the row forgot, keeps the target and the generation it left', async () => {
    const w = world(false);
    await publish(w, 140);
    const row = await rowOf(w);
    expect(row.knownGens).toHaveLength(128);
    expect(row.knownGens![0]!.generation).toBe(12);
    // 5 is in the bucket and not in the ledger: older than a full ledger reaches, so today's rule takes it with no flag.
    // 20 is known. An unknown one inside the ledger's range needs the flag: put one there.
    await writeStray(w, 200, [1, 2]);
    const audit = new RecordingAuditSink();
    await rollbackSegment(SEG, 200, w.rollbackDeps(), { audit, allowUnknown: true });
    const after = await rowOf(w);
    expect(after.currentGen).toBe(200);
    expect(after.knownGens!.length).toBeLessThanOrEqual(MAX_KNOWN_GENERATIONS);
    expect(after.knownGens!.at(-1)!.generation).toBe(200);
    expect(after.knownGens!.map((e) => e.generation)).toContain(139);
    expect(rolled(events(audit)[0]!)).toMatchObject({ unknown: true });
  });

  it('judges a target below a full ledger’s oldest entry as it does on a row with no record: no flag, key-less allowed, audited unknown; one publish moves the limit', async () => {
    const w = world(false);
    await publish(w, 140);
    expect((await names(w))![0]).toBe(12);
    const audit = new RecordingAuditSink();
    // 5 left the ledger: below its oldest entry (12), so today's rule: no flag.
    await rollbackSegment(SEG, 5, w.rollbackDeps(false), { audit });
    expect((await rowOf(w)).currentGen).toBe(5);
    expect(rolled(events(audit)[0]!)).toMatchObject({ generation: 5, unknown: true });
    // The ledger is back to 128 with 5 last; a checked rollback onto 139 moves it to the end.
    await rollbackSegment(SEG, 139, w.rollbackDeps(), { audit });
    expect(events(audit)[1]).not.toHaveProperty('unknown');
    // 8 is below the ledger's oldest entry (13 now) and above 5, which a rollback onto it put in the ledger: the number test
    // (below the lowest entry, 5) would refuse it, the oldest entry (13) takes it.
    expect((await names(w))![0]).toBe(13);
    await rollbackSegment(SEG, 8, w.rollbackDeps(false), { audit });
    expect(rolled(events(audit)[2]!)).toMatchObject({ generation: 8, unknown: true });
    // 100 is known: checked.
    await rollbackSegment(SEG, 100, w.rollbackDeps(), { audit });
    expect(events(audit)[3]).not.toHaveProperty('unknown');
  });

  it('is stricter right after a rollback onto an old generation, until one publish drops it', async () => {
    const w = world(false);
    await publish(w, 140);
    await rollbackSegment(SEG, 5, w.rollbackDeps(false)); // the ledger is [13 … 139, 5]
    await publish(w, 127); // 13 … 139 leave in turn; the ledger is [5, 140 … 266]
    const ledger = (await names(w))!;
    expect(ledger[0]).toBe(5);
    expect(ledger).toHaveLength(128);
    // 100 is unknown and above 5, the ledger's oldest entry: it needs the flag, though it is far older than the newest 128.
    await expect(rollbackSegment(SEG, 100, w.rollbackDeps(false))).rejects.toBeInstanceOf(
      ValidationError,
    );
    await publish(w, 1); // drops 5: the oldest entry is 140 now
    expect((await names(w))![0]).toBe(140);
    await rollbackSegment(SEG, 100, w.rollbackDeps(false));
    expect((await rowOf(w)).currentGen).toBe(100);
  });

  it.each([
    ['the current generation', 139],
    ['the oldest entry', 12],
    ['a middle entry', 80],
  ])(
    'a lease on %s leaves the ledger full: a rollback past it takes the fallback, with no flag, audited unknown',
    async (_label, leased) => {
      const w = world(false);
      await publish(w, 140);
      expect(await names(w)).toHaveLength(128);
      const row = await rowOf(w);
      const taken = await takeLease(SEG, w.deps, {
        holder: '0000000000000004',
        generation: leased,
        until: T0 + 3_600_000,
        row,
        current: leased === row.currentGen,
      });
      expect(taken).not.toBe('moved');
      expect((await names(w))![0]).toBe(12);
      const audit = new RecordingAuditSink();
      await rollbackSegment(SEG, 5, w.rollbackDeps(false), { audit });
      expect((await rowOf(w)).currentGen).toBe(5);
      expect(rolled(events(audit)[0]!)).toMatchObject({ generation: 5, unknown: true });
    },
  );

  it('a ledger of fewer than 128 entries is not full, a lease or not: an unknown number below its oldest entry needs the flag', async () => {
    const w = world(false);
    for (let i = 0; i < 130; i++) await loadSegment(SEG, [i % 50], w.deps, { keep: 100 });
    const row = await rowOf(w);
    await takeLease(SEG, w.deps, {
      holder: '0000000000000005',
      generation: 129,
      until: T0 + 3_600_000,
      row,
      current: true,
    });
    expect(await names(w)).toHaveLength(101);
    await writeStray(w, 5, [1]); // a freed number below the ledger's oldest entry
    await expect(rollbackSegment(SEG, 5, w.rollbackDeps(false))).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it('an inserting rollback into a ledger the leases extended drops one entry for one inserted, and every other known generation still lands with no flag', async () => {
    const w = world(false);
    await publish(w, 120);
    // Twenty generations inside the vouched span, leased: the ledger grows past 128 as later publishes vouch for 127 more.
    for (let g = 100; g < 120; g++) {
      const row = await rowOf(w);
      const taken = await takeLease(SEG, w.deps, {
        holder: g.toString(16).padStart(16, '0'),
        generation: g,
        until: T0 + 3_600_000,
        row,
        current: g === row.currentGen,
      });
      expect(taken).not.toBe('moved');
    }
    await publish(w, 180);
    const before = (await names(w))!;
    expect(before).toHaveLength(148); // 128 vouched and 20 leased extras
    await writeStray(w, 400, [1]);
    await rollbackSegment(SEG, 400, w.rollbackDeps(), { allowUnknown: true });
    const after = (await names(w))!;
    // One unleased entry left for the one inserted: the oldest of the vouched span, never a leased one.
    expect(after).toHaveLength(148); // one in, one out: 128 vouched and 20 leased extras
    expect(before.filter((g) => !after.includes(g))).toEqual([172]);
    for (let g = 100; g < 120; g++) expect(after).toContain(g);
    // Back to 299, then onto 180, which the row knew before the insert: it lands with no flag.
    await rollbackSegment(SEG, 299, w.rollbackDeps());
    const audit = new RecordingAuditSink();
    await rollbackSegment(SEG, 180, w.rollbackDeps(), { audit });
    expect((await rowOf(w)).currentGen).toBe(180);
    expect(events(audit)[0]).not.toHaveProperty('unknown');
  });

  it('a lease on the oldest entry does not hold the bound: the oldest entry no lease names does', async () => {
    const w = world(false);
    await publish(w, 140);
    await rollbackSegment(SEG, 5, w.rollbackDeps(false));
    const row = await rowOf(w);
    const taken = await takeLease(SEG, w.deps, {
      holder: '0000000000000002',
      generation: 5,
      until: T0 + 3_600_000,
      row,
      current: true,
    });
    expect(taken).not.toBe('moved');
    await publish(w, 130);
    const ledger = (await names(w))!;
    expect(ledger[0]).toBe(5); // the lease keeps it first, as an extra
    // 100 left the ledger while it was full; the bound is the oldest entry no lease names (a generation above 100), so it
    // is decided by the pointer alone: no flag, no key, audited unknown.
    const audit = new RecordingAuditSink();
    await rollbackSegment(SEG, 100, w.rollbackDeps(false), { audit });
    expect((await rowOf(w)).currentGen).toBe(100);
    expect(rolled(events(audit)[0]!)).toMatchObject({ generation: 100, unknown: true });
  });

  it('a rollback-made oldest entry no lease names still holds the bound (the ruled limit)', async () => {
    const w = world(false);
    await publish(w, 140);
    await rollbackSegment(SEG, 5, w.rollbackDeps(false));
    await publish(w, 127); // [5, 140 ... 266]
    expect((await names(w))![0]).toBe(5);
    await expect(rollbackSegment(SEG, 100, w.rollbackDeps(false))).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it('leased extras ahead of the span: a generation the span left, numbered between them and it, is decided by the pointer alone', async () => {
    const w = world(false);
    await publish(w, 120);
    for (let g = 100; g < 120; g++) {
      const row = await rowOf(w);
      const taken = await takeLease(SEG, w.deps, {
        holder: g.toString(16).padStart(16, '0'),
        generation: g,
        until: T0 + 86_400_000,
        row,
        current: g === row.currentGen,
      });
      expect(taken).not.toBe('moved');
    }
    await publish(w, 180); // ledger: 100..119 leased extras, then 172..299
    const ledger = (await names(w))!;
    expect(ledger.length).toBe(148);
    expect(ledger[0]).toBe(100);
    // 150 is in the bucket, once current, forgotten when the span passed it: today's rule, key-less, audited unknown.
    const audit = new RecordingAuditSink();
    await rollbackSegment(SEG, 150, w.rollbackDeps(false), { audit });
    expect((await rowOf(w)).currentGen).toBe(150);
    expect(rolled(events(audit)[0]!)).toMatchObject({ generation: 150, unknown: true });
  });
});

describe('a ledger padded to 128 by leased extras, and an *Into ledger with the very same row', () => {
  const content = (g: number): number[] => [g % 50, 1000 + g];
  /** Publish 0..148, leasing 20..83 while each is current, at `keep` 64 (padded) or keeping every generation. */
  async function build(keep: number): Promise<World> {
    const w = world(false);
    for (let g = 0; g <= 148; g++) {
      await loadSegment(SEG, content(g), w.deps, { keep });
      if (g >= 20 && g <= 83) {
        const row = await rowOf(w);
        const taken = await takeLease(SEG, w.deps, {
          holder: g.toString(16).padStart(16, '0'),
          generation: g,
          until: T0 + 13 * 86_400_000,
          row,
          current: true,
        });
        expect(taken).not.toBe('moved');
      }
    }
    return w;
  }
  const shape = async (w: World) => {
    const r = await rowOf(w);
    return {
      known: r.knownGens,
      leases: r.leases?.map((l) => l.generation).sort((a, b) => a - b),
      current: r.currentGen,
    };
  };

  it('cannot be told apart by the row, so both are judged full: the *Into generation lands with no flag', async () => {
    const padded = await build(64);
    const into = await build(Number.MAX_SAFE_INTEGER);
    expect(await shape(padded)).toEqual(await shape(into));
    expect((await names(into))!.length).toBe(129);
    expect(await generationsOf(into.memory, SEG)).toContain(5); // once current, still in the bucket
    expect(await generationsOf(padded.memory, SEG)).not.toContain(5); // collected
    const audit = new RecordingAuditSink();
    await rollbackSegment(SEG, 5, into.rollbackDeps(false), { audit });
    expect(rolled(events(audit)[0]!)).toMatchObject({ generation: 5, unknown: true });
  });

  it('on the padded ledger, a stray below the bound is collected by the next periodic listing', async () => {
    const w = await build(64);
    await writeStray(w, 5, [7, 8, 9]); // in a freed number: no load writes there
    for (let g = 149; g <= 160; g++) await loadSegment(SEG, content(g), w.deps, { keep: 64 });
    expect(await generationsOf(w.memory, SEG)).not.toContain(5);
  });
});

describe('what the ledger no longer names after a smaller keep (needs allowUnknown)', () => {
  const KEEP_ALL = Number.MAX_SAFE_INTEGER;
  it('a generation a lease spared, which the ledger had forgotten while full', async () => {
    const w = world(false);
    for (let i = 0; i < 140; i++) await loadSegment(SEG, [i % 50], w.deps, { keep: KEEP_ALL });
    const row = await rowOf(w);
    await takeLease(SEG, w.deps, {
      holder: '00000000000000aa',
      generation: 5,
      until: T0 + 3_600_000,
      row,
      current: false,
    });
    await loadSegment(SEG, [7, 8], w.deps, { keep: 1 });
    expect(await names(w)).toEqual([139, 140]);
    expect(await generationsOf(w.memory, SEG)).toContain(5);
    await expect(rollbackSegment(SEG, 5, w.rollbackDeps(false))).rejects.toBeInstanceOf(
      ValidationError,
    );
    await rollbackSegment(SEG, 5, w.rollbackDeps(), { allowUnknown: true });
    expect((await rowOf(w)).currentGen).toBe(5);
  });

  it('a generation whose delete failed', async () => {
    const w = world(false);
    for (let i = 0; i < 140; i++) await loadSegment(SEG, [i % 50], w.deps, { keep: KEEP_ALL });
    const storage = Object.create(w.memory) as IStorageDriver;
    storage.delete = (key: GenKey, opts?: unknown) =>
      key.generation === 100
        ? Promise.reject(new Error('AccessDenied'))
        : (w.memory.delete as (k: GenKey, o?: unknown) => Promise<void>)(key, opts);
    await expect(loadSegment(SEG, [7, 8], { ...w.deps, storage }, { keep: 1 })).rejects.toThrow(
      'AccessDenied',
    );
    expect(await generationsOf(w.memory, SEG)).toContain(100);
    await expect(rollbackSegment(SEG, 100, w.rollbackDeps())).rejects.toBeInstanceOf(
      ValidationError,
    );
    await rollbackSegment(SEG, 100, w.rollbackDeps(), { allowUnknown: true });
  });
});

describe('every loop that deletes, against a rollback that checks the ledger', () => {
  it('a load’s eviction by name: the evicted generation is out of the ledger first, so a rollback onto it is refused', async () => {
    const w = world(false);
    await loadSegment(SEG, ids(3), w.deps, { keep: 1 });
    await loadSegment(SEG, ids(4), w.deps, { keep: 1 });
    // The load that numbers 2 evicts 0: it is out of the ledger in the publish, before it is deleted.
    await loadSegment(SEG, ids(5), w.deps, { keep: 1 });
    expect(await names(w)).toEqual([1, 2]);
    await expect(rollbackSegment(SEG, 0, w.rollbackDeps())).rejects.toBeInstanceOf(ValidationError);
  });

  it('a load’s listing pass (keep above 64) spares what the row knows: a rollback onto the oldest known generation still lands', async () => {
    const w = world(false);
    // keep 70 collects by listing; the ledger names the 70 generations it vouches for.
    for (let n = 0; n < 80; n++) await loadSegment(SEG, [n % 40], w.deps, { keep: 70 });
    const known = (await names(w))!;
    expect(known).toHaveLength(71);
    const present: number[] = [];
    for await (const k of w.memory.list(SEG)) present.push(k.generation);
    for (const g of known) expect(present).toContain(g);
    await rollbackSegment(SEG, known[0]!, w.rollbackDeps());
    expect((await rowOf(w)).currentGen).toBe(known[0]);
  });

  it('an erasure’s rewrite leaves the ledger holding the rewrite alone, so every older generation is refused', async () => {
    const w = world(false);
    for (const content of [
      [1, 2, 3],
      [1, 2, 3, 4],
      [1, 2, 3, 4, 5],
    ])
      await loadSegment(SEG, content, w.deps, { keep: 9 });
    const erased = await eraseIdFromSegment(SEG, 4, w.deps);
    expect(erased).toMatchObject({ erased: true });
    expect((await names(w))!).toEqual([erased.erased ? erased.generation : -1]);
    for (const g of [0, 1, 2]) {
      await expect(rollbackSegment(SEG, g, w.rollbackDeps())).rejects.toBeInstanceOf(
        ValidationError,
      );
    }
  });
});

describe('generations() says which targets need no flag', () => {
  it('marks each generation the row knows, the current one included, and none on a row with no ledger or none at all', async () => {
    const w = world(false);
    expect(await listGenerations(SEG, w.deps)).toEqual([]);
    await loads(w, 3, 2);
    await writeStray(w, 7, [1]);
    await rollbackSegment(SEG, 1, w.rollbackDeps());
    const listed = await listGenerations(SEG, w.deps);
    expect(listed.map((e) => [e.generation, e.current, e.known])).toEqual([
      [0, false, true],
      [1, true, true],
      [2, false, true],
      [7, false, false],
    ]);
    await w.registry.compareAndSwap(SEG, (await rowOf(w)).token, { knownGens: undefined });
    expect((await listGenerations(SEG, w.deps)).map((e) => e.known)).toEqual([
      false,
      false,
      false,
      false,
    ]);
  });
});

// The ledger a rollback writes is in recency order and carries its entries' checksums.
describe('the ledger a checked rollback writes', () => {
  it('moves the target to the end with its recorded checksum and keeps every other entry as it was', async () => {
    const w = world(false);
    await loads(w, 4);
    const before = (await rowOf(w)).knownGens as readonly KnownGeneration[];
    await rollbackSegment(SEG, 1, w.rollbackDeps());
    const after = (await rowOf(w)).knownGens!;
    expect(after.map((e) => e.generation)).toEqual([0, 2, 3, 1]);
    for (const e of after)
      expect(e.footerCrc).toBe(before.find((b) => b.generation === e.generation)!.footerCrc);
  });
});

describe('the move is on the record once the swap has landed', () => {
  it.each([
    ['a known target', false],
    ['an override', true],
  ])(
    '%s: a fault of the footer read after the swap is thrown after the event is emitted',
    async (_label, override) => {
      const w = world(false);
      await loads(w, 3);
      if (override) await writeStray(w, 7, [4, 5]);
      const target = override ? 7 : 0;
      let tails = 0;
      const storage = Object.create(w.memory) as IStorageDriver;
      storage.getTail = (key, maxBytes) => {
        if (key.generation === target && ++tails > 1) {
          return Promise.reject(new TransientError('the read after the swap was throttled'));
        }
        return w.memory.getTail(key, maxBytes);
      };
      const audit = new RecordingAuditSink();
      await expect(
        rollbackSegment(
          SEG,
          target,
          { ...w.rollbackDeps(), storage },
          { audit, allowUnknown: override },
        ),
      ).rejects.toBeInstanceOf(TransientError);
      // The swap landed, so the pointer is on the target and the move is recorded.
      expect((await rowOf(w)).currentGen).toBe(target);
      expect(events(audit)).toHaveLength(1);
      expect(rolled(events(audit)[0]!)).toMatchObject({ generation: target });
      expect(Object.hasOwn(events(audit)[0]!, 'unknown')).toBe(override);
    },
  );

  it('a refusal emits no event', async () => {
    const w = world(false);
    await loads(w, 3, 0);
    await writeStray(w, 7, [4]);
    const audit = new RecordingAuditSink();
    await expect(rollbackSegment(SEG, 7, w.rollbackDeps(), { audit })).rejects.toBeInstanceOf(
      ValidationError,
    );
    await swap(w, 2);
    await expect(rollbackSegment(SEG, 2, w.rollbackDeps(), { audit })).rejects.toBeInstanceOf(
      IntegrityError,
    );
    expect(events(audit)).toEqual([]);
  });
});

describe('what the checksum covers', () => {
  it('a current footer that fails its own checks is an IntegrityError for the no-op, on a row with a ledger and on one without', async () => {
    for (const dropLedger of [false, true]) {
      const w = world(false);
      await loads(w, 2);
      const bytes = (await w.memory.getTail({ ...SEG, generation: 1 }, 1 << 20)).bytes.slice();
      bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 0xff;
      await w.memory.delete({ ...SEG, generation: 1 });
      await w.memory.putImmutable({ ...SEG, generation: 1 }, (sink) => sink.write(bytes));
      if (dropLedger) {
        await w.registry.compareAndSwap(SEG, (await rowOf(w)).token, { knownGens: undefined });
      }
      await expect(rollbackSegment(SEG, 1, w.rollbackDeps())).rejects.toBeInstanceOf(
        IntegrityError,
      );
    }
  });

  it('a cleartext object put back with the same ids and other metadata of the same length has the same checksum: it is not seen', async () => {
    const w = world(false);
    for (const n of [3, 4, 5]) {
      await loadSegment(SEG, ids(n), w.deps, { keep: 9, metadata: { run: 'a' } });
    }
    await w.memory.delete({ ...SEG, generation: 0 });
    await writeStray(w, 0, ids(3), { run: 'b' });
    const audit = new RecordingAuditSink();
    await rollbackSegment(SEG, 0, w.rollbackDeps(), { audit });
    expect((await rowOf(w)).currentGen).toBe(0);
    expect((await rowOf(w)).summary).toMatchObject({ metadata: { run: 'b' } });
    expect(events(audit)[0]).not.toHaveProperty('unknown');
  });
});

describe('the fallbacks move onto an object sealed under a key no row holds, key-less', () => {
  it('on a row with no usable ledger, below the pointer', async () => {
    const w = world(true);
    await loads(w, 3, 0);
    await writeForeign(w, 1, [8]);
    await w.registry.compareAndSwap(SEG, (await rowOf(w)).token, { knownGens: undefined });
    const audit = new RecordingAuditSink();
    await rollbackSegment(SEG, 1, w.rollbackDeps(false), { audit });
    expect((await rowOf(w)).currentGen).toBe(1);
    expect(rolled(events(audit)[0]!)).toMatchObject({ generation: 1, unknown: true });
  });

  it('below a full ledger', async () => {
    const w = world(true);
    for (let i = 0; i < 140; i++) {
      await loadSegment(SEG, [i % 50], w.deps, { keep: Number.MAX_SAFE_INTEGER });
    }
    expect((await names(w))![0]).toBe(12);
    await w.memory.delete({ ...SEG, generation: 5 });
    await writeForeign(w, 5, [8]);
    const audit = new RecordingAuditSink();
    await rollbackSegment(SEG, 5, w.rollbackDeps(false), { audit });
    expect((await rowOf(w)).currentGen).toBe(5);
    expect(rolled(events(audit)[0]!)).toMatchObject({ generation: 5, unknown: true });
  });
});

describe('generations() reads the validated ledger', () => {
  it('a ledger that disagrees with its row names nothing: no generation is known', async () => {
    const w = world(false);
    await loads(w, 3);
    const row = await rowOf(w);
    const registry = Object.create(w.registry) as MemoryRegistryDriver;
    registry.get = async (ref) => {
      const got = await w.registry.get(ref);
      return got === null ? null : { ...got, knownGens: row.knownGens!.slice(0, -1) };
    };
    const listed = await listGenerations(SEG, { ...w.rollbackDeps(), registry });
    expect(listed.map((e) => e.known)).toEqual([false, false, false]);
  });
});

describe('request counts, an encrypted target and one above the pointer', () => {
  /** Requests a rollback makes to storage, the registry and the keystore, counted together. */
  async function requests(w: World, target: number, withKey = true): Promise<number> {
    let n = 0;
    const storage = Object.create(w.memory) as IStorageDriver;
    storage.getTail = (key, max) => {
      n += 1;
      return w.memory.getTail(key, max);
    };
    storage.getRange = (key, offset, length) => {
      n += 1;
      return w.memory.getRange(key, offset, length);
    };
    storage.list = (ref) => {
      n += 1;
      return w.memory.list(ref);
    };
    const registry = Object.create(w.registry) as MemoryRegistryDriver;
    registry.get = (ref) => {
      n += 1;
      return w.registry.get(ref);
    };
    registry.compareAndSwap = (ref, token, patch) => {
      n += 1;
      return w.registry.compareAndSwap(ref, token, patch);
    };
    const opened = w.keystore?.opened() ?? 0;
    await rollbackSegment(SEG, target, { ...w.rollbackDeps(withKey), storage, registry });
    return n + ((w.keystore?.opened() ?? 0) - opened);
  }

  it('a known encrypted target below the pointer is 5 (the keystore call included), and one above the pointer is 4 with no key', async () => {
    const w = world(true);
    await loads(w, 3);
    expect(await requests(w, 0)).toBe(5); // row, keystore, tail, swap, footer
    const keyless = world(true);
    await loads(keyless, 3);
    await rollbackSegment(SEG, 0, keyless.rollbackDeps(false));
    expect(await requests(keyless, 2, false)).toBe(4); // row, tail, swap, footer: no key call
  });

  it('a known cleartext target above the pointer is 4', async () => {
    const w = world(false);
    await loads(w, 3);
    await rollbackSegment(SEG, 0, w.rollbackDeps());
    expect(await requests(w, 2)).toBe(4);
  });
});
