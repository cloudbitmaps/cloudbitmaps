/**
 * Helpers for counting the requests the engine makes — what the cost model and the calibration harness are held to.
 * A count is only evidence if it is taken of the real engine over real protocols, so these wrap a driver or a
 * registry store rather than stand in for one.
 */
import { WriteConflictError } from '@/core/errors';
import type { ObjectRegistryStore, ObjectRow } from '@/drivers/_shared/object-registry';

/**
 * An object store for the registry protocol that counts its reads and writes, and loses the first `lostRaces`
 * conditional writes the way a concurrent writer would make them lose. Its writes fence for real. With
 * `conditionalDelete`, it also deletes under a version precondition that fences for real, and vouches for it, so a
 * registry over it removes rows rather than tombstoning them.
 */
export class CountingObjectStore implements ObjectRegistryStore {
  readonly label = 'counting';
  reads = 0;
  writes = 0;
  /** Conditional deletes, and listings (each `listKeys` call: one paged LIST on a real store per 1,000 keys). */
  deletes = 0;
  lists = 0;
  readonly conditionalDelete: boolean;
  /** Run just before the next conditional delete is applied: another writer landing between its read and it. */
  beforeDelete: (() => Promise<void>) | undefined;
  /** Apply the next conditional delete, then fail it with this: a delete that lands and loses its response. */
  landThenFailDelete: Error | undefined;
  /**
   * Refuse every conditional delete of a key this answers for, with the error it returns, before applying it: a policy
   * that denies delete, or a blob with a snapshot. It stays set until it is cleared.
   */
  refuseDelete: ((key: string) => Error | undefined) | undefined;
  private readonly objects = new Map<string, { bytes: Uint8Array; version: number }>();
  private nextVersion = 1;

  constructor(
    private lostRaces: number,
    options: { conditionalDelete?: boolean } = {},
  ) {
    this.conditionalDelete = options.conditionalDelete === true;
  }

  /** How many objects the store holds under `prefix`, uncounted: rows, tombstones and due pointers alike. */
  size(prefix = ''): number {
    let n = 0;
    for (const key of this.objects.keys()) if (key.startsWith(prefix)) n++;
    return n;
  }

  /** Put `text` at `key` as a new version, uncounted: a row another writer left, as it left it. */
  plant(key: string, text: string): void {
    this.objects.set(key, { bytes: new TextEncoder().encode(text), version: this.nextVersion++ });
  }

  /** Remove `key` outright, uncounted: a row taken away out of band, as a hard purge or a lifecycle rule would. */
  remove(key: string): void {
    this.objects.delete(key);
  }

  /** The bytes at `key` as text, uncounted, or `undefined` when there is no object. */
  text(key: string): string | undefined {
    const found = this.objects.get(key);
    return found === undefined ? undefined : new TextDecoder().decode(found.bytes);
  }

  read(key: string): Promise<ObjectRow | null> {
    this.reads += 1;
    const found = this.objects.get(key);
    return Promise.resolve(
      found === undefined ? null : { bytes: found.bytes, version: String(found.version) },
    );
  }

  write(key: string, body: Uint8Array, expect: 'absent' | { version: string }): Promise<void> {
    this.writes += 1;
    if (this.lostRaces > 0) {
      this.lostRaces -= 1;
      return Promise.reject(new WriteConflictError(`lost race: ${key}`));
    }
    const found = this.objects.get(key);
    const holds =
      expect === 'absent'
        ? found === undefined
        : found !== undefined && String(found.version) === expect.version;
    if (!holds) return Promise.reject(new WriteConflictError(`precondition failed: ${key}`));
    this.objects.set(key, { bytes: body, version: this.nextVersion++ });
    return Promise.resolve();
  }

  async *listKeys(prefix: string): AsyncIterable<string> {
    this.lists += 1;
    for (const key of [...this.objects.keys()]) if (key.startsWith(prefix)) yield key;
  }

  async delete(key: string, expect: { version: string }): Promise<void> {
    this.deletes += 1;
    const refusal = this.refuseDelete?.(key);
    if (refusal !== undefined) throw refusal;
    const hook = this.beforeDelete;
    this.beforeDelete = undefined;
    if (hook !== undefined) await hook();
    const found = this.objects.get(key);
    if (found === undefined || String(found.version) !== expect.version) {
      throw new WriteConflictError(`precondition failed on delete: ${key}`);
    }
    this.objects.delete(key);
    const lost = this.landThenFailDelete;
    this.landThenFailDelete = undefined;
    if (lost !== undefined) throw lost;
  }
}

/** `target`, with every call to each of its methods counted in `counts` under the method's name. */
export function counting<T extends object>(target: T, counts: Record<string, number>): T {
  return new Proxy(target, {
    get(t, prop, receiver) {
      const value: unknown = Reflect.get(t, prop, receiver);
      if (typeof value !== 'function') return value;
      const fn = value as (...args: unknown[]) => unknown;
      return (...args: unknown[]) => {
        counts[String(prop)] = (counts[String(prop)] ?? 0) + 1;
        return fn.apply(t, args);
      };
    },
  });
}
