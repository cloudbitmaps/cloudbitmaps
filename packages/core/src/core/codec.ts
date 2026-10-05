/**
 * The **bitmap-codec seam**.
 *
 * `core/` is **codec-agnostic**: `SegmentEngine`, the erasure rewrite, and the `.crbm` read/write helpers only ever
 * construct and combine bitmaps through the {@link CodecInterface} factory + the {@link CodecBitmap} value type
 * defined here — never a concrete implementation. The flagship codec is roaring (in
 * `@cloudbitmaps/roaring`), and another codec would plug in behind the same seam with zero engine or driver
 * changes. That is the seam's value even with one codec shipped: a plain-bitset flavor was measured and
 * **decided against** (above ~6% density a Roaring chunk already *is* an uncompressed bitset), so the seam is
 * what let that question be answered by measurement rather than by a rewrite.
 *
 * **Homogeneity contract:** a single store uses a single codec, so every {@link CodecBitmap} an operation sees
 * was produced by the same {@link CodecInterface}. The binary set ops ({@link CodecBitmap.orInPlace} etc.) may
 * therefore assume `other` is the same concrete type and are not required to interoperate across codecs.
 * (Corollary: a decoded-chunk cache is codec-specific — never share one `cache` across engines built with
 * different codecs, or a cached bitmap from codec A could reach codec B's in-place op. The `CloudRoaring` facade
 * mints the cache per store, so this cannot arise in normal use.)
 *
 * **Interface surface = exactly what the engine needs**, kept general enough for the known fast-follow codecs
 * (positional/rank-select access + raw-bitset interop that `@cloudbitmaps/bitset` will add live on that
 * package's own extended value type, not here — the engine never calls them). The one codec-linked concern
 * this seam intentionally leaves in the format layer is the `.crbm` **payload codec id**
 * (`PAYLOAD_CODEC_ROARING_PORTABLE` / `KNOWN_PAYLOAD_CODEC_IDS` in `crbm/format.ts`): it is stamped in the footer
 * and validated on read, as membership of a registry rather than equality with one constant, so a codec-specific
 * name is not frozen into the format at `1.0` and a future codec is a one-line registration rather than a major
 * format version. Still deliberately outside this interface: a codec declares
 * its bytes, the seam does not.
 */

import { ValidationError } from './errors';

/**
 * The value type a codec produces — a mutable set of `u32` with set algebra and portable (de)serialization.
 * This is the shape the roaring flavor's bitmap already has; the engine holds these, caches them, and merges tiers with them.
 */
export interface CodecBitmap {
  /** Serialize with the codec's **stable, portable** format (never a frozen/unsafe variant). */
  serialize(): Uint8Array;
  add(value: number): void;
  addMany(values: Iterable<number>): void;
  remove(value: number): void;
  removeMany(values: Iterable<number>): void;
  has(value: number): boolean;
  /** Cardinality. */
  readonly size: number;
  readonly isEmpty: boolean;
  /** A deep copy — mutating the clone must not touch the original (the cache relies on this). */
  clone(): CodecBitmap;
  /** In-place union `this = this ∪ other`. `other` is from the same codec (see the homogeneity contract). */
  orInPlace(other: CodecBitmap): void;
  /** In-place difference `this = this \ other`. */
  andNotInPlace(other: CodecBitmap): void;
  /** In-place intersection `this = this ∩ other`. */
  andInPlace(other: CodecBitmap): void;
  /** Ascending iterator over the set values. */
  [Symbol.iterator](): IterableIterator<number>;
  toArray(): number[];
  /**
   * The set's values as one ascending `Uint32Array` the caller owns: what a batch read converts a chunk with, in one
   * native step instead of one iterator step per value.
   *
   * **Optional.** A codec without it is read through its iterator, which is correct and slower.
   *
   * **It must return a NEW array on every call, which the caller owns:** the engine adds the chunk's base to each
   * value in place and hands the array on, so an array that is shared, cached or a view of the bitmap's own storage
   * would be corrupted, and would corrupt the bitmap. It holds exactly what the iterator yields, ascending.
   */
  toUint32Array?(): Uint32Array;
  /**
   * The largest value in the set, or `undefined` when empty.
   *
   * **Optional, and deliberately so.** The engine uses it for one thing: asserting that a payload it is about
   * to interpret **as a chunk** holds only 16-bit remainders (see {@link assertChunkPayload}). A codec that
   * cannot answer this in better than O(n) should simply omit it — the engine then skips the check rather
   * than walking every value on the read path, which is the one thing this must never cost.
   *
   * Roaring answers it in O(1) from its container index, so the flagship codec implements it. The check is only
   * as good as the answer: a codec that implements this must return the true largest value of whatever
   * {@link CodecInterface.safeDeserialize} decoded, which for roaring holds only because that call refuses bytes
   * whose containers or values are out of order.
   */
  maximum?(): number | undefined;
  /**
   * Re-encode for size, in place, immediately before a **storage** write. Representation only — this must never
   * change membership, and `serialize()` afterwards must decode back to exactly the same set.
   *
   * **Canonical:** afterwards `serialize()` depends on membership alone, never on how the bitmap was built. A load
   * relies on it: a chunk built from ids and the same chunk cut from a caller's bitmap must store the same bytes.
   *
   * **Optional, like {@link maximum}.** A codec whose encoding has no size decision to make (a plain bitset has
   * one representation and nothing to choose) simply omits it, and the engine skips the call.
   *
   * WHY THIS EXISTS. Roaring picks per container between an array, a bitset and a RUN — but the run choice is
   * not automatic in any implementation: it is a `runOptimize()` pass you have to ask for, and nothing here was
   * asking. So two of the three container types were ever used, and run-shaped data paid list or bitmap prices
   * for a run. Measured on the shipped codec: a contiguous 1,000,000-id range serialized to 128.1 KiB where
   * run-encoding needs **0.2 KiB** (570×), and a 2,000-run shape 536.5 KiB against **8.5 KiB** (63×). Sparse
   * data is unchanged, because there are no runs to find — the pass is not a gamble.
   *
   * WHY ONLY AT WRITE TIME. This is called where a whole immutable generation is written, so its cost amortizes
   * over a write that is already serializing and checksumming every chunk — and a generation is read many times
   * after. It is deliberately NOT called on the read path (a clone made for a combine is transient): the hot path
   * must not pay for a win that only the stored bytes collect, per KISS/YAGNI.
   */
  optimize?(): void;
  /**
   * This set as storage chunks: ascending by chunk key, empty chunks left out, each payload exactly the bytes that
   * {@link CodecInterface.fromValues} of that chunk's low 16 bits, then {@link optimize}, then {@link serialize}
   * would give. So a generation written from these is byte for byte the one the same ids write. It may re-encode
   * this bitmap in place first, as `optimize()` does; membership is untouched.
   *
   * **Flavor-author surface, and optional.** A load from a bitmap or from serialized bytes writes these, never
   * touching an id in JavaScript. A codec without it still loads those inputs, through the bitmap's ids.
   */
  encodeChunks?(): Iterable<EncodedChunk>;
}

/**
 * One chunk of a set, encoded for storage: what {@link CodecBitmap.encodeChunks} yields, and what a `.crbm`
 * generation stores per chunk. Flavor-author surface.
 */
export interface EncodedChunk {
  /** The high 16 bits every id in the chunk shares. */
  readonly chunkKey: number;
  /** The stored bytes: the codec's serialization of a bitmap holding only the chunk's low 16 bits. */
  readonly payload: Uint8Array;
  /** How many ids the chunk holds, 1 to 65,536. */
  readonly cardinality: number;
}

/**
 * A pluggable bitmap codec — the factory the codec-agnostic engine constructs {@link CodecBitmap}s through.
 * Implementations **must** size-cap before handing untrusted bytes to any native decoder and use a safe
 * (never a trusting/frozen) deserializer — hard invariant 5.
 */
export interface CodecInterface {
  /** An empty set. */
  empty(): CodecBitmap;
  /** A set seeded from an iterable of `u32` values. */
  fromValues(values: Iterable<number>): CodecBitmap;
  /**
   * Size-cap (`bytes.length <= maxBytes`) then portable-deserialize. Throws `IntegrityError` when the input
   * exceeds the cap or fails to decode — the native decoder is never handed unbounded or unsafe-format input.
   *
   * "Fails to decode" includes bytes that are the right length and the wrong shape. A bitmap this returns must
   * satisfy every invariant its own operations assume (for roaring: containers and values in order, runs
   * disjoint, cardinalities matching the bits), because the engine trusts `has`, `size`, iteration order and
   * {@link CodecBitmap.maximum} on what comes back, and a decoder that only bounds its reads guarantees none of
   * them.
   *
   * `whole: true` means the bytes must be exactly one bitmap: anything after its end is refused too. A load passes
   * it for a caller's bytes, so two serializations back to back are refused rather than loaded as the first. A
   * stored chunk is read without it. A codec must honour it: core cannot read the format, so it relies on the codec
   * for this refusal, and a codec that ignores the option loads two concatenated bitmaps as the first of them.
   */
  safeDeserialize(
    bytes: Uint8Array,
    maxBytes: number,
    options?: { readonly whole?: boolean },
  ): CodecBitmap;
  /**
   * Whether `bitmap` is one this codec made: its own type, with the invariants its own operations keep (a `size` that
   * is the true cardinality, a `serialize()` that decodes back to the same set). A load of a combine's chunks
   * ({@link loadSegmentChunks}) writes bitmaps it is given without decoding them again, so it asks this of each and
   * refuses any that answers `false`.
   *
   * **Optional.** A codec without it cannot vouch for a bitmap, so a load of chunks refuses every chunk it is given.
   */
  owns?(bitmap: unknown): boolean;
}

/**
 * Resolve a codec that a **public core entry point** was given, failing fast when it is missing.
 *
 * Why these entry points take `codec?` rather than a required field: `loadSegment` / `eraseIdFromSegment` /
 * `runExport` are call-compatible public API, and core cannot supply a default (the concrete
 * codec lives in a *flavor* package that depends on core — a default here would invert that arrow). A **flavor**
 * package binds the codec for its users (`@cloudbitmaps/roaring`'s store passes its codec to each of these), so an
 * application never reaches this throw; only someone calling `@cloudbitmaps/core` directly — i.e. a flavor or
 * driver author — can, and for them the typed error names exactly what to pass.
 */
export function requireCodec(codec: CodecInterface | undefined, api: string): CodecInterface {
  if (codec === undefined) {
    throw new ValidationError(
      `${api} needs a bitmap codec: pass \`codec\`. ` +
        `@cloudbitmaps/core is codec-agnostic and has no default. A flavor's store passes its own codec, ` +
        `so an application calls the store's method instead of this function.`,
    );
  }
  return codec;
}
