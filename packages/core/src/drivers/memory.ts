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
import type { Entropy } from '../core/determinism';
import { NotFoundError, ValidationError, WriteConflictError } from '../core/errors';
import { segmentKey } from '../core/keys';
import { validateSegmentRef } from '../core/validate';
import type {
  StorageCaps,
  StorageDeleteOptions,
  TailRead,
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
  drawIncarnation,
  drawWrite,
  incarnationOf,
  recordFromNew,
  validateNewRegistryRecord,
  validateRegistryPatch,
} from './_shared/registry';
import { entropyIsAvailable, webCryptoEntropy } from './_shared/entropy';

export interface MemoryRegistryDriverOptions {
  /** Injected clock for `createdAt`/`updatedAt`; defaults to `Date.now` (drivers may use ambient time). */
  readonly now?: () => number;
  /** Draws every token's random parts; defaults to Web Crypto. Inject one only to make a test replayable. */
  readonly entropy?: Entropy;
}

/**
 * In-memory {@link IRegistryDriver} — one record per segment under OCC. The token has the form every shipped driver
 * gives it, an incarnation id drawn at create, a counter and a per-write random part, but its counter is global to the
 * driver: monotonic and never reused, so a record recreated after `delete` never meets an earlier token, by
 * construction, even though `delete` removes the row physically.
 */
export class MemoryRegistryDriver implements IRegistryDriver {
  private readonly rows = new Map<string, RegistryRecord>();
  private readonly now: () => number;
  private readonly entropy: Entropy;
  private seq = 0;

  constructor(options: MemoryRegistryDriverOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.entropy = options.entropy ?? webCryptoEntropy;
  }

  private nextToken(incarnation: string): Token {
    this.seq += 1;
    return `${incarnation}.${this.seq}.${drawWrite(this.entropy)}`;
  }

  /** `conditionalDelete`: a delete checks the token and removes the row in one step, with no await between. */
  capabilities(): RegCaps {
    return entropyIsAvailable(this.entropy)
      ? { strongRead: true, conditionalDelete: true }
      : { strongRead: true, canWrite: false, conditionalDelete: true };
  }

  async get(ref: SegmentRef): Promise<RegistryRecord | null> {
    validateSegmentRef(ref);
    const row = this.rows.get(segmentKey(ref));
    return row ? structuredClone(row) : null; // clone out: callers can't mutate stored (nested) state
  }

  async create(ref: SegmentRef, record: NewRegistryRecord): Promise<{ token: Token }> {
    validateSegmentRef(ref);
    const checked = validateNewRegistryRecord(record);
    const key = segmentKey(ref);
    if (this.rows.has(key)) {
      throw new WriteConflictError(`registry row already exists for segment ${ref.segment}`);
    }
    const token = this.nextToken(drawIncarnation(this.entropy));
    // clone in: the caller's (nested) retention/residency can't alias stored state (value semantics, parity
    // with the serialize-based persistent drivers).
    this.rows.set(key, structuredClone(recordFromNew(ref, checked, this.now(), token)));
    return { token };
  }

  /**
   * A caller's `held` row (see `RegistryWriteOptions`) has no read to spare here: the token is compared with the stored row in the same step
   * as the write, in memory, so a stale one fails exactly as a lost race does.
   */
  async compareAndSwap(
    ref: SegmentRef,
    expected: Token,
    patch: RegistryPatch,
  ): Promise<{ token: Token }> {
    validateSegmentRef(ref);
    const checked = validateRegistryPatch(patch);
    const key = segmentKey(ref);
    const existing = this.rows.get(key);
    if (!existing || existing.token !== expected) {
      throw new WriteConflictError(`OCC token mismatch for registry row ${ref.segment}`);
    }
    // Every row here was created by this driver, so its token carries an incarnation, which every write keeps.
    const token = this.nextToken(incarnationOf(existing.token)!);
    this.rows.set(key, structuredClone(applyRegistryPatch(existing, checked, this.now(), token)));
    return { token };
  }

  async *list(namespace?: string): AsyncIterable<RegistryRecord> {
    // A namespace that is given is checked as every other name is: `''` names none, and reads as an error, not as empty.
    if (namespace !== undefined) validateSegmentRef({ segment: 'x', namespace });
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
 *
 * Every object stored gets a version from a counter the driver never reuses, so two objects stored one after the other
 * under one key never share one, whatever their bytes. A delete given `ifVersion` compares it with the stored object's
 * and removes it in the same step, with no await between them: `conditionalDelete` is `true`.
 */
export class MemoryStorageDriver implements IStorageDriver {
  private readonly objects = new Map<
    string,
    { readonly body: Uint8Array; readonly version: string }
  >();
  private stored = 0;

  capabilities(): StorageCaps {
    return {
      rangeRead: true,
      maxObjectBytes: Number.MAX_SAFE_INTEGER,
      conditionalPut: true,
      conditionalDelete: true,
    };
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
    this.stored += 1;
    this.objects.set(k, { body, version: String(this.stored) });
    return { size: body.length, sha256: createHash('sha256').update(body).digest('hex') };
  }

  async getRange(key: GenKey, offset: number, length: number): Promise<Uint8Array> {
    if (!Number.isInteger(offset) || !Number.isInteger(length) || offset < 0 || length < 0) {
      throw new ValidationError(`invalid range offset=${offset} length=${length}`);
    }
    const { body } = this.require(key);
    if (offset + length > body.length) {
      throw new ValidationError(
        `range [${offset}, ${offset + length}) out of bounds for ${body.length}B`,
      );
    }
    return body.slice(offset, offset + length);
  }

  async getTail(key: GenKey, maxBytes: number): Promise<TailRead> {
    const { body, version } = this.require(key);
    const take = Math.min(Math.max(maxBytes, 0), body.length);
    return { bytes: body.slice(body.length - take), size: body.length, version };
  }

  async delete(key: GenKey, options?: StorageDeleteOptions): Promise<void> {
    const k = genObjectKey(key);
    const ifVersion = options?.ifVersion;
    const stored = this.objects.get(k);
    // The check and the removal in one step: nothing can store another object under the key between them.
    if (ifVersion !== undefined && stored !== undefined && stored.version !== ifVersion) {
      throw new WriteConflictError(
        `generation ${key.segment}.${key.generation} is another object than the version given; not deleted`,
      );
    }
    this.objects.delete(k); // idempotent
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

  private require(key: GenKey): { readonly body: Uint8Array; readonly version: string } {
    const stored = this.objects.get(genObjectKey(key));
    if (stored === undefined) {
      throw new NotFoundError(`no such generation: ${key.segment}.${key.generation}`);
    }
    return stored;
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
