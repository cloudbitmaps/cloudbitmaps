import * as copied from '@/tools/store-defaults';
import { LIST_COLLECTION_CADENCE } from '@/core/generation-gc';
import { DEFAULT_CURRENT_GEN_TTL_MS, DEFAULT_MAX_OPEN_SEGMENTS } from '@/core/reader-defaults';

/**
 * `@cloudbitmaps/tools` imports nothing internal from core, so it keeps its own copies of the store's figures the cost
 * model prices. Each copy must stay equal to the figure the engine runs on, or the model prices a store that no longer
 * exists while every other test stays green.
 */
describe("the cost model's copies of the store's figures", () => {
  it('each equals the figure core runs on', () => {
    expect(copied.LIST_COLLECTION_CADENCE).toBe(LIST_COLLECTION_CADENCE);
    expect(copied.DEFAULT_CURRENT_GEN_TTL_MS).toBe(DEFAULT_CURRENT_GEN_TTL_MS);
    expect(copied.DEFAULT_MAX_OPEN_SEGMENTS).toBe(DEFAULT_MAX_OPEN_SEGMENTS);
  });

  it('holds every copy the module has, so one added later is held too', () => {
    expect(Object.keys(copied).sort()).toEqual([
      'DEFAULT_CURRENT_GEN_TTL_MS',
      'DEFAULT_MAX_OPEN_SEGMENTS',
      'LIST_COLLECTION_CADENCE',
    ]);
  });
});
