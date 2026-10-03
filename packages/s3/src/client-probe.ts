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
 * So the probe builds the requests the registry sends, hands each to the client's own stack, and reads the request back
 * as it stands once the SDK has serialised it, which is before it is signed or sent. A middleware added to the probe
 * command's own stack answers there instead of passing the request on, so nothing is sent. The SDK resolves the client's
 * credentials on its way to that step, as it does for any first request, so the probe makes the same lookup the first
 * real request would, which the client then caches; what the client resolves is what its first real request resolves.
 *
 * A probe that cannot run (a client with no middleware stack, an unresolvable region or credential chain, a stack that
 * does not hold the step the probe hooks) answers `undefined`, which callers read as "not known".
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

/** Whether `client` has the parts of a real `S3Client` the probe needs: a test double has none of them. */
function hasMiddlewareStack(client: S3Client): boolean {
  const parts = client as unknown as {
    send?: unknown;
    middlewareStack?: unknown;
    config?: unknown;
  };
  return typeof parts.send === 'function' && parts.middlewareStack != null && parts.config != null;
}

/**
 * Run `command` through `client`'s stack up to the step after the SDK serialises the request, and return the request.
 * The answer is made there, so the rest of the stack (retry, signing, the transport) never runs.
 *
 * `send` is given options, which makes a client built with `cacheMiddleware: true` resolve afresh instead of reusing
 * a handler cached from an earlier command of the class, which would not hold this command's middleware.
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
  await client.send(command, {});
  if (seen === undefined) throw new Error('the probe saw no request');
  return seen;
}

const hasHeader = (request: SerialisedRequest, name: string): boolean =>
  request.headers?.[name] !== undefined;

/**
 * What `client` does with a conditional `DeleteObject` and `PutObject` to `bucket`, or `undefined` when it cannot be
 * found out. Never throws, and never sends a request.
 */
export async function probeClient(
  client: S3Client,
  bucket: string,
): Promise<ClientFacts | undefined> {
  if (!hasMiddlewareStack(client)) return undefined;
  try {
    const del = await serialise(
      client,
      new DeleteObjectCommand({ Bucket: bucket, Key: PROBE_KEY, IfMatch: '"probe"' }),
    );
    const put = await serialise(
      client,
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
