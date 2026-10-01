/**
 * In-memory drivers — the reference backing for tests and quick experiments.
 * They store **serialized bytes + an OCC token** (not live objects), so the engine's
 * safe-deserialize / size-cap paths and the registry's OCC paths are genuinely exercised.
 *
 * Not in `core/` (this is a driver), so it may hold concrete state.
 */
import { createHash } from 'node:crypto';
import { BufferSink } from '../core/blob';
import type { BlobSink } from '../core/blob';
import { NotFoundError, ValidationError, WriteConflictError } from '../core/errors';
import { segmentKey } from '../core/keys';
import { validateSegmentRef } from '../core/validate';
import type {
  StorageCaps,
  GenKey,
  IStorageDriver,
  IRegistryDriver,
  NewRegistryRecord,
  RegCaps,
  RegistryPatch,
  RegistryRecord,
  SegmentRef,
  Token,
} from '../core/ports';
import {
  applyRegistryPatch,
  recordFromNew,
  validateNewRegistryRecord,
  validateRegistryPatch,
} from './_shared/registry';

export interface MemoryRegistryDriverOptions {
  /** Injected clock for `createdAt`/`updatedAt`; defaults to `Date.now` (drivers may use ambient time). */
  readonly now?: () => number;
}

/**
 * In-memory {@link IRegistryDriver} — one record per segment under OCC. The token is a single global,
 * monotonic, never-reused counter (so a record recreated after `delete` always gets a strictly-greater
 * token → ABA-safe even though `delete` removes the row physically).
 */
export class MemoryRegistryDriver implements IRegistryDriver {
  private readonly rows = new Map<string, RegistryRecord>();
  private readonly now: () => number;
  private seq = 0;

  constructor(options: MemoryRegistryDriverOptions = {}) {
    this.now = options.now ?? (() => Date.now());
  }

  private nextToken(): Token {
    this.seq += 1;
    return String(this.seq);
  }

  capabilities(): RegCaps {
    return { strongRead: true };
  }

  async get(ref: SegmentRef): Promise<RegistryRecord | null> {
    validateSegmentRef(ref);
    const row = this.rows.get(segmentKey(ref));
    return row ? structuredClone(row) : null; // clone out: callers can't mutate stored (nested) state
  }

  async create(ref: SegmentRef, record: NewRegistryRecord): Promise<{ token: Token }> {
    validateSegmentRef(ref);
    validateNewRegistryRecord(record);
    const key = segmentKey(ref);
    if (this.rows.has(key)) {
      throw new WriteConflictError(`registry row already exists for segment ${ref.segment}`);
    }
    const token = this.nextToken();
    // clone in: the caller's (nested) retention/residency can't alias stored state (value semantics, parity
    // with the serialize-based persistent drivers).
    this.rows.set(key, structuredClone(recordFromNew(ref, record, this.now(), token)));
    return { token };
  }

  async compareAndSwap(
    ref: SegmentRef,
    expected: Token,
    patch: RegistryPatch,
  ): Promise<{ token: Token }> {
    validateSegmentRef(ref);
    validateRegistryPatch(patch);
    const key = segmentKey(ref);
    const existing = this.rows.get(key);
    if (!existing || existing.token !== expected) {
      throw new WriteConflictError(`OCC token mismatch for registry row ${ref.segment}`);
    }
    const token = this.nextToken();
    this.rows.set(key, structuredClone(applyRegistryPatch(existing, patch, this.now(), token)));
    return { token };
  }

  async *list(namespace?: string): AsyncIterable<RegistryRecord> {
    for (const row of this.rows.values()) {
      if (namespace === undefined || row.namespace === namespace) yield structuredClone(row);
    }
  }

  async delete(ref: SegmentRef, expected?: Token): Promise<void> {
    validateSegmentRef(ref);
    const key = segmentKey(ref);
    if (expected !== undefined && this.rows.get(key)?.token !== expected) {
      throw new WriteConflictError(`OCC token mismatch for registry row ${ref.segment}`);
    }
    this.rows.delete(key); // idempotent; token uniqueness is global so a recreate is ABA-safe
  }
}

/**
 * In-memory {@link IStorageDriver} — write-once immutable generation objects as opaque bytes. A "dumb byte
 * mover" (understands neither roaring nor `.crbm`), so it's a faithful storage backend for tests and a zero-setup
 * local storage tier. Mirrors the LocalFs/S3 contract (write-once, range/tail reads).
 */
export class MemoryStorageDriver implements IStorageDriver {
  private readonly objects = new Map<string, Uint8Array>();

  capabilities(): StorageCaps {
    return { rangeRead: true, maxObjectBytes: Number.MAX_SAFE_INTEGER, conditionalPut: true };
  }

  async putImmutable(
    key: GenKey,
    write: (sink: BlobSink) => Promise<void>,
  ): Promise<{ size: number; sha256: string }> {
    const k = genObjectKey(key); // validates ref + generation
    const sink = new BufferSink();
    await write(sink);
    const body = sink.bytes();
    if (this.objects.has(k)) {
      throw new WriteConflictError(
        `generation already exists (write-once): ${key.segment}.${key.generation}`,
      );
    }
    this.objects.set(k, body);
    return { size: body.length, sha256: createHash('sha256').update(body).digest('hex') };
  }

  async getRange(key: GenKey, offset: number, length: number): Promise<Uint8Array> {
    if (!Number.isInteger(offset) || !Number.isInteger(length) || offset < 0 || length < 0) {
      throw new ValidationError(`invalid range offset=${offset} length=${length}`);
    }
    const body = this.require(key);
    if (offset + length > body.length) {
      throw new ValidationError(
        `range [${offset}, ${offset + length}) out of bounds for ${body.length}B`,
      );
    }
    return body.slice(offset, offset + length);
  }

  async getTail(key: GenKey, maxBytes: number): Promise<{ bytes: Uint8Array; size: number }> {
    const body = this.require(key);
    const take = Math.min(Math.max(maxBytes, 0), body.length);
    return { bytes: body.slice(body.length - take), size: body.length };
  }

  async delete(key: GenKey): Promise<void> {
    this.objects.delete(genObjectKey(key)); // idempotent
  }

  async *list(ref: SegmentRef): AsyncIterable<GenKey> {
    validateSegmentRef(ref);
    const prefix = `${segmentKey(ref)} `;
    for (const k of this.objects.keys()) {
      if (k.startsWith(prefix)) {
        yield {
          namespace: ref.namespace,
          segment: ref.segment,
          generation: Number(k.slice(prefix.length)),
        };
      }
    }
  }

  private require(key: GenKey): Uint8Array {
    const body = this.objects.get(genObjectKey(key));
    if (body === undefined) {
      throw new NotFoundError(`no such generation: ${key.segment}.${key.generation}`);
    }
    return body;
  }
}

/** Collision-proof object key for a generation: `<segmentKey> <generation>` (the name parts are encoded, so a space cannot appear inside one). */
function genObjectKey(key: GenKey): string {
  validateSegmentRef(key);
  if (!Number.isInteger(key.generation) || key.generation < 0) {
    throw new ValidationError(`generation must be a non-negative integer; got ${key.generation}`);
  }
  return `${segmentKey(key)} ${key.generation}`;
}
