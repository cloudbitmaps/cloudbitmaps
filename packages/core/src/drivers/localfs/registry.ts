/**
 * `LocalFsRegistryDriver` — a zero-cloud, persistent {@link IRegistryDriver}.
 *
 * One JSON file per segment at `<root>/<namespace>/registry/<segment>.reg`, holding `{ deleted, record }`.
 * OCC: the token is a monotonic counter (stringified), advanced on every mutation and
 * even across a `delete` (which **tombstones** rather than unlinks) so a deleted-then-recreated row never
 * re-issues an old token (ABA-safe). Every write is temp → fsync(file) → atomic rename → fsync(dir), and
 * read-modify-write is serialized per row across the whole process (the lock is keyed by the row's resolved
 * path, so every instance on one root shares it). A root is for one process: two processes on one root are not
 * fenced. Drivers do I/O; only `core/` is bound by determinism.
 */
import { constants as FS } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { mkdir, open, readdir, realpath, rename, unlink } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { IntegrityError, ValidationError, WriteConflictError } from '@/core/errors';
import type {
  IRegistryDriver,
  NewRegistryRecord,
  RegCaps,
  RegistryPatch,
  RegistryRecord,
  SegmentRef,
  Token,
} from '@/core/ports';
import {
  applyRegistryPatch,
  parseRegistryEnvelope,
  recordFromNew,
  registryCounterOf,
  serializeRegistryEnvelope,
  validateNewRegistryRecord,
  validateRegistryPatch,
  type RegistryEnvelope,
} from '../_shared/registry';
import { registryDir, registryRowPath, parseNamespaceDir, parseRegistryRow } from './paths';
import { O_NOFOLLOW, fsyncDir, isCode, mapFsError } from './fs-util';

/** Defensive cap on a single registry file read from storage, before allocation. */
const DEFAULT_MAX_ROW_BYTES = 1 * 1024 * 1024;

/**
 * Per-row promise chains, shared by every driver instance in the process and keyed by the row's resolved path,
 * so two instances on one root (or one root reached through a symlink or a relative path) take one lock. An
 * entry is deleted when its chain drains, so the map holds only rows with an operation in flight.
 */
const rowChains = new Map<string, Promise<unknown>>();

/** Entries in the process-wide row-lock map; the map is empty whenever no registry operation is in flight. */
export function localFsRowLockCount(): number {
  return rowChains.size;
}

/**
 * The row's identity for locking: the real path of the nearest directory that exists, plus the not-yet-created
 * tail. Resolving symlinks and relative roots makes every spelling of one row the same key.
 */
async function rowLockKey(path: string): Promise<string> {
  const abs = resolve(path);
  const tail: string[] = [basename(abs)];
  let dir = dirname(abs);
  for (;;) {
    try {
      return join(await realpath(dir), ...tail);
    } catch (err) {
      const parent = dirname(dir);
      if (!isCode(err, 'ENOENT') || parent === dir) throw mapFsError(err);
      tail.unshift(basename(dir));
      dir = parent;
    }
  }
}

export interface LocalFsRegistryDriverOptions {
  /** Injected clock for `createdAt`/`updatedAt`; defaults to `Date.now`. */
  readonly now?: () => number;
}

export class LocalFsRegistryDriver implements IRegistryDriver {
  private readonly now: () => number;

  constructor(
    private readonly root: string,
    options: LocalFsRegistryDriverOptions = {},
  ) {
    this.now = options.now ?? (() => Date.now());
  }

  capabilities(): RegCaps {
    return { strongRead: true };
  }

  async get(ref: SegmentRef): Promise<RegistryRecord | null> {
    const env = await this.readRow(registryRowPath(this.root, ref));
    return env && !env.deleted ? env.record : null;
  }

  async create(ref: SegmentRef, record: NewRegistryRecord): Promise<{ token: Token }> {
    validateNewRegistryRecord(record);
    const path = registryRowPath(this.root, ref);
    return this.withRowLock(path, async () => {
      const current = await this.readRow(path);
      if (current !== null && !current.deleted) {
        throw new WriteConflictError(`registry row already exists for segment ${ref.segment}`);
      }
      const counter = current ? registryCounterOf(current.record) + 1 : 0; // advance across a tombstone (ABA-safe)
      const token = String(counter);
      await this.writeRow(path, false, recordFromNew(ref, record, this.now(), token));
      return { token };
    });
  }

  async compareAndSwap(
    ref: SegmentRef,
    expected: Token,
    patch: RegistryPatch,
  ): Promise<{ token: Token }> {
    validateRegistryPatch(patch);
    const path = registryRowPath(this.root, ref);
    return this.withRowLock(path, async () => {
      const current = await this.readRow(path);
      if (current === null || current.deleted || current.record.token !== expected) {
        throw new WriteConflictError(`OCC token mismatch for registry row ${ref.segment}`);
      }
      const token = String(registryCounterOf(current.record) + 1);
      await this.writeRow(
        path,
        false,
        applyRegistryPatch(current.record, patch, this.now(), token),
      );
      return { token };
    });
  }

  async *list(namespace?: string): AsyncIterable<RegistryRecord> {
    for (const ns of await this.namespaceDirs(namespace)) {
      const dir = registryDir(this.root, ns);
      let names: string[];
      try {
        names = await readdir(dir);
      } catch (err) {
        if (isCode(err, 'ENOENT')) continue; // no registry rows in this namespace yet
        throw mapFsError(err);
      }
      for (const name of names) {
        const segment = parseRegistryRow(name);
        if (segment === null) continue;
        const env = await this.readRow(registryRowPath(this.root, { namespace: ns, segment }));
        if (env && !env.deleted) yield env.record;
      }
    }
  }

  async delete(ref: SegmentRef): Promise<void> {
    const path = registryRowPath(this.root, ref);
    return this.withRowLock(path, async () => {
      const current = await this.readRow(path);
      if (current === null || current.deleted) return; // idempotent
      // Tombstone (advance the counter) rather than unlink — keeps the token monotonic for ABA-safety.
      const token = String(registryCounterOf(current.record) + 1);
      await this.writeRow(path, true, { ...current.record, token, updatedAt: this.now() });
    });
  }

  /** Namespaces to scan: just the one requested, or every namespace dir under the root. */
  private async namespaceDirs(namespace: string | undefined): Promise<Array<string | undefined>> {
    if (namespace !== undefined) return [namespace];
    let entries: string[];
    try {
      entries = await readdir(this.root);
    } catch (err) {
      if (isCode(err, 'ENOENT')) return [];
      throw mapFsError(err);
    }
    // A namespace dir name is the namespace ENCODED for a path, so it has to be parsed back rather than used
    // as-is — `tenant:acme` lives in `tenant%3Aacme`, and `%` only ever appears in an escape we wrote, so an un-decoded directory name fails the round-trip check. Anything that does
    // not parse is skipped, never thrown on: this enumeration is fleet-wide, so one unrecognised directory
    // must not take the consistency check, the retention sweep and subject erasure down with it.
    const namespaces: Array<string | undefined> = [];
    for (const entry of entries) {
      const parsed = parseNamespaceDir(entry);
      if (parsed !== null) namespaces.push(parsed.namespace);
    }
    return namespaces;
  }

  private async readRow(path: string): Promise<RegistryEnvelope | null> {
    let handle;
    try {
      handle = await open(path, FS.O_RDONLY | O_NOFOLLOW);
    } catch (err) {
      if (isCode(err, 'ENOENT') || isCode(err, 'ELOOP')) return null;
      throw mapFsError(err);
    }
    try {
      const { size } = await handle.stat();
      if (size > DEFAULT_MAX_ROW_BYTES) {
        throw new IntegrityError(`registry row ${size}B exceeds cap ${DEFAULT_MAX_ROW_BYTES}B`);
      }
      const text = (await handle.readFile()).toString('utf8');
      return parseRegistryEnvelope(text, path);
    } finally {
      await handle.close();
    }
  }

  private async writeRow(path: string, deleted: boolean, record: RegistryRecord): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    const out = Buffer.from(serializeRegistryEnvelope({ deleted, record }), 'utf8');
    // Cap on the write path too (the read path caps at the same size): never produce a row that would later
    // be unreadable. The governance fields are already capped by validate*, so this is a belt-and-braces guard.
    if (out.length > DEFAULT_MAX_ROW_BYTES) {
      throw new ValidationError(
        `registry row ${out.length}B exceeds cap ${DEFAULT_MAX_ROW_BYTES}B`,
      );
    }

    const tmp = `${path}.${randomUUID()}.tmp`;
    let handle;
    try {
      handle = await open(tmp, FS.O_CREAT | FS.O_EXCL | FS.O_WRONLY | O_NOFOLLOW);
    } catch (err) {
      throw mapFsError(err);
    }
    try {
      await handle.write(out);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tmp, path).catch(async (err) => {
      await unlink(tmp).catch(() => {});
      throw mapFsError(err);
    });
    await fsyncDir(dirname(path));
  }

  /** Serialize callbacks for a row so read-modify-write is atomic across every instance in the process. */
  private async withRowLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
    const key = await rowLockKey(path);
    const prev = rowChains.get(key) ?? Promise.resolve();
    const result = prev.then(fn, fn);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    rowChains.set(key, tail);
    void tail.then(() => {
      if (rowChains.get(key) === tail) rowChains.delete(key);
    });
    return result;
  }
}
