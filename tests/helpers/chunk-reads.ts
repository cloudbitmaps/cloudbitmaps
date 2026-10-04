import { CrbmReader } from '@/core/crbm/reader';

/**
 * Counts the chunk reads the engine asks the `.crbm` reader for, by either route: the chunks in the key lists of its
 * streams, and the chunks it reads one at a time. A coalesced stream makes few requests for many chunks, so the
 * request count no longer says which chunks a read wanted; this does, and is what "fetches only the chunks in range"
 * is checked against.
 *
 * Call `start()` in `beforeEach` and `stop()` in `afterEach`.
 */
export function chunkReads() {
  const proto = CrbmReader.prototype;
  const readChunks = proto.readChunks;
  const getChunk = proto.getChunk;
  /** The key list of every stream the reader was asked to read, in order. */
  const streams: number[][] = [];
  /** The key of every chunk read on its own, in order. */
  const singles: number[] = [];
  return {
    streams,
    singles,
    start(): void {
      proto.readChunks = function (this: CrbmReader, keys, options) {
        streams.push([...keys]);
        return readChunks.call(this, keys, options);
      };
      proto.getChunk = function (this: CrbmReader, key) {
        singles.push(key);
        return getChunk.call(this, key);
      };
    },
    stop(): void {
      proto.readChunks = readChunks;
      proto.getChunk = getChunk;
    },
    reset(): void {
      streams.length = 0;
      singles.length = 0;
    },
    /** Chunks asked for, however they were read. */
    total(): number {
      return streams.reduce((n, s) => n + s.length, 0) + singles.length;
    },
  };
}
