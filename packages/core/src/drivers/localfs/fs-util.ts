/**
 * Shared filesystem helpers for the LocalFs drivers (storage and registry) — one source
 * of truth for error-code matching, the symlink-refusal flag, and directory durability.
 */
import { constants as FS } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, opendir, open, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
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
 * The modes LocalFs creates what it stores with: files readable and writable by their owner alone, directories
 * searchable by it alone, so another user of the machine cannot read or list a segment. A process umask can only
 * remove bits from these, never add any. On Windows Node ignores a mode apart from the read-only bit, so passing
 * them there changes nothing.
 */
export const FILE_MODE = 0o600;
export const DIR_MODE = 0o700;

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

/**
 * Create `dir` and the directories missing above it, private from `top` down: what is missing above `top` is created
 * with the default mode (another service may need to traverse it), `top` and everything below it {@link DIR_MODE}. A
 * directory that exists keeps its mode.
 */
export async function makeDirs(dir: string, top: string): Promise<void> {
  if (!parentsMade.has(top)) {
    await mkdir(dirname(top), { recursive: true });
    parentsMade.add(top);
  }
  await mkdir(dir, { recursive: true, mode: DIR_MODE });
}
const parentsMade = new Set<string>();

/** The name of a temp file beside `finalPath`: `<finalPath>.<uuid>.tmp`. The only names {@link sweepOrphanTemps} removes. */
export const tempPathFor = (finalPath: string): string => `${finalPath}.${randomUUID()}.tmp`;
const TEMP_NAME = /\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/;

/** A temp file this old belongs to no write in progress: a crash or a failed close left it behind. */
const ORPHAN_TEMP_AGE_MS = 24 * 60 * 60 * 1000;
/** A directory is swept at most this often per process, so a save never lists a large directory every time. */
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;
const lastSwept = new Map<string, number>();

/**
 * Remove the temp files in `dir` named by {@link tempPathFor} that were last written more than a day ago, streaming the
 * directory, and at most once an hour per directory in this process. Only regular files go (a symlink is never followed
 * or removed). Best effort: a failure leaves the files for a later sweep and is never raised. Callers start it without
 * awaiting it.
 */
export async function sweepOrphanTemps(dir: string, now: number = Date.now()): Promise<void> {
  const last = lastSwept.get(dir);
  if (last !== undefined && now - last < SWEEP_INTERVAL_MS) return;
  lastSwept.set(dir, now);
  try {
    const entries = await opendir(dir);
    for await (const entry of entries) {
      if (!TEMP_NAME.test(entry.name)) continue;
      const path = join(dir, entry.name);
      const info = await lstat(path).catch(() => undefined);
      if (info?.isFile() === true && info.mtimeMs < now - ORPHAN_TEMP_AGE_MS) {
        await unlink(path).catch(() => {});
      }
    }
  } catch {
    // Nothing to sweep, or unreadable: the next interval tries again.
  }
}
