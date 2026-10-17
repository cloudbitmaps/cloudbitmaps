import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { types } from 'node:util';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import {
  isTransientError,
  isTransportFault,
  isValidationError,
  toTransient,
} from '@cloudbitmaps/core/driver-kit';
import {
  errorCode,
  errorName,
  httpStatus,
  isNetworkOrTimeout,
  isSdkRetryable,
  isServerSide,
} from '@/s3/aws-errors';
import {
  asMissingBucket,
  isConditionalConflict,
  isInvalidRange,
  isMissingBucket,
  isNoSuchUpload,
  isNotFound,
  isPreconditionFailed,
  isThrottle,
  isTransient,
  transientFaultMessage,
} from '@/s3/s3-errors';
import { scrubCredentials } from '@/s3/scrub-error';

/**
 * The scrubbed copy of an SDK error classifies exactly as the raw error does, so the driver maps every S3 answer to the
 * same error before and after the scrub. Each command the driver sends gets each answer S3, an S3-compatible store, a
 * proxy or the network can give it, from a loopback server, with and without a session token. Every predicate the
 * driver classifies with is compared, with what the driver's last mapping step makes of the error.
 */
const KEY_ID = ['STAND', 'IN', 'KEYID'].join('');
const SECRET = ['stand', 'in', 'secret', '0123456789'].join('-');
const TOKEN = ['stand', 'in', 'session', 'token', '0123456789'].join('-');
const LIMIT = { timeout: 60_000 };

type Answer = (req: IncomingMessage, res: ServerResponse) => void;

/** An S3 error document. */
const s3Error =
  (status: number, code: string, extra = '', headers: Record<string, string> = {}): Answer =>
  (req, res) => {
    res.writeHead(status, {
      'content-type': 'application/xml',
      'x-amz-request-id': 'r',
      ...headers,
    });
    if (req.method === 'HEAD') return void res.end();
    res.end(
      `<Error><Code>${code}</Code><Message>m</Message>${extra}<RequestId>r</RequestId></Error>`,
    );
  };
const raw =
  (status: number, type: string, body: (req: IncomingMessage) => string): Answer =>
  (req, res) => {
    res.writeHead(status, { 'content-type': type });
    res.end(req.method === 'HEAD' ? undefined : body(req));
  };

const ANSWERS: Record<string, Answer> = {
  '400 InvalidArgument': s3Error(400, 'InvalidArgument'),
  '403 AccessDenied': s3Error(403, 'AccessDenied'),
  '403 SignatureDoesNotMatch quoting the request': (req, res) =>
    s3Error(
      403,
      'SignatureDoesNotMatch',
      `<SignatureProvided>${/Signature=(\w+)/.exec(String(req.headers.authorization))?.[1] ?? ''}` +
        `</SignatureProvided><CanonicalRequest>x-amz-security-token:${String(req.headers['x-amz-security-token'])}` +
        `</CanonicalRequest><AWSAccessKeyId>${KEY_ID}</AWSAccessKeyId>`,
    )(req, res),
  '403 RequestTimeTooSkewed, an hour off': s3Error(403, 'RequestTimeTooSkewed', '', {
    date: new Date(Date.now() - 3_600_000).toUTCString(),
  }),
  '404 NoSuchKey': s3Error(404, 'NoSuchKey'),
  '404 NoSuchBucket': s3Error(404, 'NoSuchBucket'),
  '404 NoSuchUpload': s3Error(404, 'NoSuchUpload'),
  '409 ConditionalRequestConflict': s3Error(409, 'ConditionalRequestConflict'),
  '412 PreconditionFailed': s3Error(412, 'PreconditionFailed'),
  '416 InvalidRange': s3Error(416, 'InvalidRange'),
  '500 InternalError': s3Error(500, 'InternalError'),
  '503 SlowDown': s3Error(503, 'SlowDown'),
  '503 ServiceUnavailable': s3Error(503, 'ServiceUnavailable'),
  '502 proxy page quoting the request': raw(
    502,
    'text/html',
    (req) => `<html><body><p>refused ${String(req.headers.authorization)}</p></body></html>`,
  ),
  '400 JSON body quoting the request': raw(400, 'application/json', (req) =>
    JSON.stringify({ headers: req.headers }),
  ),
  '200 body that is not XML': raw(
    200,
    'application/xml',
    (req) => `<x ${String(req.headers.authorization)}`,
  ),
  'reset connection': (req) => req.socket.destroy(),
};
/** No answer at all: the client's request timeout, or an abort, ends the request. */
const SILENT = ['request timeout', 'abort'];

const COMMANDS = {
  GetObject: () => new GetObjectCommand({ Bucket: 'b', Key: 'k', Range: 'bytes=0-7' }),
  HeadObject: () => new HeadObjectCommand({ Bucket: 'b', Key: 'k' }),
  PutObject: () =>
    new PutObjectCommand({ Bucket: 'b', Key: 'k', Body: new Uint8Array([1]), IfNoneMatch: '*' }),
  DeleteObject: () => new DeleteObjectCommand({ Bucket: 'b', Key: 'k', IfMatch: '"v"' }),
  ListObjectsV2: () => new ListObjectsV2Command({ Bucket: 'b', Prefix: 'p' }),
};

/** What the driver reads of an error, and what its last mapping step makes of it. */
function classify(err: unknown): Record<string, unknown> {
  const e = err as Record<string, unknown>;
  const mapped = toTransient(asMissingBucket(err, 'b'), isTransient, transientFaultMessage);
  return {
    preconditionFailed: isPreconditionFailed(err),
    conditionalConflict: isConditionalConflict(err),
    throttle: isThrottle(err),
    noSuchUpload: isNoSuchUpload(err),
    missingBucket: isMissingBucket(err),
    notFound: isNotFound(err),
    invalidRange: isInvalidRange(err),
    transient: isTransient(err),
    transientMessage: transientFaultMessage(err),
    name: errorName(err),
    status: httpStatus(err),
    code: errorCode(err),
    sdkRetryable: isSdkRetryable(err),
    serverSide: isServerSide(err),
    network: isNetworkOrTimeout(err),
    transportFault: isTransportFault(err),
    message: e['message'],
    fault: e['$fault'],
    metadata: e['$metadata'],
    retryable: e['$retryable'],
    Code: e['Code'],
    serviceException: err instanceof S3ServiceException,
    error: err instanceof Error,
    native: types.isNativeError(err),
    mapped: {
      same: mapped === err,
      transient: isTransientError(mapped),
      validation: isValidationError(mapped),
      message: (mapped as Error).message,
    },
  };
}

describe('S3: a scrubbed SDK error classifies as the raw one', LIMIT, () => {
  let server: Server;
  let url: string;
  let answer: Answer | undefined;
  let compared = 0;
  let copied = 0;

  beforeAll(async () => {
    server = createServer((req, res) => {
      req.resume();
      // `undefined` holds the request open: the client's timeout or abort ends it.
      answer?.(req, res);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    // 5 commands, 20 answers and 2 credentials make 200 cases; a 200 whose body is not XML is a success for all but the
    // listing, which leaves 192 errors. Each of the 152 that carries the SDK's response is copied; the reset, the
    // timeout, the abort and the refused connection carry none.
    expect(compared).toBe(192);
    expect(copied).toBe(152);
  });

  const client = (session: boolean, endpoint = url): S3Client =>
    new S3Client({
      endpoint,
      region: 'us-east-1',
      forcePathStyle: true,
      maxAttempts: 1,
      requestHandler: { requestTimeout: 200, throwOnRequestTimeout: true },
      credentials: session
        ? { accessKeyId: KEY_ID, secretAccessKey: SECRET, sessionToken: TOKEN }
        : { accessKeyId: KEY_ID, secretAccessKey: SECRET },
    });

  /** The raw error a command fails with, or `undefined` when it succeeds. */
  async function rawError(
    c: S3Client,
    command: keyof typeof COMMANDS,
    signal?: AbortSignal,
  ): Promise<unknown> {
    try {
      await c.send(
        COMMANDS[command]() as never,
        signal === undefined ? {} : { abortSignal: signal },
      );
      return undefined;
    } catch (err) {
      return err;
    }
  }

  function compare(err: unknown): void {
    const before = classify(err);
    const scrubbed = scrubCredentials(err);
    expect(classify(scrubbed)).toEqual(before);
    expect(Object.getPrototypeOf(scrubbed)).toBe(Object.getPrototypeOf(err));
    expect(scrubCredentials(scrubbed)).toBe(scrubbed);
    // What the raw error read is unchanged by the scrub.
    expect(classify(err)).toEqual(before);
    if (Object.getOwnPropertyNames(err).includes('$response')) {
      expect(scrubbed).not.toBe(err);
      copied++;
    }
    compared++;
  }

  describe.each([true, false])('session token: %s', (session) => {
    describe.each(Object.keys(COMMANDS) as (keyof typeof COMMANDS)[])('%s', (command) => {
      it.each(Object.keys(ANSWERS))('%s', async (name) => {
        answer = ANSWERS[name];
        const c = client(session);
        try {
          const err = await rawError(c, command);
          if (err !== undefined) compare(err);
        } finally {
          c.destroy();
        }
      });

      it.each(SILENT)('%s', async (name) => {
        answer = undefined;
        const c = client(session);
        const controller = new AbortController();
        const timer = name === 'abort' ? setTimeout(() => controller.abort(), 20) : undefined;
        try {
          const err = await rawError(c, command, name === 'abort' ? controller.signal : undefined);
          expect(err).toBeDefined();
          compare(err);
        } finally {
          clearTimeout(timer);
          c.destroy();
        }
      });

      it('refused connection', async () => {
        const closed = createServer();
        await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
        const port = (closed.address() as AddressInfo).port;
        await new Promise<void>((resolve) => closed.close(() => resolve()));
        const c = client(session, `http://127.0.0.1:${port}`);
        try {
          const err = await rawError(c, command);
          expect(errorCode(err)).toBe('ECONNREFUSED');
          compare(err);
        } finally {
          c.destroy();
        }
      });
    });
  });
});
