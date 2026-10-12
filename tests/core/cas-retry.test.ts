import { casRetry } from '@/core/cas-retry';
import { LEASE_ONLY_RETRIES } from '@/core/leases';
import { WriteConflictError } from '@/core/errors';
import type { LeaseEntry, RegistryRecord, SegmentRef } from '@/core/ports';
import type { Clock } from '@/core/determinism';
import { MemoryRegistryDriver } from '@/drivers/memory';
import { MIN_EXPIRES_AT_MS } from '@/index';

/**
 * `casRetry` reads a row, runs a step, and runs it again on a fresh read when the step loses a write race. A race lost to
 * a write that changed only the row's leases is waited out and costs no attempt; any other lost race costs one.
 */

const SEG: SegmentRef = { namespace: 'ns', segment: 's' };
const T0 = MIN_EXPIRES_AT_MS * 2;
const FAR = T0 * 2;

async function world() {
  const sleeps: number[] = [];
  const clock: Clock = {
    now: () => T0,
    sleep: (ms: number) => (sleeps.push(ms), Promise.resolve()),
  };
  const registry = new MemoryRegistryDriver({ now: () => T0 });
  await registry.create(SEG, { currentGen: 1 });
  let gets = 0;
  const counted = new Proxy(registry, {
    get(t, p, rx) {
      const v: unknown = Reflect.get(t, p, rx);
      if (typeof v !== 'function') return v;
      const fn = (v as (...a: unknown[]) => unknown).bind(t);
      if (p !== 'get') return fn;
      return (...a: unknown[]) => (gets++, fn(...a));
    },
  });
  return { registry: counted, clock, sleeps, gets: () => gets };
}
type W = Awaited<ReturnType<typeof world>>;

/** One write of the row that changes only its leases. */
async function leaseWrite(w: W): Promise<void> {
  const row = (await w.registry.get(SEG))!;
  const entry: LeaseEntry = { holder: '0'.repeat(16), generation: 1, until: FAR };
  await w.registry.compareAndSwap(SEG, row.token, {
    leases: row.leases === undefined ? [entry] : undefined,
  });
}

/** A lease write, then the conflict the stale writer would see. */
async function leaseConflict(w: W): Promise<never> {
  await leaseWrite(w);
  throw new WriteConflictError('lost to a lease write');
}

/** A write of the row that changes something else, then the conflict the stale writer would see. */
async function otherConflict(w: W, nth: number): Promise<never> {
  const row = (await w.registry.get(SEG))!;
  await w.registry.compareAndSwap(SEG, row.token, { retention: { expiresAt: FAR + nth } });
  throw new WriteConflictError('lost to a policy write');
}

const contention = () => new WriteConflictError('op: contention on "s"');

describe('casRetry', () => {
  it('gives the step the row it read and returns what the step returns', async () => {
    const w = await world();
    const seen: Array<RegistryRecord | null> = [];
    const out = await casRetry(
      { registry: w.registry, clock: w.clock },
      SEG,
      { attempts: 3, contention },
      (row) => {
        seen.push(row);
        return Promise.resolve('done');
      },
    );
    expect(out).toBe('done');
    expect(seen).toHaveLength(1);
    expect(seen[0]?.segment).toBe('s');
    expect(w.gets()).toBe(1);
  });

  it('runs the step exactly `attempts` times when every one loses to a write that is not a lease write', async () => {
    for (const attempts of [1, 3, 8]) {
      const w = await world();
      let calls = 0;
      await expect(
        casRetry({ registry: w.registry, clock: w.clock }, SEG, { attempts, contention }, () =>
          otherConflict(w, calls++),
        ),
      ).rejects.toThrow(WriteConflictError);
      expect(calls).toBe(attempts);
      expect(w.gets()).toBe(attempts * 2); // the loop's read and the step's own read, once per attempt
      expect(w.sleeps).toEqual([]);
    }
  });

  it('throws the error the caller built, with its own message', async () => {
    const w = await world();
    const err = await casRetry(
      { registry: w.registry, clock: w.clock },
      SEG,
      { attempts: 2, contention: () => new WriteConflictError('setRetention: contention on "s"') },
      (): Promise<never> => otherConflict(w, 0),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WriteConflictError);
    expect((err as Error).message).toBe('setRetention: contention on "s"');
  });

  it('retries a lost race against a fresh read of the row', async () => {
    const w = await world();
    const tokens: string[] = [];
    let calls = 0;
    const out = await casRetry(
      { registry: w.registry, clock: w.clock },
      SEG,
      { attempts: 2, contention },
      async (row) => {
        tokens.push(row!.token);
        if (calls++ === 0) await otherConflict(w, 0);
        return 'won';
      },
    );
    expect(out).toBe('won');
    expect(tokens).toHaveLength(2);
    expect(tokens[1]).not.toBe(tokens[0]);
    expect(w.sleeps).toEqual([]);
  });

  it('does not retry an error that is not a write conflict', async () => {
    const w = await world();
    let calls = 0;
    await expect(
      casRetry({ registry: w.registry, clock: w.clock }, SEG, { attempts: 5, contention }, () => {
        calls++;
        return Promise.reject(new Error('boom'));
      }),
    ).rejects.toThrow('boom');
    expect(calls).toBe(1);
  });

  it('waits out a lost race to a lease write without spending an attempt', async () => {
    const w = await world();
    let calls = 0;
    const out = await casRetry(
      { registry: w.registry, clock: w.clock },
      SEG,
      { attempts: 2, contention },
      async () => {
        if (calls++ < 4) await leaseConflict(w);
        return 'won';
      },
    );
    expect(out).toBe('won');
    expect(calls).toBe(5); // the first loss spent one of two attempts; the next four runs were waited out
    expect(w.sleeps).toHaveLength(4);
  });

  it('hands the step the row read after a wait, not the one read before it', async () => {
    const w = await world();
    const row0 = (await w.registry.get(SEG))!;
    // A write that lands while the loop sleeps.
    const clock: Clock = {
      now: () => T0,
      sleep: () => leaseWrite(w),
    };
    const tokens: string[] = [];
    let calls = 0;
    await casRetry(
      { registry: w.registry, clock },
      SEG,
      { attempts: 3, contention },
      async (row) => {
        tokens.push(row!.token);
        if (calls++ === 0) await leaseConflict(w);
      },
    );
    const latest = (await w.registry.get(SEG))!.token;
    expect(tokens).toHaveLength(2);
    expect(tokens[0]).toBe(row0.token);
    expect(tokens[1]).toBe(latest);
  });

  it('spends an attempt on a lost race that is not a lease write, after lease writes were waited out', async () => {
    const w = await world();
    let calls = 0;
    await expect(
      casRetry({ registry: w.registry, clock: w.clock }, SEG, { attempts: 2, contention }, () =>
        calls++ === 0 ? leaseConflict(w) : otherConflict(w, calls),
      ),
    ).rejects.toThrow('contention');
    // lease loss (1 attempt), waited out and lost to a policy write (not spent), then a policy loss (2nd attempt)
    expect(calls).toBe(3);
    expect(w.sleeps).toHaveLength(1);
  });

  it('stops waiting at the churn bound and then spends attempts', async () => {
    const w = await world();
    let calls = 0;
    await expect(
      casRetry({ registry: w.registry, clock: w.clock }, SEG, { attempts: 2, contention }, () => {
        calls++;
        return leaseConflict(w);
      }),
    ).rejects.toThrow('contention');
    expect(w.sleeps).toHaveLength(LEASE_ONLY_RETRIES);
    expect(calls).toBe(LEASE_ONLY_RETRIES + 2);
  });
});
