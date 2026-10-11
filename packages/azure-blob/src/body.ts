/**
 * Reading an Azure download's body: the one reader both halves use, and the one mapping of a body cut off mid-read.
 *
 * ```
 *   download() answered ──▶ collect(body, signal, maxBytes, oversize, advertised?)
 *                              ├─ advertised length > cap ───────▶ body destroyed, oversize()
 *                              ├─ a byte past the cap arrives ───▶ body destroyed, oversize()
 *                              ├─ AbortError, signal unaborted ──▶ ECONNRESET error (retryable)
 *                              ├─ closed before its end ─────────▶ ECONNRESET error (retryable)
 *                              └─ ends ──────────────────────────▶ the bytes
 * ```
 */
import { NotFoundError, concatBytes } from '@cloudbitmaps/core/driver-kit';

const noop = (): void => {};

/** Destroy a response body left unread, which releases its connection. */
export function destroyBody(body: NodeJS.ReadableStream): void {
  // A destroyed body can still error when its read is aborted later, and an error nothing listens for is thrown out of
  // the event, where no caller can catch it.
  body.on('error', noop);
  (body as { destroy?: () => void }).destroy?.();
}

/**
 * Collect an Azure download's Node readable body into a `Uint8Array`, at most `maxBytes` of it: the count is kept as
 * the body arrives, and the read stops with `oversize()` at the first byte past it, or at once when the response
 * advertises more. Called in the turn the download returns: the
 * loop listens for the body's errors from its first step, before the read's timer can abort it.
 */
export async function collect(
  body: NodeJS.ReadableStream | undefined,
  abortSignal: AbortSignal,
  maxBytes: number,
  oversize: () => Error,
  advertised?: number,
): Promise<Uint8Array> {
  if (body === undefined) {
    throw new NotFoundError('Azure download returned no body');
  }
  if (advertised !== undefined && advertised > maxBytes) {
    destroyBody(body);
    throw oversize();
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  let done = false;
  try {
    for await (const chunk of body) {
      const u8 =
        typeof chunk === 'string'
          ? new TextEncoder().encode(chunk)
          : new Uint8Array(chunk as Buffer);
      total += u8.length;
      if (total > maxBytes) throw oversize();
      chunks.push(u8);
    }
    done = true;
  } catch (err) {
    // The SDK fails a body whose connection dropped part-way with an `AbortError`. This read's own signal aborts only
    // on its timer, whose error the read has already thrown, so an `AbortError` with the signal unaborted is the
    // dropped connection, and retryable.
    if (!abortSignal.aborted && (err as { name?: unknown } | null)?.name === 'AbortError') {
      throw Object.assign(
        new Error('Azure Blob read was cut off before the response completed', { cause: err }),
        { code: 'ECONNRESET' },
      );
    }
    // A body that closes without ending or erring was cut off all the same: a dropped connection, and retryable.
    if ((err as { code?: unknown } | null)?.code === 'ERR_STREAM_PREMATURE_CLOSE') {
      throw Object.assign(
        new Error('Azure Blob read ended before the response completed', { cause: err }),
        {
          code: 'ECONNRESET',
        },
      );
    }
    throw err;
  } finally {
    // A read stopped before its end leaves the body open: destroying it closes the connection.
    if (!done) destroyBody(body);
  }
  return concatBytes(chunks);
}
