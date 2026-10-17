import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { types } from 'node:util';
import { createRequire } from 'node:module';
import { ApiError, type Storage } from '@google-cloud/storage';
import {
  isTransientError,
  isTransportFault as isNodeTransportFault,
  isValidationError,
  toTransient,
} from '@cloudbitmaps/core/driver-kit';
import {
  asMissingBucket,
  isDownloadRetryable,
  isInvalidRange,
  isMissingBucket,
  isNotFound,
  isPreconditionFailed,
  isThrottle,
  isTransient,
  isTransportFault,
  transientFaultMessage,
} from '@/gcs/gcs-errors';
import { downloadFile, readOnce } from '@/gcs/read-once';
import { Deadline, ReadTimedOut, withDeadline } from '@/gcs/read-timeout';
import { scrubCredentials } from '@/gcs/scrub-error';
import { saveOnce } from '@/gcs/send-once';
import {
  ACCESS_TOKEN,
  ANSWERS,
  CLIENT_SECRET,
  CREDENTIAL_KINDS,
  REFRESH_TOKEN,
  SELF_SIGNED_JWT,
  TOKEN_ANSWERS,
  clientFor,
  guardLoopback,
  isolateGoogleEnv,
  startLoopback,
  type Answer,
} from '../../helpers/gcs-error-answers';

/**
 * The scrubbed copy of a GCS SDK error classifies exactly as the raw error does, so the driver maps every GCS answer to
 * the same error before and after the scrub. Each request the driver sends, made as the driver makes it, gets each
 * answer GCS, a compatible store, a proxy or the network can give it, from a loopback server, with each kind of
 * credential. Every predicate the driver classifies with is compared, with what the driver's last mapping step makes
 * of the error. A message that quotes a credential differs from the raw one by the redaction alone, so the message is
 * compared only where the raw one quotes none; what the driver reads of it (a missing bucket) is compared everywhere.
 */
const LIMIT = { timeout: 60_000 };

const nodeRequire = createRequire(import.meta.url);
const { GaxiosError } = nodeRequire(
  nodeRequire.resolve('gaxios', { paths: [nodeRequire.resolve('@google-cloud/storage')] }),
) as { GaxiosError: abstract new (...args: never[]) => Error };

/** The requests the driver sends, each made as the driver makes it. */
const REQUESTS: Record<string, (s: Storage) => Promise<unknown>> = {
  download: (s) =>
    readOnce(
      downloadFile(s, 'b', 'o'),
      { start: 0, end: 7, decompress: false },
      8,
      () => new Error('long'),
    ),
  'tail download': (s) =>
    readOnce(downloadFile(s, 'b', 'o'), { end: -8, decompress: false }, 8, () => new Error('long')),
  metadata: (s) => downloadFile(s, 'b', 'o').getMetadata(),
  'single-request upload': (s) =>
    saveOnce(s.bucket('b').file('o'), new Uint8Array([1]), {
      preconditionOpts: { ifGenerationMatch: 0 },
      metadata: { contentType: 'application/octet-stream' },
    }),
  'resumable upload': (s) =>
    new Promise((resolve, reject) => {
      const stream = s
        .bucket('b')
        .file('o')
        .createWriteStream({ resumable: true, preconditionOpts: { ifGenerationMatch: 0 } });
      stream.on('error', reject);
      stream.on('finish', resolve);
      stream.end(Buffer.from([1, 2, 3]));
    }),
  delete: (s) => s.bucket('b').file('o').delete(),
  'delete under a generation': (s) => s.bucket('b').file('o').delete({ ifGenerationMatch: 5 }),
  listing: (s) => s.bucket('b').getFiles({ prefix: 'p' }),
  'listing a page': (s) => s.bucket('b').getFiles({ maxResults: 1, autoPaginate: false }),
};

/** The requests the driver puts a deadline on. */
const TIMED = ['download', 'tail download', 'metadata'];

/** What the driver reads of an error, and what its last mapping step makes of it. */
function classify(err: unknown): Record<string, unknown> {
  const e = err as Record<string, unknown>;
  const mapped = toTransient(asMissingBucket(err, 'b'), isTransient, transientFaultMessage);
  const errors = Array.isArray(e['errors']) ? (e['errors'] as unknown[]) : undefined;
  return {
    preconditionFailed: isPreconditionFailed(err),
    throttle: isThrottle(err),
    notFound: isNotFound(err),
    missingBucket: isMissingBucket(err),
    invalidRange: isInvalidRange(err),
    transportFault: isTransportFault(err),
    nodeTransportFault: isNodeTransportFault(err),
    downloadRetryable: isDownloadRetryable(err),
    transient: isTransient(err),
    transientMessage: transientFaultMessage(err),
    code: e['code'],
    status: e['status'],
    responseStatus: (e['response'] as { status?: unknown } | undefined)?.status,
    name: e['name'],
    reasons: errors?.map((item) => (item as { reason?: unknown } | null)?.reason),
    apiError: err instanceof ApiError,
    gaxiosError: err instanceof GaxiosError,
    readTimedOut: err instanceof ReadTimedOut,
    error: err instanceof Error,
    native: types.isNativeError(err),
    mapped: {
      same: mapped === err,
      transient: isTransientError(mapped),
      validation: isValidationError(mapped),
      message: mapped === err ? undefined : (mapped as Error).message,
    },
  };
}

describe('GCS: a scrubbed SDK error classifies as the raw one', LIMIT, () => {
  let answer: Answer | undefined;
  let token: Answer = TOKEN_ANSWERS.issued;
  let loop: Awaited<ReturnType<typeof startLoopback>>;
  let guard: ReturnType<typeof guardLoopback>;
  let restoreEnv: () => void;
  let compared = 0;
  let copied = 0;

  beforeAll(async () => {
    restoreEnv = isolateGoogleEnv();
    guard = guardLoopback();
    loop = await startLoopback(
      () => answer,
      () => token,
    );
  });
  afterAll(async () => {
    await loop.close();
    guard.restore();
    restoreEnv();
    expect(guard.attempts).toEqual([]);
    expect({ compared, copied }).toEqual(COUNTS);
  });
  beforeEach(() => {
    token = TOKEN_ANSWERS.issued;
  });

  const secrets = (): string[] => [
    ACCESS_TOKEN,
    SELF_SIGNED_JWT,
    REFRESH_TOKEN,
    CLIENT_SECRET,
    ...[...loop.seen].map((value) => value.replace(/^Bearer /, '')),
  ];
  const quotesSecret = (text: unknown): boolean =>
    typeof text === 'string' && secrets().some((secret) => text.includes(secret));

  async function rawError(run: () => Promise<unknown>): Promise<unknown> {
    try {
      await run();
      return undefined;
    } catch (err) {
      return err;
    }
  }

  function compare(err: unknown): void {
    const before = classify(err);
    const message = (err as { message?: unknown }).message;
    const scrubbed = scrubCredentials(err);
    expect(classify(scrubbed)).toEqual(before);
    expect(Object.getPrototypeOf(scrubbed)).toBe(Object.getPrototypeOf(err));
    expect(scrubCredentials(scrubbed)).toBe(scrubbed);
    if (!quotesSecret(message)) expect((scrubbed as { message?: unknown }).message).toBe(message);
    else expect(quotesSecret((scrubbed as { message?: unknown }).message)).toBe(false);
    // What the raw error reads is unchanged by the scrub.
    expect(classify(err)).toEqual(before);
    expect((err as { message?: unknown }).message).toBe(message);
    const own = Object.getOwnPropertyNames(err);
    if (own.includes('response') || own.includes('config')) {
      expect(scrubbed).not.toBe(err);
      copied++;
    } else if (!quotesSecret(message)) {
      // An error with no transport and no credential is passed on as itself.
      expect(scrubbed).toBe(err);
    }
    compared++;
  }

  describe.each(CREDENTIAL_KINDS)('%s', (kind) => {
    describe.each(Object.keys(REQUESTS))('%s', (request) => {
      it.each(Object.keys(ANSWERS))('%s', async (name) => {
        answer = ANSWERS[name];
        const err = await rawError(() => REQUESTS[request]!(clientFor(kind, loop.url)));
        if (err !== undefined) compare(err);
      });

      // The driver times its reads alone: a download through `readOnce`, a metadata read through `withDeadline`.
      if (TIMED.includes(request)) {
        it('no answer in time', async () => {
          answer = undefined;
          const client = clientFor(kind, loop.url);
          const deadline = new Deadline(100, 'read of o');
          const err = await rawError(() =>
            request === 'metadata'
              ? withDeadline(() => downloadFile(client, 'b', 'o').getMetadata(), deadline)
              : readOnce(downloadFile(client, 'b', 'o'), {}, 8, () => new Error('long'), deadline),
          );
          expect(err).toBeInstanceOf(ReadTimedOut);
          compare(err);
        });
      }

      it('refused connection', async () => {
        const closed = createServer();
        await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
        const port = (closed.address() as AddressInfo).port;
        await new Promise<void>((resolve) => closed.close(() => resolve()));
        const err = await rawError(() =>
          REQUESTS[request]!(clientFor(kind, `http://127.0.0.1:${port}`)),
        );
        expect(err).toBeDefined();
        compare(err);
      });
    });
  });

  it.each(Object.keys(REQUESTS))(
    '%s, after a refresh the token endpoint refuses',
    async (request) => {
      answer = ANSWERS['503 backendError'];
      token = TOKEN_ANSWERS['refused, quoting the request'];
      const err = await rawError(() => REQUESTS[request]!(clientFor('refresh token', loop.url)));
      expect(err).toBeDefined();
      compare(err);
    },
  );
});

/**
 * 9 requests, 15 answers and 3 credentials make 405 cases. A 404 for an object answers a listing as a bucket that holds
 * nothing, so the two listings succeed under it, which leaves 399 errors; then 9 reads with no answer in time, 27
 * requests refused, and 9 after a refused refresh: 444. Each error that carries the SDK's response or config is copied:
 * the 372 HTTP answers, the resumable upload's 6 reset or refused (gaxios keeps its config), the 8 refused requests
 * whose refresh token the auth library could not exchange (the token request's error, with its config), and the 9
 * after a refused refresh. The other 49 (a connection reset or refused on a JSON API request, a read cut off) are not.
 */
const COUNTS = { compared: 444, copied: 395 };
