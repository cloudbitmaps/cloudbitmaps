import { CrbmStorageChunkSource } from '@/core/crbm-storage-source';
import { PinnedStorageChunkSource } from '@/core/pinned-storage-source';

/**
 * Makes the library's own sources answer as a source that cannot read a range does, so the engine reads them chunk by
 * chunk: what a custom source without `getChunks` gets. For a test of the per-key path through the real `.crbm` source
 * (generations, pins, the registry), which every store the library ships otherwise streams past.
 *
 * Call `off()` in `beforeEach` and `restore()` in `afterEach`.
 */
export function withoutRangedReads() {
  const crbm = Object.getOwnPropertyDescriptor(CrbmStorageChunkSource.prototype, 'getChunks');
  const pinned = Object.getOwnPropertyDescriptor(PinnedStorageChunkSource.prototype, 'getChunks');
  return {
    off(): void {
      Object.defineProperty(CrbmStorageChunkSource.prototype, 'getChunks', {
        value: undefined,
        configurable: true,
        writable: true,
      });
      Object.defineProperty(PinnedStorageChunkSource.prototype, 'getChunks', {
        value: undefined,
        configurable: true,
        writable: true,
      });
    },
    restore(): void {
      if (crbm) Object.defineProperty(CrbmStorageChunkSource.prototype, 'getChunks', crbm);
      if (pinned) Object.defineProperty(PinnedStorageChunkSource.prototype, 'getChunks', pinned);
    },
  };
}
