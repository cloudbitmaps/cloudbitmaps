/**
 * `probeClient` — what an `S3Client` would send for the requests the registry makes, found out without sending one.
 *
 * Two facts about a client decide whether the registry may rely on S3's conditional requests, and neither shows on the
 * client's configuration:
 *
 *  - **Where a request goes.** A constructor `endpoint` is on the resolved config, but an endpoint from
 *    `AWS_ENDPOINT_URL_S3`, `AWS_ENDPOINT_URL` or an `endpoint_url` in the shared config file is read only when the
 *    first request is built, and the client's `isCustomEndpoint` stays `false` for all of them. A store reached that way
 *    (MinIO, LocalStack) can accept `If-Match` on a delete and ignore it.
 *  - **Whether the SDK sends the header at all.** The SDK serialises the members its model knows, and an SDK that
 *    predates one drops it from the request without a word, so a conditional write or delete goes out unconditional.
 *
 * So the probe builds the requests the registry sends and runs them through a **second client of the same class**,
 * made from the first one's resolved configuration, with a placeholder credential, a transport that is never handed a
 * request and a silent logger. It reads each request back as it stands once the SDK has serialised it, which is before
 * it is signed or sent: a middleware added to the probe command's own stack answers there instead of passing the
 * request on. The second client is the SDK's own resolution of everything that decides where a request goes (region,
 * endpoint, the environment, the shared config file, FIPS, dual-stack, path style), and the client the caller holds is
 * never touched: nothing it has been given runs, so no middleware of the caller's counts a request that never exists,
 * no logger prints one, and no credential is looked up.
 *
 * The probe runs the command through the second client's stack itself, as its `send` would, and does not call `send`: a
 * stub of `S3Client.prototype.send` (a class-level mock, as `aws-sdk-client-mock` installs) records nothing from it.
 *
 * A middleware the caller added to its own client that changes where a request goes is therefore not seen.
 *
 * A probe that cannot run (a client with no resolved config, an unresolvable region, a stack that does not hold the
 * step the probe hooks) answers `undefined`, which callers read as "not known".
 */
import { DeleteObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import type {
  $Command,
  S3Client,
  S3ClientResolvedConfig,
  ServiceInputTypes,
  ServiceOutputTypes,
} from '@aws-sdk/client-s3';

/** What a client does with the requests the registry sends. */
export interface ClientFacts {
  /** The host a request to the bucket is addressed to, as the client resolves it now. */
  readonly host: string;
  /** Whether a `DeleteObject` given `IfMatch` goes out with an `If-Match` header. */
  readonly sendsDeleteIfMatch: boolean;
  /** Whether a `PutObject` given `IfMatch` goes out with an `If-Match` header: the registry's compare-and-swap. */
  readonly sendsPutIfMatch: boolean;
  /** Whether a `PutObject` given `IfNoneMatch` goes out with an `If-None-Match` header: the registry's create. */
  readonly sendsPutIfNoneMatch: boolean;
}

/** A key no registry row or generation can hold; the probe's requests are never sent, so it is never used. */
export const PROBE_KEY = 'cloudbitmaps-probe';

/** The request as the SDK serialises it, as far as the probe reads it. */
interface SerialisedRequest {
  readonly hostname?: unknown;
  readonly headers?: Record<string, unknown>;
}

/** A credential no one can use: the probe signs nothing, but the client it builds wants one. */
const PLACEHOLDER_CREDENTIALS = { accessKeyId: 'cloudbitmaps-probe', secretAccessKey: 'unused' };

/** A transport that is never handed a request: the probe answers before the step that would send one. */
const NEVER_SENDS = {
  handle: (): Promise<never> =>
    Promise.reject(new Error('the client probe was asked to send a request')),
  updateHttpClientConfig: (): void => {},
  httpHandlerConfigs: (): Record<string, never> => ({}),
  destroy: (): void => {},
};

const SILENT_LOGGER = {
  debug: (): void => {},
  info: (): void => {},
  warn: (): void => {},
  error: (): void => {},
};

/**
 * A second client like `client`: its class (so the SDK that resolves where a request goes is the caller's), its resolved
 * configuration, and none of what the caller added to it. `undefined` for anything that is not a client of that shape.
 */
function cloneForProbe(client: S3Client): S3Client | undefined {
  const parts = client as unknown as { config?: unknown; constructor?: unknown; send?: unknown };
  if (
    typeof parts.send !== 'function' ||
    typeof parts.config !== 'object' ||
    parts.config === null
  ) {
    return undefined;
  }
  if (typeof parts.constructor !== 'function' || parts.constructor === Object) return undefined;
  const Class = parts.constructor as new (config: object) => S3Client;
  const clone = new Class({
    ...parts.config,
    credentials: PLACEHOLDER_CREDENTIALS,
    requestHandler: NEVER_SENDS,
    logger: SILENT_LOGGER,
  });
  return typeof clone.send === 'function' && clone.middlewareStack != null ? clone : undefined;
}

/**
 * Run `command` through `client`'s stack up to the step after the SDK serialises the request, and return the request.
 * The answer is made there, so the rest of the stack (retry, signing, the transport) never runs.
 */
async function serialise<Input extends ServiceInputTypes, Output extends ServiceOutputTypes>(
  client: S3Client,
  command: $Command<Input, Output, S3ClientResolvedConfig, ServiceInputTypes, ServiceOutputTypes>,
): Promise<SerialisedRequest> {
  let seen: SerialisedRequest | undefined;
  command.middlewareStack.addRelativeTo(
    () => (args: { request?: unknown }) => {
      seen = args.request as SerialisedRequest;
      return Promise.resolve({ response: {}, output: { $metadata: {} } as unknown as Output });
    },
    { relation: 'after', toMiddleware: 'serializerMiddleware', name: 'cloudbitmapsProbe' },
  );
  // What `send` does, minus `send`: a stub of `S3Client.prototype.send` (a class-level mock) sees nothing of the probe.
  const handler = command.resolveMiddleware(client.middlewareStack, client.config, {});
  await handler(command);
  if (seen === undefined) throw new Error('the probe saw no request');
  return seen;
}

const hasHeader = (request: SerialisedRequest, name: string): boolean =>
  request.headers?.[name] !== undefined;

/**
 * What `client` does with a conditional `DeleteObject` and `PutObject` to `bucket`, or `undefined` when it cannot be
 * found out. Never throws, never sends a request, and never runs anything the caller added to `client`.
 */
export async function probeClient(
  client: S3Client,
  bucket: string,
): Promise<ClientFacts | undefined> {
  let probe: S3Client | undefined;
  try {
    probe = cloneForProbe(client);
    if (probe === undefined) return undefined;
    const del = await serialise(
      probe,
      new DeleteObjectCommand({ Bucket: bucket, Key: PROBE_KEY, IfMatch: '"probe"' }),
    );
    const put = await serialise(
      probe,
      new PutObjectCommand({
        Bucket: bucket,
        Key: PROBE_KEY,
        Body: new Uint8Array(0),
        IfMatch: '"probe"',
        IfNoneMatch: '*',
      }),
    );
    if (typeof del.hostname !== 'string' || del.hostname === '') return undefined;
    return {
      host: del.hostname,
      sendsDeleteIfMatch: hasHeader(del, 'if-match'),
      sendsPutIfMatch: hasHeader(put, 'if-match'),
      sendsPutIfNoneMatch: hasHeader(put, 'if-none-match'),
    };
  } catch {
    return undefined;
  } finally {
    probe?.destroy();
  }
}

/** The domains AWS serves S3 from: the standard partition, and China's. */
const AWS_DOMAINS = ['.amazonaws.com', '.amazonaws.com.cn'];

/**
 * Whether `hostname` is an AWS S3 host: under an AWS domain and naming S3 in one of its labels (`s3`, `s3-fips`,
 * `s3-accesspoint`, `s3express-…`), so the FIPS, dual-stack, access-point and VPC interface forms all count, and another
 * AWS service's host does not. A host of any other domain is not, whatever it speaks: a store behind one has to be
 * vouched for by the caller.
 */
export function isAwsS3Host(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (!AWS_DOMAINS.some((domain) => host.endsWith(domain))) return false;
  return host
    .split('.')
    .some((label) => label === 's3' || label.startsWith('s3-') || label.startsWith('s3express-'));
}
