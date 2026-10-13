/**
 * For a test file whose cases are about a read that goes to storage for its chunks: what a generation swept or replaced
 * mid-read does to one, which requests a cold read makes of them, what a pin reads after its object changed. A reader
 * that kept a small generation's chunks from its open answers those from memory and never meets the change, which is
 * the behaviour of a chunk-cache hit and is held in `tests/core/tail-handoff.test.ts`; these files keep the readers
 * from keeping, so that what they hold is held on the path that reads.
 *
 * Use in the file, above its imports of the library:
 *
 *     vi.mock('@/core/crbm/reader', async (original) =>
 *       (await import('../helpers/chunks-not-kept')).withoutKeptChunks(await original()),
 *     );
 */
import type * as Reader from '@/core/crbm/reader';

export function withoutKeptChunks(original: typeof Reader): typeof Reader {
  return {
    ...original,
    openCrbmReaderKeeping: (blob, options) =>
      original.openCrbmReaderKeeping(blob, options, undefined),
  };
}
