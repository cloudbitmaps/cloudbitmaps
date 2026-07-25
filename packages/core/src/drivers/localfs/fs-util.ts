/**
 * Shared filesystem helpers for the LocalFs drivers (cold/warm, and the Phase-4 registry) — one source
 * of truth for error-code matching, the symlink-refusal flag, and directory durability.
 */
import { constants as FS } from 'node:fs';
import { open } from 'node:fs/promises';
import { TransientError } from '@/core/errors';

interface NodeError extends Error {
  code?: string;
}

/** True when `err` is a Node system error with the given `code` (e.g. `'ENOENT'`, `'EEXIST'`). */
export const isCode = (err: unknown, code: string): boolean =>
  err instanceof Error && (err as NodeError).code === code;

/**
 * Filesystem error codes that are transient — a retry after a brief backoff often succeeds: the resource is
 * busy (`EBUSY`), the OS asked us to retry (`EAGAIN`), or we hit the open-file-descriptor ceiling
 * (`EMFILE`/`ENFILE`, common under heavy concurrency once earlier handles close). A networked FS may also
 * surface `ETIMEDOUT`.
 */
const TRANSIENT_FS_CODES = new Set(['EBUSY', 'EAGAIN', 'EMFILE', 'ENFILE', 'ETIMEDOUT']);

export const isFsTransient = (err: unknown): boolean =>
  err instanceof Error && TRANSIENT_FS_CODES.has((err as NodeError).code ?? '');

/**
 * Reclassify a transient filesystem fault as a retryable {@link TransientError} (so the retry decorator can
 * ride it out); everything else — including the driver's own typed errors — propagates unchanged.
 */
export const mapFsError = (err: unknown): unknown =>
  isFsTransient(err)
    ? new TransientError(`transient filesystem fault: ${(err as NodeError).code}`, { cause: err })
    : err;

/**
 * `O_NOFOLLOW` where the platform supports it (absent on Windows → 0). OR it into an `open` flag set so a
 * symlink **at the final path component** is refused rather than followed outside the storage root.
 * Containment of symlinked *directory* components assumes the root itself is not attacker-writable.
 */
export const O_NOFOLLOW = FS.O_NOFOLLOW ?? 0;

/** Best-effort parent-directory fsync so a just-published `rename`/`link` survives a crash (C13). */
export async function fsyncDir(dir: string): Promise<void> {
  try {
    const handle = await open(dir, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Some platforms reject directory fsync; durability of the entry is then best-effort.
  }
}
