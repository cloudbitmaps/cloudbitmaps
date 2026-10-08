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
 *        ▼
 *   a twin, from the client's own class, with:
 *     the same credentials object (one token cache), endpoint, universe, project, user agent, timeout, checksum
 *     generator and retry settings but `autoRetry: false`, and one interceptor that applies the client's own
 *     interceptors as they are when each request is sent (a later one too)
 *        │
 *        ▼
 *   did it take those settings: a `bucket` method, the same     ── yes ──▶ downloads use the twin
 *   credentials object, its retries off, the same endpoint?
 *        │ no, or it could not be built
 *        ▼
 *   the client's own retries off? ── yes ──▶ downloads use the client as it is (a test double, say)
 *        │ no
 *        ▼
 *   refuse at construction, with the fix
 * ```
 *
 * The twin is built even for a client whose retries read off: the SDK turns a client's `autoRetry` off while a delete or
 * an upload with no precondition is in flight and back on when it ends, so that value, read once, does not say how the
 * client was built. The twin's settings are its own object, which nothing turns back on.
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
 * A twin of `client` that sends each download once, else `client` itself when no faithful twin can be built and its
 * own retries are off. `supplied`: the caller handed `client` in, rather than the backend building it.
 */
export function downloadClient(client: Storage, supplied: boolean): Storage {
  let twin: Storage | undefined;
  let why: string | undefined;
  let cause: unknown;
  try {
    twin = twinOf(client);
    why = unfaithful(client, twin);
  } catch (err) {
    why = 'could not be built';
    cause = err;
  }
  if (why === undefined) return twin!;
  if (client.retryOptions?.autoRetry === false) return client;
  const err = new ValidationError(
    supplied
      ? "GcsStorage cannot send the supplied client's downloads without the SDK's retries: a client built from its " +
          `class with its settings ${why}. Build the client with \`retryOptions: { autoRetry: false }\`, or leave out ` +
          '`client`'
      : "GcsStorage cannot build a client that sends downloads without the SDK's retries: the one built from its " +
          `settings ${why}. Pass a \`client\` built with \`retryOptions: { autoRetry: false }\``,
  );
  // The credential-free copy, never the SDK's error as raised.
  if (cause !== undefined) err.cause = scrubCredentials(cause);
  throw err;
}

function twinOf(client: Storage): Storage {
  const Own = client.constructor as new (options: StorageOptions) => Storage;
  return new Own({
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
}

/**
 * What the twin did not take of the settings it was given, or `undefined`. A subclass may build from options of its own
 * and a test double is not built from options at all, and either would send downloads with other credentials, with the
 * SDK's retries, or somewhere else.
 */
function unfaithful(client: Storage, twin: Storage): string | undefined {
  if (typeof twin.bucket !== 'function') return 'has no `bucket` method';
  if (twin.authClient === undefined || twin.authClient !== client.authClient) {
    return 'would use other credentials';
  }
  if (twin.retryOptions?.autoRetry !== false) return "keeps the SDK's retries";
  // `baseUrl` prefers STORAGE_EMULATOR_HOST over `apiEndpoint` as each client is built.
  if (twin.baseUrl !== client.baseUrl) {
    return 'would send to another URL, as when `STORAGE_EMULATOR_HOST` changed after the client was built';
  }
  if (twin.apiEndpoint !== client.apiEndpoint) return 'would name another endpoint';
  if (twin.customEndpoint !== client.customEndpoint) {
    return 'would decide otherwise whether requests carry credentials';
  }
  return undefined;
}
