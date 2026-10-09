/**
 * `LocalFsRegistryDriver` — a zero-cloud, persistent {@link IRegistryDriver}.
 *
 * One JSON file per segment at `<root>/<namespace>/registry/<segment>.reg`, holding `{ deleted, record }`.
 * OCC: the token is a random incarnation id drawn when the row is created, a counter advanced on every mutation, and a
 * random part drawn for every write, so with overwhelming probability a deleted-then-recreated row, or one restored from a backup, never
 * re-issues an old token (ABA-safe). A `delete` unlinks the row's file: a re-create draws a new incarnation, so nothing
 * of the old row is needed to keep its tokens apart. Every write is temp → fsync(file) → atomic rename → fsync(dir), and
 * read-modify-write is serialized per row across the whole process (the lock is keyed by the row's resolved
 * path, so every instance on one root shares it). A root is for one process: two processes on one root are not
 * fenced. Drivers do I/O; only `core/` is bound by determinism.
 */
import { constants as FS } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { mkdir, open, opendir, readdir, realpath, rename, unlink } from 'node:fs/promises';
import type { Dir } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { IntegrityError, ValidationError, WriteConflictError } from '@/core/errors';
import type { Entropy } from '@/core/determinism';
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
  newIncarnationToken,
  nextRegistryToken,
  parseRegistryEnvelope,
  recordFromNew,
  serializeRegistryEnvelope,
  validateNewRegistryRecord,
  validateRegistryPatch,
  type RegistryEnvelope,
} from '../_shared/registry';
import { entropyIsAvailable, webCryptoEntropy } from '../_shared/entropy';
import {
  assertRegistryNamesFit,
  registryDir,
  registryRowPath,
  parseNamespaceDir,
  parseRegistryRow,
} from './paths';
import { ExactCase } from './exact-case';
import { O_NOFOLLOW, fsyncDir, isAbsent, isCode, mapFsError, writeAll } from './fs-util';

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
      if (!isAbsent(err) || parent === dir) throw mapFsError(err);
      tail.unshift(basename(dir));
      dir = parent;
    }
  }
}

export interface LocalFsRegistryDriverOptions {
  /** Injected clock for `createdAt`/`updatedAt`; defaults to `Date.now`. */
  readonly now?: () => number;
  /** Draws every token's random parts; defaults to Web Crypto. Inject one only to make a test replayable. */
  readonly entropy?: Entropy;
}

export class LocalFsRegistryDriver implements IRegistryDriver {
  private readonly now: () => number;
  private readonly entropy: Entropy;

  private readonly exactCase: ExactCase;

  constructor(
    private readonly root: string,
    options: LocalFsRegistryDriverOptions = {},
  ) {
    this.exactCase = new ExactCase(root);
    this.now = options.now ?? (() => Date.now());
    this.entropy = options.entropy ?? webCryptoEntropy;
  }

  /**
   * `conditionalDelete`: a delete reads the row, checks it, and unlinks it under the row's lock, which every writer on
   * the root in this process takes, so no write can land between the check and the unlink.
   */
  capabilities(): RegCaps {
    return entropyIsAvailable(this.entropy)
      ? { strongRead: true, conditionalDelete: true }
      : { strongRead: true, canWrite: false, conditionalDelete: true };
  }

  async get(ref: SegmentRef): Promise<RegistryRecord | null> {
    const env = await this.readRow(registryRowPath(this.root, ref), ref);
    return env && !env.deleted ? env.record : null;
  }

  async create(ref: SegmentRef, record: NewRegistryRecord): Promise<{ token: Token }> {
    const checked = validateNewRegistryRecord(record);
    const path = registryRowPath(this.root, ref);
    assertRegistryNamesFit(ref);
    return this.withRowLock(path, async () => {
      const current = await this.readRow(path, ref);
      if (current !== null && !current.deleted) {
        throw new WriteConflictError(`registry row already exists for segment ${ref.segment}`);
      }
      // A new incarnation, whose counter continues across a tombstone (ABA-safe).
      const token = newIncarnationToken(this.entropy, current?.record);
      await this.writeRow(path, recordFromNew(ref, checked, this.now(), token));
      return { token };
    });
  }

  /**
   * A caller's `held` row (see `RegistryWriteOptions`) has no read to spare here: the row's file is read under its lock and its token compared
   * there, a local read and no request, so a stale one fails exactly as a lost race does.
   */
  async compareAndSwap(
    ref: SegmentRef,
    expected: Token,
    patch: RegistryPatch,
  ): Promise<{ token: Token }> {
    const checked = validateRegistryPatch(patch);
    const path = registryRowPath(this.root, ref);
    assertRegistryNamesFit(ref);
    return this.withRowLock(path, async () => {
      const current = await this.readRow(path, ref);
      if (current === null || current.deleted || current.record.token !== expected) {
        throw new WriteConflictError(`OCC token mismatch for registry row ${ref.segment}`);
      }
      const token = nextRegistryToken(current.record, this.entropy);
      await this.writeRow(path, applyRegistryPatch(current.record, checked, this.now(), token));
      return { token };
    });
  }

  async *list(namespace?: string): AsyncIterable<RegistryRecord> {
    for (const ns of await this.namespaceDirs(namespace)) {
      const dir = registryDir(this.root, ns);
      if (await this.exactCase.differs(dir)) continue; // another case's directory is not this one
      let entries: Dir;
      try {
        entries = await opendir(dir);
      } catch (err) {
        if (isAbsent(err)) continue; // no registry rows in this namespace yet
        throw mapFsError(err);
      }
      // Streamed a batch of names at a time, so a namespace of many rows is never held as one list; the directory is
      // closed when the loop ends, the consumer's stopping early included.
      for await (const entry of entries) {
        const segment = parseRegistryRow(entry.name);
        if (segment === null) continue;
        const ref = { namespace: ns, segment };
        const env = await this.readRow(registryRowPath(this.root, ref), ref);
        if (env && !env.deleted) yield env.record;
      }
    }
  }

  async delete(ref: SegmentRef, expected?: Token): Promise<void> {
    const path = registryRowPath(this.root, ref);
    return this.withRowLock(path, async () => {
      const current = await this.readRow(path, ref);
      if (expected !== undefined) {
        if (current === null || current.deleted || current.record.token !== expected) {
          throw new WriteConflictError(`OCC token mismatch for registry row ${ref.segment}`);
        }
      } else if (current === null || current.deleted) {
        return; // idempotent
      }
      await this.unlinkRow(path);
    });
  }

  /** Remove a row's file and make the removal durable (fsync the directory). */
  private async unlinkRow(path: string): Promise<void> {
    try {
      await unlink(path);
    } catch (err) {
      if (!isCode(err, 'ENOENT')) throw mapFsError(err);
    }
    await fsyncDir(dirname(path));
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

  /** Read the row at `path`, which must be the row of `ref`: one that names another segment is refused. */
  private async readRow(path: string, ref: SegmentRef): Promise<RegistryEnvelope | null> {
    let handle;
    try {
      if (await this.exactCase.differs(path)) return null; // another case's row is not this one
      handle = await open(path, FS.O_RDONLY | O_NOFOLLOW);
    } catch (err) {
      if (isAbsent(err) || isCode(err, 'ELOOP')) return null;
      throw mapFsError(err);
    }
    try {
      const { size } = await handle.stat();
      if (size > DEFAULT_MAX_ROW_BYTES) {
        throw new IntegrityError(`registry row ${size}B exceeds cap ${DEFAULT_MAX_ROW_BYTES}B`);
      }
      const text = (await handle.readFile()).toString('utf8');
      // Named by its path under the root, which says which file to look at without putting the host's layout in a log.
      return parseRegistryEnvelope(text, relative(this.root, path), ref);
    } finally {
      await handle.close();
    }
  }

  private async writeRow(path: string, record: RegistryRecord): Promise<void> {
    await this.exactCase.refuseVariant(path);
    await mkdir(dirname(path), { recursive: true });
    const out = Buffer.from(serializeRegistryEnvelope({ deleted: false, record }), 'utf8');
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
      await writeAll(handle, out);
      await handle.sync();
    } catch (err) {
      // The temp file goes with the failed write, rather than accumulate beside the row.
      await handle.close().catch(() => {});
      await unlink(tmp).catch(() => {});
      throw mapFsError(err);
    }
    await handle.close();
    await rename(tmp, path).catch(async (err) => {
      await unlink(tmp).catch(() => {});
      throw mapFsError(err);
    });
    await fsyncDir(dirname(path));
  }

  /** Serialize callbacks for a row so read-modify-write is atomic across every instance in the process. */
  private async withRowLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
    // On a case-insensitive root two spellings of a path are one row, so they take one lock.
    const resolved = await rowLockKey(path);
    const key = (await this.exactCase.folds()) ? resolved.toLowerCase() : resolved;
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
