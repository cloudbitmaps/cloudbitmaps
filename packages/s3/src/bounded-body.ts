/**
 * Read an S3 response body as a stream, counting bytes, and stop at the first byte past `maxBytes`: a server that
 * ignores `Range`, or sends a body with no `Content-Length`, cannot make the caller buffer more than it asked for.
 * The body is destroyed on every exit that leaves it unread, which closes its connection.
 *
 * A body that is not a stream (a stand-in with only `transformToByteArray`) is read whole and its length checked after.
 */
import { NotFoundError } from '@cloudbitmaps/core';

/** The `GetObject` response body, narrowed to the parts used. */
export type ResponseBody =
  | {
      transformToByteArray?: () => Promise<Uint8Array>;
      [Symbol.asyncIterator]?: () => AsyncIterator<unknown>;
      destroy?: () => void;
    }
  | undefined;

/** Destroy a response body left unread, which releases its connection; a body with no `destroy` is left alone. */
export function destroyBody(body: unknown): void {
  (body as { destroy?: () => void } | undefined)?.destroy?.();
}

/**
 * The body's bytes, at most `maxBytes` of them. `oversize` builds the typed error thrown when the count passes
 * `maxBytes`, or when the response advertises more than that before a byte is read; any other failure of the stream
 * propagates as it is.
 */
export async function readBounded(
  body: ResponseBody,
  maxBytes: number,
  oversize: () => Error,
  advertised?: number,
): Promise<Uint8Array> {
  if (body === undefined) throw new NotFoundError('S3 GetObject returned an empty body');
  if (advertised !== undefined && advertised > maxBytes) {
    destroyBody(body);
    throw oversize();
  }
  if (typeof body[Symbol.asyncIterator] !== 'function') {
    const bytes = await body.transformToByteArray!();
    if (bytes.length > maxBytes) throw oversize();
    return bytes;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  let done = false;
  try {
    for await (const chunk of body as AsyncIterable<Uint8Array | string>) {
      const piece = typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk;
      total += piece.length;
      if (total > maxBytes) throw oversize();
      chunks.push(piece);
    }
    done = true;
  } finally {
    if (!done) destroyBody(body);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const piece of chunks) {
    out.set(piece, at);
    at += piece.length;
  }
  return out;
}
