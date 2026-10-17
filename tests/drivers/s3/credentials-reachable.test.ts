import { createServer } from 'node:http';
import type { IncomingMessage, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  NotFoundError,
  TransientError,
  ValidationError,
  WriteConflictError,
} from '@cloudbitmaps/core/driver-kit';
import { GetObjectCommand, S3Client, S3ServiceException } from '@aws-sdk/client-s3';
import { S3RegistryDriver, S3RegistryStore } from '@/s3/registry';
import { scrubCredentials } from '@/s3/scrub-error';
import { S3StorageDriver } from '@/s3/storage';

/**
 * An error the S3 driver throws carries no credential in anything code can reach, not only in what a logger prints.
 * The SDK keeps its HTTP response on `err.$response`, and through the socket the request it sent, with the signed
 * `Authorization` header and `x-amz-security-token`. It also puts every field of the error body on the error: a
 * `SignatureDoesNotMatch` body quotes the request's signature and its canonical request (session token included, in
 * text and in hex), and a proxy's error page can quote the `Authorization` value and the token inside a line. Every
 * object reachable from the error is walked here: own properties (non-enumerable and symbol-keyed included, getters
 * read), map and set entries, prototypes and the `cause` chain. The class the driver raises is checked as well.
 */
// Built at run time, so the leak scan never reads a credential-looking literal in this file.
const KEY_ID = ['STAND', 'IN', 'KEYID'].join('');
const SECRET = ['stand', 'in', 'secret', 'access', 'key', '0123456789'].join('-');
const TOKEN = ['stand', 'in', 'session', 'token', '0123456789'].join('-');
const GEN = { segment: 's', generation: 1 };
const LIMIT = { timeout: 30_000 };
const hex = (text: string): string =>
  [...Buffer.from(text)].map((b) => b.toString(16).padStart(2, '0')).join(' ');

/** The code S3 sends with a status that has a specific one. */
const CODES: Record<number, string> = {
  403: 'AccessDenied',
  404: 'NoSuchKey',
  409: 'ConditionalRequestConflict',
  412: 'PreconditionFailed',
  503: 'SlowDown',
};

/** What the requests carried, as the server saw them: each signature, and the session token. */
const seen = { signatures: new Set<string>(), tokens: new Set<string>() };
const secretsIn = (text: string): string[] =>
  [SECRET, TOKEN, hex(TOKEN), ...seen.signatures, ...seen.tokens].filter((secret) =>
    text.includes(secret),
  );

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
  for (let e = err, i = 0; typeof e === 'object' && e !== null && i < 12; i++) {
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

/** How the server answers. */
type Body =
  /** An S3 error document with the code. */
  | 'error'
  /** S3's `SignatureDoesNotMatch` document, which quotes the request back. */
  | 'echo'
  /** A proxy's HTML page that quotes the `Authorization` value and the token inside a line. */
  | 'proxy'
  /** A JSON body that quotes every request header: the SDK cannot parse it, and keeps it as text. */
  | 'json'
  /** S3's answer to a session token it refuses (`ExpiredToken`, `InvalidToken`), which quotes it in `Token-0`. */
  | 'token';

type Client = 'session' | 'static';
interface Case {
  name: string;
  /** The status the server answers with, and a HEAD with (the same when absent). */
  status: number;
  head?: number;
  /** The error code the body names; the status's usual one when absent. */
  code?: string;
  body?: Body;
  /** The error's `cause` is the SDK's error: the driver raised its own class around it. */
  cause?: boolean;
  run: (c: S3Client) => Promise<unknown>;
  /** The class the driver raises; the SDK's own when it passes the SDK's error on. */
  expected: abstract new (...args: never[]) => Error;
}

const sleepless = { sleep: async (): Promise<void> => {} };
const storage = (c: S3Client, extra: Record<string, unknown> = {}): S3StorageDriver =>
  new S3StorageDriver({ client: c, bucket: 'b', clock: sleepless, ...extra });
const put = (c: S3Client): Promise<unknown> =>
  storage(c).putImmutable(GEN, async (sink) => {
    await sink.write(new Uint8Array([1, 2, 3]));
  });
/** A write larger than one part: a multipart upload. */
const putParts = (c: S3Client): Promise<unknown> =>
  storage(c, { partBytes: 4 }).putImmutable(GEN, async (sink) => {
    await sink.write(new Uint8Array(9));
  });
const registry = (c: S3Client): S3RegistryDriver =>
  new S3RegistryDriver({ client: c, bucket: 'b' });
/** The registry's own calls, under the driver that adds the row layer. */
const store = (c: S3Client): S3RegistryStore => new S3RegistryStore(c, 'b', 0);
const drain = async (items: AsyncIterable<unknown>): Promise<void> => {
  for await (const item of items) void item;
};
const read = (c: S3Client): Promise<unknown> => storage(c).getRange(GEN, 0, 8);
const tail = (c: S3Client): Promise<unknown> => storage(c).getTail(GEN, 8);
const head = (c: S3Client): Promise<unknown> => storage(c).getTail(GEN, 0);
const del = (c: S3Client): Promise<unknown> => storage(c).delete(GEN);
const delIf = (c: S3Client): Promise<unknown> =>
  storage(c, { conditionalDelete: true }).delete(GEN, { ifVersion: '"v"' });
const list = (c: S3Client): Promise<unknown> => drain(storage(c).list({ segment: 's' }));
const get = (c: S3Client): Promise<unknown> => registry(c).get({ segment: 's' });
const create = (c: S3Client): Promise<unknown> =>
  registry(c).create({ segment: 's' }, { currentGen: 0 });
const cas = (c: S3Client): Promise<unknown> =>
  store(c).write('k', new Uint8Array([1]), { version: '"v"' });
const rowDelete = (c: S3Client): Promise<unknown> => store(c).delete('k', { version: '"v"' });
const listKeys = (c: S3Client): Promise<unknown> => drain(store(c).listKeys('p'));

const SDK = S3ServiceException as unknown as abstract new (...args: never[]) => Error;
const missing = { status: 404, code: 'NoSuchBucket', cause: true, expected: ValidationError };
const refused = { status: 403, expected: SDK };
const echo = { status: 403, code: 'SignatureDoesNotMatch', body: 'echo' as const, expected: SDK };
const throttled = { status: 503, cause: true, expected: TransientError };
const proxy = { status: 502, body: 'proxy' as const, cause: true, expected: TransientError };
const unparsed = { status: 400, body: 'json' as const, expected: Error };

/** Every call that sends a body-carrying request, for the answers each of them can get. */
const calls: [string, (c: S3Client) => Promise<unknown>][] = [
  ['storage read', read],
  ['storage tail', tail],
  ['storage write', put],
  ['storage multipart write', putParts],
  ['storage delete', del],
  ['storage delete under a version', delIf],
  ['storage list', list],
  ['registry read', get],
  ['registry create', create],
  ['registry compare-and-swap write', cas],
  ['registry delete', rowDelete],
  ['registry listKeys', listKeys],
];
const quoting: Omit<Case, 'name' | 'run'>[] = [
  { status: 400, code: 'ExpiredToken', body: 'token', expected: SDK },
  { status: 400, code: 'InvalidToken', body: 'token', expected: SDK },
];
const answerName = (answer: Omit<Case, 'name' | 'run'>): string =>
  `${String(answer.code)} quoting the token`;

const cases: Case[] = [
  { name: 'storage read, 403', ...refused, run: read },
  { name: 'storage read, 403 quoting the request', ...echo, run: read },
  { name: 'storage read, 404', status: 404, run: read, expected: NotFoundError },
  { name: 'storage read, NoSuchBucket', ...missing, run: read },
  { name: 'storage read, 503', ...throttled, run: read },
  { name: 'storage read, a proxy page quoting the request', ...proxy, run: read },
  { name: 'storage read, an unparsed body quoting the request', ...unparsed, run: read },
  { name: 'storage tail, 403 quoting the request', ...echo, run: tail },
  { name: 'storage tail, NoSuchBucket', ...missing, run: tail },
  { name: 'storage tail, 503', ...throttled, run: tail },
  { name: 'storage head, 403', ...refused, run: head },
  { name: 'storage head, 404', status: 404, run: head, expected: NotFoundError },
  { name: 'storage head, 503', ...throttled, run: head },
  { name: 'storage write, 403', ...refused, run: put },
  { name: 'storage write, 403 quoting the request', ...echo, run: put },
  { name: 'storage write, 409', status: 409, head: 404, run: put, expected: WriteConflictError },
  { name: 'storage write, 412', status: 412, head: 404, run: put, expected: WriteConflictError },
  { name: 'storage write, 503', ...throttled, head: 404, run: put },
  { name: 'storage write, NoSuchBucket', ...missing, run: put },
  { name: 'storage write, a proxy page quoting the request', ...proxy, run: put },
  { name: 'storage write, an unparsed body quoting the request', ...unparsed, run: put },
  { name: 'storage multipart write, 403 quoting the request', ...echo, run: putParts },
  { name: 'storage multipart write, 503', ...throttled, run: putParts },
  { name: 'storage delete, 403 quoting the request', ...echo, run: del },
  { name: 'storage delete, 503', ...throttled, run: del },
  { name: 'storage delete, NoSuchBucket', ...missing, run: del },
  { name: 'storage delete under a version, 403 quoting the request', ...echo, run: delIf },
  {
    name: 'storage delete under a version, 412 over an object',
    status: 412,
    head: 200,
    run: delIf,
    expected: WriteConflictError,
  },
  { name: 'storage list, 403 quoting the request', ...echo, run: list },
  { name: 'storage list, 503', ...throttled, run: list },
  { name: 'storage list, NoSuchBucket', ...missing, run: list },
  { name: 'storage list, a proxy page quoting the request', ...proxy, run: list },
  { name: 'storage list, an unparsed body quoting the request', ...unparsed, run: list },
  { name: 'registry read, 403', ...refused, run: get },
  { name: 'registry read, 403 quoting the request', ...echo, run: get },
  { name: 'registry read, 503', ...throttled, run: get },
  { name: 'registry read, NoSuchBucket', ...missing, run: get },
  { name: 'registry read, a proxy page quoting the request', ...proxy, run: get },
  { name: 'registry create, 403 quoting the request', ...echo, run: create },
  { name: 'registry create, 503', ...throttled, run: create },
  {
    name: 'registry compare-and-swap write, 412',
    status: 412,
    run: cas,
    expected: WriteConflictError,
  },
  { name: 'registry compare-and-swap write, 403 quoting the request', ...echo, run: cas },
  { name: 'registry compare-and-swap write, 503', ...throttled, run: cas },
  { name: 'registry delete, 403 quoting the request', ...echo, run: rowDelete },
  { name: 'registry delete, 503', ...throttled, run: rowDelete },
  { name: 'registry delete, 412', status: 412, run: rowDelete, expected: WriteConflictError },
  { name: 'registry listKeys, 403 quoting the request', ...echo, run: listKeys },
  { name: 'registry listKeys, NoSuchBucket', ...missing, run: listKeys },
  ...calls.flatMap(([call, run]) =>
    quoting.map((answer) => ({ name: `${call}, ${answerName(answer)}`, ...answer, run })),
  ),
];

/** The canonical request S3 computes for `req`, as a `SignatureDoesNotMatch` body quotes it. */
function canonicalOf(req: IncomingMessage): string {
  const signed = ['host', 'x-amz-date', 'x-amz-security-token'].filter(
    (name) => req.headers[name] !== undefined,
  );
  const lines = signed.map((name) => `${name}:${String(req.headers[name])}`);
  return `${req.method}\n${req.url}\n\n${lines.join('\n')}\n\n${signed.join(';')}\nUNSIGNED-PAYLOAD`;
}

/** The body the server answers `req` with. */
function bodyOf(req: IncomingMessage, body: Body, code: string): string {
  const auth = String(req.headers.authorization ?? '');
  const token = req.headers['x-amz-security-token'];
  if (body === 'echo') {
    const signature = /Signature=([0-9a-f]+)/.exec(auth)?.[1] ?? '';
    const canonical = canonicalOf(req);
    const toSign = `AWS4-HMAC-SHA256\n${String(req.headers['x-amz-date'])}\nscope\nhash`;
    return (
      `<Error><Code>${code}</Code><Message>The request signature we calculated does not match the signature ` +
      `you provided.</Message><AWSAccessKeyId>${KEY_ID}</AWSAccessKeyId><StringToSign>${toSign}</StringToSign>` +
      `<SignatureProvided>${signature}</SignatureProvided><StringToSignBytes>${hex(toSign)}</StringToSignBytes>` +
      `<CanonicalRequest>${canonical}</CanonicalRequest>` +
      `<CanonicalRequestBytes>${hex(canonical)}</CanonicalRequestBytes><RequestId>r</RequestId></Error>`
    );
  }
  if (body === 'proxy') {
    return (
      `<html><head><title>502 Bad Gateway</title></head><body><h1>Bad Gateway</h1>` +
      `<p>upstream refused authorization ${auth} with x-amz-security-token: ${String(token)}</p></body></html>`
    );
  }
  if (body === 'json') return JSON.stringify({ message: 'bad request', headers: req.headers });
  if (body === 'token') {
    return (
      `<Error><Code>${code}</Code><Message>The provided token is not valid.</Message>` +
      (typeof token === 'string' ? `<Token-0>${token}</Token-0>` : '') +
      '<RequestId>r</RequestId></Error>'
    );
  }
  return `<Error><Code>${code}</Code><Message>refused</Message><RequestId>r</RequestId></Error>`;
}

describe('S3: no credential is reachable from an error the driver throws', LIMIT, () => {
  let server: Server;
  let url: string;
  let answer: { status: number; head: number; code: string; body: Body };

  beforeEach(async () => {
    answer = { status: 503, head: 503, code: 'SlowDown', body: 'error' };
    seen.signatures.clear();
    seen.tokens.clear();
    server = createServer((req, res) => {
      req.resume();
      const signature = /Signature=([0-9a-f]+)/.exec(String(req.headers.authorization ?? ''))?.[1];
      if (signature !== undefined) seen.signatures.add(signature);
      const token = req.headers['x-amz-security-token'];
      if (typeof token === 'string') seen.tokens.add(token);
      const status = req.method === 'HEAD' ? answer.head : answer.status;
      const type =
        answer.body === 'proxy'
          ? 'text/html'
          : answer.body === 'json'
            ? 'application/json'
            : 'application/xml';
      res.writeHead(status, { 'content-type': type, 'x-amz-request-id': 'r' });
      if (req.method === 'HEAD' || status < 300) return void res.end();
      res.end(bodyOf(req, answer.body, answer.code));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const client = (kind: Client): S3Client =>
    new S3Client({
      endpoint: url,
      region: 'us-east-1',
      forcePathStyle: true,
      maxAttempts: 1,
      credentials:
        kind === 'session'
          ? { accessKeyId: KEY_ID, secretAccessKey: SECRET, sessionToken: TOKEN }
          : { accessKeyId: KEY_ID, secretAccessKey: SECRET },
    });

  describe.each<Client>(['session', 'static'])('%s credentials', (kind) => {
    it.each(cases)('$name', async ({ status, head, code, body, cause, run, expected }) => {
      answer = {
        status,
        head: head ?? status,
        code: code ?? CODES[status] ?? 'Refused',
        body: body ?? 'error',
      };
      const c = client(kind);
      try {
        const err = await outcome(() => run(c));
        expect(err).toBeInstanceOf(expected);
        expect(seen.signatures.size).toBeGreaterThan(0);
        if (kind === 'session') expect(seen.tokens).toEqual(new Set([TOKEN]));
        if (cause) {
          const inner = (err as { cause?: unknown }).cause as S3ServiceException;
          expect(inner).toBeInstanceOf(Error);
          expect(inner.$metadata.httpStatusCode).toBe(status);
        }
        for (const e of chain(err)) {
          expect(Object.getOwnPropertyNames(e)).not.toContain('$response');
          for (const text of reachableStrings(e)) expect(secretsIn(text)).toEqual([]);
        }
      } finally {
        c.destroy();
      }
    });
  });

  it('redacts the token S3 quotes from an SDK error inside an AggregateError', async () => {
    answer = { status: 400, head: 400, code: 'ExpiredToken', body: 'token' };
    const c = client('session');
    try {
      const raw = await outcome(() => c.send(new GetObjectCommand({ Bucket: 'b', Key: 'k' })));
      expect((raw as Record<string, unknown>)['Token-0']).toBe(TOKEN);
      const out = scrubCredentials(new AggregateError([new Error('first'), raw], 'many'));
      expect((out.errors[1] as Record<string, unknown>)['Token-0']).toBe('[redacted]');
      for (const text of reachableStrings(out)) expect(secretsIn(text)).toEqual([]);
    } finally {
      c.destroy();
    }
  });

  it('keeps what classification reads on the error the driver passes on', async () => {
    answer = { status: 403, head: 403, code: 'SignatureDoesNotMatch', body: 'echo' };
    const c = client('session');
    try {
      const err = (await outcome(() => read(c))) as S3ServiceException & Record<string, unknown>;
      expect(err.name).toBe('SignatureDoesNotMatch');
      expect(err.$fault).toBe('client');
      expect(err.$metadata.httpStatusCode).toBe(403);
      expect(err['RequestId']).toBe('r');
      expect(err['AWSAccessKeyId']).toBe(KEY_ID);
      expect(err['SignatureProvided']).toBe('[redacted]');
      expect(err['CanonicalRequest']).toBe('[redacted]');
      expect(String(err['StringToSign'])).toMatch(/^AWS4-HMAC-SHA256\n/);
    } finally {
      c.destroy();
    }
  });
});

describe('the walker finds what the SDK hides', () => {
  it('sees a credential on a non-enumerable property, in a map, behind a getter', () => {
    const err = new Error('x');
    Object.defineProperty(err, '$response', {
      value: { headers: new Map([['x-amz-security-token', TOKEN]]) },
      enumerable: false,
    });
    expect(reachableStrings(err).some((t) => secretsIn(t).length > 0)).toBe(true);
    const peek = Object.defineProperty(new Error('y'), 'peek', { get: () => hex(TOKEN) });
    expect(reachableStrings(peek).some((t) => secretsIn(t).length > 0)).toBe(true);
  });
});
