/**
 * Helpers for counting the requests the engine makes — what the cost model and the calibration harness are held to.
 * A count is only evidence if it is taken of the real engine over real protocols, so these wrap a driver or a
 * registry store rather than stand in for one.
 */
import { WriteConflictError } from '@/core/errors';
import type { ObjectRegistryStore, ObjectRow } from '@/drivers/_shared/object-registry';

/**
 * An object store for the registry protocol that counts its reads and writes, and loses the first `lostRaces`
 * conditional writes the way a concurrent writer would make them lose. Its writes fence for real.
 */
export class CountingObjectStore implements ObjectRegistryStore {
  readonly label = 'counting';
  reads = 0;
  writes = 0;
  private readonly objects = new Map<string, { bytes: Uint8Array; version: number }>();
  private nextVersion = 1;

  constructor(private lostRaces: number) {}

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
    for (const key of this.objects.keys()) if (key.startsWith(prefix)) yield key;
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
