/**
 * `runPreflight` — the first-run check of a store's storage and registry, behind `store.preflight()`.
 *
 * ```
 *   registry ── get(probe row) must be null, canWrite !== false
 *   write ───── put marker A under the probe key
 *   write-once  put marker B under the same key: must throw WriteConflictError
 *   read ────── getTail: must return A (read-after-write); gives the version
 *   list ────── list the probe segment: must name the probe
 *   delete ──── (finally) delete this run's own key, with the tail's version when it has one
 *   lifecycle ─ backend.checkLifecycle(), bounded by a timer, unchecked when the backend has none
 * ```
 *
 * The probe key is `cbm.due.preflight/probe.<48-bit random>`. That namespace sits inside the reserved `cbm.due.`
 * prefix an application can never name, so no segment of the application's can collide with it, and the registry
 * writes nothing: the probe is a storage object only, which no registry row names and no scan of the registry
 * reaches. Storage is only ever listed one segment at a time, from rows or from refs the application gave.
 *
 * A finding never throws. A step that fails (a transient fault included) is a `problem` whose detail says so, and the
 * checks that cannot run without it are `unchecked`. The only throws are a store with nothing to check (the facade
 * refuses it before it gets here) and a deps object with no entropy.
 *
 * Not checked: read-after-delete, the registry's `If-Match` on compare-and-swap, multipart abort permission,
 * versioning and backups.
 *
 * Time arrives through the injected {@link Clock}: the lifecycle step is bounded by {@link LIFECYCLE_TIMEOUT_MS},
 * counted in short sleeps of {@link LIFECYCLE_TICK_MS} so that a check that answers at once leaves no long timer
 * holding a short-lived process open.
 */
import type { Clock, Entropy } from './determinism';
import { isTransientError, isWriteConflictError } from './errors';
import type { GenKey, IRegistryDriver, IStorageDriver, LifecycleVerdict } from './ports';
import { RESERVED_NAMESPACE_PREFIX } from './validate';

/**
 * What one check found.
 *
 * - `ok`: the check ran and found nothing wrong.
 * - `problem`: the check ran and found something wrong, or a step it needs failed (a transient fault included: `detail`
 *   says to run again then).
 * - `unchecked`: the check could not be made, because a step it depends on failed, or the backend offers no such check,
 *   or it did not answer in time. `ok` on the result does not vouch for it.
 */
export interface PreflightCheck {
  /** Which check this is. A run lists all seven, in this order. */
  readonly name: 'registry' | 'write' | 'write-once' | 'read' | 'list' | 'delete' | 'lifecycle';
  /** What the check found. */
  readonly status: 'ok' | 'problem' | 'unchecked';
  /** A sentence or two for a person: what was found, and what to do. The name and message of a failed step's error. */
  readonly detail: string;
}

/** What `store.preflight()` found: every check, and whether none of them is a `problem`. */
export interface PreflightResult {
  /** True when no check is a `problem`. A check that is `unchecked` does not make it false. */
  readonly ok: boolean;
  /** All seven checks, in the order the type of `PreflightCheck.name` lists them. */
  readonly checks: PreflightCheck[];
}

/** What a run needs: the store's raw drivers, an entropy source for the probe's number, and a clock for the bound. */
export interface PreflightDeps {
  readonly storage: IStorageDriver;
  readonly registry: IRegistryDriver;
  readonly clock: Clock;
  readonly entropy: Entropy;
  /** The backend's lifecycle check, bound to the backend; absent for a backend that has none. */
  readonly checkLifecycle?: (() => Promise<LifecycleVerdict>) | undefined;
}

/** The probe's namespace, inside the reserved prefix; no application ref can name it. */
export const PREFLIGHT_NAMESPACE = `${RESERVED_NAMESPACE_PREFIX}preflight`;
/** The probe's segment name. */
export const PREFLIGHT_SEGMENT = 'probe';
/** How long the lifecycle step may take before it is read as `unchecked`: 30 seconds of the injected clock. */
export const LIFECYCLE_TIMEOUT_MS = 30_000;
/** The length of each sleep the bound is counted in. */
export const LIFECYCLE_TICK_MS = 250;

const MARKER_A = ascii('cloudbitmaps preflight probe A');
const MARKER_B = ascii('cloudbitmaps preflight probe B');
/** A tail read this long returns a whole marker. */
const TAIL_BYTES = 64;
const MAX_MESSAGE_CHARS = 300;
const MAX_LEFTOVERS_NAMED = 3;
const MAX_LIFECYCLE_DETAIL_CHARS = 1000;

function ascii(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) bytes[i] = text.charCodeAt(i);
  return bytes;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

/** A 48-bit whole number from six entropy bytes. */
function probeNumber(entropy: Entropy): number {
  const bytes = entropy(6);
  if (!(bytes instanceof Uint8Array) || bytes.length < 6) {
    throw new TypeError('preflight needs an entropy source that returns the bytes it is asked for');
  }
  let n = 0;
  for (let i = 0; i < 6; i += 1) n = n * 256 + (bytes[i] ?? 0);
  return n;
}

/** The error's name and message, cut, whatever was thrown: a getter that throws must not escape a check. */
function describeError(err: unknown): string {
  let name = 'Error';
  let message = '';
  try {
    if (typeof err === 'object' && err !== null) {
      const n = (err as { name?: unknown }).name;
      const m = (err as { message?: unknown }).message;
      if (typeof n === 'string' && n !== '') name = n;
      if (typeof m === 'string') message = m;
    } else {
      message = String(err);
    }
  } catch {
    // an unreadable error reads as its bare name
  }
  const cut =
    message.length > MAX_MESSAGE_CHARS ? `${message.slice(0, MAX_MESSAGE_CHARS)}...` : message;
  return cut === '' ? name : `${name}: ${cut}`;
}

/** A failed step's detail: what it was doing, what came back, and, for a transient fault, to run again. */
function failed(doing: string, err: unknown): string {
  let transient = false;
  try {
    transient = isTransientError(err);
  } catch {
    // not a transient fault
  }
  return `${doing} failed with ${describeError(err)}.${transient ? ' This is a transient fault: run preflight() again.' : ''}`;
}

type PreflightCheckName = PreflightCheck['name'];
type Slot = Omit<PreflightCheck, 'name'>;

const ORDER: readonly PreflightCheckName[] = [
  'registry',
  'write',
  'write-once',
  'read',
  'list',
  'delete',
  'lifecycle',
];

/** The lifecycle verdict, or `unchecked` when the backend has no check, it failed, it timed out, or it answered nonsense. */
async function lifecycleStep(deps: PreflightDeps): Promise<Slot> {
  const check = deps.checkLifecycle;
  if (check === undefined) {
    return {
      status: 'unchecked',
      detail:
        'This backend does not offer the lifecycle check. Look at the bucket lifecycle rules by hand: none may delete or archive the store objects or the registry rows.',
    };
  }
  let settled = false;
  type Outcome =
    | { readonly kind: 'answered'; readonly verdict: unknown }
    | { readonly kind: 'threw'; readonly error: unknown }
    | { readonly kind: 'timeout' };
  const run: Promise<Outcome> = (async (): Promise<Outcome> => {
    try {
      return { kind: 'answered', verdict: await check() };
    } catch (error) {
      return { kind: 'threw', error };
    } finally {
      settled = true;
    }
  })();
  const bound: Promise<Outcome> = (async (): Promise<Outcome> => {
    for (let waited = 0; waited < LIFECYCLE_TIMEOUT_MS && !settled; waited += LIFECYCLE_TICK_MS) {
      await deps.clock.sleep(LIFECYCLE_TICK_MS);
    }
    return { kind: 'timeout' };
  })();
  let outcome = await Promise.race([run, bound]);
  if (outcome.kind === 'timeout' && settled) outcome = await run;
  if (outcome.kind === 'timeout') {
    return {
      status: 'unchecked',
      detail: `The lifecycle check did not answer within ${LIFECYCLE_TIMEOUT_MS / 1000} seconds. Run preflight() again, or look at the bucket lifecycle rules by hand.`,
    };
  }
  if (outcome.kind === 'threw') {
    return {
      status: 'unchecked',
      detail: `${failed('The lifecycle check', outcome.error)} Look at the bucket lifecycle rules by hand.`,
    };
  }
  const verdict = outcome.verdict as Partial<LifecycleVerdict> | null | undefined;
  const status = verdict?.status;
  if (status !== 'ok' && status !== 'problem' && status !== 'unchecked') {
    return {
      status: 'unchecked',
      detail:
        'The lifecycle check gave an answer preflight could not read. Look at the bucket lifecycle rules by hand.',
    };
  }
  const detail = typeof verdict?.detail === 'string' ? verdict.detail : '';
  return {
    status,
    detail:
      detail.length > MAX_LIFECYCLE_DETAIL_CHARS
        ? `${detail.slice(0, MAX_LIFECYCLE_DETAIL_CHARS)}...`
        : detail,
  };
}

/** Step 1, read-only: the probe's row must be absent, and the registry must be able to write. */
async function registryStep(registry: IRegistryDriver): Promise<Slot> {
  try {
    const row = await registry.get({ namespace: PREFLIGHT_NAMESPACE, segment: PREFLIGHT_SEGMENT });
    if (row !== null) {
      return {
        status: 'problem',
        detail: `A registry row exists at ${PREFLIGHT_NAMESPACE}/${PREFLIGHT_SEGMENT}, an address only the library uses and never writes a row at. The registry is not the one this store expects, or something else writes there.`,
      };
    }
    if (registry.capabilities().canWrite === false) {
      return {
        status: 'problem',
        detail:
          'The registry reads but cannot write in this runtime (no Web Crypto to draw its tokens from), so a load would be refused.',
      };
    }
    return { status: 'ok', detail: 'The registry answered a read, and can write.' };
  } catch (err) {
    return { status: 'problem', detail: failed('Reading the registry', err) };
  }
}

/** What the object steps know as they go: the key, the run's findings, and what the later steps need. */
interface Probe {
  readonly storage: IStorageDriver;
  readonly key: GenKey;
  /** The object's name for a person, with where it sits. */
  readonly object: string;
  readonly found: Map<PreflightCheckName, Slot>;
  /** The bytes the storage accepted last: A, or B when a second write succeeded. */
  accepted: Uint8Array;
  /** The version the tail read gave. */
  version?: string;
}

const skipped = (because: string): Slot => ({
  status: 'unchecked',
  detail: `Not run: ${because}.`,
});

/** Step 2. Returns whether the object was written, and whether a refusal means the key was not this run's. */
async function writeStep(probe: Probe): Promise<{ wrote: boolean; notOurs: boolean }> {
  try {
    await probe.storage.putImmutable(probe.key, async (sink) => sink.write(MARKER_A));
    probe.found.set('write', { status: 'ok', detail: 'A new object was written.' });
    return { wrote: true, notOurs: false };
  } catch (err) {
    // A refused first write means the key held an object already, which is not this run's to delete.
    const notOurs = isWriteConflictError(err);
    probe.found.set('write', {
      status: 'problem',
      detail: notOurs
        ? 'The probe object already existed: another run drew the same number. Run preflight() again.'
        : failed('Writing a new object', err),
    });
    return { wrote: false, notOurs };
  }
}

/** Step 3: a second write to the key must be refused with `WriteConflictError`. */
async function writeOnceStep(probe: Probe): Promise<void> {
  try {
    await probe.storage.putImmutable(probe.key, async (sink) => sink.write(MARKER_B));
    probe.accepted = MARKER_B;
    probe.found.set('write-once', {
      status: 'problem',
      detail:
        'A second write to the same key succeeded. The storage does not refuse an overwrite, so a generation could be replaced under a reader.',
    });
  } catch (err) {
    probe.found.set(
      'write-once',
      isWriteConflictError(err)
        ? { status: 'ok', detail: 'A second write to the same key was refused.' }
        : {
            status: 'problem',
            detail: `${failed('The second write to the same key', err)} Whether it was refused is not known.`,
          },
    );
  }
}

/** Step 4: the object must read back as the storage accepted it; its version is kept for the delete. */
async function readStep(probe: Probe): Promise<void> {
  try {
    const tail = await probe.storage.getTail(probe.key, TAIL_BYTES);
    probe.version = tail.version;
    const same = sameBytes(tail.bytes, probe.accepted) && tail.size === probe.accepted.length;
    probe.found.set(
      'read',
      same
        ? { status: 'ok', detail: 'The object just written read back as written.' }
        : {
            status: 'problem',
            detail:
              'The object just written did not read back as written: the bytes or the size differ.',
          },
    );
  } catch (err) {
    probe.found.set('read', {
      status: 'problem',
      detail: failed('Reading the object just written', err),
    });
  }
}

/** The sentence about other probes a listing showed, which are named and never deleted. */
function leftoversSentence(others: number, named: readonly number[]): string {
  if (others === 0) return '';
  const more = others > named.length ? ', ...' : '';
  const one = others === 1;
  return ` ${others} other probe object${one ? '' : 's'} (generation ${named.join(', ')}${more}) ${one ? 'was' : 'were'} left alone: ${one ? 'it may be' : 'they may be'} a run in progress, or one that was cut off.`;
}

/** Step 5: the listing of the probe segment must name the probe. */
async function listStep(probe: Probe): Promise<void> {
  try {
    let seen = false;
    let others = 0;
    const named: number[] = [];
    for await (const listed of probe.storage.list({
      namespace: PREFLIGHT_NAMESPACE,
      segment: PREFLIGHT_SEGMENT,
    })) {
      if (listed.generation === probe.key.generation) {
        seen = true;
      } else {
        others += 1;
        if (named.length < MAX_LEFTOVERS_NAMED) named.push(listed.generation);
      }
    }
    const leftovers = leftoversSentence(others, named);
    probe.found.set(
      'list',
      seen
        ? { status: 'ok', detail: `The listing named the object just written.${leftovers}` }
        : {
            status: 'problem',
            detail: `The listing did not name the object just written, so a listing can lag a write.${leftovers}`,
          },
    );
  } catch (err) {
    probe.found.set('list', {
      status: 'problem',
      detail: failed('Listing the probe segment', err),
    });
  }
}

/**
 * Step 6: delete this run's own key, with the version the tail read gave when it gave one. When the write failed, the
 * delete is still asked for, since a write that got no answer may have landed, but it is not a finding then.
 */
async function deleteStep(probe: Probe, wrote: boolean): Promise<void> {
  try {
    await probe.storage.delete(
      probe.key,
      probe.version === undefined ? undefined : { ifVersion: probe.version },
    );
    probe.found.set(
      'delete',
      wrote
        ? { status: 'ok', detail: 'The object was deleted.' }
        : skipped('no object was written to delete'),
    );
  } catch (err) {
    if (wrote) {
      probe.found.set('delete', {
        status: 'problem',
        detail: `${failed('Deleting the object just written', err)} The object ${probe.object} was left behind: delete it by hand.`,
      });
      return;
    }
    probe.found.set('delete', skipped('no object was written to delete'));
    const write = probe.found.get('write');
    if (write !== undefined) {
      probe.found.set('write', {
        status: write.status,
        detail: `${write.detail} A delete of ${probe.object} also failed, so it may have been left behind.`,
      });
    }
  }
}

/** Steps 2 to 6 on the probe object. The delete runs whatever the steps before it found. */
async function objectSteps(probe: Probe): Promise<void> {
  const { wrote, notOurs } = await writeStep(probe);
  try {
    if (wrote) {
      await writeOnceStep(probe);
      await readStep(probe);
      await listStep(probe);
    } else {
      const why = skipped('no object was written');
      for (const name of ['write-once', 'read', 'list'] as const) probe.found.set(name, why);
    }
  } finally {
    if (notOurs) {
      probe.found.set(
        'delete',
        skipped("the object under the key was not this run's, so it was left alone"),
      );
    } else {
      await deleteStep(probe, wrote);
    }
  }
}

/**
 * Run the seven checks. Never rejects over a finding; see the module comment for what it does reject.
 */
export async function runPreflight(deps: PreflightDeps): Promise<PreflightResult> {
  const key: GenKey = {
    namespace: PREFLIGHT_NAMESPACE,
    segment: PREFLIGHT_SEGMENT,
    generation: probeNumber(deps.entropy),
  };
  const probe: Probe = {
    storage: deps.storage,
    key,
    object: `${PREFLIGHT_NAMESPACE}/segments/${PREFLIGHT_SEGMENT}.${key.generation}.crbm (under the store's prefix)`,
    found: new Map(),
    accepted: MARKER_A,
  };
  probe.found.set('registry', await registryStep(deps.registry));
  await objectSteps(probe);
  probe.found.set('lifecycle', await lifecycleStep(deps));
  const checks: PreflightCheck[] = ORDER.map((name) => ({
    name,
    ...(probe.found.get(name) ?? skipped('the check did not run')),
  }));
  return { ok: !checks.some((c) => c.status === 'problem'), checks };
}
