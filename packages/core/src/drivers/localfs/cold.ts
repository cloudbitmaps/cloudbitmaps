/**
 * `LocalFsColdDriver` — a zero-cloud {@link IColdDriver} backed by the local filesystem.
 *
 * Generations are write-once immutable files. A new object is streamed to a temp file (with its content
 * hashed in-flight), `fsync`-ed, then published with an atomic `link` that fails if the destination
 * already exists — so a generation can never be silently overwritten, and a crash leaves only an orphan
 * temp file, never a torn object (C13). Drivers do filesystem I/O and may use `node:crypto`; only `core/`
 * is bound by the determinism lint.
 */
import { constants as FS } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, open, readdir, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { NotFoundError, ValidationError, WriteConflictError } from '@/core/errors';
import type { BlobSink } from '@/core/blob';
import type { ColdCaps, GenKey, IColdDriver, SegmentRef } from '@/core/ports';
import { coldObjectPath, parseGeneration, segmentsDir } from './paths';
import { O_NOFOLLOW, fsyncDir, isCode, mapFsError } from './fs-util';

export class LocalFsColdDriver implements IColdDriver {
  constructor(private readonly root: string) {}

  capabilities(): ColdCaps {
    return { rangeRead: true, maxObjectBytes: Number.MAX_SAFE_INTEGER, conditionalPut: false };
  }

  async putImmutable(
    key: GenKey,
    write: (sink: BlobSink) => Promise<void>,
  ): Promise<{ size: number; sha256: string }> {
    const finalPath = coldObjectPath(this.root, key);
    await mkdir(dirname(finalPath), { recursive: true });

    const tmpPath = `${finalPath}.${randomUUID()}.tmp`;
    // 'wx' = O_CREAT|O_EXCL|O_WRONLY; add O_NOFOLLOW so a pre-planted symlink can't redirect the write.
    const handle = await open(tmpPath, FS.O_CREAT | FS.O_EXCL | FS.O_WRONLY | O_NOFOLLOW);
    const hash = createHash('sha256');
    let size = 0;
    const sink: BlobSink = {
      async write(bytes) {
        await handle.write(bytes);
        hash.update(bytes);
        size += bytes.length;
      },
    };

    try {
      await write(sink);
      await handle.sync();
    } catch (err) {
      await handle.close().catch(() => {});
      await unlink(tmpPath).catch(() => {});
      throw mapFsError(err);
    }
    await handle.close();

    // Atomic write-once publish: link fails with EEXIST if the generation already exists.
    try {
      await link(tmpPath, finalPath);
    } catch (err) {
      await unlink(tmpPath).catch(() => {});
      if (isCode(err, 'EEXIST')) {
        // A generation is write-once; a collision is a concurrency/state condition, not bad input.
        // Identify it by the logical key only — never leak the absolute filesystem path.
        throw new WriteConflictError(
          `generation already exists (write-once): ${key.segment}.${key.generation}`,
        );
      }
      throw mapFsError(err);
    }
    await unlink(tmpPath).catch(() => {});
    await fsyncDir(dirname(finalPath));
    return { size, sha256: hash.digest('hex') };
  }

  async getRange(key: GenKey, offset: number, length: number): Promise<Uint8Array> {
    if (!Number.isInteger(offset) || !Number.isInteger(length) || offset < 0 || length < 0) {
      throw new ValidationError(`invalid range offset=${offset} length=${length}`);
    }
    const handle = await this.openRead(key);
    try {
      const { size } = await handle.stat();
      if (offset + length > size) {
        throw new ValidationError(
          `range [${offset}, ${offset + length}) out of bounds for ${size}B`,
        );
      }
      const buf = Buffer.alloc(length);
      if (length > 0) await handle.read(buf, 0, length, offset);
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    } finally {
      await handle.close();
    }
  }

  async getTail(key: GenKey, maxBytes: number): Promise<{ bytes: Uint8Array; size: number }> {
    const handle = await this.openRead(key);
    try {
      const { size } = await handle.stat();
      const take = Math.min(Math.max(maxBytes, 0), size);
      const buf = Buffer.alloc(take);
      if (take > 0) await handle.read(buf, 0, take, size - take);
      return { bytes: new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength), size };
    } finally {
      await handle.close();
    }
  }

  async delete(key: GenKey): Promise<void> {
    // Idempotent: deleting an absent generation is a no-op (GC may race / retry).
    await unlink(coldObjectPath(this.root, key)).catch((err) => {
      if (!isCode(err, 'ENOENT')) throw mapFsError(err);
    });
  }

  async *list(ref: SegmentRef): AsyncIterable<GenKey> {
    const dir = segmentsDir(this.root, ref);
    let names: string[];
    try {
      names = await readdir(dir);
    } catch (err) {
      if (isCode(err, 'ENOENT')) return; // no generations yet
      throw mapFsError(err);
    }
    for (const name of names) {
      const generation = parseGeneration(ref.segment, name);
      if (generation !== null) {
        yield { namespace: ref.namespace, segment: ref.segment, generation };
      }
    }
  }

  private async openRead(key: GenKey): Promise<Awaited<ReturnType<typeof open>>> {
    try {
      return await open(coldObjectPath(this.root, key), FS.O_RDONLY | O_NOFOLLOW);
    } catch (err) {
      if (isCode(err, 'ENOENT')) {
        throw new NotFoundError(`no such generation: ${key.segment}.${key.generation}`);
      }
      // A symlink at the object path is rejected (ELOOP) — treat as not-found, don't follow it.
      if (isCode(err, 'ELOOP')) {
        throw new NotFoundError(
          `generation path is a symlink, refusing: ${key.segment}.${key.generation}`,
        );
      }
      throw mapFsError(err);
    }
  }
}
