/**
 * `LocalFsRegistryDriver` — a zero-cloud, persistent {@link IRegistryDriver} (Phase 4c).
 *
 * One JSON file per segment at `<root>/<namespace>/registry/<segment>.reg`, holding `{ deleted, record }`.
 * OCC mirrors the Warm tier: the token is a monotonic counter (stringified), advanced on every mutation and
 * even across a `delete` (which **tombstones** rather than unlinks) so a deleted-then-recreated row never
 * re-issues an old token (ABA-safe). Every write is temp → fsync(file) → atomic rename → fsync(dir), and
 * read-modify-write is serialized per row in-process. Drivers do I/O; only `core/` is bound by determinism.
 */
import { constants as FS } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { mkdir, open, readdir, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
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
import { registryDir, registryRowPath, parseRegistryRow } from './paths';
import { O_NOFOLLOW, fsyncDir, isCode, mapFsError } from './fs-util';

/** Defensive cap on a single registry file read from storage, before allocation. */
const DEFAULT_MAX_ROW_BYTES = 1 * 1024 * 1024;

export interface LocalFsRegistryDriverOptions {
  /** Injected clock for `createdAt`/`updatedAt`; defaults to `Date.now`. */
  readonly now?: () => number;
}

export class LocalFsRegistryDriver implements IRegistryDriver {
  /** Per-row promise chain — serializes read-modify-write so an in-process CAS never loses an update. */
  private readonly chain = new Map<string, Promise<unknown>>();
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
    // A namespace dir name IS the namespace; the `_default` sentinel dir maps back to "no namespace".
    return entries.map((e) => (e === '_default' ? undefined : e));
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

  /** Serialize callbacks for a row path so read-modify-write is atomic in-process (mirrors the Warm tier). */
  private withRowLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chain.get(key) ?? Promise.resolve();
    const result = prev.then(fn, fn);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.chain.set(key, tail);
    void tail.then(() => {
      if (this.chain.get(key) === tail) this.chain.delete(key);
    });
    return result;
  }
}
