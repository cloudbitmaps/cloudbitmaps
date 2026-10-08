/**
 * Shared filesystem helpers for the LocalFs drivers (storage and registry) — one source
 * of truth for error-code matching, the symlink-refusal flag, and directory durability.
 */
import { constants as FS } from 'node:fs';
import { open } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { TransientError } from '@/core/errors';

interface NodeError extends Error {
  code?: string;
}

/** True when `err` is a Node system error with the given `code` (e.g. `'ENOENT'`, `'EEXIST'`). */
export const isCode = (err: unknown, code: string): boolean =>
  err instanceof Error && (err as NodeError).code === code;

/**
 * True when `err` says nothing is at the path: it is not there, a parent is not a directory, or the name is longer than
 * the filesystem allows, so no such object can exist.
 */
export const isAbsent = (err: unknown): boolean =>
  isCode(err, 'ENOENT') || isCode(err, 'ENOTDIR') || isCode(err, 'ENAMETOOLONG');

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
 * Reclassify a transient filesystem fault as a retryable {@link TransientError}, so the store's read retry can
 * ride it out and a write's caller can tell it from a deterministic failure; everything else — including the
 * driver's own typed errors — propagates unchanged.
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

/**
 * Best-effort parent-directory fsync, so a just-published `rename`/`link` survives a crash. Without it the
 * directory entry can still be in the page cache when power goes: the generation's bytes are durable and
 * the name pointing at them is not, which is the one way a published generation can come back missing.
 */
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

/**
 * Write every byte of `bytes` at the handle's position. One `write` can write fewer bytes than it was asked to and not
 * fail (a full disk, a quota, some network filesystems), and a caller that took it for the whole would store a torn row
 * or object as a whole one. A write that makes no progress is a full device.
 */
export async function writeAll(handle: FileHandle, bytes: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset);
    if (bytesWritten <= 0) {
      throw Object.assign(new Error('a write made no progress: the device is full'), {
        code: 'ENOSPC',
      });
    }
    offset += bytesWritten;
  }
}
