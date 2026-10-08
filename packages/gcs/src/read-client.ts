/**
 * The client a GCS backend sends its downloads on: one that never retries a download itself.
 *
 * `@google-cloud/storage` 7.x and 8.x retry a failed download by default, and when the retried request succeeds they
 * throw `ERR_STREAM_UNABLE_TO_PIPE` outside any promise, which ends the process whatever the caller wrote around the
 * call. So a download is sent once, and the driver retries it itself (`download-retry.ts`). Every other request keeps
 * the client's own retries: a resumable upload's session, a listing, a metadata read, none of which the store retries.
 *
 * ```
 *   the client                        its retries off?  ── yes ──▶ downloads use it as it is
 *        │ no
 *        ▼
 *   a twin, from the client's own class, with:
 *     the same credentials object (one token cache), endpoint, universe, project, user agent, timeout, checksum
 *     generator and retry settings but `autoRetry: false`, and one interceptor that applies the client's own
 *     interceptors as they are when each request is sent (a later one too)
 *        │
 *        ▼
 *   does it address the same place? ── yes ──▶ downloads use the twin
 *        │ no, or it could not be built
 *        ▼
 *   refuse at construction, with the fix
 * ```
 *
 * The twin is built from the client's own class, not this package's import: a caller on another major of the SDK hands
 * in a client whose credentials object is another copy's class, which this package's class would wrap in a second one.
 */
import { ValidationError } from '@cloudbitmaps/core/driver-kit';
import type { Storage, StorageOptions } from '@google-cloud/storage';
import { scrubCredentials } from './scrub-error';

/** An interceptor's request hook, as the client's constructor takes one; `getRequestInterceptors` types them `Function`. */
type Intercept = NonNullable<StorageOptions['interceptors_']>[number]['request'];

/** `client` itself when it already sends downloads once, else a twin of it that does. */
export function downloadClient(client: Storage): Storage {
  if (client.retryOptions?.autoRetry === false) return client;
  let twin: Storage;
  try {
    const Own = client.constructor as new (options: StorageOptions) => Storage;
    twin = new Own({
      authClient: client.authClient as StorageOptions['authClient'],
      apiEndpoint: client.apiEndpoint,
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
  } catch (cause) {
    throw refusal('it could not be built from it', cause);
  }
  // `baseUrl` prefers STORAGE_EMULATOR_HOST over `apiEndpoint` as each client is built, and a subclass may build its
  // own endpoint: a twin that would download from somewhere else is refused, never used.
  if (
    twin.baseUrl !== client.baseUrl ||
    twin.apiEndpoint !== client.apiEndpoint ||
    twin.customEndpoint !== client.customEndpoint
  ) {
    throw refusal('one built from it would address another endpoint');
  }
  return twin;
}

function refusal(why: string, cause?: unknown): ValidationError {
  const err = new ValidationError(
    `GcsStorage cannot send the supplied client's downloads without its retries: ${why}. ` +
      'Build the client with `retryOptions: { autoRetry: false }`, or leave out `client`',
  );
  // The credential-free copy, never the SDK's error as raised.
  if (cause !== undefined) err.cause = scrubCredentials(cause);
  return err;
}
