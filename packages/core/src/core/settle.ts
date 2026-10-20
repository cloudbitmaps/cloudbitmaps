/**
 * Settling a write that got no answer, by reading back what it wrote.
 *
 * A request that lands and loses its response looks, to the caller, like one that never landed. The library does not
 * guess: it reads the row (or the object) back and takes the write as landed only when what it reads carries this
 * call's own mark. These helpers are the two pieces every such settle shares. Pure but for the ports it is handed: no
 * I/O of its own.
 */
import type { Rng } from './determinism';
import { isTransientError } from './errors';
import { UNANSWERED_BASE_MS } from './leases';
import type { IRegistryDriver, RegistryRecord, RegistryWriteOptions, Token } from './ports';
import { type Sleeper, jitteredWait } from './retry';

/** The write tokens one call has sent, and the option that collects them. */
interface WriteTokens {
  /**
   * The tokens of every write this call sent, as a registry that reports them says before it sends each one. `undefined`
   * for a registry that does not report them (a third party's): a write that got no answer there cannot be settled by
   * a token.
   */
  readonly sent: Set<Token> | undefined;
  /** Pass to `create` or `compareAndSwap`; `undefined` when the registry reports no tokens. */
  readonly options: RegistryWriteOptions | undefined;
  /**
   * Whether `row` shows a write this call sent: its token, or its `pointerId` (the token of the last write that named
   * a field a read resolves through, which a lease or policy write leaves as it was), is one this call sent. A token is
   * never reused, so a match is this call's write and not another writer's.
   */
  wrote(row: RegistryRecord | null): boolean;
}

/**
 * Collect the tokens a call's registry writes carry. `onSent` is called with each, before the write is sent, for a
 * caller that records something beside it.
 */
export function writeTokens(
  registry: IRegistryDriver,
  onSent?: (token: Token) => void,
): WriteTokens {
  const sent = registry.reportsWriteTokens === true ? new Set<Token>() : undefined;
  return {
    sent,
    options:
      sent === undefined
        ? undefined
        : {
            onToken: (token) => {
              sent.add(token);
              onSent?.(token);
            },
          },
    wrote: (row) =>
      row !== null && sent !== undefined && (sent.has(row.token) || sent.has(row.pointerId)),
  };
}

/** What a read-back waits with: a clock that sleeps, and the source that spreads each wait. Both are optional. */
interface ReadBackWaits {
  readonly clock?: Sleeper | undefined;
  readonly rng?: Rng | undefined;
}

/** Reads a read-back makes before it gives up. */
const READ_BACK_TRIES = 3;

/**
 * Read back what a write that got no answer wrote: up to three reads, waiting under half a second and then under a
 * second between them (full jitter, on the clock's `sleep`, when there is one). The first read that answers is
 * returned. A read that fails for a reason that is not transient (a refusal, a row that is not one the library wrote)
 * is thrown as it is: it says more than the lost answer does, and reading again will not change it. When every read
 * fails transiently, `unanswered`, the write's own error, is thrown with the last read's error as its `cause` (unless it
 * has one): the outcome is unknown.
 */
export async function readBack<T>(
  read: () => Promise<T>,
  unanswered: Error,
  waits: ReadBackWaits = {},
): Promise<T> {
  let last: unknown;
  for (let attempt = 0; attempt < READ_BACK_TRIES; attempt++) {
    try {
      return await read();
    } catch (err) {
      if (!isTransientError(err)) throw err;
      last = err;
    }
    if (attempt < READ_BACK_TRIES - 1) {
      await jitteredWait(waits.clock, waits.rng, UNANSWERED_BASE_MS * 2 ** attempt);
    }
  }
  if (unanswered.cause === undefined) unanswered.cause = last;
  throw unanswered;
}
