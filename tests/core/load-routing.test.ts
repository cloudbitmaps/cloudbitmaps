import { inject } from 'vitest';
import { CloudRoaring, MemoryStorage } from '@/index';
import { ROUTED_PROJECT } from '../helpers/load-input-routes';

declare module 'vitest' {
  export interface ProvidedContext {
    /** Which input the project hands core's load: the ids as given, or `{ serialized }`. */
    loadInput: string;
  }
}

/**
 * The `serialized` project is only evidence if it really hands core's load `{ serialized }`: a setup that stopped
 * converting would leave every routed file green and prove nothing. So this file runs in both projects and tells
 * them apart by when a load reads its ids. The id path reads them during its write, after the registry row; the
 * routed load has read them all before its first request.
 */
describe('the serialized project routes loads through { serialized }', () => {
  it('reads the ids before the row under serialized, and after it under ids', async () => {
    const backend = new MemoryStorage();
    const get = backend.registry.get.bind(backend.registry);
    let rowRead = false;
    backend.registry.get = async (ref) => {
      rowRead = true;
      return get(ref);
    };
    let readBeforeRow: boolean | undefined;
    function* ids(): Generator<number> {
      readBeforeRow = !rowRead;
      yield 1;
    }
    const r = await new CloudRoaring({ storage: backend }).load({ segment: 'routed' }, ids());
    expect(r).toMatchObject({ published: true, cardinality: 1 });
    expect(readBeforeRow).toBe(inject('loadInput') === ROUTED_PROJECT);
  });
});
