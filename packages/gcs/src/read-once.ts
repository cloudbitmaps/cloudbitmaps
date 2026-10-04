/**
 * `readOnce` — read one object, or one range of it, in a single GET, with the response headers in hand.
 *
 * `file.download()` returns only the bytes. The headers carry what a caller needs alongside them — the object's
 * `generation` (the registry's version fence) and, on a ranged read, the object's total size in `Content-Range` — so
 * this reads through `createReadStream`, which announces the raw response before any data flows. Both come from the
 * same response as the bytes, so they describe one observation of the object.
 *
 * **Everything on the wire is untrusted.** The advertised `Content-Length` is checked against `maxBytes` before the
 * first byte is buffered, and the bytes are counted as they arrive, so a response that understates its length (or
 * omits it) still cannot make the caller hold more than `maxBytes`. The headers are returned as received; each caller
 * parses the ones it relies on strictly.
 *
 * **Every download stays off the SDK's shared connection pool.** When a download fails part-way — a body cut off, a
 * refused response, a timeout — the SDK destroys the HTTP agent the request went out on, to free its socket. By default
 * that is one keep-alive agent the whole process shares (teeny-request's, for every request with `forever: true`), so
 * every other request in flight on any client is reset with it, uploads included. {@link downloadFile} sets
 * `forever: false` on its own requests, through the SDK's request interceptors: they then go out on Node's global
 * agent, which the SDK never destroys, and on `@google-cloud/storage` 8.x a destroyed download closes its own socket
 * and nothing else. The cost: the global agent closes a connection idle for 5 seconds, where the SDK's pool keeps it,
 * so a read after a longer pause opens a new one; and it is shared with the process's other `http` and `https` code.
 */
import type { Storage } from '@google-cloud/storage';
import type { Deadline } from './read-timeout';

type GcsFile = ReturnType<ReturnType<Storage['bucket']>['file']>;
type Interceptor = GcsFile['interceptors'][number];
/** What the SDK hands an interceptor: its typing says less, but every request it decorates carries a `uri`. */
type RequestOptions = ReturnType<Interceptor['request']>;

/** Sends a request on Node's global agent rather than the SDK's shared keep-alive one (see the module comment). */
const OFF_THE_SHARED_AGENT: Interceptor = {
  request: (reqOpts) => ({ ...(reqOpts as RequestOptions), forever: false }),
};

/** A handle on `name` for downloading: its requests stay off the SDK's shared agent. The client is not touched. */
export function downloadFile(storage: Storage, bucket: string, name: string): GcsFile {
  const file = storage.bucket(bucket).file(name);
  file.interceptors.push(OFF_THE_SHARED_AGENT);
  return file;
}

export interface ObjectRead {
  /** The HTTP status of the response (200 for a whole object, 206 for a range). */
  readonly status: number;
  /** The response headers, lower-cased as Node delivers them. */
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  /** The body, at most `maxBytes` long. */
  readonly bytes: Uint8Array;
}

/**
 * The response the SDK announces. It is the HTTP layer's own body stream with the status and headers laid on it, and
 * while that body is in flight the SDK and the HTTP layer each run a pipeline over it, which with its own listeners is
 * eleven or twelve error and close listeners: one past Node's default limit of ten, so Node prints a possible-leak
 * warning for every read that is still arriving when it is let go. Nothing grows with the number of attempts, because
 * each attempt has a body of its own. The limit is raised on that one stream, to {@link BODY_LISTENER_LIMIT}.
 */
interface RawResponse {
  statusCode?: unknown;
  headers?: Record<string, string | string[] | undefined>;
  setMaxListeners?: (n: number) => unknown;
}

/** Room for the listeners the SDK's and the HTTP layer's pipelines put on one response body, with a few to spare. */
const BODY_LISTENER_LIMIT = 16;

/** The value of a header that must appear once, or `undefined` when it is absent, repeated or empty. */
export function singleHeader(headers: ObjectRead['headers'], name: string): string | undefined {
  const value = headers[name];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * GET `file` (with the SDK's `createReadStream` options), buffering at most `maxBytes`. `oversize` builds the error
 * thrown when the advertised or actual length passes the cap, so each caller reports it in its own vocabulary.
 * Transport and HTTP errors reject as the SDK raises them (a 404 carries `code: 404`).
 *
 * With a `deadline`, a read still unsettled when it passes rejects with its `ReadTimedOut`; one asked for after it has
 * passed is not sent. The deadline belongs to the whole driver read, so an attempt gets only what is left of it.
 */
export function readOnce(
  file: GcsFile,
  options: { start?: number; end?: number; validation?: false; decompress?: false },
  maxBytes: number,
  oversize: (size: number | undefined) => Error,
  deadline?: Deadline,
): Promise<ObjectRead> {
  if (deadline !== undefined && deadline.remaining() === 0)
    return Promise.reject(deadline.expired());
  return new Promise<ObjectRead>((resolve, reject) => {
    const stream = file.createReadStream(options);
    const chunks: Buffer[] = [];
    let total = 0;
    let status = 0;
    let headers: ObjectRead['headers'] = {};
    let responded = false;
    let settled = false;
    // The SDK makes no request until the stream is read from, in a later turn, so a timer set here covers all of it.
    const timer =
      deadline === undefined
        ? undefined
        : setTimeout(() => fail(deadline.expired()), deadline.remaining());

    // Deferred: the SDK builds its response pipeline right after announcing the response, and destroying the stream
    // before that makes the pipeline throw out of an event handler, where nothing can catch it, and ends the process.
    // One turn later the same destroy ends the read without a throw. So a read is let go only once its response has
    // been announced, never before: one that settles first (a timeout before any answer) is destroyed when its
    // response comes, if one ever does. Until then the SDK has no way to cancel it, so its request stays open until
    // the server answers or the connection closes.
    const release = (): void => void setImmediate(() => stream.destroy());

    const fail = (err: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (responded) release();
      reject(err);
    };

    stream.on('response', (res: RawResponse) => {
      responded = true;
      res.setMaxListeners?.(BODY_LISTENER_LIMIT);
      if (settled) return release();
      status = typeof res.statusCode === 'number' ? res.statusCode : 0;
      headers = res.headers ?? {};
      if (status < 200 || status > 299) return; // the SDK raises the error itself, with its own status
      const advertised = singleHeader(headers, 'content-length');
      if (advertised !== undefined && /^\d+$/.test(advertised) && Number(advertised) > maxBytes) {
        fail(oversize(Number(advertised)));
      }
    });
    stream.on('data', (chunk: Buffer) => {
      if (settled) return;
      total += chunk.length;
      if (total > maxBytes) return fail(oversize(undefined));
      chunks.push(chunk);
    });
    stream.on('error', fail);
    stream.on('end', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ status, headers, bytes: new Uint8Array(Buffer.concat(chunks, total)) });
    });
    // A net under the SDK: it reports a cut-off body as an 'error' itself, but a stream that closes without ending
    // or erring was cut off all the same, so it is a dropped connection, and retryable.
    stream.on('close', () =>
      fail(
        Object.assign(new Error('GCS read ended before the response completed'), {
          code: 'ECONNRESET',
        }),
      ),
    );
  });
}
