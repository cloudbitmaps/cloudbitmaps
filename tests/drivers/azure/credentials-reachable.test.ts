import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  NotFoundError,
  TransientError,
  ValidationError,
  WriteConflictError,
} from '@cloudbitmaps/core/driver-kit';
import { AnonymousCredential, ContainerClient, RestError } from '@azure/storage-blob';
import { StorageSharedKeyCredential } from '@azure/storage-blob';
import { AzureBlobRegistryDriver, AzureBlobRegistryStore } from '@/azure-blob/registry';
import { AzureBlobStorageDriver } from '@/azure-blob/storage';
import { guardLoopback } from '../../helpers/loopback-guard';

/**
 * An error the Azure driver throws carries no credential in anything code can reach, not only in what a logger prints.
 * The SDK keeps the request it sent on `err.request` and `err.response.request`, with the signed `Authorization`
 * header (SharedKey) or the SAS signature in the URL (`sig=`), on properties `util.inspect` and `JSON.stringify` hide.
 * Every object reachable from the error is walked here: own properties (non-enumerable and symbol-keyed included),
 * map entries and the `cause` chain. The error class and the driver's classification are checked unchanged.
 */
const ACCOUNT_KEY = Buffer.from('stand-in-account-key-0123456789').toString('base64');
const SAS_SIGNATURE = 'SECRETSIGNATUREVALUE0123456789';
const GEN = { segment: 's', generation: 1 };
const LIMIT = { timeout: 30_000 };
/** The code Azure sends with a status that has a specific one. */
const CODES: Record<number, string> = {
  404: 'BlobNotFound',
  409: 'BlobAlreadyExists',
  412: 'ConditionNotMet',
};

/** Anything that shows a credential: a SharedKey header, an account key, or a `sig=` that is not redacted. */
const LEAK = new RegExp(
  `SharedKey\\s|${ACCOUNT_KEY.replace(/[+/=]/g, '\\$&')}|${SAS_SIGNATURE}|sig=(?!\\[redacted\\])`,
);

/** The signatures the requests carried, as the server saw them: the SharedKey MAC and the SAS `sig`, both encodings. */
const seen = { signatures: new Set<string>() };
const signaturesIn = (text: string): string[] =>
  [...seen.signatures].filter((signature) => text.includes(signature));

/** Every string reachable from `root`, keys included, with a guard against cycles. */
function reachableStrings(root: unknown): string[] {
  const strings: string[] = [];
  const visited = new Set<unknown>();
  const visit = (value: unknown): void => {
    if (typeof value === 'string') {
      strings.push(value);
      return;
    }
    if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return;
    if (visited.has(value)) return;
    visited.add(value);
    if (value instanceof Map) {
      for (const [k, v] of value) {
        visit(k);
        visit(v);
      }
    } else if (value instanceof Set) {
      for (const v of value) visit(v);
    }
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key === 'string') strings.push(key);
      let child: unknown;
      try {
        child = (value as Record<string | symbol, unknown>)[key];
      } catch {
        continue;
      }
      visit(child);
    }
    visit(Object.getPrototypeOf(value));
  };
  visit(root);
  return strings;
}

/** An error and the errors in its `cause` chain. */
function chain(err: unknown): unknown[] {
  const out: unknown[] = [];
  for (let e = err, i = 0; typeof e === 'object' && e !== null && i < 10; i++) {
    out.push(e);
    e = (e as { cause?: unknown }).cause;
  }
  return out;
}

async function outcome(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error('expected a failure');
}

type Client = 'sharedkey' | 'sas';
interface Case {
  name: string;
  /** The status the server answers a write with, and a HEAD or GET with (the same when absent). */
  status: number;
  head?: number;
  /** The `x-ms-error-code` the server sends; the status's usual one when absent. */
  code?: string;
  /** The 403 body quotes the request's own signature, as Azure does for a signature it could not verify. */
  echo?: boolean;
  /** The error's `cause` is the SDK's error: the driver raised its own class around it. */
  cause?: boolean;
  run: (c: ContainerClient) => Promise<unknown>;
  /** The class the driver raises; the SDK's own `RestError` when it passes it on. */
  expected: abstract new (...args: never[]) => Error;
}

const cases: Case[] = [
  {
    name: 'storage read, 403',
    status: 403,
    run: (c) => new AzureBlobStorageDriver({ containerClient: c }).getRange(GEN, 0, 8),
    expected: RestError,
  },
  {
    name: 'storage read, 404',
    status: 404,
    run: (c) => new AzureBlobStorageDriver({ containerClient: c }).getRange(GEN, 0, 8),
    expected: NotFoundError,
  },
  {
    name: 'storage tail, 503',
    status: 503,
    run: (c) => new AzureBlobStorageDriver({ containerClient: c }).getTail(GEN, 8),
    expected: TransientError,
  },
  {
    name: 'storage write, 403',
    status: 403,
    run: (c) =>
      new AzureBlobStorageDriver({ containerClient: c }).putImmutable(GEN, async (sink) => {
        await sink.write(new Uint8Array([1, 2, 3]));
      }),
    expected: RestError,
  },
  {
    name: 'storage write, 409',
    status: 409,
    head: 404,
    run: (c) =>
      new AzureBlobStorageDriver({ containerClient: c }).putImmutable(GEN, async (sink) => {
        await sink.write(new Uint8Array([1, 2, 3]));
      }),
    expected: WriteConflictError,
  },
  {
    name: 'storage write, 412',
    status: 412,
    head: 404,
    run: (c) =>
      new AzureBlobStorageDriver({ containerClient: c }).putImmutable(GEN, async (sink) => {
        await sink.write(new Uint8Array([1, 2, 3]));
      }),
    expected: WriteConflictError,
  },
  {
    name: 'storage write, 503',
    status: 503,
    run: (c) =>
      new AzureBlobStorageDriver({ containerClient: c }).putImmutable(GEN, async (sink) => {
        await sink.write(new Uint8Array([1, 2, 3]));
      }),
    expected: TransientError,
  },
  {
    name: 'registry read, 403',
    status: 403,
    run: (c) => new AzureBlobRegistryDriver({ containerClient: c }).get({ segment: 's' }),
    expected: RestError,
  },
  {
    name: 'registry read, 503',
    status: 503,
    run: (c) => new AzureBlobRegistryDriver({ containerClient: c }).get({ segment: 's' }),
    expected: TransientError,
  },
  {
    name: 'registry create, 409',
    status: 409,
    head: 404,
    run: (c) =>
      new AzureBlobRegistryDriver({ containerClient: c }).create(
        { segment: 's' },
        { currentGen: 0 },
      ),
    expected: WriteConflictError,
  },
  {
    name: 'registry create, 503',
    status: 503,
    run: (c) =>
      new AzureBlobRegistryDriver({ containerClient: c }).create(
        { segment: 's' },
        { currentGen: 0 },
      ),
    expected: TransientError,
  },
];

const put = (c: ContainerClient): Promise<unknown> =>
  new AzureBlobStorageDriver({ containerClient: c }).putImmutable(GEN, async (sink) => {
    await sink.write(new Uint8Array([1, 2, 3]));
  });
const registry = (c: ContainerClient): AzureBlobRegistryDriver =>
  new AzureBlobRegistryDriver({ containerClient: c });
/** The registry's own calls, under the driver that adds the row layer. */
const store = (c: ContainerClient): AzureBlobRegistryStore =>
  new AzureBlobRegistryStore(c, 0, true);
const drain = async (items: AsyncIterable<unknown>): Promise<void> => {
  for await (const item of items) void item;
};

const more: Case[] = [
  {
    name: 'storage read, 403 echoing the request signature',
    status: 403,
    code: 'AuthenticationFailed',
    echo: true,
    run: (c) => new AzureBlobStorageDriver({ containerClient: c }).getRange(GEN, 0, 8),
    expected: RestError,
  },
  {
    name: 'storage write, 403 echoing the request signature',
    status: 403,
    code: 'AuthenticationFailed',
    echo: true,
    run: put,
    expected: RestError,
  },
  {
    name: 'registry read, 403 echoing the request signature',
    status: 403,
    code: 'AuthenticationFailed',
    echo: true,
    run: (c) => registry(c).get({ segment: 's' }),
    expected: RestError,
  },
  {
    name: 'storage read, ContainerNotFound',
    status: 404,
    code: 'ContainerNotFound',
    cause: true,
    run: (c) => new AzureBlobStorageDriver({ containerClient: c }).getRange(GEN, 0, 8),
    expected: ValidationError,
  },
  {
    name: 'storage tail, ContainerNotFound',
    status: 404,
    code: 'ContainerNotFound',
    cause: true,
    run: (c) => new AzureBlobStorageDriver({ containerClient: c }).getTail(GEN, 8),
    expected: ValidationError,
  },
  {
    name: 'storage write, ContainerNotFound',
    status: 404,
    code: 'ContainerNotFound',
    cause: true,
    run: put,
    expected: ValidationError,
  },
  {
    name: 'registry read, ContainerNotFound',
    status: 404,
    code: 'ContainerNotFound',
    cause: true,
    run: (c) => registry(c).get({ segment: 's' }),
    expected: ValidationError,
  },
  {
    name: 'storage delete, 403 echoing the request signature',
    status: 403,
    code: 'AuthenticationFailed',
    echo: true,
    run: (c) => new AzureBlobStorageDriver({ containerClient: c }).delete(GEN),
    expected: RestError,
  },
  {
    name: 'storage delete, 503',
    status: 503,
    run: (c) => new AzureBlobStorageDriver({ containerClient: c }).delete(GEN),
    expected: TransientError,
  },
  {
    name: 'storage delete, ContainerNotFound',
    status: 404,
    code: 'ContainerNotFound',
    cause: true,
    run: (c) => new AzureBlobStorageDriver({ containerClient: c }).delete(GEN),
    expected: ValidationError,
  },
  {
    name: 'storage delete under a version, 403',
    status: 403,
    code: 'AuthenticationFailed',
    echo: true,
    run: (c) =>
      new AzureBlobStorageDriver({ containerClient: c }).delete(GEN, { ifVersion: '"v"' }),
    expected: RestError,
  },
  {
    name: 'storage list, 403 echoing the request signature',
    status: 403,
    code: 'AuthenticationFailed',
    echo: true,
    run: (c) => drain(new AzureBlobStorageDriver({ containerClient: c }).list({ segment: 's' })),
    expected: RestError,
  },
  {
    name: 'storage list, ContainerNotFound',
    status: 404,
    code: 'ContainerNotFound',
    cause: true,
    run: (c) => drain(new AzureBlobStorageDriver({ containerClient: c }).list({ segment: 's' })),
    expected: ValidationError,
  },
  {
    name: 'registry delete, 403 echoing the request signature',
    status: 403,
    code: 'AuthenticationFailed',
    echo: true,
    run: (c) => store(c).delete('k', { version: '"v"' }),
    expected: RestError,
  },
  {
    name: 'registry delete, 503',
    status: 503,
    run: (c) => store(c).delete('k', { version: '"v"' }),
    expected: TransientError,
  },
  {
    name: 'registry listKeys, 403 echoing the request signature',
    status: 403,
    code: 'AuthenticationFailed',
    echo: true,
    run: (c) => drain(store(c).listKeys('p')),
    expected: RestError,
  },
  {
    name: 'registry listKeys, ContainerNotFound',
    status: 404,
    code: 'ContainerNotFound',
    cause: true,
    run: (c) => drain(store(c).listKeys('p')),
    expected: ValidationError,
  },
  {
    name: 'registry compare-and-swap write, 403 echoing the request signature',
    status: 403,
    code: 'AuthenticationFailed',
    echo: true,
    run: (c) => store(c).write('k', new Uint8Array([1]), { version: '"v"' }),
    expected: RestError,
  },
  {
    name: 'registry compare-and-swap write, 412',
    status: 412,
    head: 404,
    run: (c) => store(c).write('k', new Uint8Array([1]), { version: '"v"' }),
    expected: WriteConflictError,
  },
  {
    name: 'registry compare-and-swap write, 503',
    status: 503,
    run: (c) => store(c).write('k', new Uint8Array([1]), { version: '"v"' }),
    expected: TransientError,
  },
];
cases.push(...more);

describe('Azure: no credential is reachable from an error the driver throws', LIMIT, () => {
  let server: Server;
  let url: string;
  let answer: { status: number; head: number; code?: string; echo?: boolean };
  let guard: ReturnType<typeof guardLoopback>;

  beforeAll(() => {
    guard = guardLoopback();
  });
  afterAll(() => {
    guard.restore();
    // Nothing was sent anywhere but the loopback server.
    expect(guard.attempts).toEqual([]);
  });

  beforeEach(async () => {
    answer = { status: 503, head: 503 };
    seen.signatures.clear();
    server = createServer((req, res) => {
      req.resume();
      const code = answer.code ?? CODES[answer.status] ?? 'Refused';
      const headers: Record<string, string> = {
        'content-type': 'application/xml',
        'x-ms-error-code': code,
      };
      res.writeHead(
        req.method === 'HEAD' || req.method === 'GET' ? answer.head : answer.status,
        headers,
      );
      if (req.method === 'HEAD') return void res.end();
      let message = 'refused';
      let detail = '';
      if (answer.echo) {
        // What Azure quotes back: the request's own MAC signature, and (here, as a proxy page would) its URL, encoded.
        const mac = /^SharedKey [^:]+:(.+)$/.exec(String(req.headers.authorization ?? ''))?.[1];
        const sas = /[?&]sig=([^&]+)/.exec(req.url ?? '')?.[1];
        if (mac !== undefined) {
          seen.signatures.add(mac);
          detail = `The MAC signature found in the HTTP request '${mac}' is not the same as any computed signature.`;
        }
        if (sas !== undefined) {
          seen.signatures.add(sas);
          message = `refused https://x/c?sv=1%26sig%3D${encodeURIComponent(sas)}%26se=2 and ?sv=1&sig=${sas}`;
        }
      }
      res.end(
        `<Error><Code>${code}</Code><Message>${message}</Message>` +
          (detail === ''
            ? ''
            : `<AuthenticationErrorDetail>${detail}</AuthenticationErrorDetail>`) +
          '</Error>',
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const client = (kind: Client): ContainerClient =>
    kind === 'sharedkey'
      ? new ContainerClient(`${url}/c`, new StorageSharedKeyCredential('stand-in', ACCOUNT_KEY), {
          retryOptions: { maxTries: 1 },
        })
      : new ContainerClient(
          `${url}/c?sv=2022-11-02&sp=rw&sig=${SAS_SIGNATURE}`,
          new AnonymousCredential(),
          { retryOptions: { maxTries: 1 } },
        );

  describe.each<Client>(['sharedkey', 'sas'])('%s client', (kind) => {
    it.each(cases)('$name', async ({ status, head, code, echo, cause, run, expected }) => {
      answer = { status, head: head ?? status, code, echo };
      const err = await outcome(() => run(client(kind)));
      expect(err).toBeInstanceOf(expected);
      if (echo) expect(seen.signatures.size).toBeGreaterThan(0);
      if (cause) {
        const inner = (err as { cause?: unknown }).cause as RestError;
        expect(inner).toBeInstanceOf(RestError);
        expect(inner.statusCode).toBe(404);
        // A HEAD has no body, so its code reaches `details.errorCode` from the header alone.
        expect(inner.code ?? (inner.details as { errorCode?: string }).errorCode).toBe(
          'ContainerNotFound',
        );
      }
      for (const e of chain(err)) {
        const { request, response } = e as {
          request?: { headers?: { get?: (n: string) => unknown }; url?: string };
          response?: { request?: unknown };
        };
        expect(request?.headers?.get?.('authorization')).toBeUndefined();
        expect(request?.url ?? '').not.toMatch(LEAK);
        expect(response?.request).toBeUndefined();
        for (const text of reachableStrings(e)) {
          expect(text).not.toMatch(LEAK);
          expect(signaturesIn(text)).toEqual([]);
        }
      }
    });
  });

  it('keeps what classification reads on the error the driver passes on', async () => {
    answer = { status: 403, head: 403 };
    const err = (await outcome(() =>
      new AzureBlobStorageDriver({ containerClient: client('sas') }).getRange(GEN, 0, 8),
    )) as RestError;
    expect(err.name).toBe('RestError');
    expect(err.statusCode).toBe(403);
    expect(err.message).not.toMatch(LEAK);
    expect(String(err.stack)).not.toMatch(LEAK);
  });
});

describe('the walker finds what the SDK hides', () => {
  it('sees a credential on a non-enumerable request, in a map', () => {
    const err = new Error('x');
    Object.defineProperty(err, 'request', {
      value: { headers: new Map([['authorization', 'SharedKey a:b']]) },
      enumerable: false,
    });
    expect(reachableStrings(err).some((t) => LEAK.test(t))).toBe(true);
  });
  it('does not flag a redacted signature', () => {
    expect(LEAK.test('https://h/c?sig=[redacted]&sv=1')).toBe(false);
  });
});
