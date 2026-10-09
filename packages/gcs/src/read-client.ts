/**
 * The client a GCS backend sends its downloads on: one that never retries a download itself.
 *
 * `@google-cloud/storage` 7.x and 8.x retry a failed download by default, and when the retried request succeeds they
 * throw `ERR_STREAM_UNABLE_TO_PIPE` outside any promise, which ends the process whatever the caller wrote around the
 * call. So a download is sent once, and the driver retries it itself (`download-retry.ts`). The other requests keep the
 * client as it was built: a resumable upload's session, a listing, a delete (the conditional writes are sent once by
 * `send-once.ts` either way).
 *
 * ```
 *   the client
 *        │
 *        ├── not a Storage client (a test double) ──▶ its retries off? yes: used as it is; no: refused
 *        ├── its `bucket` replaced on the instance (a test stub), or overridden by its class ──▶ refused
 *        ▼
 *   a twin, from the client's own class, with:
 *     the same credentials object (one token cache), endpoint, universe, project, user agent, timeout, checksum
 *     generator and retry settings but `autoRetry: false`, and one interceptor that applies the client's own
 *     interceptors as they are when each request is sent (a later one too); then its own retry settings turned off,
 *     over any its class set
 *        │
 *        ▼
 *   a second client, with a `bucket` method, the same credentials ── yes ──▶ downloads use the twin
 *   object, retry settings of its own and off, the same URL and endpoint?
 *        │ no, or it could not be built
 *        ▼
 *   refused at construction, saying what differed
 * ```
 *
 * A `Storage` client is never used as it is, even one whose retries read off: the SDK turns a client's `autoRetry` off
 * while a delete or an upload with no precondition is in flight and back on when it ends, so that value, read once,
 * does not say how the client was built. The twin's retry settings are its own object, and only reads are sent on it,
 * which never change them; the SDK reads that object on every request.
 *
 * The twin is built from the client's own class, not this package's import: a caller on another major of the SDK hands
 * in a client whose credentials object is another copy's class, which this package's class would wrap in a second one.
 */
import { ValidationError } from '@cloudbitmaps/core/driver-kit';
import type { Storage, StorageOptions } from '@google-cloud/storage';
import { scrubCredentials } from './scrub-error';

/** An interceptor's request hook, as the client's constructor takes one; `getRequestInterceptors` types them `Function`. */
type Intercept = NonNullable<StorageOptions['interceptors_']>[number]['request'];

/**
 * A twin of `client` that sends each download once, or `client` itself when it is a test double whose retries are off.
 * `supplied`: the caller handed `client` in, rather than the backend building it.
 */
export function downloadClient(client: Storage, supplied: boolean): Storage {
  // A test double has nothing a twin could copy, and is used as it is when it says its retries are off.
  if (!isSdkClient(client)) {
    if (client.retryOptions?.autoRetry === false) return client;
    throw supplied
      ? refusal(
          true,
          'it is not a `Storage` client (a test double, say)',
          'Give it `retryOptions: { autoRetry: false }` to have it used as it is',
        )
      : refusal(
          false,
          "the `Storage` it was built from is not the SDK's (a mocked module, say)",
          'Pass the mock as `client`, with `retryOptions: { autoRetry: false }`',
        );
  }
  const instead =
    'Stub `Storage.prototype.bucket` instead, which reaches that client too, or pass a test double that does not ' +
    'extend `Storage`, with `retryOptions: { autoRetry: false }`';
  if (Object.hasOwn(client, 'bucket')) {
    throw refusal(
      supplied,
      'its `bucket` method is replaced on the instance, as by a test stub, which a client built from its class would ' +
        'not have',
      instead,
    );
  }
  if (overridesBucket(client)) {
    throw refusal(
      supplied,
      'its class overrides `bucket`, as a test double built on `Storage` does, so a client built from its class need ' +
        'not hold what this one holds',
      instead,
    );
  }
  const second = supplied
    ? 'a second client built from its class with its settings'
    : 'a second client built from the same settings';
  const remedy = supplied
    ? 'Pass a client its class builds from the options it is given, as `Storage` does, or leave out `client`'
    : undefined;
  let twin: Storage;
  try {
    twin = twinOf(client);
  } catch (err) {
    throw refusal(supplied, `${second} could not be built`, remedy, err);
  }
  const why = unfaithful(client, twin);
  if (why !== undefined) throw refusal(supplied, `${second} ${why}`, remedy);
  return twin;
}

/**
 * Whether `client` is the SDK's own: its constructor sets `authClient` from the request factory it builds. A mock that
 * answers every property with a function, as an auto-mocking library's does, answers that one too, but not with the
 * same credentials object.
 */
function isSdkClient(client: Storage): boolean {
  const factory: unknown = (client as { makeAuthenticatedRequest?: unknown })
    .makeAuthenticatedRequest;
  return (
    client.authClient !== undefined &&
    typeof factory === 'function' &&
    (factory as { authClient?: unknown }).authClient === client.authClient
  );
}

/** Whether a subclass of the SDK's client defines `bucket` over the SDK's own. */
function overridesBucket(client: Storage): boolean {
  let defined = 0;
  for (let proto: unknown = Object.getPrototypeOf(client); proto !== null;) {
    if (Object.hasOwn(proto as object, 'bucket')) defined++;
    proto = Object.getPrototypeOf(proto);
  }
  return defined > 1;
}

function twinOf(client: Storage): Storage {
  const Own = client.constructor as new (options: StorageOptions) => Storage;
  const twin = new Own({
    authClient: client.authClient as StorageOptions['authClient'],
    // The SDK treats an endpoint spelled other than its default as a custom one, whose requests go without credentials,
    // and then stores it with any trailing slash taken off. A client given the default in another spelling is custom
    // with the default's URL, which that URL with a slash reproduces.
    apiEndpoint: client.customEndpoint === true ? `${client.apiEndpoint}/` : client.apiEndpoint,
    universeDomain: client.universeDomain,
    projectId: client.projectId,
    ...(client.useAuthWithCustomEndpoint === undefined
      ? {}
      : { useAuthWithCustomEndpoint: client.useAuthWithCustomEndpoint }),
    ...(client.providedUserAgent === undefined ? {} : { userAgent: client.providedUserAgent }),
    ...(client.timeout === undefined ? {} : { timeout: client.timeout }),
    crc32cGenerator: client.crc32cGenerator,
    retryOptions: { ...client.retryOptions, autoRetry: false },
    // A view, not a copy: the client's interceptors as they are when each request is sent.
    interceptors_: [
      {
        request: (options: Parameters<Intercept>[0]) =>
          (client.getRequestInterceptors() as Intercept[]).reduce(
            (sent, intercept) => intercept(sent),
            options as ReturnType<Intercept>,
          ),
      },
    ],
  });
  // A subclass may set retry settings of its own over the ones it is given. Turned off here, as the SDK turns them off
  // for a request it must not retry, on the twin's own settings only: never on an object the client holds too.
  if (
    twin !== client &&
    twin.retryOptions !== undefined &&
    twin.retryOptions !== client.retryOptions
  ) {
    twin.retryOptions.autoRetry = false;
  }
  return twin;
}

/**
 * What a twin did not take of the settings that decide where and how a download is sent, or `undefined`. A subclass may
 * build from options of its own, and would send downloads with other credentials, with the SDK's retries, or elsewhere.
 * Interceptors are carried as a view and not checked.
 */
function unfaithful(client: Storage, twin: Storage): string | undefined {
  if (twin === client) return 'is the same client';
  if (typeof twin.bucket !== 'function') return 'has no `bucket` method';
  if (twin.authClient === undefined || twin.authClient !== client.authClient) {
    return 'would use other credentials';
  }
  if (twin.retryOptions === client.retryOptions) return 'would share its retry settings';
  if (twin.retryOptions?.autoRetry !== false) return "keeps the SDK's retries";
  // `baseUrl` prefers STORAGE_EMULATOR_HOST over `apiEndpoint` as each client is built.
  if (twin.baseUrl !== client.baseUrl) {
    return 'would send to another URL, as when `STORAGE_EMULATOR_HOST` changed after the client was built or is not a URL';
  }
  if (twin.apiEndpoint !== client.apiEndpoint) return 'would name another endpoint';
  if (twin.customEndpoint !== client.customEndpoint) {
    return 'would decide otherwise whether requests carry credentials';
  }
  return undefined;
}

function refusal(
  supplied: boolean,
  why: string,
  remedy: string | undefined,
  cause?: unknown,
): ValidationError {
  const err = new ValidationError(
    (supplied
      ? `GcsStorage cannot send the supplied client's downloads without the SDK's retries: ${why}`
      : `GcsStorage cannot build a client that sends downloads without the SDK's retries: ${why}`) +
      (remedy === undefined ? '' : `. ${remedy}`),
  );
  // The credential-free copy, never the SDK's error as raised.
  if (cause !== undefined) err.cause = scrubCredentials(cause);
  return err;
}
