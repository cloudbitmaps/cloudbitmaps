import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { GcsStorage } from '@/gcs/backend';
import { CRC32C, Storage, type StorageOptions } from '@google-cloud/storage';
import { ValidationError } from '@/core/errors';
import { downloadClient } from '@/gcs/read-client';

/**
 * A GCS download is sent once by the SDK and retried by the driver, and a retried read cannot crash the process.
 *
 * `@google-cloud/storage` (7.x and 8.x) retries a failed `download()` by default, on a reset connection, a 408, a 429 and
 * a 5xx. When the retried request succeeds, the SDK throws `ERR_STREAM_UNABLE_TO_PIPE` outside any promise ("Cannot pipe
 * to a closed or destroyed stream") and Node exits with code 1, whatever the caller wrote around the call. So the client
 * the driver builds sends each download once, and the driver runs a download again itself after exactly the faults the
 * SDK would have retried, a few times, whichever call made it and whether or not the store's own read retry is on.
 *
 * Each scenario runs the driver in a child process, against a stub of the JSON API in this one, so a crash is the child's
 * exit code and not the test runner's. The real SDK is the thing under test: a mock of it could not crash.
 */

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
// Under node_modules so the bundle resolves `@google-cloud/storage` and `roaring` from the repo, and out of git's way.
const CACHE = `${ROOT}node_modules/.cache`;
let outDir = '';
let child = '';
let home = '';

const TOKEN = `${'0'.repeat(32)}.0.${'0'.repeat(16)}`;
const ROW = JSON.stringify({
  schemaVersion: 4,
  deleted: false,
  record: {
    segment: 's',
    currentGen: 0,
    status: 'active',
    createdAt: 1,
    updatedAt: 1,
    token: TOKEN,
    pointerId: TOKEN,
  },
});

/** A status, a socket dropped before any answer (`reset`), or a body cut off after 200 with (`cut-sized`) or without a length. */
type Fault = 'reset' | 'cut' | 'cut-sized' | 503 | 429 | 408 | 404;

interface Stub {
  readonly endpoint: string;
  /** Requests seen so far, as `kind`: `media` (a download), `list` or `metadata`. */
  readonly seen: string[];
  close(): Promise<void>;
}

/**
 * Answers the first `times` downloads with `fault` (a reset drops the socket without answering) and every request after
 * that with a small 200.
 */
async function startStub(
  options: { fault?: Fault; times?: number; failList?: number } = {},
): Promise<Stub> {
  const seen: string[] = [];
  let faulted = 0;
  let listsFailed = 0;
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://stub');
    const isList = url.pathname.endsWith('/o');
    const kind = url.searchParams.get('alt') === 'media' ? 'media' : isList ? 'list' : 'metadata';
    seen.push(kind);
    if (kind === 'media' && options.fault !== undefined && faulted < (options.times ?? 1)) {
      faulted++;
      if (options.fault === 'reset') req.socket.destroy();
      else if (options.fault === 'cut' || options.fault === 'cut-sized') {
        const length = options.fault === 'cut-sized' ? { 'content-length': '8' } : {};
        res.writeHead(200, { 'x-goog-generation': '7', ...length });
        res.write('1234', () => req.socket.destroy());
      } else res.writeHead(options.fault).end('fault');
      return;
    }
    if (kind === 'list' && listsFailed === 0 && options.failList !== undefined) {
      listsFailed++;
      res.writeHead(options.failList).end('fail');
      return;
    }
    if (kind === 'media') {
      const registry = url.pathname.includes('registry');
      res.writeHead(200, { 'x-goog-generation': '7' }).end(registry ? ROW : '12345678');
      return;
    }
    const json = { 'content-type': 'application/json' };
    if (kind === 'list') {
      res
        .writeHead(200, json)
        .end(
          JSON.stringify({ items: [{ name: `${url.searchParams.get('prefix') ?? ''}3.crbm` }] }),
        );
      return;
    }
    res.writeHead(200, json).end(JSON.stringify({ name: 'o', generation: '7', size: '100' }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    seen,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

interface Run {
  readonly code: number | null;
  readonly outcome: Record<string, unknown> | undefined;
}

/** The child gets a minimal environment, so nothing the developer or CI exports (an emulator host, credentials) leaks in. */
function runChild(
  endpoint: string,
  call: string,
  extra: string[] = [],
  extraEnv: Record<string, string> = {},
): Promise<Run> {
  return new Promise((resolve, reject) => {
    const env = { PATH: process.env.PATH ?? '', HOME: home, ...extraEnv };
    const proc = spawn(process.execPath, [child, endpoint, call, ...extra], {
      env,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let out = '';
    proc.stdout.on('data', (d: Buffer) => (out += d.toString('utf8')));
    proc.on('error', reject);
    proc.on('close', (code) => {
      const line = out.trim().split('\n').filter(Boolean).pop();
      resolve({
        code,
        outcome: line === undefined ? undefined : (JSON.parse(line) as Run['outcome']),
      });
    });
  });
}

/** Run `call` against a stub with `options`; the stub is closed afterwards. */
async function scenario(
  call: string,
  options: Parameters<typeof startStub>[0],
): Promise<{ run: Run; downloads: number; seen: string[] }> {
  const stub = await startStub(options);
  try {
    const run = await runChild(stub.endpoint, call);
    return { run, downloads: stub.seen.filter((s) => s === 'media').length, seen: stub.seen };
  } finally {
    await stub.close();
  }
}

describe('a GCS download', () => {
  beforeAll(async () => {
    mkdirSync(CACHE, { recursive: true });
    outDir = mkdtempSync(`${CACHE}/gcs-read-retry-`);
    home = mkdtempSync(`${tmpdir()}/gcs-read-retry-home-`);
    child = `${outDir}/read-child.mjs`;
    await build({
      entryPoints: [`${HERE}fixtures/read-child.ts`],
      outfile: child,
      bundle: true,
      platform: 'node',
      format: 'esm',
      logLevel: 'silent',
      packages: 'external',
      alias: {
        '@cloudbitmaps/core/driver-kit': `${ROOT}packages/core/src/driver-kit.ts`,
        '@cloudbitmaps/core': `${ROOT}packages/core/src/index.ts`,
      },
    });
  }, 30_000);
  afterAll(() => {
    rmSync(outDir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  describe.each(['tail', 'range', 'registry'] as const)('read by %s', (call) => {
    it.concurrent.each([503, 429, 408, 'reset', 'cut', 'cut-sized'] as const)(
      'a first fault (%s) is retried once: success, two requests, no crash',
      async (fault) => {
        const { run, downloads } = await scenario(call, { fault });
        expect(run.code).toBe(0);
        expect(run.outcome).toHaveProperty('ok');
        expect(downloads).toBe(2);
      },
      20_000,
    );

    it.concurrent.each([
      [503, 'own-client'],
      ['reset', 'own-client'],
      ['cut', 'own-client'],
      [503, 'own-pinned'],
      ['reset', 'own-pinned'],
    ] as const)(
      "through the caller's own client, with the SDK's retries on, a first fault (%s) is retried once with no crash (%s)",
      async (fault, client) => {
        const stub = await startStub({ fault });
        try {
          const run = await runChild(stub.endpoint, call, [client]);
          expect(run.code).toBe(0);
          expect(run.outcome).toHaveProperty('ok');
          expect(stub.seen.filter((s) => s === 'media')).toHaveLength(2);
        } finally {
          await stub.close();
        }
      },
      20_000,
    );

    it.concurrent(
      'a persistent 503 is a TransientError after the bounded attempts, with no crash',
      async () => {
        const { run, downloads } = await scenario(call, { fault: 503, times: 100 });
        expect(run.code).toBe(0);
        expect(run.outcome).toEqual({ error: 'TransientError' });
        expect(downloads).toBe(4);
      },
      20_000,
    );

    it.concurrent(
      'a connection refused every time is a TransientError after the bounded attempts, with no crash',
      async () => {
        // A port that was just free and is now closed: every connection is refused before any response.
        const probe = createServer();
        await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
        const port = (probe.address() as AddressInfo).port;
        await new Promise<void>((resolve) => probe.close(() => resolve()));
        const run = await runChild(`http://127.0.0.1:${port}`, call, ['count-connects']);
        expect(run.code).toBe(0);
        expect(run.outcome).toEqual({ error: 'TransientError', connects: 4 });
      },
      20_000,
    );

    it.concurrent(
      'a credentials file that does not exist is raised as it is, on the first attempt',
      async () => {
        const stub = await startStub();
        try {
          const run = await runChild(stub.endpoint, call, ['creds-missing'], {
            GOOGLE_APPLICATION_CREDENTIALS: `${home}/no-such-key.json`,
          });
          expect(run.code).toBe(0);
          expect(run.outcome).toEqual({ error: 'Error', code: 'ENOENT', reads: 1 });
        } finally {
          await stub.close();
        }
      },
      20_000,
    );
  });

  it.concurrent.each(['tail', 'range'] as const)(
    'a 404 on a %s read is not retried',
    async (call) => {
      const { run, downloads } = await scenario(call, { fault: 404, times: 100 });
      expect(run.code).toBe(0);
      expect(run.outcome).toEqual({ error: 'NotFoundError' });
      expect(downloads).toBe(1);
    },
    20_000,
  );

  it.concurrent(
    'is retried on a facade call that reads the registry with the store retry off',
    async () => {
      const { run, downloads } = await scenario('exists', { fault: 'reset' });
      expect(run.code).toBe(0);
      expect(run.outcome).toEqual({ ok: true });
      expect(downloads).toBe(2);
    },
    20_000,
  );

  it.concurrent(
    'is the only request the SDK is kept from retrying: a listing keeps its retry',
    async () => {
      const { run, seen } = await scenario('list', { failList: 503 });
      expect(run.code).toBe(0);
      expect(run.outcome).toEqual({ ok: [3] });
      expect(seen.filter((s) => s === 'list')).toHaveLength(2);
    },
    20_000,
  );

  describe('the clients the driver builds', () => {
    const readClientOf = (backend: GcsStorage): Storage =>
      (backend.storage as unknown as { readStorage: Storage }).readStorage;

    it('send downloads once and leave every other call on the default retries', () => {
      const backend = new GcsStorage({
        bucket: 'b',
        apiEndpoint: 'http://127.0.0.1:1',
        projectId: 'p',
      });
      expect(readClientOf(backend).retryOptions.autoRetry).toBe(false);
      expect(backend.client.retryOptions.autoRetry).toBe(true);
    });

    it("send a caller's client's downloads through a twin of it that does not retry, and leave the client as it was", () => {
      const own = new Storage({
        apiEndpoint: 'http://127.0.0.1:1',
        projectId: 'p',
        userAgent: 'app/1',
        timeout: 4_321,
      });
      const backend = new GcsStorage({ bucket: 'b', client: own });
      const twin = readClientOf(backend);
      expect(backend.client).toBe(own);
      expect(twin).not.toBe(own);
      expect(own.retryOptions.autoRetry).toBe(true);
      expect(twin.retryOptions.autoRetry).toBe(false);
      // The same credentials object, so one token cache, and the same place, project, agent and timeout.
      expect(twin.authClient).toBe(own.authClient);
      expect(twin.constructor).toBe(own.constructor);
      expect([twin.baseUrl, twin.apiEndpoint, twin.projectId]).toEqual([
        own.baseUrl,
        own.apiEndpoint,
        own.projectId,
      ]);
      expect(twin.providedUserAgent).toBe('app/1');
      expect(twin.timeout).toBe(4_321);
      // An interceptor the caller adds afterwards applies to the twin's requests too.
      type Hook = (o: { uri: string; headers?: Record<string, string> }) => {
        uri: string;
        headers?: Record<string, string>;
      };
      const later: Hook = (o) => ({ ...o, headers: { ...o.headers, 'x-later': '1' } });
      own.interceptors.push({ request: later as never });
      const sent = (twin.getRequestInterceptors() as Hook[]).reduce<ReturnType<Hook>>(
        (r, f) => f(r),
        { uri: '/' },
      );
      expect(sent.headers?.['x-later']).toBe('1');
    });

    it('carry the checksum generator, universe, auth-on-custom-endpoint flag and retry settings to the twin', () => {
      const crc32cGenerator = () => new CRC32C();
      const retryableErrorFn = () => false;
      const own = new Storage({
        apiEndpoint: 'http://127.0.0.1:1',
        projectId: 'p',
        universeDomain: 'example.test',
        useAuthWithCustomEndpoint: true,
        crc32cGenerator,
        retryOptions: { maxRetries: 7, retryableErrorFn, idempotencyStrategy: 2 },
      });
      const twin = readClientOf(new GcsStorage({ bucket: 'b', client: own }));
      expect(twin.crc32cGenerator).toBe(crc32cGenerator);
      expect(twin.universeDomain).toBe('example.test');
      expect(twin.useAuthWithCustomEndpoint).toBe(true);
      expect(twin.retryOptions).toMatchObject({
        autoRetry: false,
        maxRetries: 7,
        retryableErrorFn,
        idempotencyStrategy: 2,
      });
      expect(twin.retryOptions).not.toBe(own.retryOptions);
    });

    it.each([
      ['with a trailing slash', 'https://storage.googleapis.com/'],
      ['with no scheme', 'storage.googleapis.com'],
    ])(
      'take the default endpoint written %s as the client does: custom, so sent without credentials',
      (_, apiEndpoint) => {
        const own = new Storage({ apiEndpoint, projectId: 'p' });
        const built = new GcsStorage({ bucket: 'b', apiEndpoint, projectId: 'p' });
        for (const [client, twin] of [
          [own, readClientOf(new GcsStorage({ bucket: 'b', client: own }))],
          [built.client, readClientOf(built)],
        ] as const) {
          expect(client.customEndpoint).toBe(true);
          expect([twin.baseUrl, twin.apiEndpoint, twin.customEndpoint]).toEqual([
            client.baseUrl,
            client.apiEndpoint,
            true,
          ]);
        }
      },
    );

    it('build a twin for a client whose retries read off while a write of its own is in flight, and keep it off', async () => {
      // The SDK turns a client's `autoRetry` off while a delete with no precondition is in flight, and back on when it
      // ends: a store built over a shared client meanwhile must not take that reading for how the client was built.
      const stub = await startStub();
      try {
        const own = new Storage({ apiEndpoint: stub.endpoint, projectId: 'p' });
        const deleting = own.bucket('b').file('o').delete();
        expect(own.retryOptions.autoRetry).toBe(false);
        const twin = readClientOf(new GcsStorage({ bucket: 'b', client: own }));
        await deleting;
        expect(own.retryOptions.autoRetry).toBe(true);
        expect(twin).not.toBe(own);
        expect(twin.retryOptions.autoRetry).toBe(false);
      } finally {
        await stub.close();
      }
    });

    it('give a client built with its retries off a twin as well, with retry settings of its own', () => {
      const own = new Storage({
        apiEndpoint: 'http://127.0.0.1:1',
        projectId: 'p',
        retryOptions: { autoRetry: false },
      });
      const twin = readClientOf(new GcsStorage({ bucket: 'b', client: own }));
      expect(twin).not.toBe(own);
      expect(twin.retryOptions.autoRetry).toBe(false);
      expect(twin.retryOptions).not.toBe(own.retryOptions);
    });

    describe('a subclass, a stub or a test double', () => {
      class Pinned extends Storage {
        // An organisation's wrapper that sets its own retry policy whatever it is given.
        constructor(options: StorageOptions = {}) {
          super({ ...options, retryOptions: { maxRetries: 3 } });
        }
      }
      class FromConfig extends Storage {
        // An application's client built from its own configuration, not from the SDK's options.
        constructor(config: { project?: string; endpoint?: string; retries?: boolean }) {
          super({
            projectId: config.project,
            apiEndpoint: config.endpoint,
            retryOptions: { autoRetry: config.retries ?? true },
          });
        }
      }
      /** What a request's credential header would hold, built as the scrubber's own tests build it. */
      const SIGNED = `Bearer ${'SECRET'}`;
      class Throws extends Storage {
        constructor(options?: StorageOptions) {
          if (options?.authClient !== undefined) {
            throw Object.assign(new Error('cannot build'), {
              config: { headers: { Authorization: SIGNED } },
            });
          }
          super({ apiEndpoint: 'http://127.0.0.1:1', projectId: 'p' });
        }
      }
      /** A subclass that hands back the one client it ever built. */
      class Single extends Storage {
        static built: Single | undefined;
        constructor(options: StorageOptions = {}) {
          super(options);
          if (Single.built !== undefined) return Single.built;
          Single.built = this;
        }
      }
      const SHARED = { autoRetry: true, maxRetries: 3 };
      /** A subclass whose every client holds one retry settings object. */
      class SharedRetries extends Storage {
        constructor(options: StorageOptions = {}) {
          super(options);
          this.retryOptions = SHARED as Storage['retryOptions'];
        }
      }
      /** A test double that keeps objects in memory: a new one is another, empty store. */
      class InMemory {
        readonly files = new Map<string, Uint8Array>();
        constructor(readonly retryOptions?: { autoRetry: boolean }) {}
        bucket(): never {
          throw new Error('not reached');
        }
      }
      const refusal = (client: unknown): Error => {
        try {
          new GcsStorage({ bucket: 'b', client: client as Storage });
        } catch (err) {
          expect(err).toBeInstanceOf(ValidationError);
          return err as Error;
        }
        throw new Error('built');
      };
      const at = { apiEndpoint: 'http://127.0.0.1:1', projectId: 'p' };

      it('a subclass that sets its own retries gets a twin with them off, and keeps the rest of its policy', () => {
        const own = new Pinned(at);
        const twin = readClientOf(new GcsStorage({ bucket: 'b', client: own }));
        expect(twin).not.toBe(own);
        expect(twin.retryOptions.autoRetry).toBe(false);
        expect(twin.retryOptions.maxRetries).toBe(3);
        expect(own.retryOptions.autoRetry).toBe(true);
      });

      it.each([
        [
          'built from its own configuration',
          () => new FromConfig({ project: 'p', endpoint: at.apiEndpoint }),
          /would use other credentials/,
        ],
        [
          'built from its own configuration, with its retries off',
          () => new FromConfig({ project: 'p', endpoint: at.apiEndpoint, retries: false }),
          /would use other credentials/,
        ],
        ['that hands back one client', () => new Single(at), /is the same client/],
        [
          'whose clients share retry settings',
          () => new SharedRetries(at),
          /would share its retry settings/,
        ],
      ])('refuses a subclass %s, whatever its retries read', (_, build, why) => {
        Single.built = undefined;
        const err = refusal(build());
        expect(err.message).toMatch(why);
        expect(err.message).toMatch(/builds from the options it is given/);
        expect(SHARED.autoRetry).toBe(true);
      });

      it('refuses a subclass whose constructor throws, with the cause kept and its credentials left out', () => {
        const err = refusal(new Throws());
        expect(err.message).toMatch(/could not be built/);
        const cause = err.cause as Error & { config?: unknown };
        expect(cause.message).toBe('cannot build');
        expect(cause.config).toBeUndefined();
        expect(JSON.stringify(cause)).not.toContain(SIGNED);
      });

      it('refuses a client whose `bucket` is stubbed on the instance, and takes one stubbed on the prototype', () => {
        const stubbed = new Storage({ ...at, retryOptions: { autoRetry: false } });
        vi.spyOn(stubbed, 'bucket');
        expect(refusal(stubbed).message).toMatch(
          /replaced on the instance.*Storage\.prototype\.bucket/,
        );
        const marker = {} as ReturnType<Storage['bucket']>;
        const spy = vi.spyOn(Storage.prototype, 'bucket').mockReturnValue(marker);
        try {
          const twin = readClientOf(new GcsStorage({ bucket: 'b', client: new Storage(at) }));
          expect(twin.bucket('b')).toBe(marker);
        } finally {
          spy.mockRestore();
        }
      });

      it.each([
        [
          'a plain-object double',
          (retryOptions?: { autoRetry: boolean }) => ({ bucket: () => undefined, retryOptions }),
        ],
        [
          'an in-memory double',
          (retryOptions?: { autoRetry: boolean }) => new InMemory(retryOptions),
        ],
      ])('uses %s as it is with its retries off, and refuses it without', (_, build) => {
        const off = build({ autoRetry: false });
        expect(
          readClientOf(new GcsStorage({ bucket: 'b', client: off as unknown as Storage })),
        ).toBe(off);
        const err = refusal(build());
        expect(err.message).toMatch(/not a `Storage` client.*autoRetry: false/);
      });

      it.each([
        ['baseUrl', 'http://127.0.0.1:2/storage/v1', /would send to another URL/],
        ['apiEndpoint', 'http://127.0.0.1:2', /would name another endpoint/],
        ['customEndpoint', true, /whether requests carry credentials/],
      ] as const)("refuses a twin whose %s differs from the client's", (field, other, why) => {
        const auth = {};
        /** A client whose second instance, the one built with options, differs from the first in `field` alone. */
        class Differs {
          // As the SDK's constructor leaves them: the request factory carries the client's credentials object.
          readonly makeAuthenticatedRequest: (() => void) & { authClient?: unknown };
          readonly authClient: unknown;
          retryOptions = { autoRetry: true };
          readonly baseUrl: unknown = 'http://127.0.0.1:1/storage/v1';
          readonly apiEndpoint: unknown = 'http://127.0.0.1:1';
          readonly customEndpoint: unknown = false;
          constructor(options?: StorageOptions) {
            this.authClient = options?.authClient ?? auth;
            this.makeAuthenticatedRequest = Object.assign(() => undefined, {
              authClient: this.authClient,
            });
            if (options !== undefined) Object.assign(this, { [field]: other });
          }
          bucket(): void {}
          getRequestInterceptors(): unknown[] {
            return [];
          }
        }
        expect(refusal(new Differs()).message).toMatch(why);
      });

      it('refuses a subclass that overrides `bucket`, as an in-memory double built on `Storage` does', () => {
        class MemStorage extends Storage {
          readonly files = new Map<string, Uint8Array>();
          override bucket(name: string): ReturnType<Storage['bucket']> {
            return super.bucket(name);
          }
        }
        const err = refusal(new MemStorage({ ...at, retryOptions: { autoRetry: false } }));
        expect(err.message).toMatch(/its class overrides `bucket`.*does not extend `Storage`/);
      });

      it('takes an auto-mock that answers every property as a test double, not as a `Storage` client', () => {
        // As a mocking library's `mock<Storage>()` behaves: a function for any property not set on it.
        const mockOf = (set: Record<string, unknown>): Storage =>
          new Proxy(set, {
            get: (target, key) => (key in target ? target[key as string] : () => undefined),
          }) as unknown as Storage;
        const off = mockOf({ retryOptions: { autoRetry: false } });
        expect(readClientOf(new GcsStorage({ bucket: 'b', client: off }))).toBe(off);
        expect(refusal(mockOf({})).message).toMatch(/not a `Storage` client/);
      });

      it('says to pass the mock as `client` when the backend built its own from a mocked module', () => {
        expect(() =>
          downloadClient({ bucket: () => undefined } as unknown as Storage, false),
        ).toThrow(/is not the SDK's \(a mocked module, say\)\. Pass the mock as `client`/);
      });

      it('refuses a client built before STORAGE_EMULATOR_HOST was set, whose twin would go to the emulator', () => {
        const own = new Storage(at);
        const before = process.env.STORAGE_EMULATOR_HOST;
        process.env.STORAGE_EMULATOR_HOST = 'http://127.0.0.1:9';
        try {
          expect(refusal(own).message).toMatch(/would send to another URL/);
        } finally {
          if (before === undefined) delete process.env.STORAGE_EMULATOR_HOST;
          else process.env.STORAGE_EMULATOR_HOST = before;
        }
      });

      it('says only what went wrong when the client is the one the backend builds', () => {
        expect(() => downloadClient(new Single(at), false)).toThrow(
          /^GcsStorage cannot build a client that sends downloads without the SDK's retries: a second client built from the same settings is the same client$/,
        );
      });
    });

    it('built for the caller, share one set of credentials between the two clients', () => {
      const backend = new GcsStorage({
        bucket: 'b',
        apiEndpoint: 'http://127.0.0.1:1',
        projectId: 'p',
      });
      expect(readClientOf(backend).authClient).toBe(backend.client.authClient);
    });
  });
});
