/**
 * Fault classification shared by the cloud drivers: which connection failures are transient whatever the service, and
 * how a driver hands a transient fault on as {@link TransientError}. Each driver keeps its own reading of its service's
 * statuses and error codes; what is the same for every service built on Node's networking lives here once, so a write
 * and a read, or two drivers, cannot disagree about it.
 */
import { TransientError } from '@/core/errors';

/**
 * The codes Node gives a connection that failed or was cut off: refused, reset, aborted, timed out, a DNS failure, an
 * unreachable host or network, and a broken pipe. Only these: a missing or unreadable credentials file (`ENOENT`,
 * `EACCES`) and a TLS failure (`EPROTO`, a certificate error) carry codes of the same shape, and would fail the same
 * way again.
 */
const TRANSPORT_FAULT_CODES: ReadonlySet<string> = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
]);

/**
 * Whether `err` is a connection that failed or was cut off before the service answered: its `code` is one of the
 * strings Node gives such a failure (`ECONNRESET`, `ECONNREFUSED`, `ECONNABORTED`, `ETIMEDOUT`, `ENOTFOUND`,
 * `EAI_AGAIN`, `EHOSTUNREACH`, `ENETUNREACH`, `EPIPE`). A retry on a fresh connection usually succeeds, so a driver
 * raises one as {@link TransientError}. It reads nothing else: a driver whose service also answers with a status
 * checks that first.
 */
export function isTransportFault(err: unknown): boolean {
  const code = (err as { code?: unknown } | null | undefined)?.code;
  return typeof code === 'string' && TRANSPORT_FAULT_CODES.has(code);
}

/**
 * `err` as a {@link TransientError} when `isTransient(err)` holds, with `message(err)` as its message and `err` as its
 * `cause`; any other error unchanged. The last step of a driver's error mapping, so the store's read retry can ride a
 * transient fault out and a write's caller can tell one from a deterministic failure. Run whatever scrubs credentials
 * from an error before it, since the error becomes the cause.
 */
export function toTransient(
  err: unknown,
  isTransient: (err: unknown) => boolean,
  message: (err: unknown) => string,
): unknown {
  return isTransient(err) ? new TransientError(message(err), { cause: err }) : err;
}
