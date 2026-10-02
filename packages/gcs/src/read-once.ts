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
 */
import type { Storage } from '@google-cloud/storage';

type GcsFile = ReturnType<ReturnType<Storage['bucket']>['file']>;

export interface ObjectRead {
  /** The HTTP status of the response (200 for a whole object, 206 for a range). */
  readonly status: number;
  /** The response headers, lower-cased as Node delivers them. */
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  /** The body, at most `maxBytes` long. */
  readonly bytes: Uint8Array;
}

interface RawResponse {
  statusCode?: unknown;
  headers?: Record<string, string | string[] | undefined>;
}

/** The value of a header that must appear once, or `undefined` when it is absent, repeated or empty. */
export function singleHeader(headers: ObjectRead['headers'], name: string): string | undefined {
  const value = headers[name];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * GET `file` (with the SDK's `createReadStream` options), buffering at most `maxBytes`. `oversize` builds the error
 * thrown when the advertised or actual length passes the cap, so each caller reports it in its own vocabulary.
 * Transport and HTTP errors reject as the SDK raises them (a 404 carries `code: 404`).
 */
export function readOnce(
  file: GcsFile,
  options: { start?: number; end?: number; validation?: false; decompress?: false },
  maxBytes: number,
  oversize: (size: number | undefined) => Error,
): Promise<ObjectRead> {
  return new Promise<ObjectRead>((resolve, reject) => {
    const stream = file.createReadStream(options);
    const chunks: Buffer[] = [];
    let total = 0;
    let status = 0;
    let headers: ObjectRead['headers'] = {};
    let settled = false;

    const fail = (err: unknown): void => {
      if (settled) return;
      settled = true;
      // Deferred: the SDK builds its response pipeline right after announcing the response, and destroying the
      // stream before that makes the pipeline throw out of an event handler, where nothing can catch it, and
      // leaves the socket open. One turn later the same destroy ends the read without a throw. The SDK then
      // destroys its keep-alive agent, which the client's other requests share, so a refused response also resets
      // whatever else that client has in flight; those surface as connection faults, which a read retries.
      setImmediate(() => stream.destroy());
      reject(err);
    };

    stream.on('response', (res: RawResponse) => {
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
