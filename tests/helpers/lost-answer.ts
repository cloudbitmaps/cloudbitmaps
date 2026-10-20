/**
 * Drivers that lose the answer to a write that landed, for the tests of a call that settles such a write by reading
 * back what it wrote. Each is a `Proxy` over a driver that binds every member it does not override, so
 * `reportsWriteTokens` and `capabilities()` pass through and a driver with private fields still works
 * (`Object.create` breaks one).
 */
import { TransientError, WriteConflictError, unsettledConflict } from '@/core/errors';
import type {
  IRegistryDriver,
  IStorageDriver,
  RegistryRecord,
  RegistryWriteOptions,
  SegmentRef,
} from '@/core/ports';

/**
 * What goes wrong with one write:
 * - `'a'`: it lands, and its answer is lost (`TransientError`);
 * - `'b'`: it lands, and what comes back is a conflict that may follow its own landing (`unsettledConflict`);
 * - `'c'`: it never lands: its token is reported, as a registry does before it sends, and `TransientError` follows;
 * - `'d'`: it never lands: it loses a race, and a plain `WriteConflictError` comes back.
 */
export type Fault = 'a' | 'b' | 'c' | 'd';

/** The writes of a registry that can be armed. */
type WriteOp = 'create' | 'compareAndSwap' | 'delete';

interface Armed {
  readonly op: WriteOp;
  readonly fault: Fault;
  readonly match: (ref: SegmentRef) => boolean;
  left: number;
}

export interface FaultyRegistry extends IRegistryDriver {
  /**
   * Fault the next `times` writes of `op` whose segment `match`es (every segment by default). A write that is not
   * armed passes through.
   */
  arm(op: WriteOp, fault: Fault, match?: (ref: SegmentRef) => boolean, times?: number): void;
  /**
   * After the next armed fault fires, make the next `n` `get` calls throw `TransientError`: the double fault, an
   * answer lost and the read-back with it. `skip` reads answer first, and `error` is what they throw (a `TransientError` by default). `failReads(0)` clears what is left of them.
   */
  failReads(n: number, skip?: number, error?: Error): void;
  /** Run `hook` after an armed fault's write has been applied (or skipped, for `'c'`) and before the fault is thrown. */
  between(hook: () => Promise<void>): void;
  /** How many armed faults have fired. */
  readonly fired: number;
}

const bound = <T extends object>(target: T, prop: string | symbol): unknown => {
  const value = Reflect.get(target, prop, target) as unknown;
  return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
};

export function faultyRegistry(base: IRegistryDriver): FaultyRegistry {
  const armed: Armed[] = [];
  let readsToFail = 0;
  let readsToSkip = 0;
  let readsFailing = 0;
  let readError: Error | undefined;
  let readsSkipping = 0;
  let hook: (() => Promise<void>) | undefined;
  let fired = 0;
  const lose = async (
    op: WriteOp,
    ref: SegmentRef,
    options: RegistryWriteOptions | undefined,
    send: (options: RegistryWriteOptions | undefined) => Promise<unknown>,
  ): Promise<unknown> => {
    const hit = armed.find((a) => a.op === op && a.left > 0 && a.match(ref));
    if (hit === undefined) return send(options);
    hit.left -= 1;
    fired += 1;
    if (hit.fault === 'c' || hit.fault === 'd') options?.onToken?.(`unapplied.${fired}.${fired}`);
    else await send(options);
    readsFailing = readsToFail;
    readsSkipping = readsToSkip;
    await hook?.();
    if (hit.fault === 'd') throw new WriteConflictError('the write lost a race');
    if (hit.fault === 'b')
      throw unsettledConflict('the write met a conflict that may follow its own landing');
    throw new TransientError('the registry write got no answer');
  };
  const own: Record<string, unknown> = {
    arm: (op: WriteOp, fault: Fault, match: (ref: SegmentRef) => boolean = () => true, times = 1) =>
      void armed.push({ op, fault, match, left: times }),
    failReads: (n: number, skip = 0, error?: Error) => {
      readError = error;
      readsToFail = n;
      readsToSkip = skip;
      if (n === 0) readsFailing = 0;
    },
    between: (fn: () => Promise<void>) => void (hook = fn),
    get fired() {
      return fired;
    },
    create: (ref: SegmentRef, record: never, options?: RegistryWriteOptions) =>
      lose('create', ref, options, (o) => base.create(ref, record, o)),
    compareAndSwap: (
      ref: SegmentRef,
      expected: string,
      patch: never,
      options?: RegistryWriteOptions,
    ) => lose('compareAndSwap', ref, options, (o) => base.compareAndSwap(ref, expected, patch, o)),
    delete: (ref: SegmentRef, expected?: string) =>
      lose('delete', ref, undefined, () => base.delete(ref, expected)),
    get: async (ref: SegmentRef): Promise<RegistryRecord | null> => {
      if (readsSkipping > 0) readsSkipping -= 1;
      else if (readsFailing > 0) {
        readsFailing -= 1;
        throw readError ?? new TransientError('the registry read failed');
      }
      return base.get(ref);
    },
  };
  return new Proxy(base, {
    get: (target, prop) => (prop in own ? own[prop as string] : bound(target, prop)),
  }) as FaultyRegistry;
}

export interface FaultyStorage extends IStorageDriver {
  /**
   * Make the next `n` listings throw `TransientError`, once `trigger` answers true (checked as a listing starts): the
   * way to fail the listing that follows a write rather than the one before it.
   */
  failListsAfter(trigger: () => Promise<boolean>, n: number): void;
}

export function faultyStorage(base: IStorageDriver): FaultyStorage {
  let trigger: (() => Promise<boolean>) | undefined;
  let toFail = 0;
  const own: Record<string, unknown> = {
    failListsAfter: (when: () => Promise<boolean>, n: number) => {
      trigger = when;
      toFail = n;
    },
    list: (ref: SegmentRef) =>
      (async function* () {
        if (toFail > 0 && trigger !== undefined && (await trigger())) {
          toFail -= 1;
          throw new TransientError('the listing failed');
        }
        yield* base.list(ref);
      })(),
  };
  return new Proxy(base, {
    get: (target, prop) => (prop in own ? own[prop as string] : bound(target, prop)),
  }) as FaultyStorage;
}
