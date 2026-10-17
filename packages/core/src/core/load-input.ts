/**
 * What a load accepts: ids, or a whole bitmap as `{ serialized }` bytes or as a `{ bitmap }` that serializes to
 * them.
 *
 * Every bitmap input takes one path. The bytes are size-capped, checked structurally and decoded by the codec's
 * safe deserializer into a bitmap of the codec's own, which then writes its chunks straight from its containers:
 * no id passes through JavaScript. `{ bitmap }` is only a spelling of `{ serialized }`, serialized once, here, so
 * a caller's bitmap is never trusted as a structure and a change made to it after the call is not loaded.
 *
 * All of it runs before the load's first request, so a malformed input costs no round trip and writes nothing.
 */
import type { CodecBitmap, CodecInterface } from './codec';
import type { CombinedChunk } from './engine';
import { ValidationError, isIntegrityError } from './errors';

/**
 * Anything that serializes itself to portable Roaring: `roaring`'s `RoaringBitmap32` is one. Typed by shape, so
 * no codec's own class appears in a signature. A bitmap that can also say how large its serialization is
 * (`getSerializationSizeInBytes`) is asked first, so one over the cap is refused before it is serialized.
 */
export interface PortableBitmap {
  serialize(format: 'portable'): Uint8Array;
  getSerializationSizeInBytes?(format: 'portable'): number;
}

/**
 * What a load writes as the segment's new contents.
 *
 * - **ids**: an iterable or async iterable of integers in `[0, 2^32)`, consumed lazily. Not a `Uint8Array`,
 *   `Uint8ClampedArray` or `Buffer`, which a load refuses, since each byte would load as an id.
 * - **`{ serialized }`**: one bitmap in the portable Roaring format, checked before anything is written.
 * - **`{ bitmap }`**: an object with `serialize('portable')`, loaded as `{ serialized: bitmap.serialize('portable') }`.
 */
export type LoadInput =
  | Iterable<number>
  | AsyncIterable<number>
  | { readonly serialized: Uint8Array }
  | { readonly bitmap: PortableBitmap };

/**
 * No canonical 32-bit Roaring bitmap serializes to more than this. Under the run cookie, the larger of the two
 * headers, it is a 4-byte cookie, 8,192 bytes of run flags and 8 bytes of header for each of the 65,536
 * containers, and no container's body is over 8,192 bytes: a bitset is 8,192, and a run container is kept only
 * where it is smaller. 537,403,396 bytes, about 512.5 MiB.
 */
export const MAX_SERIALIZED_LOAD_BYTES = 4 + 8_192 + 8 * 65_536 + 65_536 * 8_192;

/** A bitmap input, decoded into the codec's own bitmap: written from its chunks, never id by id. */
export class DecodedLoadInput {
  constructor(readonly bitmap: CodecBitmap) {}
}

/**
 * A combine's result as the bitmaps of its chunks, ascending by key: written as they are, never id by id. Made only by
 * {@link loadSegmentChunks}, never by {@link prepareLoadInput}, so no input a load is handed can be one.
 */
export class ChunkLoadInput {
  constructor(readonly chunks: AsyncIterable<CombinedChunk>) {}
}

/** Errors a load's input raised as it was read, which a load hands on as they are, never as its own lost race. */
const sourceErrors = new WeakSet<object>();

/**
 * Mark `err` as raised by a load's input (its ids, a bitmap's encoding, a combine's chunks) rather than by the write,
 * and return it. A write-once conflict is a lost race only when the write raised it: a source that reads another
 * segment (through a pin, say) can throw this library's own `WriteConflictError`, which is the source's to report.
 */
export function raisedBySource<T>(err: T): T {
  if (typeof err === 'object' && err !== null) sourceErrors.add(err);
  return err;
}

/** Whether a load's input raised `err` ({@link raisedBySource}). */
export function isSourceError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && sourceErrors.has(err);
}

/**
 * Ids the caller says ascend (`sorted: true`), written chunk by chunk while they are read, during the object's upload,
 * so a load holds one chunk and the writer's index rather than the whole generation. Made only by
 * {@link sortedLoadInput}, from ids.
 *
 * The first error the ids raise, or their check raises (an id out of range, or lower than the one before it), or the
 * chunker raises building a chunk, is kept here, and the load throws that same error. The driver's upload never sees
 * it: the chunker throws a sentinel of its own into the writer instead, so no driver maps, redacts or probes the
 * caller's error on its way out.
 */
export class SortedLoadInput {
  private failure: { readonly error: unknown } | undefined;

  constructor(readonly ids: Iterable<number> | AsyncIterable<number>) {}

  /** Keep `error` as what the ids raised, unless an earlier one is kept. */
  fail(error: unknown): void {
    this.failure ??= { error };
  }

  /** What the load throws for a write that failed with `err`: the error the ids raised, when they raised one. */
  thrown(err: unknown): unknown {
    return this.failure === undefined ? err : raisedBySource(this.failure.error);
  }
}

/** How a value given as `sorted` is named in a refusal: by its kind, never by its content. */
function kindOfOption(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  const kind = typeof value;
  return kind === 'object' || kind === 'undefined' ? `an ${kind}` : `a ${kind}`;
}

/**
 * Whether a load was asked for `sorted: true`. `undefined` and `false` mean no; anything else that is not a boolean is
 * refused before any request, since `sorted: 'yes'` read as absent would hold the whole generation in memory instead.
 *
 * @throws {ValidationError} for a value that is not a boolean.
 */
export function wantsSorted(sorted: unknown): boolean {
  if (sorted === undefined || sorted === false) return false;
  if (sorted !== true) {
    throw new ValidationError(`sorted must be a boolean; got ${kindOfOption(sorted)}`);
  }
  return true;
}

/**
 * The input a load reads under its `sorted` option: ids as {@link SortedLoadInput} when it is `true`, anything else
 * unchanged.
 *
 * @throws {ValidationError} for a `sorted` that is not a boolean, and for `sorted: true` with `{ serialized }`,
 * `{ bitmap }` or a bitmap of the flavor's own: those are written from their own chunks already, so the option would
 * do nothing, and an option that does nothing is refused rather than ignored.
 */
export function sortedLoadInput(
  prepared: ReturnType<typeof prepareLoadInput>,
  sorted: unknown,
): ReturnType<typeof prepareLoadInput> | SortedLoadInput {
  if (!wantsSorted(sorted)) return prepared;
  if (prepared instanceof DecodedLoadInput) {
    throw new ValidationError(
      'sorted: true applies to ids, and this load was given a bitmap ({ serialized }, { bitmap } or a bitmap ' +
        'itself), which is already held whole and is written from its own chunks: leave sorted off',
    );
  }
  return new SortedLoadInput(prepared);
}

/** `Object.prototype.toString`'s tag, which names a typed array's kind across realms and for `Buffer` too. */
function tagOf(value: object): string {
  return Object.prototype.toString.call(value).slice(8, -1);
}

/** The typed arrays' own accessors, which read the view itself whatever a subclass or another realm defines. */
const VIEW = Object.getPrototypeOf(Uint8Array.prototype) as object;
const viewGetter = (name: 'buffer' | 'byteOffset' | 'byteLength'): ((this: unknown) => unknown) =>
  Object.getOwnPropertyDescriptor(VIEW, name)?.get as (this: unknown) => unknown;
const bufferOf = viewGetter('buffer');
const byteOffsetOf = viewGetter('byteOffset');
const byteLengthOf = viewGetter('byteLength');

/**
 * The bytes a `Uint8Array` really holds, as a plain view the check and the decoder both read: never through a
 * getter a subclass overrides, so the two cannot be shown different bytes. A detached buffer holds none.
 */
function plainView(bytes: Uint8Array, what: string): Uint8Array {
  let buffer: ArrayBufferLike;
  let offset: number;
  let length: number;
  try {
    buffer = bufferOf.call(bytes) as ArrayBufferLike;
    offset = byteOffsetOf.call(bytes) as number;
    length = byteLengthOf.call(bytes) as number;
  } catch {
    throw new ValidationError(`${what} must be a Uint8Array of portable Roaring bytes`);
  }
  return length === 0 ? new Uint8Array(0) : new Uint8Array(buffer, offset, length);
}

/**
 * Whether `buffer` is a `SharedArrayBuffer`, by its brand: the type's own `byteLength` getter throws on anything
 * else, where a `Symbol.toStringTag` can be given any value. False on a runtime without one.
 */
const sharedByteLength =
  typeof SharedArrayBuffer === 'function'
    ? (Object.getOwnPropertyDescriptor(SharedArrayBuffer.prototype, 'byteLength')?.get as
        ((this: unknown) => unknown) | undefined)
    : undefined;
function isShared(buffer: ArrayBufferLike): boolean {
  if (sharedByteLength === undefined) return false;
  try {
    sharedByteLength.call(buffer);
    return true;
  } catch {
    return false;
  }
}

function overCap(what: string, length: number): ValidationError {
  return new ValidationError(
    `${what} is ${length} bytes, more than any canonical 32-bit bitmap serializes to ` +
      `(${MAX_SERIALIZED_LOAD_BYTES}). If it was serialized from a bitmap, call runOptimize() on the bitmap first.`,
  );
}

/**
 * Check a load's input and decode a bitmap input, before the load makes any request.
 *
 * @returns ids unchanged, to be consumed lazily by the write, or the decoded bitmap.
 * @throws {ValidationError} for a byte array passed as ids; bytes that are malformed, over the cap, or followed by
 * more bytes; a `{ bitmap }` with no `serialize` method, or whose `serialize('portable')` returns no `Uint8Array`;
 * and anything that is none of the three inputs. An error the caller's own `serialize` throws propagates as it is.
 */
export function prepareLoadInput(
  input: LoadInput,
  codec: CodecInterface,
): Iterable<number> | AsyncIterable<number> | DecodedLoadInput {
  if (typeof input !== 'object' || input === null) {
    throw new ValidationError('a load takes ids, { serialized } or { bitmap }');
  }
  const tag = tagOf(input);
  if (tag === 'Uint8Array' || tag === 'Uint8ClampedArray') {
    throw new ValidationError(
      `a load's ids cannot be a ${tag} or Buffer: each byte would be loaded as an id. Pass portable Roaring ` +
        `bytes as { serialized }, and ids as a Uint32Array or an array of numbers.`,
    );
  }
  if (Symbol.iterator in input || Symbol.asyncIterator in input) return input;
  const keys = Object.keys(input);
  if (keys.length === 1 && keys[0] === 'serialized') {
    return new DecodedLoadInput(
      decodeSerialized((input as { serialized: unknown }).serialized, codec, '{ serialized }'),
    );
  }
  if (keys.length === 1 && keys[0] === 'bitmap') {
    const bitmap = (input as { bitmap: unknown }).bitmap as Partial<PortableBitmap> | null;
    if (typeof bitmap !== 'object' || bitmap === null || typeof bitmap.serialize !== 'function') {
      throw new ValidationError(`{ bitmap } needs an object with serialize('portable')`);
    }
    const what = "{ bitmap }'s serialize('portable')";
    if (typeof bitmap.getSerializationSizeInBytes === 'function') {
      const size = bitmap.getSerializationSizeInBytes('portable');
      if (typeof size === 'number' && size > MAX_SERIALIZED_LOAD_BYTES) throw overCap(what, size);
    }
    return new DecodedLoadInput(decodeSerialized(bitmap.serialize('portable'), codec, what));
  }
  throw new ValidationError(
    `a load takes ids (an iterable of integers), { serialized } or { bitmap }, as the only key; got an object ` +
      `with keys [${keys.join(', ')}]. Load options go in the next argument.`,
  );
}

/**
 * Portable bytes a caller holds, checked and decoded by the codec's safe deserializer: the one check every bitmap
 * input of a load goes through, and what a flavor offers its users to decode bytes they hold themselves.
 *
 * The bytes must be a `Uint8Array` (a Node `Buffer` is one), at most {@link MAX_SERIALIZED_LOAD_BYTES}, one whole
 * bitmap and structurally sound. A view is read over the bytes it really holds, and bytes in a `SharedArrayBuffer`
 * are copied first. An empty or detached buffer is the empty bitmap.
 *
 * @param what names the input in a refusal's message.
 * @throws {ValidationError} for anything that is not such bytes; nothing reaches the codec's native decoder then.
 */
export function decodeSerialized(
  bytes: unknown,
  codec: CodecInterface,
  what = 'the buffer',
): CodecBitmap {
  if (typeof bytes !== 'object' || bytes === null || tagOf(bytes) !== 'Uint8Array') {
    throw new ValidationError(`${what} must be a Uint8Array of portable Roaring bytes`);
  }
  const view = plainView(bytes as Uint8Array, what);
  if (view.byteLength > MAX_SERIALIZED_LOAD_BYTES) throw overCap(what, view.byteLength);
  // Bytes in a SharedArrayBuffer are copied: another thread could change them between the check and the decode.
  const own = isShared(view.buffer) ? new Uint8Array(view) : view;
  try {
    return codec.safeDeserialize(own, MAX_SERIALIZED_LOAD_BYTES, { whole: true });
  } catch (err) {
    // The codec reports bytes it refuses as corrupt; here they are the caller's input, not a stored object.
    if (!isIntegrityError(err)) throw err;
    throw new ValidationError(`${what} is not a valid bitmap: ${(err as Error).message}`);
  }
}
