import { CloudRoaring, MemoryStorage, ValidationError } from '@/index';
import { loadedStore } from '../helpers/loaded';
import { routedProject, routing } from '../helpers/load-routing';

/**
 * The `serialized` project is only evidence if it really hands the write path `{ serialized }`: a setup that stopped
 * converting, or converted to the wrong thing, would leave every routed file green and prove nothing. This file runs
 * in both projects and checks what core's write path received, for each kind of id source a test hands it: a sync
 * iterable, an async one, and the fixture loader, which writes without going through core's load. It also checks
 * when a load reads its ids (before the first request when routed, during the write otherwise), and that a bad id
 * is still refused when routed.
 */
const ROUTED = routedProject();

beforeEach(() => {
  routing.received.length = 0;
});

describe('the serialized project routes loads through { serialized }', () => {
  it('reads the ids before the row when routed, and after it otherwise', async () => {
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
    expect(readBeforeRow).toBe(ROUTED);
  });

  it('hands core { serialized } for a sync source, an async source and the fixture loader', async () => {
    const store = new CloudRoaring({ storage: new MemoryStorage() });
    async function* stream(): AsyncGenerator<number> {
      yield 70_000;
      yield 5;
    }
    expect(await store.load({ segment: 'sync' }, [1, 2, 3])).toMatchObject({ cardinality: 3 });
    expect(await store.load({ segment: 'async' }, stream())).toMatchObject({ cardinality: 2 });
    const fixture = await loadedStore({ seeded: [9, 10] });
    expect(await fixture.store.segment('seeded').count()).toBe(2);
    expect(routing.received).toEqual(ROUTED ? ['serialized', 'serialized', 'serialized'] : []);
  });

  it('still refuses a bad id, from either kind of source', async () => {
    const store = new CloudRoaring({ storage: new MemoryStorage() });
    async function* stream(): AsyncGenerator<number> {
      yield 1;
      yield 1.5;
    }
    await expect(store.load({ segment: 'bad' }, [1, -1])).rejects.toThrow(ValidationError);
    await expect(store.load({ segment: 'bad' }, stream())).rejects.toThrow(ValidationError);
    await expect(store.load({ segment: 'bad' }, [2 ** 32])).rejects.toThrow(ValidationError);
  });
});
