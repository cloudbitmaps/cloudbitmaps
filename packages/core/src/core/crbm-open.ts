/**
 * Opening and proving a stored `.crbm` generation: the blob reader over a driver's object, the checked and noting opens, the
 * identity checks that tie an open to the object it read, and generation verification.
 */
import { IntegrityError, NotFoundError, isNotFoundError } from './errors';
import type { BlobReader } from './blob';
import { ascending } from './order';
import type { CrbmCrypto, WrappedDek } from './crypto';
import type { GenerationMetadata, GenKey, IStorageDriver, TailRead } from './ports';
import { DEFAULT_TAIL_BYTES, FOOTER_BYTES } from './crbm/format';
import { CrbmReader, footerSaysEncrypted, openCrbmReaderKeeping } from './crbm/reader';
import type { CrbmReaderOptions } from './crbm/reader';
import { summaryAgrees } from './summary';

/**
 * Adapt one `(driver, key)` pair to the codec's `BlobReader` seam. With `noteTail`, each tail read the reader makes is
 * shown to it with the bytes, `size` and `version` the driver answered, after the copy below when one is made.
 *
 * A tail's bytes reach the reader as a plain `Uint8Array`: the reader keeps a small object's chunk region by slicing
 * the tail, and a subclass's `slice` need not copy. A Node `Buffer`'s is a view, so a driver that answered with one
 * would leave the reader holding the driver's memory, all of it, as the cache weighs only the region. Such an answer
 * is copied here, once ({@link ownedTail}); a plain `Uint8Array` of this realm, which every shipped driver returns, is
 * handed through as it is.
 */
export function storageBlobReader(
  driver: IStorageDriver,
  key: GenKey,
  noteTail?: (tail: TailRead) => void,
): BlobReader {
  return {
    getRange(offset, length) {
      return driver.getRange(key, offset, length);
    },
    async getTail(maxBytes) {
      const tail = ownedTail(await driver.getTail(key, maxBytes));
      noteTail?.(tail);
      return tail;
    },
  };
}

/**
 * `tail` with its bytes in a plain `Uint8Array` of this realm. Any other `Uint8Array`, a subclass (a Node `Buffer`) or
 * one made in another realm (a `vm` context), is copied once, and the copy is built from the answer's fields by name,
 * so a `size` or `version` the driver serves from a getter on its own class carries over. The brand is read, not
 * `instanceof`, which is false for another realm's arrays. A plain `Uint8Array` of this realm is handed through as it is.
 */
export function ownedTail(tail: TailRead): TailRead {
  const { bytes } = tail;
  if (
    Object.prototype.toString.call(bytes) !== '[object Uint8Array]' ||
    Object.getPrototypeOf(bytes) === Uint8Array.prototype
  ) {
    return tail;
  }
  const version = tail.version;
  return {
    bytes: new Uint8Array(bytes),
    size: tail.size,
    ...(version === undefined ? {} : { version }),
  };
}

/** Whether two rows carry the same wrapped keys. */
export const sameKeys = (a: readonly WrappedDek[] | undefined, b: readonly WrappedDek[]): boolean =>
  a !== undefined && JSON.stringify(a) === JSON.stringify(b);

/**
 * The object under `key`, when it is provably the one `fingerprint` names ({@link CrbmReader.fingerprint}), from one
 * read of its footer, with the version the driver reported on that read (`undefined` from a driver that reports none).
 * `null` when it is another object, when it is gone, and when the read fails in any way: a caller that deletes what
 * this proves deletes nothing it cannot prove is its own, and passes the version as the delete's `ifVersion`, so a
 * number taken again between the read and the delete keeps the object put under it since.
 */
export async function provenObject(
  storage: IStorageDriver,
  key: GenKey,
  fingerprint: string,
): Promise<{ readonly version: string | undefined } | null> {
  let version: string | undefined;
  try {
    const blob = storageBlobReader(storage, key, (tail) => {
      version ??= tail.version;
    });
    return (await CrbmReader.sameObject(blob, fingerprint)) ? { version } : null;
  } catch {
    return null;
  }
}

/**
 * Whether the object under `key` is still the one `fingerprint` names ({@link CrbmReader.fingerprint}), from one read
 * of its footer. Unlike {@link provenObject}, a fault is not an answer: `NotFoundError` when the key holds no object,
 * and any other failure of the read, thrown as it is.
 */
export function sameObjectUnder(
  storage: IStorageDriver,
  key: GenKey,
  fingerprint: string,
): Promise<boolean> {
  return CrbmReader.sameObject(storageBlobReader(storage, key), fingerprint);
}

/**
 * Whether the object under `key` says it is encrypted, from one read of its footer, with no key. `noteVersion` is shown
 * the version the driver reported on that read, when it reported one: a caller that deletes the object for what its
 * footer says passes it as the delete's `ifVersion`.
 */
export function objectIsEncrypted(
  storage: IStorageDriver,
  key: GenKey,
  noteVersion?: (version: string) => void,
): Promise<boolean> {
  return footerSaysEncrypted(
    storageBlobReader(
      storage,
      key,
      noteVersion === undefined
        ? undefined
        : (tail) => {
            if (tail.version !== undefined) noteVersion(tail.version);
          },
    ),
  );
}

/**
 * `blob`, with its first tail read remembered: a later tail read of no more bytes is answered from it, so a caller that
 * asks the footer a question and then opens the object makes one request, not two.
 */
function rememberingTail(blob: BlobReader): BlobReader {
  let first: { bytes: Uint8Array; size: number } | undefined;
  return {
    getRange: (offset, length) => blob.getRange(offset, length),
    async getTail(maxBytes) {
      // Answered from the first read when it holds the bytes asked for, or holds the whole object, which is all there is.
      if (
        first !== undefined &&
        (maxBytes <= first.bytes.length || first.bytes.length === first.size)
      ) {
        const take = Math.min(maxBytes, first.bytes.length);
        return { bytes: first.bytes.subarray(first.bytes.length - take), size: first.size };
      }
      const read = await blob.getTail(maxBytes);
      first ??= read;
      return read;
    },
  };
}

/**
 * What one tail read of the object under `key` tells a rollback about it: whether the footer says it is encrypted, and,
 * when the object and the key agree (an encrypted object opened with `crypto`, a cleartext one with none), the reader
 * the open gives, which holds its count and metadata. No reader when they disagree, which the caller refuses as a
 * target the row cannot use, and none for an encrypted object when the caller has no key. A footer that fails its own
 * checks, an object another generation's, and an index or metadata that do not open are an {@link IntegrityError}.
 */
export async function openRollbackTarget(
  storage: IStorageDriver,
  key: GenKey,
  crypto: CrbmCrypto | undefined,
): Promise<{ encrypted: boolean; reader: CrbmReader | undefined }> {
  const blob = rememberingTail(storageBlobReader(storage, key));
  await blob.getTail(DEFAULT_TAIL_BYTES);
  const encrypted = await footerSaysEncrypted(blob);
  if (encrypted !== (crypto !== undefined)) return { encrypted, reader: undefined };
  const reader = await CrbmReader.open(blob, { crypto });
  if (reader.generation !== key.generation) {
    throw new IntegrityError(
      `segment "${key.segment}" generation ${key.generation}: its footer says generation ${reader.generation}`,
    );
  }
  return { encrypted, reader };
}

/**
 * Whether the object under `key` is the one `fingerprint` names, from one read of its footer: false when it is another
 * object or gone. Unlike {@link provenObject}, a read that cannot tell throws, for a caller that must not take "could
 * not look" for "not this object".
 */
export async function provesOwnObject(
  storage: IStorageDriver,
  key: GenKey,
  fingerprint: string,
): Promise<boolean> {
  try {
    return await CrbmReader.sameObject(storageBlobReader(storage, key), fingerprint);
  } catch (err) {
    if (isNotFoundError(err)) return false;
    throw err;
  }
}

/** The version the driver reported for the object each reader {@link openGenerationReader} opened. */
const openedVersions = new WeakMap<CrbmReader, string>();

/**
 * Open a {@link CrbmReader} on one generation over the storage driver's range/tail reads (decrypting if `crypto`).
 * The reader the write paths use to re-read what they wrote, and the erasure rewrite uses to stream the old
 * generation; the engine's read path goes through {@link CrbmStorageChunkSource} instead, which caches these. With
 * `named`, the fingerprint the row's summary records, the object must be that one: another is {@link NotFoundError}.
 * The version of the object it opened, from the tail read the open made, is what {@link objectVersionOf} answers.
 */
export function openGenerationReader(
  storage: IStorageDriver,
  key: GenKey,
  crypto: CrbmCrypto | undefined,
  options: Omit<CrbmReaderOptions, 'crypto'> = {},
  named?: string,
): Promise<CrbmReader> {
  return openNoting(storage, key, crypto, options, named);
}

/**
 * {@link openGenerationReader}, with `noteVersion` shown the version {@link objectVersionOf} would answer as soon as the
 * tail read that carries it returns, before the open goes on: a caller whose open then fails, on an object sealed under
 * another key, say, still knows which object it met, and can condition a delete of it on that read.
 */
export function openGenerationReaderNoting(
  storage: IStorageDriver,
  key: GenKey,
  crypto: CrbmCrypto | undefined,
  noteVersion: (version: string) => void,
): Promise<CrbmReader> {
  return openNoting(storage, key, crypto, {}, undefined, noteVersion);
}

async function openNoting(
  storage: IStorageDriver,
  key: GenKey,
  crypto: CrbmCrypto | undefined,
  options: Omit<CrbmReaderOptions, 'crypto'>,
  named: string | undefined,
  noteVersion?: (version: string) => void,
): Promise<CrbmReader> {
  let version: string | undefined;
  const reader = await openChecked(
    storage,
    key,
    { ...options, crypto },
    undefined,
    named,
    (tail) => {
      if (version !== undefined || tail.version === undefined) return;
      version = tail.version;
      noteVersion?.(version);
    },
  );
  if (version !== undefined) openedVersions.set(reader, version);
  return reader;
}

/**
 * The version of the object `reader` was opened on, as the driver reported it on the tail read the open made, for a
 * delete conditioned on that object ({@link StorageDeleteOptions.ifVersion}); `undefined` for a reader
 * {@link openGenerationReader} did not open, or a driver that reports none. Held beside the reader rather than on it, so
 * nothing is added to the reader's public surface, and no read the engine makes pays for it.
 */
export function objectVersionOf(reader: CrbmReader): string | undefined {
  return openedVersions.get(reader);
}

/**
 * {@link openGenerationReader}, of the object `fingerprint` names: `undefined` when the object under the key is another
 * one, found from its footer before its index is opened, so an object sealed under another key is told apart as well.
 */
export async function openNamedGeneration(
  storage: IStorageDriver,
  key: GenKey,
  crypto: CrbmCrypto | undefined,
  fingerprint: string,
): Promise<CrbmReader | undefined> {
  return openHeldTo(storage, key, { crypto }, undefined, fingerprint);
}

/**
 * Open a reader on `key`, refusing an object whose footer names another generation. Every writer stamps the key's
 * number, and the chunk cache, the load guard and the erasure rewrite all trust it, so an object that disagrees
 * was written under another key or altered. Every open, the live read's, a pin's and the write paths', comes here.
 * With `named`, the object must also be the one that fingerprint names: another one is {@link NotFoundError}, a move.
 */
export async function openChecked(
  storage: IStorageDriver,
  key: GenKey,
  options: CrbmReaderOptions,
  keepChunkBytesUpTo?: number,
  named?: string,
  noteTail?: (tail: TailRead) => void,
): Promise<CrbmReader> {
  const reader = await openHeldTo(storage, key, options, keepChunkBytesUpTo, named, noteTail);
  if (reader === undefined) {
    throw new NotFoundError(
      `segment "${key.segment}" generation ${key.generation} is another object than its registry row names`,
    );
  }
  return reader;
}

/**
 * {@link openChecked}'s open: `undefined` when `named` is given and the object under the key is another one. Either way
 * the open makes one tail read of the driver, which `noteTail` is shown.
 */
async function openHeldTo(
  storage: IStorageDriver,
  key: GenKey,
  options: CrbmReaderOptions,
  keepChunkBytesUpTo: number | undefined,
  named: string | undefined,
  noteTail?: (tail: TailRead) => void,
): Promise<CrbmReader | undefined> {
  const raw = storageBlobReader(storage, key, noteTail);
  let reader: CrbmReader;
  if (named === undefined) {
    reader = await openCrbmReaderKeeping(raw, options, keepChunkBytesUpTo);
  } else {
    // The object is held to the one the row names before its index is read, let alone decrypted: another object under
    // the number is a move, never an error of the object's own, whoever sealed it. The open then reads what the footer
    // check read, so this costs no request; and the reader keeps a blob that holds none of it, so what it retains is
    // what the reader cache weighs.
    let tail: { bytes: Uint8Array; size: number } | undefined = await raw.getTail(
      Math.max(options.tailBytes ?? DEFAULT_TAIL_BYTES, FOOTER_BYTES),
    );
    const blob: BlobReader = {
      getRange: (offset, length) => raw.getRange(offset, length),
      getTail: async (maxBytes) => {
        const held = tail;
        if (
          held !== undefined &&
          (maxBytes <= held.bytes.length || held.bytes.length === held.size)
        ) {
          const take = Math.min(maxBytes, held.bytes.length);
          return { bytes: held.bytes.subarray(held.bytes.length - take), size: held.size };
        }
        return raw.getTail(maxBytes);
      },
    };
    try {
      if (!(await CrbmReader.sameObject(blob, named))) return undefined;
      reader = await openCrbmReaderKeeping(blob, options, keepChunkBytesUpTo);
    } finally {
      tail = undefined;
    }
  }
  if (reader.generation !== key.generation) {
    throw new IntegrityError(
      `segment "${key.segment}" generation ${key.generation}: its footer says generation ${reader.generation}`,
    );
  }
  return reader;
}

/**
 * Re-open a freshly written generation and assert it round-trips exactly what was streamed into it: the same
 * per-chunk key set *and* the same total cardinality (on top of the codec's own per-chunk CRC + footer checks), and the
 * metadata it was given. `expected` is the streaming writer's tally (the stream is consumed, so it can't be
 * re-iterated) — the key-set comparison catches a dropped/extra chunk that a cardinality-only check could miss when
 * two errors cancel out. The count and the metadata are what the generation's row summary is about to claim, so the
 * summary is held to the object it describes before it is published.
 * Throws {@link IntegrityError}: the object is on disk but must not be published.
 */
export async function verifyGeneration(
  storage: IStorageDriver,
  key: GenKey,
  expected: {
    readonly chunkKeys: readonly number[];
    readonly cardinality: number;
    readonly metadata?: GenerationMetadata | undefined;
  },
  crypto: CrbmCrypto | undefined,
): Promise<void> {
  const expectedKeys = [...expected.chunkKeys].sort(ascending);
  const reader = await openGenerationReader(storage, key, crypto);
  const actualKeys = [...reader.chunkKeys()].sort(ascending);
  const keysMatch =
    actualKeys.length === expectedKeys.length && actualKeys.every((k, i) => k === expectedKeys[i]);
  if (!keysMatch) {
    throw new IntegrityError(
      `verify failed for ${key.segment}.${key.generation}: chunk-key set mismatch (${actualKeys.length} vs ${expectedKeys.length})`,
    );
  }
  if (reader.count() !== expected.cardinality) {
    throw new IntegrityError(
      `verify failed for ${key.segment}.${key.generation}: cardinality ${reader.count()} != ${expected.cardinality}`,
    );
  }
  if (!summaryAgrees(expected, { cardinality: reader.count(), metadata: reader.metadata })) {
    throw new IntegrityError(
      `verify failed for ${key.segment}.${key.generation}: the object's metadata is not the metadata it was written with`,
    );
  }
}
