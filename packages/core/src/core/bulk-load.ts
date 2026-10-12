/**
 * The loader `load()` is built on: ids or a decoded bitmap in, one generation written and published.
 */
import { type IAuditSink, NOOP_AUDIT, safeAudit } from './audit';
import { KeyUnavailableError, ValidationError } from './errors';
import { yieldEvery } from './cooperative';
import type { Clock } from './determinism';
import { incarnationField } from './token';
import { MAX_REMAINDER } from './bit-route';
import { aadFor } from './crypto';
import type { Aead, CrbmCrypto, IKeystore, WrappedDek } from './crypto';
import type {
  GenerationMetadata,
  GenKey,
  IStorageDriver,
  IRegistryDriver,
  RegistryRecord,
  RegistrySummary,
  SegmentRef,
} from './ports';
import type { CodecBitmap, CodecInterface, EncodedChunk } from './codec';
import { requireCodec } from './codec';
import { ChunkLoadInput, DecodedLoadInput } from './load-input';
import { summaryOf } from './summary';
import { encodeEach, encodedChunksOfInput, writeEncodedChunks } from './crbm-write';
import { sameKeys, provesOwnObject } from './crbm-open';
import { publishGenerationKept } from './publish';

/** What a bulk-load wrote — the driver's `{ size, sha256 }` plus a summary of the built generation. */
export interface BulkLoadResult {
  /** Bytes written to the Storage object. */
  readonly size: number;
  /** The driver's content hash of the object. */
  readonly sha256: string;
  /** Distinct non-empty chunks written (≤ 65536). */
  readonly chunkCount: number;
  /**
   * The DEK freshly minted for this generation, wrapped — present only when the segment is encrypted AND this
   * call minted one (an existing segment reuses its key, which is already on the row).
   *
   * Returned so a caller that deliberately does **not** pass `registry` here — writing now and publishing later,
   * which is how a load applies a guard while the old generation is still authoritative — can carry the key onto
   * its own `publishGeneration`. Without it that publish stores no DEK and the generation it makes current is
   * unreadable: the bytes are encrypted with a key nothing recorded.
   */
  readonly wrappedDeks?: readonly WrappedDek[];
  /** Whether the object was written encrypted: under the segment's key, or under one this call minted. */
  readonly encrypted: boolean;
  /** The written object's fingerprint, which tells it from an object stored later under the same key. */
  readonly fingerprint: string;
  /** Total distinct ids in the generation (post-dedup). */
  readonly cardinality: number;
  /**
   * The summary of what was written, for the write that makes it current: its id count and metadata, sealed under the
   * segment's key when the object was written with one. A caller that defers the publish (`publish: false`) passes it
   * to {@link publishGeneration}.
   */
  readonly summary: RegistrySummary;
  /**
   * Whether this generation is now the segment's **current** one — `undefined` when no `registry` was wired, so
   * there is no pointer and no publish step to report on.
   *
   * `false` means the object is durable but a **concurrent writer published a higher generation first**, so this
   * one is an orphan that no reader will ever resolve. The write succeeded and the *load* did not: whatever this
   * call was asked to make the segment contain, the segment does not contain. That is not a detail a caller can
   * be left to infer — a `*Into` materialisation that reported the generation it wrote as "the destination's new
   * current generation" on this path would state a plain untruth — so the flag is on the result and the verbs that
   * promise a published generation check it.
   */
  readonly becameCurrent?: boolean;
}

/**
 * **Bulk-load** a whole immutable generation from a flat id source — the batch "seed/rebuild" entry point.
 * Unlike {@link writeCrbmGeneration} (which takes pre-grouped bitmaps), this
 * consumes an arbitrary, **unsorted** stream of u32 ids (sync or async) and routes each into its chunk's
 * Roaring bitmap as it goes. The input is consumed lazily and ids dedup on insert, so memory is bounded by
 * the **built generation** — the in-memory Roaring representation of the *distinct* set (≤ one bitmap per
 * non-empty chunk) — not by the input length: you can stream a billion duplicate-heavy ids and hold only the
 * distinct result. Note this is `O(distinct set)`, **not** window-bounded like {@link SegmentEngine.intersect}:
 * bulk-load holds the whole generation in RAM, which suits batch seed/rebuild jobs but not an
 * unbounded-cardinality stream (a segment larger than RAM needs external-merge / pre-sorted input — later phase).
 *
 * Each id must be an integer in `[0, 2³²)` ({@link splitId} throws {@link ValidationError} otherwise) — the
 * source is consumed lazily, so a bad id aborts mid-stream without writing a partial object (the driver
 * commits only after the callback resolves). An empty source writes a valid empty generation.
 *
 * Writes a fresh full snapshot of a segment. The caller picks the generation number in `key` — `nextGeneration`
 * computes one from the registry and the bucket, as `nextLoadGeneration` does for a load — and re-using an existing
 * generation throws
 * {@link WriteConflictError} (write-once). Without a registry a `StorageChunkSource` serves the **highest**
 * generation present, so a too-high number silently shadows real data; with one, `publishGeneration` decides.
 */
export function bulkLoadCrbmGeneration(
  driver: IStorageDriver,
  key: GenKey,
  ids: Iterable<number> | AsyncIterable<number> | DecodedLoadInput | ChunkLoadInput,
  options: {
    registry?: IRegistryDriver;
    keystore?: IKeystore;
    requireEncryption?: boolean;
    audit?: IAuditSink;
    /** Bitmap codec. Optional in the type; a **flavor** package binds it ({@link requireCodec}). */
    codec?: CodecInterface;
    /**
     * Injected clock. Supplying one makes bulk-load **cooperative**: it yields the event loop periodically so a
     * long load does not stall everything else on the process. Without it the load still completes, just
     * without yielding — which is the pre-existing behaviour, kept so this is purely additive.
     *
     * `@cloudbitmaps/roaring` supplies a real clock by default, so flavor users get cooperative behaviour with
     * no wiring. `core/` cannot default it: it is timer-free by lint, which is exactly why waiting goes through
     * this seam rather than `setTimeout`.
     */
    clock?: Clock;
    /**
     * Write the object but do **not** advance the pointer (default: publish when a `registry` is wired).
     *
     * For a caller that has to inspect what it wrote before deciding whether it should become current — a
     * guarded {@link loadSegment} is the one in-tree case — because the check is only meaningful while the old
     * generation is still authoritative. The `registry` is still required for an encrypted segment and still
     * consulted: it is where an existing segment's DEK lives, and reusing that key is not optional. The wrapped
     * DEK comes back on the result so the deferred publish can store it.
     *
     * A caller that defers the publish owns what it wrote: an unpublished object sits ABOVE `currentGen`, where
     * generation collection deliberately never looks, so nothing reclaims it until a later generation above it is
     * current.
     */
    publish?: boolean;
    /**
     * The generation's metadata (see {@link GenerationMetadata}), written into the object and carried in the summary.
     * The caller has checked it against the metadata rules; the writer checks it again, and refuses a record that breaks
     * one before a byte is written.
     */
    metadata?: GenerationMetadata;
    /**
     * The segment's row as the caller already read it (`null`: it found none), for a caller that defers the
     * publish (`publish: false`) and fences it on that same row. A present cleartext row is then used as read,
     * rather than read again: a row that changes in between (a publish, a drop, a purge and re-create) makes the
     * fenced publish lose, so the object is never published on the strength of the stale read. A row read as
     * absent, or one carrying key material, is read again after the ids, as with no row passed: a first load must
     * see a row another writer created meanwhile, and an encrypted segment's key is unwrapped only from a row read
     * after the ids, so a segment shredded while they streamed is refused before its key is used.
     */
    row?: RegistryRecord | null;
  } = {},
): Promise<BulkLoadResult> {
  return bulkLoadAhead(driver, key, { generation: Promise.resolve(key.generation) }, ids, options);
}

/**
 * What a load has already started when it calls {@link bulkLoadAhead}: its number, and the segment's data key, each
 * still in flight so their round trips overlap the encoding. Both are joined where the write needs them, and neither
 * may be left to reject unobserved.
 */
interface LoadAhead {
  /** The number the generation takes (see {@link nextLoadGeneration}); joined just before the object is written. */
  readonly generation: PromiseLike<number>;
  /**
   * The key a caller already asked the keystore to unwrap, with the wrappings it asked about. Used only when the
   * row the write reads after the ids carries exactly these wrappings; otherwise the write unwraps for itself.
   */
  readonly unwrapped?: {
    readonly wrapped: readonly WrappedDek[];
    readonly aead: PromiseLike<Aead>;
  };
}

/** What a load with `requireEncryption` meets on a segment that already has a cleartext generation. */
export function cleartextUnderRequiredEncryption(
  ref: SegmentRef,
  currentGen: number,
): ValidationError {
  return new ValidationError(
    `requireEncryption: segment "${ref.segment}" already has generation ${currentGen} in ` +
      `cleartext, so this load cannot be encrypted — encryption is chosen when a segment is first ` +
      `loaded. Load into a new segment with the keystore wired, then drop this one.`,
  );
}

/**
 * {@link bulkLoadCrbmGeneration} for a load whose number, and perhaps its key, are still being fetched: the same
 * options, with the same meaning, and the same writes. The number is joined only where the object is written.
 */
export async function bulkLoadAhead(
  driver: IStorageDriver,
  ref: SegmentRef,
  ahead: LoadAhead,
  ids: Parameters<typeof bulkLoadCrbmGeneration>[2],
  options: NonNullable<Parameters<typeof bulkLoadCrbmGeneration>[3]> = {},
): Promise<BulkLoadResult> {
  if (options.keystore === undefined && options.requireEncryption === true) {
    throw new ValidationError('requireEncryption: a load needs a keystore to write encrypted');
  }
  const codec = requireCodec(options.codec, 'bulkLoadCrbmGeneration');
  // A decoded bitmap writes its own chunks, which never touches an id. Ids, and the bitmap of a codec that cannot
  // encode its own chunks, are bucketed per chunk instead; both give the same bytes.
  let chunks: Iterable<EncodedChunk>;
  if (ids instanceof ChunkLoadInput) {
    // A combine's chunks are held whole before the first write, as the bucketed ids are, so the reads they cost come
    // where the ids' do: before the row is read, and a read that fails writes nothing.
    chunks = encodeEach(rangeCheckedAtWrite(await collectChunks(ids, codec, options.clock)));
  } else {
    chunks = await encodedChunksOfInput(ids, codec, options.clock);
  }

  if (options.keystore !== undefined && options.registry === undefined) {
    throw new ValidationError('an encrypted load requires a registry to store the wrapped DEK');
  }
  // Read the segment's record once (when a registry is wired): to refuse writing to a crypto-shredded segment (which
  // would create unreadable/unreachable bytes), and to reuse its DEK if it's encrypted. A present cleartext row the
  // caller already read is used as read (see `row`).
  const passed = options.row;
  const existing =
    passed !== undefined &&
    passed !== null &&
    (passed.wrappedDeks === undefined || passed.wrappedDeks.length === 0)
      ? passed
      : options.registry !== undefined
        ? await options.registry.get(ref)
        : null;
  if (existing?.status === 'destroyed') {
    throw new ValidationError(
      `segment "${ref.segment}" is destroyed (crypto-shredded) — refusing to write; use a new segment`,
    );
  }

  // An encrypted row with no keystore is a lost key, not a cleartext segment — the same fail-fast the erasure
  // rewrite does. Without it this wrote a CLEARTEXT generation onto a row that still advertises `wrappedDeks`, and the
  // damage is not just a confusing state: `destroySegment` keys `cryptoShredded` off the *presence* of wrappings,
  // so shredding that segment emits `segment.erase` — the audit event defined as "these bytes are unreadable
  // everywhere, backups included" — over bytes that are plaintext and stay readable from any copy. An audit trail
  // that over-attests is the one failure it exists to prevent, so this refuses to create the state.
  if (
    existing?.wrappedDeks !== undefined &&
    existing.wrappedDeks.length > 0 &&
    options.keystore === undefined
  ) {
    throw new KeyUnavailableError(
      `segment "${ref.segment}" is encrypted but this load has no keystore — refusing to write a cleartext ` +
        `generation onto an encrypted segment. Pass the keystore holding its DEK.`,
    );
  }

  // The number is joined only here, after the ids are bucketed and the row is read and judged: its existence check
  // ran while they did, and a check that failed fails the load now, before anything is written.
  const generation = await ahead.generation;
  const key: GenKey = { namespace: ref.namespace, segment: ref.segment, generation };

  // Encryption (opt-in): reuse the segment's existing DEK, or mint a fresh one on its FIRST generation.
  //
  // The segment's own posture decides, not the presence of a keystore. A keystore is wired on the store, so it is
  // in scope for every segment that store touches — including ones deliberately left cleartext — and minting on
  // that basis alone is what made "load it again with a keystore wired" destroy the data: the minted wrapping has
  // nowhere to live on a row whose pointer is already set (see `publishGeneration`'s advance branch), so the
  // generation ends up encrypted under a key that exists in no persistent store. `requireEncryption` is the way
  // to *demand* encryption, and on an already-cleartext lineage it fails fast rather than silently downgrading.
  let crypto: CrbmCrypto | undefined;
  let newWrapped: readonly WrappedDek[] | undefined;
  if (options.keystore !== undefined) {
    if (existing?.wrappedDeks !== undefined && existing.wrappedDeks.length > 0) {
      // Reuse the segment's DEK: the one the caller already asked for when the row still carries its wrappings,
      // otherwise a fresh unwrap of what the row carries now.
      const early = ahead.unwrapped;
      const aead =
        early !== undefined && sameKeys(early.wrapped, existing.wrappedDeks)
          ? await early.aead
          : await options.keystore.openDek(existing.wrappedDeks);
      crypto = { aead, aadFor: (scope) => aadFor(key, key.generation, scope) };
    } else if (existing !== null && existing.currentGen !== null) {
      // An existing lineage with no key material on the row: the segment is cleartext, and one segment cannot be
      // half-encrypted — a pin of a superseded generation, once its reader is reopened, would find bytes its key
      // cannot open, and a later `destroySegment` would attest that shredding one DEK made every copy unreadable
      // while the older cleartext objects stay readable from any of them.
      if (options.requireEncryption === true)
        throw cleartextUnderRequiredEncryption(ref, existing.currentGen);
      // Otherwise the segment stays what it is: cleartext.
    } else {
      const minted = await options.keystore.createDek();
      newWrapped = minted.wrapped;
      crypto = { aead: minted.aead, aadFor: (scope) => aadFor(key, key.generation, scope) };
    }
  }

  const { size, sha256, chunkCount, cardinality, fingerprint } = await writeEncodedChunks(
    driver,
    key,
    chunks,
    { crypto, clock: options.clock, metadata: options.metadata },
  );
  const summary = summaryOf(
    key,
    key.generation,
    { cardinality, metadata: options.metadata, fingerprint },
    crypto?.aead,
  );
  // Publish only after the immutable object is durable (write-then-publish): a registry-aware reader should
  // never point at a generation that isn't fully written. A freshly minted DEK is stored on this publish.
  if (options.registry !== undefined && options.publish !== false) {
    const published = await publishGenerationKept(options.registry, key, {
      wrappedDeks: newWrapped,
      summary,
      cleartext: crypto === undefined,
      holdsOwnObject: () => provesOwnObject(driver, key, fingerprint),
      clock: options.clock,
    });
    const becameCurrent = published.published;
    // Audit the publish only when this generation actually *became* the current one — not when a
    // forward-only publish no-oped because a newer generation was already current (the event's contract is
    // "became the segment's current generation"). Needs a registry to have a "current generation" at all.
    if (becameCurrent) {
      safeAudit(options.audit ?? NOOP_AUDIT).onEvent({
        kind: 'segment.publish',
        namespace: key.namespace,
        segment: key.segment,
        ...incarnationField(published.token),
        generation: key.generation,
      });
    }
    return {
      size,
      sha256,
      chunkCount,
      cardinality,
      summary,
      becameCurrent,
      wrappedDeks: newWrapped,
      encrypted: crypto !== undefined,
      fingerprint,
    };
  }
  return {
    size,
    sha256,
    chunkCount,
    cardinality,
    summary,
    wrappedDeks: newWrapped,
    encrypted: crypto !== undefined,
    fingerprint,
  };
}

/**
 * The chunks a load was handed, each range-checked again as it is written: a caller's bitmap could have been changed
 * after the load collected it.
 */
function* rangeCheckedAtWrite(
  chunks: Iterable<{ chunkKey: number; bitmap: CodecBitmap }>,
): Generator<{ chunkKey: number; bitmap: CodecBitmap }> {
  for (const chunk of chunks) {
    const max = chunk.bitmap.maximum?.();
    if (max !== undefined && max > MAX_REMAINDER) {
      throw new ValidationError(
        `a chunk holds a value outside the 16-bit range [0, ${MAX_REMAINDER}]`,
      );
    }
    yield chunk;
  }
}

/**
 * Take a combine's chunks as they come, checking each as an id's chunk is checked: the bitmap one the codec made, the
 * key a u16 and above the last, the values 16-bit (`maximum()`, one call per chunk). The bitmaps are the load's to
 * consume: encoding may re-encode one in place (representation only), so a caller hands over bitmaps it owns. An empty bitmap is left out where the chunks are encoded, as for
 * ids, and the writer checks the cardinality when it adds a chunk.
 */
async function collectChunks(
  input: ChunkLoadInput,
  codec: CodecInterface,
  clock: Clock | undefined,
): Promise<Array<{ chunkKey: number; bitmap: CodecBitmap }>> {
  const chunks: Array<{ chunkKey: number; bitmap: CodecBitmap }> = [];
  const tick = yieldEvery(clock);
  let last = -1;
  for await (const chunk of input.chunks) {
    if (typeof chunk !== 'object' || chunk === null) {
      throw new ValidationError('a chunk must be an object with a chunkKey and a bitmap');
    }
    // Each field is read once, so the bitmap checked is the bitmap written. Only the codec's own bitmaps are written as
    // they are: one of any other shape could hold bytes or a count the codec never checked, and would be published.
    const { chunkKey, bitmap } = chunk;
    if (codec.owns?.(bitmap) !== true) {
      throw new ValidationError(`a chunk's bitmap is not one this load's codec made`);
    }
    if (!Number.isInteger(chunkKey) || chunkKey < 0 || chunkKey > MAX_REMAINDER) {
      throw new ValidationError("a chunk's key must be an integer in [0, 65535]");
    }
    if (chunkKey <= last) {
      throw new ValidationError(`chunk ${chunkKey} does not ascend: the last was ${last}`);
    }
    last = chunkKey;
    const max = bitmap.maximum?.();
    if (max !== undefined && max > MAX_REMAINDER) {
      throw new ValidationError(
        `a chunk holds a value outside the 16-bit range [0, ${MAX_REMAINDER}]`,
      );
    }
    chunks.push({ chunkKey, bitmap });
    const pause = tick();
    if (pause !== null) await pause;
  }
  return chunks;
}
