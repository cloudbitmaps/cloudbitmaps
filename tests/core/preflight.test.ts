import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { CloudRoaring, LocalFsStorage, MemoryStorage, UnsupportedError } from '@/index';
import {
  LIFECYCLE_TICK_MS,
  LIFECYCLE_TIMEOUT_MS,
  PREFLIGHT_NAMESPACE,
  runPreflight,
} from '@/core/preflight';
import type { PreflightDeps, PreflightResult } from '@/core/preflight';
import { NotFoundError, TransientError } from '@/core/errors';
import { brandAsBackend } from '@/core/ports';
import type {
  GenKey,
  IRegistryDriver,
  IStorageDriver,
  LifecycleVerdict,
  StorageDeleteOptions,
  TailRead,
} from '@/core/ports';
import { SystemClock } from '@/system-clock';

/**
 * `store.preflight()` over the two backends with no cloud, and `runPreflight` with a fault put at each step. The
 * drivers under test are the real memory and local-file ones, wrapped so one call can be made to fail or lie.
 */

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

const NAMES = ['registry', 'write', 'write-once', 'read', 'list', 'delete', 'lifecycle'];
const statuses = (r: PreflightResult): Record<string, string> =>
  Object.fromEntries(r.checks.map((c) => [c.name, c.status]));
const detail = (r: PreflightResult, name: string): string =>
  r.checks.find((c) => c.name === name)?.detail ?? '';

/** A driver with some members replaced, the rest delegating to the real one. */
function over<T extends object>(base: T, replace: Partial<T>): T {
  return new Proxy(base, {
    get(target, prop, receiver) {
      if (prop in replace) return Reflect.get(replace, prop, receiver) as unknown;
      const value: unknown = Reflect.get(target, prop, target);
      return typeof value === 'function'
        ? (value as (...a: unknown[]) => unknown).bind(target)
        : value;
    },
  });
}

/** An entropy source whose six bytes read as `generation`, big-endian. */
const fixedEntropy =
  (generation: number) =>
  (length: number): Uint8Array => {
    const out = new Uint8Array(length);
    let v = generation;
    for (let i = 5; i >= 0; i--) {
      out[i] = v % 256;
      v = Math.floor(v / 256);
    }
    return out;
  };

const instantClock = {
  now: () => 0,
  sleep: () => Promise.resolve(),
};

/** Deps over a fresh memory backend, with the probe's number fixed by a counting entropy source. */
function rig(
  replace: {
    storage?: Partial<IStorageDriver>;
    registry?: Partial<IRegistryDriver>;
    checkLifecycle?: (() => Promise<LifecycleVerdict>) | undefined;
    clock?: PreflightDeps['clock'];
  } = {},
) {
  const memory = new MemoryStorage();
  const calls: string[] = [];
  const deletes: Array<{ key: GenKey; options: StorageDeleteOptions | undefined }> = [];
  const storage = over(memory.storage, {
    delete: (key: GenKey, options?: StorageDeleteOptions) => {
      deletes.push({ key, options });
      return memory.storage.delete(key, options);
    },
    ...replace.storage,
  });
  const registry = over(memory.registry, {
    get: (ref) => {
      calls.push('registry.get');
      return memory.registry.get(ref);
    },
    ...replace.registry,
  });
  const deps: PreflightDeps = {
    storage,
    registry,
    clock: replace.clock ?? instantClock,
    entropy: fixedEntropy(1),
    checkLifecycle:
      'checkLifecycle' in replace
        ? replace.checkLifecycle
        : () => Promise.resolve({ status: 'ok', detail: 'fine' }),
  };
  const ours = (): GenKey => ({ namespace: PREFLIGHT_NAMESPACE, segment: 'probe', generation: 1 });
  const present = async (): Promise<number[]> => {
    const out: number[] = [];
    for await (const k of memory.storage.list({ namespace: PREFLIGHT_NAMESPACE, segment: 'probe' }))
      out.push(k.generation);
    return out;
  };
  return { memory, storage, registry, deps, calls, deletes, ours, present };
}

describe('store.preflight on the backends with no cloud', () => {
  it('reports all seven checks ok on MemoryStorage, in order, and leaves nothing behind', async () => {
    const memory = new MemoryStorage();
    const store = new CloudRoaring({ storage: memory });
    const out = await store.preflight();
    expect(out.ok).toBe(true);
    expect(out.checks.map((c) => c.name)).toEqual(NAMES);
    expect(out.checks.map((c) => c.status)).toEqual(Array(7).fill('ok'));
    expect(out.checks.every((c) => c.detail.length > 0)).toBe(true);
    const left: unknown[] = [];
    for await (const k of memory.storage.list({ namespace: PREFLIGHT_NAMESPACE, segment: 'probe' }))
      left.push(k);
    expect(left).toEqual([]);
    const rows: unknown[] = [];
    for await (const row of memory.registry.list()) rows.push(row);
    expect(rows).toEqual([]);
  });

  it('reports all seven ok on LocalFsStorage, which really writes to disk, and leaves no file', async () => {
    const root = mkdtempSync(join(tmpdir(), 'preflight-'));
    roots.push(root);
    const store = new CloudRoaring({ storage: new LocalFsStorage(root) });
    const out = await store.preflight();
    expect(out.checks.map((c) => `${c.name}:${c.status}`)).toEqual(NAMES.map((n) => `${n}:ok`));
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const p = join(dir, entry);
        if (statSync(p).isDirectory()) walk(p);
        else files.push(p);
      }
    };
    walk(root);
    expect(files).toEqual([]);
  });

  it('lists the lifecycle check as ok for these two, with the backend text', async () => {
    const out = await new CloudRoaring({ storage: new MemoryStorage() }).preflight();
    expect(detail(out, 'lifecycle')).toContain('MemoryStorage');
  });

  it('writes no registry row and reads the registry once', async () => {
    const memory = new MemoryStorage();
    const seen: Record<string, number> = {};
    const registry = new Proxy(memory.registry, {
      get(t, p) {
        const v: unknown = Reflect.get(t, p, t);
        if (typeof v !== 'function') return v;
        return (...a: unknown[]) => {
          seen[String(p)] = (seen[String(p)] ?? 0) + 1;
          return (v as (...x: unknown[]) => unknown).apply(t, a);
        };
      },
    });
    const backend = brandAsBackend({ storage: memory.storage, registry });
    await new CloudRoaring({ storage: backend }).preflight();
    expect(seen.get).toBe(1);
    for (const writer of ['create', 'compareAndSwap', 'delete'])
      expect(seen[writer]).toBeUndefined();
  });

  it('two runs at once both pass and leave nothing', async () => {
    const memory = new MemoryStorage();
    const store = new CloudRoaring({ storage: memory });
    const [a, b] = await Promise.all([store.preflight(), store.preflight()]);
    expect(a.ok && b.ok).toBe(true);
    const left: unknown[] = [];
    for await (const k of memory.storage.list({ namespace: PREFLIGHT_NAMESPACE, segment: 'probe' }))
      left.push(k);
    expect(left).toEqual([]);
  });

  it('throws UnsupportedError for a store with no backend, and only then', async () => {
    const memory = new MemoryStorage();
    const bare = new CloudRoaring({ storage: memory.storage });
    await expect(bare.preflight()).rejects.toBeInstanceOf(UnsupportedError);
    await expect(bare.preflight()).rejects.toThrow(/preflight needs/);
    const source = { getChunk: () => Promise.resolve(null) } as never;
    await expect(new CloudRoaring({ storage: source }).preflight()).rejects.toBeInstanceOf(
      UnsupportedError,
    );
  });

  it('is unchecked for the lifecycle on a backend that does not forward the check', async () => {
    const memory = new MemoryStorage();
    const wrapped = brandAsBackend({ storage: memory.storage, registry: memory.registry });
    const out = await new CloudRoaring({ storage: wrapped }).preflight();
    expect(out.ok).toBe(true);
    expect(statuses(out).lifecycle).toBe('unchecked');
    expect(detail(out, 'lifecycle')).toContain('does not offer the lifecycle check');
  });

  it('passes a backend that forwards the check its own verdict, called on the backend', async () => {
    const memory = new MemoryStorage();
    const wrapped = brandAsBackend({
      storage: memory.storage,
      registry: memory.registry,
      checkLifecycle(this: unknown) {
        return Promise.resolve({
          status: 'problem' as const,
          detail: this === wrapped ? 'a rule deletes it' : 'wrong this',
        });
      },
    });
    const out = await new CloudRoaring({ storage: wrapped }).preflight();
    expect(out.ok).toBe(false);
    expect(statuses(out).lifecycle).toBe('problem');
    expect(detail(out, 'lifecycle')).toBe('a rule deletes it');
  });
});

describe('runPreflight: a fault at each step is a finding, never a throw', () => {
  it('registry: a failed read is a problem, and the storage steps still run', async () => {
    const r = rig({ registry: { get: () => Promise.reject(new Error('denied')) } });
    const out = await runPreflight(r.deps);
    expect(out.ok).toBe(false);
    expect(statuses(out)).toEqual({
      registry: 'problem',
      write: 'ok',
      'write-once': 'ok',
      read: 'ok',
      list: 'ok',
      delete: 'ok',
      lifecycle: 'ok',
    });
    expect(detail(out, 'registry')).toContain('Error: denied');
    expect(await r.present()).toEqual([]);
  });

  it('registry: a transient fault says to run again', async () => {
    const r = rig({
      registry: { get: () => Promise.reject(new TransientError('throttled')) },
    });
    expect(detail(await runPreflight(r.deps), 'registry')).toContain('run preflight() again');
  });

  it('registry: a row at the probe address is a problem', async () => {
    const r = rig();
    await r.memory.registry.create(
      { namespace: PREFLIGHT_NAMESPACE, segment: 'probe' },
      { currentGen: 1 },
    );
    const out = await runPreflight(r.deps);
    expect(statuses(out).registry).toBe('problem');
    expect(detail(out, 'registry')).toContain(`${PREFLIGHT_NAMESPACE}/probe`);
  });

  it('registry: a registry that cannot write is a problem', async () => {
    const r = rig({ registry: { capabilities: () => ({ strongRead: true, canWrite: false }) } });
    const out = await runPreflight(r.deps);
    expect(statuses(out).registry).toBe('problem');
    expect(detail(out, 'registry')).toContain('cannot write');
  });

  it('write: a failure makes the four checks that need the object unchecked, and the lifecycle still runs', async () => {
    const r = rig({ storage: { putImmutable: () => Promise.reject(new Error('AccessDenied')) } });
    const out = await runPreflight(r.deps);
    expect(statuses(out)).toEqual({
      registry: 'ok',
      write: 'problem',
      'write-once': 'unchecked',
      read: 'unchecked',
      list: 'unchecked',
      delete: 'unchecked',
      lifecycle: 'ok',
    });
    expect(detail(out, 'write')).toContain('AccessDenied');
    // A write that failed may still have landed, so the run asked for the key to be removed.
    expect(r.deletes).toHaveLength(1);
  });

  it('write: a transient fault says to run again', async () => {
    const r = rig({ storage: { putImmutable: () => Promise.reject(new TransientError('503')) } });
    const out = await runPreflight(r.deps);
    expect(detail(out, 'write')).toContain('transient fault: run preflight() again');
  });

  it('write: a failed write whose cleanup also fails names the object in the write detail', async () => {
    const r = rig({
      storage: {
        putImmutable: () => Promise.reject(new Error('reset')),
        delete: () => Promise.reject(new Error('also down')),
      },
    });
    const out = await runPreflight(r.deps);
    expect(statuses(out).delete).toBe('unchecked');
    expect(detail(out, 'write')).toContain('probe.1.crbm');
  });

  it("write: a refused first write is not this run's object, so nothing is deleted", async () => {
    const r = rig();
    await r.memory.storage.putImmutable(r.ours(), async (s) => s.write(new Uint8Array([9])));
    const out = await runPreflight(r.deps);
    expect(statuses(out).write).toBe('problem');
    expect(detail(out, 'write')).toContain('Run preflight() again');
    expect(statuses(out).delete).toBe('unchecked');
    expect(r.deletes).toEqual([]);
    expect(await r.present()).toEqual([1]);
  });

  it('write-once: a second write that succeeds is a problem, and the cleanup still removes the object', async () => {
    const memory = new MemoryStorage();
    const real = memory.storage;
    const store = new Map<string, Uint8Array>();
    const overwrite: IStorageDriver = over(real, {
      putImmutable: async (key, write) => {
        let bytes = new Uint8Array();
        await write({
          write: (b) => {
            bytes = b.slice();
            return Promise.resolve();
          },
        });
        store.set(String(key.generation), bytes);
        return { size: bytes.length, sha256: 'x' };
      },
      getTail: (key) =>
        Promise.resolve({
          bytes: store.get(String(key.generation)) ?? new Uint8Array(),
          size: store.get(String(key.generation))?.length ?? 0,
        } as TailRead),
      list: async function* (ref) {
        for (const g of store.keys()) yield { ...ref, generation: Number(g) };
      },
      delete: () => {
        store.clear();
        return Promise.resolve();
      },
    });
    const out = await runPreflight({
      storage: overwrite,
      registry: memory.registry,
      clock: instantClock,
      entropy: fixedEntropy(1),
    });
    expect(statuses(out)['write-once']).toBe('problem');
    expect(detail(out, 'write-once')).toContain('succeeded');
    // What the object holds is read against the bytes the store accepted last, so the read is not a second finding.
    expect(statuses(out).read).toBe('ok');
    expect(statuses(out).delete).toBe('ok');
    expect(store.size).toBe(0);
    expect(out.ok).toBe(false);
  });

  it('write-once: another error from the second write is a problem that says it is not known', async () => {
    let n = 0;
    const r = rig();
    const storage = over(r.memory.storage, {
      putImmutable: (key, write) => {
        n += 1;
        return n === 1
          ? r.memory.storage.putImmutable(key, write)
          : Promise.reject(new Error('socket hang up'));
      },
    });
    const out = await runPreflight({ ...r.deps, storage });
    expect(statuses(out)['write-once']).toBe('problem');
    expect(detail(out, 'write-once')).toContain('not known');
  });

  it('read: a missing object right after the write is a problem; the listing and the cleanup still run', async () => {
    const r = rig({ storage: { getTail: () => Promise.reject(new NotFoundError('gone')) } });
    const out = await runPreflight(r.deps);
    expect(statuses(out)).toMatchObject({ read: 'problem', list: 'ok', delete: 'ok' });
    expect(detail(out, 'read')).toContain('NotFoundError');
    expect(await r.present()).toEqual([]);
  });

  it('read: other bytes, or another size, are a problem', async () => {
    for (const reply of [
      { bytes: new Uint8Array([1, 2, 3]), size: 3 },
      { bytes: new Uint8Array(0), size: 0 },
    ]) {
      const r = rig({ storage: { getTail: () => Promise.resolve(reply) } });
      const out = await runPreflight(r.deps);
      expect(statuses(out).read).toBe('problem');
      expect(detail(out, 'read')).toContain('did not read back');
    }
  });

  it('read: the right bytes under the wrong size are a problem', async () => {
    const r = rig();
    const real = r.memory.storage;
    const storage = over(real, {
      getTail: async (k, n) => ({ ...(await real.getTail(k, n)), size: 999 }),
    });
    expect(statuses(await runPreflight({ ...r.deps, storage })).read).toBe('problem');
  });

  it('list: a listing that does not name the probe is a problem', async () => {
    const r = rig({ storage: { list: async function* () {} } });
    const out = await runPreflight(r.deps);
    expect(statuses(out).list).toBe('problem');
    expect(detail(out, 'list')).toContain('did not name');
    expect(await r.present()).toEqual([]);
  });

  it('list: a failing listing is a problem and the object is still removed', async () => {
    const r = rig({
      storage: {
        list: () => ({
          [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(new Error('List denied')) }),
        }),
      },
    });
    const out = await runPreflight(r.deps);
    expect(statuses(out).list).toBe('problem');
    expect(detail(out, 'list')).toContain('List denied');
    expect(statuses(out).delete).toBe('ok');
    expect(await r.present()).toEqual([]);
  });

  it('list: leftovers of other runs are named, up to three, and never deleted', async () => {
    const r = rig();
    for (const g of [11, 12, 13, 14, 15])
      await r.memory.storage.putImmutable(
        { namespace: PREFLIGHT_NAMESPACE, segment: 'probe', generation: g },
        async (s) => s.write(new Uint8Array([1])),
      );
    const out = await runPreflight(r.deps);
    expect(statuses(out).list).toBe('ok');
    expect(detail(out, 'list')).toContain('5 other probe objects (generation 11, 12, 13, ...)');
    expect(detail(out, 'list')).toContain('left alone');
    expect(await r.present()).toEqual([11, 12, 13, 14, 15]);
    expect(r.deletes.map((d) => d.key.generation)).toEqual([1]);
  });

  it('list: one leftover reads in the singular', async () => {
    const r = rig();
    await r.memory.storage.putImmutable(
      { namespace: PREFLIGHT_NAMESPACE, segment: 'probe', generation: 77 },
      async (s) => s.write(new Uint8Array([1])),
    );
    const out = await runPreflight(r.deps);
    expect(detail(out, 'list')).toContain(
      '1 other probe object (generation 77) was left alone: it may be',
    );
  });

  it('delete: passes the version the tail read gave, and deletes only its own key', async () => {
    const r = rig();
    const real = r.memory.storage;
    const storage = over(real, {
      getTail: async (k, n) => ({ ...(await real.getTail(k, n)), version: 'v-7' }),
      delete: (key: GenKey, options?: StorageDeleteOptions) => {
        r.deletes.push({ key, options });
        return real.delete(key, options);
      },
    });
    await runPreflight({ ...r.deps, storage });
    expect(r.deletes).toEqual([
      {
        key: { namespace: PREFLIGHT_NAMESPACE, segment: 'probe', generation: 1 },
        options: { ifVersion: 'v-7' },
      },
    ]);
  });

  it('delete: with no version from the read, the delete is unconditional', async () => {
    const r = rig();
    const real = r.memory.storage;
    const storage = over(real, {
      getTail: async (k, n) => ({ bytes: (await real.getTail(k, n)).bytes, size: 30 }),
      delete: (key: GenKey, options?: StorageDeleteOptions) => {
        r.deletes.push({ key, options });
        return real.delete(key, options);
      },
    });
    await runPreflight({ ...r.deps, storage });
    expect(r.deletes).toHaveLength(1);
    expect(r.deletes[0]?.options).toBeUndefined();
  });

  it('delete: a failure is a problem that names the object, and the other checks keep their answers', async () => {
    const r = rig({ storage: { delete: () => Promise.reject(new Error('DeleteDenied')) } });
    const out = await runPreflight(r.deps);
    expect(out.ok).toBe(false);
    expect(statuses(out)).toMatchObject({
      write: 'ok',
      'write-once': 'ok',
      read: 'ok',
      list: 'ok',
      delete: 'problem',
    });
    expect(detail(out, 'delete')).toContain('DeleteDenied');
    expect(detail(out, 'delete')).toContain(`${PREFLIGHT_NAMESPACE}/segments/probe.1.crbm`);
    expect(detail(out, 'delete')).toContain('delete it by hand');
    expect(await r.present()).toEqual([1]);
  });

  it('a step whose error has a hostile getter still does not escape', async () => {
    const hostile = {
      get name(): string {
        throw new Error('boom');
      },
    };
    const r = rig({ storage: { putImmutable: () => Promise.reject(hostile) } });
    const out = await runPreflight(r.deps);
    expect(statuses(out).write).toBe('problem');
    const plain = rig({ storage: { putImmutable: () => Promise.reject('just text') } });
    expect(detail(await runPreflight(plain.deps), 'write')).toContain('just text');
  });

  it('an error message is cut at 300 characters', async () => {
    const r = rig({ storage: { putImmutable: () => Promise.reject(new Error('x'.repeat(5000))) } });
    const text = detail(await runPreflight(r.deps), 'write');
    expect(text).toContain('x'.repeat(300));
    expect(text).not.toContain('x'.repeat(301));
  });

  it('the probe number is 48 bits drawn from the entropy source', async () => {
    const r = rig();
    const gens: number[] = [];
    const storage = over(r.memory.storage, {
      putImmutable: (key, write) => {
        gens.push(key.generation);
        return r.memory.storage.putImmutable(key, write);
      },
    });
    await runPreflight({
      ...r.deps,
      storage,
      entropy: () => new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff, 0xff]),
    });
    expect(gens[0]).toBe(2 ** 48 - 1);
    await expect(
      runPreflight({ ...r.deps, entropy: () => new Uint8Array(2) }),
    ).rejects.toBeInstanceOf(TypeError);
  });
});

describe('runPreflight: the lifecycle step', () => {
  it('passes a verdict through', async () => {
    for (const status of ['ok', 'problem', 'unchecked'] as const) {
      const r = rig({ checkLifecycle: () => Promise.resolve({ status, detail: `d-${status}` }) });
      const out = await runPreflight(r.deps);
      expect(statuses(out).lifecycle).toBe(status);
      expect(detail(out, 'lifecycle')).toBe(`d-${status}`);
      expect(out.ok).toBe(status !== 'problem');
    }
  });

  it('reads a backend with no check as unchecked, and says so', async () => {
    const out = await runPreflight(rig({ checkLifecycle: undefined }).deps);
    expect(statuses(out).lifecycle).toBe('unchecked');
    expect(out.ok).toBe(true);
  });

  it('reads a check that rejects as unchecked, never a throw', async () => {
    const r = rig({ checkLifecycle: () => Promise.reject(new TransientError('503')) });
    const out = await runPreflight(r.deps);
    expect(statuses(out).lifecycle).toBe('unchecked');
    expect(detail(out, 'lifecycle')).toContain('run preflight() again');
  });

  it('reads a check that throws synchronously as unchecked', async () => {
    const r = rig({
      checkLifecycle: () => {
        throw new Error('sync');
      },
    });
    expect(statuses(await runPreflight(r.deps)).lifecycle).toBe('unchecked');
  });

  it('reads an answer it cannot read as unchecked', async () => {
    for (const bad of [null, undefined, {}, { status: 'fine', detail: 'x' }]) {
      const r = rig({ checkLifecycle: () => Promise.resolve(bad as never) });
      const out = await runPreflight(r.deps);
      expect(statuses(out).lifecycle).toBe('unchecked');
      expect(detail(out, 'lifecycle')).toContain('could not read');
    }
  });

  it('cuts a long detail at 1000 characters', async () => {
    const r = rig({
      checkLifecycle: () => Promise.resolve({ status: 'ok', detail: 'y'.repeat(5000) }),
    });
    const text = detail(await runPreflight(r.deps), 'lifecycle');
    expect(text).toContain('y'.repeat(1000));
    expect(text).not.toContain('y'.repeat(1001));
  });

  it('gives up on a check that never answers after 30 seconds of the clock, and says to run again', async () => {
    let slept = 0;
    const clock = {
      now: () => 0,
      sleep: (ms: number) => {
        expect(ms).toBe(LIFECYCLE_TICK_MS);
        slept += ms;
        return Promise.resolve();
      },
    };
    const r = rig({ clock, checkLifecycle: () => new Promise<LifecycleVerdict>(() => {}) });
    const out = await runPreflight(r.deps);
    expect(LIFECYCLE_TIMEOUT_MS).toBe(30_000);
    expect(slept).toBe(30_000);
    expect(statuses(out).lifecycle).toBe('unchecked');
    expect(detail(out, 'lifecycle')).toContain('30 seconds');
    expect(detail(out, 'lifecycle')).toContain('Run preflight() again');
    expect(out.ok).toBe(true);
  });

  it('does not let a check that answers late, after the limit, change the answer or reject unseen', async () => {
    let finish: (() => void) | undefined;
    const r = rig({
      checkLifecycle: () =>
        new Promise<LifecycleVerdict>((_, reject) => {
          finish = () => reject(new Error('late'));
        }),
    });
    const out = await runPreflight(r.deps);
    expect(statuses(out).lifecycle).toBe('unchecked');
    finish?.();
    await new Promise((resolve) => setTimeout(resolve, 5));
  });

  it('waits for a check that answers within the limit', async () => {
    let slept = 0;
    let release: (() => void) | undefined;
    const clock = {
      now: () => 0,
      sleep: () => {
        slept += 1;
        if (slept === 40) release?.();
        return Promise.resolve();
      },
    };
    const r = rig({
      clock,
      checkLifecycle: () =>
        new Promise<LifecycleVerdict>((resolve) => {
          release = () => resolve({ status: 'problem', detail: 'slow but there' });
        }),
    });
    const out = await runPreflight(r.deps);
    expect(statuses(out).lifecycle).toBe('problem');
    expect(detail(out, 'lifecycle')).toBe('slow but there');
  });

  it('leaves no long timer behind when the check answers at once, on the real clock', async () => {
    const real = new SystemClock();
    const waits: number[] = [];
    const clock = {
      now: () => real.now(),
      sleep: (ms: number) => {
        waits.push(ms);
        return real.sleep(ms);
      },
    };
    const r = rig({ clock });
    const started = Date.now();
    await runPreflight(r.deps);
    expect(Date.now() - started).toBeLessThan(LIFECYCLE_TICK_MS * 4);
    expect(waits.length).toBeLessThanOrEqual(1);
    expect(Math.max(0, ...waits)).toBeLessThanOrEqual(LIFECYCLE_TICK_MS);
  });

  it('stops counting the bound once the check has answered', async () => {
    let slept = 0;
    const clock = {
      now: () => 0,
      sleep: () => {
        slept += 1;
        return new Promise<void>((resolve) => setImmediate(resolve));
      },
    };
    await runPreflight(rig({ clock }).deps);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(slept).toBeLessThanOrEqual(1);
  });
});
