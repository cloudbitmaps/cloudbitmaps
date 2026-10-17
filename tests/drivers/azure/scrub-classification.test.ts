import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { types } from 'node:util';
import { RestError, type ContainerClient } from '@azure/storage-blob';
import {
  isTransientError,
  isTransportFault,
  isValidationError,
  toTransient,
} from '@cloudbitmaps/core/driver-kit';
import {
  asMissingContainer,
  isConditionalConflict,
  isInvalidRange,
  isMissingContainer,
  isNotFound,
  isPreconditionFailed,
  isTransient,
  transientFaultMessage,
} from '@/azure-blob/azure-errors';
import { scrubCredentials } from '@/azure-blob/scrub-error';
import {
  ANSWERS,
  CREDENTIAL_KINDS,
  PLANTED,
  clientFor,
  startLoopback,
  type Answer,
} from '../../helpers/azure-error-answers';
import { guardLoopback } from '../../helpers/loopback-guard';

/**
 * The scrubbed copy of an Azure SDK error classifies exactly as the raw error does, so the driver maps every Azure
 * answer to the same error before and after the scrub. Each request the driver sends gets each answer Azure, a
 * compatible store, a proxy or the network can give it, from a loopback server, with each kind of credential and the
 * credential headers a user's pipeline adds. Every predicate the driver classifies with is compared, with what the
 * driver's last mapping step makes of the error. The message is compared only where the raw one quotes no credential:
 * the copy's differs from it by the redaction alone, and no classification reads it.
 */
const LIMIT = { timeout: 60_000 };

/** The requests the driver sends, as the driver makes them. */
const REQUESTS: Record<string, (c: ContainerClient, signal?: AbortSignal) => Promise<unknown>> = {
  download: (c, abortSignal) => c.getBlockBlobClient('s.1.crbm').download(0, 8, { abortSignal }),
  getProperties: (c, abortSignal) =>
    c.getBlockBlobClient('s.1.crbm').getProperties({ abortSignal }),
  upload: (c, abortSignal) =>
    c
      .getBlockBlobClient('s.1.crbm')
      .upload(new Uint8Array([1]), 1, { conditions: { ifNoneMatch: '*' }, abortSignal }),
  delete: (c, abortSignal) =>
    c.getBlockBlobClient('s.1.crbm').delete({ conditions: { ifMatch: '"v"' }, abortSignal }),
  list: (c, abortSignal) =>
    c.listBlobsFlat({ prefix: 's', abortSignal }).byPage({ maxPageSize: 1 }).next(),
};

/** What the driver reads of an error, and what its last mapping step makes of it. */
function classify(err: unknown, withMessage: boolean): Record<string, unknown> {
  const e = err as { name?: unknown; statusCode?: unknown; code?: unknown; details?: unknown };
  const mapped = toTransient(asMissingContainer(err, 'c'), isTransient, transientFaultMessage);
  return {
    conditionalConflict: isConditionalConflict(err),
    preconditionFailed: isPreconditionFailed(err),
    notFound: isNotFound(err),
    missingContainer: isMissingContainer(err),
    invalidRange: isInvalidRange(err),
    transient: isTransient(err),
    transientMessage: transientFaultMessage(err),
    transportFault: isTransportFault(err),
    name: e.name,
    statusCode: e.statusCode,
    code: e.code,
    errorCode: (e.details as { errorCode?: unknown } | undefined)?.errorCode,
    restError: err instanceof RestError,
    error: err instanceof Error,
    native: types.isNativeError(err),
    ...(withMessage ? { message: (err as Error).message } : {}),
    mapped: {
      same: mapped === err,
      transient: isTransientError(mapped),
      validation: isValidationError(mapped),
      message: (mapped as Error).message,
    },
  };
}

/** Whether any text an error's own fields show quotes a planted credential or the client's own. */
const quotesCredential = (err: unknown): boolean => {
  const text = [
    String((err as Error).message),
    JSON.stringify((err as { details?: unknown }).details ?? null),
  ];
  return text.some(
    (t) => PLANTED.some((secret) => t.includes(secret)) || /SharedKey |sig=/.test(t),
  );
};

describe('Azure: a scrubbed SDK error classifies as the raw one', LIMIT, () => {
  let answer: Answer | undefined;
  let loop: Awaited<ReturnType<typeof startLoopback>>;
  let guard: ReturnType<typeof guardLoopback>;
  let compared = 0;
  let copied = 0;

  beforeAll(async () => {
    guard = guardLoopback();
    loop = await startLoopback(() => answer);
  });
  afterAll(async () => {
    await loop.close();
    guard.restore();
    // Nothing was sent anywhere but the loopback server.
    expect(guard.attempts).toEqual([]);
    // 5 requests, 17 answers and 2 credentials make 170 cases, all errors; with the abort and the refused connection,
    // 190. Every error that carries the SDK's request or response is copied: all but the abort's, which carries
    // neither (a reset or a refused connection keeps the request it was sending).
    expect(compared).toBe(190);
    expect(copied).toBe(180);
  });

  async function rawError(run: () => Promise<unknown>): Promise<unknown> {
    try {
      await run();
    } catch (err) {
      return err;
    }
    throw new Error('expected a failure');
  }

  function compare(err: unknown): void {
    const withMessage = !quotesCredential(err);
    const before = classify(err, withMessage);
    const scrubbed = scrubCredentials(err);
    expect(classify(scrubbed, withMessage)).toEqual(before);
    expect(Object.getPrototypeOf(scrubbed)).toBe(Object.getPrototypeOf(err));
    expect(scrubCredentials(scrubbed)).toBe(scrubbed);
    // What the raw error reads is unchanged by the scrub.
    expect(classify(err, withMessage)).toEqual(before);
    if (['request', 'response'].some((key) => Object.getOwnPropertyNames(err).includes(key))) {
      expect(scrubbed).not.toBe(err);
      copied++;
    }
    compared++;
  }

  describe.each(CREDENTIAL_KINDS)('%s client', (kind) => {
    describe.each(Object.keys(REQUESTS))('%s', (request) => {
      it.each(Object.keys(ANSWERS))('%s', async (name) => {
        answer = ANSWERS[name];
        compare(await rawError(() => REQUESTS[request]!(clientFor(kind, loop.url))));
      });

      it('abort', async () => {
        answer = undefined;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 20);
        try {
          compare(
            await rawError(() => REQUESTS[request]!(clientFor(kind, loop.url), controller.signal)),
          );
        } finally {
          clearTimeout(timer);
        }
      });

      it('refused connection', async () => {
        const closed = createServer();
        await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
        const port = (closed.address() as AddressInfo).port;
        await new Promise<void>((resolve) => closed.close(() => resolve()));
        const err = await rawError(() =>
          REQUESTS[request]!(clientFor(kind, `http://127.0.0.1:${port}`)),
        );
        expect((err as { code?: unknown }).code).toBe('ECONNREFUSED');
        compare(err);
      });
    });
  });
});
