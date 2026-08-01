/**
 * The **bitmap-codec seam**.
 *
 * `core/` is **codec-agnostic**: `SegmentEngine`, compaction, and the `.crbm` read/write helpers only ever
 * construct and combine bitmaps through the {@link CodecInterface} factory + the {@link CodecBitmap} value type
 * defined here — never a concrete implementation. The flagship codec is roaring (`roaringCodec`, today in
 * `core/bitmap.ts`; it moves to `@cloudbitmaps/roaring` when the package split lands); `@cloudbitmaps/bitset`
 * (plain bitset) and `@cloudbitmaps/soaring` plug in behind the same seam with zero engine or driver changes.
 *
 * **Homogeneity contract:** a single store uses a single codec, so every {@link CodecBitmap} an operation sees
 * was produced by the same {@link CodecInterface}. The binary set ops ({@link CodecBitmap.orInPlace} etc.) may
 * therefore assume `other` is the same concrete type and are not required to interoperate across codecs.
 * (Corollary: a decoded-chunk HOT cache is codec-specific — never share one `cache` across engines built with
 * different codecs, or a cached bitmap from codec A could reach codec B's in-place op. The `CloudRoaring` facade
 * mints the cache per store, so this cannot arise in normal use.)
 *
 * **Interface surface = exactly what the engine needs**, kept general enough for the known fast-follow codecs
 * (positional/rank-select access + raw-bitset interop that `@cloudbitmaps/bitset` will add live on that
 * package's own extended value type, not here — the engine never calls them). The one codec-linked concern
 * this seam intentionally leaves in the format layer is the `.crbm` **payload codec id**
 * (`PAYLOAD_CODEC_ROARING_PORTABLE` / `KNOWN_PAYLOAD_CODEC_IDS` in `crbm/format.ts`): it is stamped in the footer
 * and validated on read. That generalization is **done** as of 0.7.0 — the field was `roaringSerializationId`
 * and validated by equality against a single constant, which would have frozen a codec-specific name into the
 * format at `1.0`. It is now a registry the reader checks membership against, so a future codec is a one-line
 * registration rather than a major format version. Still deliberately outside this interface: a codec declares
 * its bytes, the seam does not.
 */

import { ValidationError } from './errors';

/**
 * The value type a codec produces — a mutable set of `u32` with set algebra and portable (de)serialization.
 * This is the shape `SafeBitmap` already has; the engine holds these, caches them, and merges tiers with them.
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
  /** A deep copy — mutating the clone must not touch the original (the HOT cache relies on this). */
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
   * The largest value in the set, or `undefined` when empty.
   *
   * **Optional, and deliberately so.** The engine uses it for one thing: asserting that a payload it is about
   * to interpret **as a chunk** holds only 16-bit remainders (see {@link assertChunkPayload}). A codec that
   * cannot answer this in better than O(n) should simply omit it — the engine then skips the check rather
   * than walking every value on the read path, which is the one thing this must never cost.
   *
   * Roaring answers it in O(1) from its container index, so the flagship codec implements it.
   */
  maximum?(): number | undefined;
  /**
   * Re-encode for size, in place, immediately before a **cold** write. Representation only — this must never
   * change membership, and `serialize()` afterwards must decode back to exactly the same set.
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
   * WHY ONLY ON THE COLD PATH. This is called where a whole immutable generation is written, so its cost
   * amortizes over a write that is already serializing and checksumming every chunk. It is deliberately NOT
   * called on the warm delta path (`chunk.ts`), which runs per operation: the hot path must not pay for a
   * rare-ish win, per KISS/YAGNI. Warm rows are short-lived and get folded into a cold generation by
   * compaction, where they are optimized then.
   */
  optimize?(): void;
}

/**
 * A pluggable bitmap codec — the factory the codec-agnostic engine constructs {@link CodecBitmap}s through.
 * Implementations **must** size-cap before handing untrusted bytes to any native decoder and use a safe
 * (never a trusting/frozen) deserializer (threat model S1).
 */
export interface CodecInterface {
  /** An empty set. */
  empty(): CodecBitmap;
  /** A set seeded from an iterable of `u32` values. */
  fromValues(values: Iterable<number>): CodecBitmap;
  /**
   * Size-cap (`bytes.length <= maxBytes`) then portable-deserialize. Throws `IntegrityError` when the input
   * exceeds the cap or fails to decode — the native decoder is never handed unbounded or unsafe-format input.
   */
  safeDeserialize(bytes: Uint8Array, maxBytes: number): CodecBitmap;
}

/**
 * Resolve a codec that a **public core entry point** was given, failing fast when it is missing.
 *
 * Why these entry points take `codec?` rather than a required field: `bulkLoadCrbmGeneration` /
 * `compactSegment` / `runExport` are call-compatible public API, and core cannot supply a default (the concrete
 * codec lives in a *flavor* package that depends on core — a default here would invert that arrow). A **flavor**
 * package binds the codec for its users (`@cloudbitmaps/roaring` re-exports codec-bound wrappers), so an
 * application never reaches this throw; only someone calling `@cloudbitmaps/core` directly — i.e. a flavor or
 * driver author — can, and for them the typed error names exactly what to pass.
 */
export function requireCodec(codec: CodecInterface | undefined, api: string): CodecInterface {
  if (codec === undefined) {
    throw new ValidationError(
      `${api} needs a bitmap codec: pass \`codec\` (e.g. \`roaringCodec\` from @cloudbitmaps/roaring). ` +
        `@cloudbitmaps/core is codec-agnostic and has no default — install a flavor package, whose ` +
        `equivalents bind the codec for you.`,
    );
  }
  return codec;
}
