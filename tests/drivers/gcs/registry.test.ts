import type { Storage } from '@google-cloud/storage';
import { registryConformance, registryConcurrency } from '@/testing/conformance';
import { GcsRegistryDriver } from '@/drivers/gcs/registry';
import { MAX_ROW_BYTES } from '@/drivers/_shared/object-registry';
import { IntegrityError, ValidationError, WriteConflictError } from '@/core/errors';

/**
 * A faithful in-memory fake of the slice of GCS the registry uses: `getMetadata`, a generation-pinned
 * `download`, a **conditional** `save`, and a paginated `getFiles`.
 *
 * Two modelling decisions carry the weight here, both copied from the backend rather than invented:
 *
 * 1. **A precondition only binds on the simple upload path.** `save()` opens a resumable session unless
 *    `resumable: false` is passed, and fake-gcs-server 1.52.2 — the emulator the integration lane runs
 *    against, pinned in `docker-compose.yml` for exactly this property — does not enforce
 *    `ifGenerationMatch` on that path. A driver that omits the flag therefore has no compare-and-swap at
 *    all while every sequential test stays green. Modelling it here makes that one line testable in the
 *    fast lane instead of only in Docker.
 * 2. **The bucket is not versioned**, so an overwrite retires the superseded generation immediately and a
 *    download pinned to it answers 404. That is the mid-read race `ObjectVersionRaced` exists for; a fake
 *    that kept old generations around could never reproduce it.
 */
function gcsError(status: number): Error {
  const err = new Error(`gcs ${status}`) as Error & { code: number };
  err.code = status; // GCS ApiError carries the HTTP status on `.code`
  return err;
}

interface FakeObject {
  bytes: Uint8Array;
  generation: number;
}

class FakeGcs {
  readonly objects = new Map<string, FakeObject>();
  private seq = 0;
  /** Counts `getMetadata` + `download` calls, to pin the round-trip cost of a read. */
  reads = 0;

  constructor(private readonly pageSize = Infinity) {}

  bucket(): unknown {
    return {
      file: (name: string, opts?: { generation?: string }) => this.file(name, opts?.generation),
      getFiles: async (q: {
        prefix?: string;
        maxResults?: number;
        pageToken?: string;
      }): Promise<unknown[]> => {
        const all = [...this.objects.keys()].filter((k) => k.startsWith(q.prefix ?? '')).sort();
        const from = q.pageToken === undefined ? 0 : all.findIndex((k) => k > q.pageToken!);
        const start = from < 0 ? all.length : from;
        const limit = Math.min(q.maxResults ?? Infinity, this.pageSize);
        const page = all.slice(start, start + limit);
        const more = start + page.length < all.length;
        // Real GCS hands back a `nextQuery` carrying the continuation token; the driver reads `.pageToken`.
        return [page.map((name) => ({ name })), more ? { pageToken: page[page.length - 1] } : null];
      },
    };
  }

  private file(name: string, pinned?: string): unknown {
    return {
      getMetadata: async (): Promise<unknown[]> => {
        this.reads++;
        const obj = this.objects.get(name);
        if (obj === undefined) throw gcsError(404);
        return [{ generation: String(obj.generation), size: String(obj.bytes.length) }];
      },
      download: async (): Promise<unknown[]> => {
        this.reads++;
        const obj = this.objects.get(name);
        if (obj === undefined) throw gcsError(404);
        // No Object Versioning: a generation that is no longer live is simply gone.
        if (pinned !== undefined && pinned !== String(obj.generation)) throw gcsError(404);
        return [Buffer.from(obj.bytes)];
      },
      save: async (
        body: Buffer,
        opts?: { resumable?: boolean; preconditionOpts?: { ifGenerationMatch?: number } },
      ): Promise<void> => {
        const cur = this.objects.get(name);
        const expect = opts?.preconditionOpts?.ifGenerationMatch;
        // The emulator enforces the precondition ONLY on the simple (non-resumable) path.
        if (opts?.resumable === false && expect !== undefined) {
          if (expect === 0 && cur !== undefined) throw gcsError(412);
          if (expect !== 0 && (cur === undefined || cur.generation !== expect)) throw gcsError(412);
        }
        this.objects.set(name, { bytes: Uint8Array.from(body), generation: ++this.seq + 1_000 });
      },
    };
  }
}

const ticking = (): (() => number) => {
  let t = 1_000;
  return () => (t += 1);
};

/** The single registry object the fake holds — asserts there is exactly one, rather than assuming it. */
function soleObject(storage: FakeGcs): { key: string; object: FakeObject } {
  const keys = [...storage.objects.keys()];
  expect(keys).toHaveLength(1);
  const key = keys[0] as string;
  return { key, object: storage.objects.get(key) as FakeObject };
}

const driverOver = (storage: FakeGcs, prefix = 'cloudroaring'): GcsRegistryDriver =>
  new GcsRegistryDriver({
    storage: storage as unknown as Storage,
    bucket: 'b',
    prefix,
    now: ticking(),
  });

// The GCS registry must pass the SAME contract as memory / LocalFs / S3 / Azure, in the fast lane.
registryConformance('GcsRegistryDriver (fake GCS)', () => driverOver(new FakeGcs()));

// …and the cross-process fence, against a fake that enforces preconditions exactly where GCS does.
registryConcurrency('GcsRegistryDriver (fake GCS)', () => {
  const storage = new FakeGcs();
  return [driverOver(storage), driverOver(storage)];
});

describe('GcsRegistryDriver — construction + GCS specifics', () => {
  const ref = { segment: 's:v1' };

  it('rejects a prefix with `.`/`..` segments or control chars (containment)', () => {
    const storage = new FakeGcs() as unknown as Storage;
    for (const prefix of ['..', 'a/../b', './x', 'a\tb']) {
      expect(() => new GcsRegistryDriver({ storage, bucket: 'b', prefix })).toThrow(
        ValidationError,
      );
    }
  });

  it('advertises strongRead', () => {
    const storage = new FakeGcs() as unknown as Storage;
    expect(new GcsRegistryDriver({ storage, bucket: 'b' }).capabilities()).toEqual({
      strongRead: true,
    });
  });

  // The regression test for the blocker: without `resumable: false` the fake (like the emulator) ignores
  // `ifGenerationMatch` entirely, so both writers "win" and one silently overwrites the other.
  it('writes on the simple upload path, so the precondition actually fences', async () => {
    const storage = new FakeGcs();
    const [a, b] = [driverOver(storage), driverOver(storage)];
    const results = await Promise.allSettled([
      a.create(ref, { currentGen: 0 }),
      b.create(ref, { currentGen: 0 }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
  });

  it('fences a compare-and-swap against the object generation, not the ETag', async () => {
    const storage = new FakeGcs();
    const d = driverOver(storage);
    const { token } = await d.create(ref, { currentGen: 0 });
    await d.compareAndSwap(ref, token, { currentGen: 1 });
    // The stale token must be refused by the in-process check AND, were it to get past, by the generation.
    await expect(d.compareAndSwap(ref, token, { currentGen: 2 })).rejects.toBeInstanceOf(
      WriteConflictError,
    );
    expect(soleObject(storage).object.generation).toBeGreaterThan(1_000);
  });

  // The failure this prevents: a live row reported as absent because the generation we pinned was retired
  // by a concurrent writer. `get` would answer null, `delete` would report a false success, and `list`
  // would quietly drop the row from every sweep that drives off it.
  it('re-reads instead of reporting absence when a write lands mid-read', async () => {
    const storage = new FakeGcs();
    const d = driverOver(storage);
    await d.create(ref, { currentGen: 7 });

    // Retire the pinned generation between `getMetadata` and `download`, exactly once.
    const realBucket = storage.bucket.bind(storage);
    let armed = true;
    vi.spyOn(storage, 'bucket').mockImplementation(() => {
      const real = realBucket() as {
        file: (n: string, o?: { generation?: string }) => { download: () => Promise<unknown[]> };
      };
      return {
        ...(real as object),
        file: (n: string, o?: { generation?: string }) => {
          const handle = real.file(n, o);
          if (o?.generation === undefined) return handle;
          return {
            ...handle,
            download: async (): Promise<unknown[]> => {
              if (armed) {
                armed = false;
                const cur = storage.objects.get(n) as FakeObject;
                storage.objects.set(n, { ...cur, generation: cur.generation + 1 });
              }
              return handle.download();
            },
          };
        },
      };
    });

    const got = await d.get(ref);
    expect(armed).toBe(false); // the race really did fire
    expect(got).not.toBeNull();
    expect(got!.currentGen).toBe(7);
    vi.restoreAllMocks();
  });

  it('threads the getFiles page token across pages', async () => {
    const storage = new FakeGcs(2); // two objects per page
    const d = driverOver(storage);
    for (let i = 0; i < 7; i++) await d.create({ segment: `s${i}` }, { currentGen: i });
    const seen: string[] = [];
    for await (const rec of d.list()) seen.push(rec.segment);
    expect(seen.sort()).toEqual(['s0', 's1', 's2', 's3', 's4', 's5', 's6']);
  });

  it('rejects an oversized object on its advertised size, before downloading it', async () => {
    const storage = new FakeGcs();
    const d = driverOver(storage);
    await d.create(ref, { currentGen: 0 });
    storage.objects.set(soleObject(storage).key, {
      bytes: new Uint8Array(MAX_ROW_BYTES + 1),
      generation: 2_000,
    });
    const before = storage.reads;
    await expect(d.get(ref)).rejects.toBeInstanceOf(IntegrityError);
    // One round trip only: the metadata call. The body was never fetched.
    expect(storage.reads - before).toBe(1);
  });

  it('refuses a version fence that is not a GCS generation', async () => {
    const storage = new FakeGcs();
    const d = driverOver(storage);
    await d.create(ref, { currentGen: 0 });
    const { object: cur } = soleObject(storage);
    // A backend that answered with an ETag-shaped fence would silently disable the precondition
    // (`Number('"etag-1"')` is NaN, and `ifGenerationMatch: NaN` is not a precondition GCS honours).
    vi.spyOn(storage, 'bucket').mockImplementation(
      () =>
        ({
          file: () => ({
            getMetadata: async () => [{ generation: '"etag-1"', size: String(cur.bytes.length) }],
            download: async () => [Buffer.from(cur.bytes)],
            save: async () => undefined,
          }),
        }) as never,
    );
    await expect(d.compareAndSwap(ref, '0', { currentGen: 1 })).rejects.toBeInstanceOf(Error);
    vi.restoreAllMocks();
  });
});
