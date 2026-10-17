/**
 * The chunks of a sorted load (`sorted: true`): ascending ids cut into one chunk at a time as they are read, so the
 * load holds one chunk's remainders and one chunk's bitmap, never the whole generation.
 *
 * ```
 *   caller's ids ──► accept(id): a u32, not lower than the last ──► remainders of the current chunk (one Uint32Array)
 *                                                                   │ the chunk key changes
 *                                                                   ▼
 *                                         { chunkKey, bitmap } ──► the writer ──► the driver's upload
 * ```
 *
 * The ids are read while the object uploads, so an error they raise would leave through the driver's upload, which maps
 * the errors it meets. It never reaches the driver: the first one is kept on the {@link SortedLoadInput}, a sentinel
 * that carries nothing of the caller's is thrown into the writer in its place, and the load throws the kept one.
 */
import { U32_MAX, refusalOfId } from './bit-route';
import type { CodecBitmap, CodecInterface } from './codec';
import { YIELD_EVERY_IDS, type Yielder, yieldEvery } from './cooperative';
import { ValidationError } from './errors';
import type { SortedLoadInput } from './load-input';

/** One chunk of a sorted load, ready for the writer. */
interface SortedChunk {
  readonly chunkKey: number;
  readonly bitmap: CodecBitmap;
}

/** What a refusal of an id lower than the last says after its position. Never the id: errors carry no id. */
const NOT_ASCENDING =
  'lower than the id before it; { sorted: true } takes ids in ascending order (repeats are fine): sort at the ' +
  'source, or leave sorted off';

/**
 * What the chunker throws into the writer in place of an error the ids raised: no field, no message of theirs, so the
 * driver's upload has nothing of the caller's to map, redact or answer. The load throws the kept error instead.
 */
class SourceFailed extends Error {
  constructor() {
    super('the ids of a sorted load raised an error');
  }
}

/** The chunks of `input`'s ids, read once, as the streaming writer reads them. */
export function sortedChunks(
  input: SortedLoadInput,
  codec: CodecInterface,
  clock: Yielder | undefined,
): AsyncIterable<SortedChunk> {
  return chunksOf(input, codec, clock);
}

/**
 * A cutter of ascending ids into chunks. One `Uint32Array` of 65,536 remainders is reused for every chunk: a repeat is
 * skipped before it is held, so a chunk never holds more than 65,536. `accept` takes the next id and returns the chunk
 * it closed, if any, built before the id is held; `rest` returns the last one. Each refusal names the id's position
 * in what the caller passed, repeats counted, never the id.
 */
function chunkCutter(codec: CodecInterface): {
  accept(id: number): SortedChunk | undefined;
  rest(): SortedChunk | undefined;
} {
  const remainders = new Uint32Array(1 << 16);
  let position = 0;
  let last = -1;
  let chunk = -1;
  let held = 0;
  const cut = (): SortedChunk => ({
    chunkKey: chunk,
    bitmap: codec.fromValues(remainders.subarray(0, held)),
  });
  return {
    accept(id) {
      if (!Number.isInteger(id) || id < 0 || id > U32_MAX) {
        const cause = refusalOfId(id);
        const positioned = new ValidationError(`ids[${position}]: ${cause.message}`);
        positioned.cause = cause;
        throw positioned;
      }
      if (id <= last) {
        if (id < last) throw new ValidationError(`ids[${position}]: ${NOT_ASCENDING}`);
        position++;
        return undefined;
      }
      last = id;
      position++;
      const key = id >>> 16;
      let closed: SortedChunk | undefined;
      if (key !== chunk) {
        if (held > 0) closed = cut();
        chunk = key;
        held = 0;
      }
      remainders[held++] = id & 0xffff;
      return closed;
    },
    rest() {
      return held > 0 ? cut() : undefined;
    },
  };
}

/**
 * Cut ascending ids into chunks and hand each to the writer. The two loops are not collapsed into one `for await`:
 * routing a sync source through an async one costs a microtask per id, measured at 20x on the unsorted load's ingest
 * (see `bulk-load.ts`). Both share the cutter, as the unsorted load's two loops share its `ingest`.
 */
async function* chunksOf(
  input: SortedLoadInput,
  codec: CodecInterface,
  clock: Yielder | undefined,
): AsyncGenerator<SortedChunk> {
  const cutter = chunkCutter(codec);
  const tick = yieldEvery(clock, YIELD_EVERY_IDS);
  // True while a chunk is with the writer. The writer ends the read there when its upload fails, which closes the
  // caller's ids; an error from that close is not one the ids raised while being read, and the writer drops it.
  let handing = false;
  const { ids } = input;
  try {
    if (Symbol.asyncIterator in ids) {
      for await (const id of ids) {
        const closed = cutter.accept(id);
        if (closed !== undefined) {
          handing = true;
          yield closed;
          handing = false;
        }
        const pause = tick();
        if (pause !== null) await pause;
      }
    } else {
      for (const id of ids) {
        const closed = cutter.accept(id);
        if (closed !== undefined) {
          handing = true;
          yield closed;
          handing = false;
        }
        const pause = tick();
        if (pause !== null) await pause;
      }
    }
    const last = cutter.rest();
    if (last !== undefined) {
      handing = true;
      yield last;
      handing = false;
    }
  } catch (err) {
    if (handing) throw err;
    input.fail(err);
    throw new SourceFailed();
  }
}
