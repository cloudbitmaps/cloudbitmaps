/**
 * The chunks of a sorted load (`sorted: true`): ascending ids cut into one chunk at a time as they are read, so the
 * load holds one chunk's remainders and one chunk's bitmap, never the whole generation.
 *
 * ```
 *   caller's ids ──► check: a u32, not lower than the last ──► remainders of the current chunk (one Uint32Array)
 *                                                                │ the chunk key changes
 *                                                                ▼
 *                                         { chunkKey, bitmap } ──► the writer ──► the driver's upload
 * ```
 *
 * The ids are read while the object uploads, so an error they raise leaves through the driver's upload, which maps the
 * errors it meets. The first one is kept on the {@link SortedLoadInput}, and the load throws that one.
 */
import { CHUNK_COUNT, U32_MAX, splitId } from './bit-route';
import type { CodecBitmap, CodecInterface } from './codec';
import { yieldEvery } from './cooperative';
import type { Clock } from './determinism';
import { IntegrityError, ValidationError } from './errors';
import type { SortedLoadInput } from './load-input';

/** One chunk of a sorted load, ready for the writer. */
interface SortedChunk {
  readonly chunkKey: number;
  readonly bitmap: CodecBitmap;
}

/**
 * Ids between yields to the event loop: the cadence of the unsorted load's ingest, whose comment in `bulk-load.ts`
 * gives the measured reason for it.
 */
const YIELD_EVERY_IDS = 1 << 14;

/** What a refusal of an id lower than the last says after its position. Never the id: errors carry no id. */
const NOT_ASCENDING =
  'lower than the id before it; { sorted: true } takes ids in ascending order (repeats are fine): sort at the ' +
  'source, or leave sorted off';

/**
 * The chunks of `input`'s ids, for one read. A second read (a driver that runs its write again) throws
 * `IntegrityError`, and the error is kept on `input` as the one its load throws.
 */
export function sortedChunks(
  input: SortedLoadInput,
  codec: CodecInterface,
  clock: Clock | undefined,
): AsyncIterable<SortedChunk> {
  return {
    [Symbol.asyncIterator]: () => {
      if (!input.take()) {
        const err = new IntegrityError(
          'the ids of a sorted load were read a second time: they can be read once, and the storage driver ' +
            'ran its write again, so nothing was written',
        );
        input.fail(err);
        throw err;
      }
      return chunksOf(input, codec, clock);
    },
  };
}

/** Where a sorted load is in its ids: the position of the next one, the last one taken, and the open chunk. */
interface Cursor {
  position: number;
  last: number;
  chunk: number;
  held: number;
}

/**
 * The id at the cursor, checked: its chunk key and remainder, or `undefined` for a repeat of the last id, which is
 * skipped. Each refusal names the id's position in what the caller passed, never the id.
 */
function step(cursor: Cursor, id: number): { chunkKey: number; remainder: number } | undefined {
  if (!Number.isInteger(id) || id < 0 || id > U32_MAX) {
    try {
      splitId(id); // throws the refusal that names what is wrong with the id
    } catch (err) {
      const positioned = new ValidationError(`ids[${cursor.position}]: ${(err as Error).message}`);
      positioned.cause = err;
      throw positioned;
    }
  }
  if (id <= cursor.last) {
    if (id < cursor.last) throw new ValidationError(`ids[${cursor.position}]: ${NOT_ASCENDING}`);
    cursor.position++;
    return undefined;
  }
  cursor.last = id;
  cursor.position++;
  return splitId(id);
}

/**
 * Cut ascending ids into chunks. One `Uint32Array` of 65,536 remainders is reused for every chunk: a repeat is skipped
 * before it is held, so a chunk never holds more than 65,536.
 *
 * The two loops are not collapsed into one `for await`: routing a sync source through an async one costs a microtask
 * per id, measured at 20x on the unsorted load's ingest (see `bulk-load.ts`).
 */
async function* chunksOf(
  input: SortedLoadInput,
  codec: CodecInterface,
  clock: Clock | undefined,
): AsyncGenerator<SortedChunk> {
  const remainders = new Uint32Array(CHUNK_COUNT);
  const cursor: Cursor = { position: 0, last: -1, chunk: -1, held: 0 };
  const tick = yieldEvery(clock, YIELD_EVERY_IDS);
  const cut = (): SortedChunk => ({
    chunkKey: cursor.chunk,
    bitmap: codec.fromValues(remainders.subarray(0, cursor.held)),
  });
  // True while a chunk is with the writer. The writer ends the read there when its upload fails, which closes the
  // caller's ids; an error from that close is not one the ids raised while being read, so it is not kept.
  let handing = false;
  const { ids } = input;
  try {
    if (Symbol.asyncIterator in ids) {
      for await (const id of ids) {
        const route = step(cursor, id);
        if (route !== undefined) {
          if (route.chunkKey !== cursor.chunk) {
            if (cursor.held > 0) {
              handing = true;
              yield cut();
              handing = false;
            }
            cursor.chunk = route.chunkKey;
            cursor.held = 0;
          }
          remainders[cursor.held++] = route.remainder;
        }
        const pause = tick();
        if (pause !== null) await pause;
      }
    } else {
      for (const id of ids) {
        const route = step(cursor, id);
        if (route !== undefined) {
          if (route.chunkKey !== cursor.chunk) {
            if (cursor.held > 0) {
              handing = true;
              yield cut();
              handing = false;
            }
            cursor.chunk = route.chunkKey;
            cursor.held = 0;
          }
          remainders[cursor.held++] = route.remainder;
        }
        const pause = tick();
        if (pause !== null) await pause;
      }
    }
    if (cursor.held > 0) {
      handing = true;
      yield cut();
      handing = false;
    }
  } catch (err) {
    if (!handing) input.fail(err);
    throw err;
  }
}
