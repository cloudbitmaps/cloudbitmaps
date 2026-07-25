/**
 * `LocalFsWarmDriver` — a zero-cloud, persistent {@link IWarmDriver} backed by the local filesystem.
 *
 * One file per dirty chunk holds `[u32 counter][u8 deleted][payload]` (an internal, unversioned row —
 * it never leaves the local FS and the driver is its sole reader/writer). The OCC token is the counter
 * stringified — monotonic, never reused: it advances even across a delete (via a **tombstone**), so a
 * deleted-then-recreated row never re-issues an old token (ABA-safe). Every mutation is
 * write-temp → fsync(file) → atomic rename → fsync(dir), and read-modify-write is serialized per row
 * in-process so concurrent writers form a single CAS chain with no lost updates. (Cross-*process* CAS on
 * a local FS is out of scope — the production OCC backends are DynamoDB et al.; LocalFs is the dev/test
 * tier. `WarmCaps`/`capabilities()` + batch paths are likewise deferred with topology validation →
 * Phase 4.)
 */
import { constants as FS } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { mkdir, open, readdir, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { IntegrityError, WriteConflictError } from '@/core/errors';
import { NO_ROW } from '@/core/ports';
import type { ChunkRef, IWarmDriver, NoRow, SegmentRef, Token, WarmRow } from '@/core/ports';
import { parseChunkRow, warmRowPath, warmSegmentDir } from './paths';
import { O_NOFOLLOW, fsyncDir, isCode, mapFsError } from './fs-util';

const HEADER_BYTES = 5; // u32 counter (LE) + u8 deleted flag
const COUNTER_MAX = 0xffffffff; // token counter is stored as a u32
/** Defensive cap on a single row read from (untrusted) storage, before allocation. */
const DEFAULT_MAX_ROW_BYTES = 64 * 1024 * 1024;

interface Row {
  readonly counter: number;
  readonly deleted: boolean;
  readonly bytes: Uint8Array;
}

export class LocalFsWarmDriver implements IWarmDriver {
  /** Per-row promise chain — serializes read-modify-write so an in-process CAS never loses an update. */
  private readonly chain = new Map<string, Promise<unknown>>();

  constructor(
    private readonly root: string,
    private readonly maxRowBytes: number = DEFAULT_MAX_ROW_BYTES,
  ) {}

  // Methods are `async` so boundary-validation throws (warmRowPath) surface as rejections, not sync throws.
  // LocalFs reads are always strongly consistent (single filesystem) — the `WarmReadOptions` hint would be a
  // no-op, so the structurally-optional param is simply omitted (still satisfies IWarmDriver).
  async get(ref: ChunkRef): Promise<WarmRow | null> {
    const row = await this.readRow(warmRowPath(this.root, ref));
    return row && !row.deleted ? { token: String(row.counter), bytes: row.bytes } : null;
  }

  async putConditional(
    ref: ChunkRef,
    bytes: Uint8Array,
    expected: Token | NoRow,
  ): Promise<{ token: Token }> {
    const path = warmRowPath(this.root, ref);
    return this.withRowLock(path, async () => {
      const current = await this.readRow(path);
      const live = current !== null && !current.deleted;
      if (expected === NO_ROW) {
        if (live) throw new WriteConflictError(`row already exists: chunk ${ref.chunkKey}`);
        const counter = current ? current.counter + 1 : 0; // advance across a tombstone (ABA-safe)
        await this.writeRow(path, counter, false, bytes);
        return { token: String(counter) };
      }
      if (!live || String(current.counter) !== expected) {
        throw new WriteConflictError(`OCC conflict on chunk ${ref.chunkKey}`);
      }
      await this.writeRow(path, current.counter + 1, false, bytes);
      return { token: String(current.counter + 1) };
    });
  }

  async deleteConditional(ref: ChunkRef, expected: Token): Promise<void> {
    const path = warmRowPath(this.root, ref);
    return this.withRowLock(path, async () => {
      const current = await this.readRow(path);
      if (current === null || current.deleted || String(current.counter) !== expected) {
        throw new WriteConflictError(`OCC conflict on delete of chunk ${ref.chunkKey}`);
      }
      // Tombstone (keep the counter advancing) rather than unlink — preserves ABA-safety.
      await this.writeRow(path, current.counter + 1, true, new Uint8Array());
    });
  }

  async *listChunks(ref: SegmentRef): AsyncIterable<{ chunkKey: number } & WarmRow> {
    const dir = warmSegmentDir(this.root, ref);
    let names: string[];
    try {
      names = await readdir(dir);
    } catch (err) {
      if (isCode(err, 'ENOENT')) return;
      throw mapFsError(err);
    }
    // Ascending chunkKey order. readdir order is unspecified, so sort.
    const keys = names
      .map((n) => parseChunkRow(n))
      .filter((k): k is number => k !== null)
      .sort((a, b) => a - b);
    for (const chunkKey of keys) {
      const row = await this.readRow(warmRowPath(this.root, { ...ref, chunkKey }));
      if (row && !row.deleted) yield { chunkKey, token: String(row.counter), bytes: row.bytes };
    }
  }

  private async readRow(path: string): Promise<Row | null> {
    let handle;
    try {
      handle = await open(path, FS.O_RDONLY | O_NOFOLLOW);
    } catch (err) {
      if (isCode(err, 'ENOENT') || isCode(err, 'ELOOP')) return null;
      throw mapFsError(err);
    }
    try {
      const { size } = await handle.stat();
      if (size > this.maxRowBytes) {
        throw new IntegrityError(`warm row ${size}B exceeds cap ${this.maxRowBytes}B`);
      }
      // A published row is always whole (atomic rename of a fully-written temp); a shorter-than-header
      // file means corruption/tampering — fail fast rather than silently reporting "absent".
      if (size < HEADER_BYTES) {
        throw new IntegrityError(`warm row truncated: ${size}B < ${HEADER_BYTES}B header`);
      }
      const buf = await handle.readFile();
      const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
      return {
        counter: view.getUint32(0, true),
        deleted: buf[4] !== 0,
        bytes: new Uint8Array(buf.subarray(HEADER_BYTES)),
      };
    } finally {
      await handle.close();
    }
  }

  private async writeRow(
    path: string,
    counter: number,
    deleted: boolean,
    bytes: Uint8Array,
  ): Promise<void> {
    if (counter > COUNTER_MAX) {
      // 4 billion writes to one chunk — astronomically unreachable, but guard rather than wrap a u32
      // (which would re-issue an old token and break ABA-safety).
      throw new IntegrityError(`warm row counter overflow on ${path}`);
    }
    await mkdir(dirname(path), { recursive: true });
    const out = new Uint8Array(HEADER_BYTES + bytes.length);
    new DataView(out.buffer).setUint32(0, counter, true);
    out[4] = deleted ? 1 : 0;
    out.set(bytes, HEADER_BYTES);

    const tmp = `${path}.${randomUUID()}.tmp`;
    let handle;
    try {
      handle = await open(tmp, FS.O_CREAT | FS.O_EXCL | FS.O_WRONLY | O_NOFOLLOW);
    } catch (err) {
      throw mapFsError(err); // e.g. EMFILE under heavy concurrency — retryable
    }
    try {
      await handle.write(out);
      await handle.sync();
    } finally {
      await handle.close();
    }
    // Atomic replace (rows are mutable, unlike write-once Cold objects); rename replaces a symlink at
    // `path` rather than following it.
    await rename(tmp, path).catch(async (err) => {
      await unlink(tmp).catch(() => {});
      throw mapFsError(err);
    });
    await fsyncDir(dirname(path)); // make the directory-entry update durable (C13 parity with Cold)
  }

  /**
   * Serialize callbacks for a given row path so read-modify-write is atomic in-process. `prev.then(fn,
   * fn)` runs `fn` regardless of whether the predecessor fulfilled or rejected — a conflict on one
   * writer must not stall the row's chain.
   */
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
