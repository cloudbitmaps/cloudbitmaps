import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { NotFoundError, TransientError, WriteConflictError } from '@cloudbitmaps/core/driver-kit';
import { AnonymousCredential, ContainerClient, RestError } from '@azure/storage-blob';
import { StorageSharedKeyCredential } from '@azure/storage-blob';
import { AzureBlobRegistryDriver } from '@/azure-blob/registry';
import { AzureBlobStorageDriver } from '@/azure-blob/storage';

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
const CODES: Record<number, string> = { 409: 'BlobAlreadyExists', 412: 'ConditionNotMet' };

/** Anything that shows a credential: a SharedKey header, an account key, or a `sig=` that is not redacted. */
const LEAK = new RegExp(
  `SharedKey\\s|${ACCOUNT_KEY.replace(/[+/=]/g, '\\$&')}|${SAS_SIGNATURE}|sig=(?!\\[redacted\\])`,
);

/** Every string reachable from `root`, keys included, with a guard against cycles. */
function reachableStrings(root: unknown): string[] {
  const strings: string[] = [];
  const seen = new Set<unknown>();
  const visit = (value: unknown): void => {
    if (typeof value === 'string') {
      strings.push(value);
      return;
    }
    if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return;
    if (seen.has(value)) return;
    seen.add(value);
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

describe('Azure: no credential is reachable from an error the driver throws', LIMIT, () => {
  let server: Server;
  let url: string;
  let answer: { status: number; head: number };

  beforeEach(async () => {
    answer = { status: 503, head: 503 };
    server = createServer((req, res) => {
      req.resume();
      res.writeHead(req.method === 'HEAD' || req.method === 'GET' ? answer.head : answer.status, {
        'content-type': 'application/xml',
      });
      res.end(
        req.method === 'HEAD'
          ? undefined
          : `<Error><Code>${CODES[answer.status] ?? 'Refused'}</Code><Message>refused</Message></Error>`,
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
    it.each(cases)('$name', async ({ status, head, run, expected }) => {
      answer = { status, head: head ?? status };
      const err = await outcome(() => run(client(kind)));
      expect(err).toBeInstanceOf(expected);
      for (const e of chain(err)) {
        const { request, response } = e as {
          request?: { headers?: { get?: (n: string) => unknown }; url?: string };
          response?: { request?: unknown };
        };
        expect(request?.headers?.get?.('authorization')).toBeUndefined();
        expect(request?.url ?? '').not.toMatch(LEAK);
        expect(response?.request).toBeUndefined();
        for (const text of reachableStrings(e)) expect(text).not.toMatch(LEAK);
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
