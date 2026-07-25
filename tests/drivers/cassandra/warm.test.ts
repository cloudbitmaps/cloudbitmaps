import type { Client } from 'cassandra-driver';
import { CassandraWarmDriver } from '@/drivers/cassandra/warm';
import { IntegrityError, TransientError, ValidationError, WriteConflictError } from '@/core/errors';
import { NO_ROW } from '@/core/ports';
import type { ChunkRef } from '@/core/ports';

// Construction + CQL/LWT-dispatch checks need no Cassandra (a fake Client records/answers), so they run on the
// normal lane. Full behaviour (real LWT CAS, streamed listChunks, concurrency) is exercised in
// tests/integration/cassandra.test.ts against a real Cassandra — the same split the other drivers use.

interface Call {
  query: string;
  params: unknown[];
  options?: { consistency?: number; fetchSize?: number };
}
interface FakeOpts {
  rows?: Record<string, unknown>[];
  applied?: boolean;
  executeThrow?: () => Promise<void>;
  streamRows?: Record<string, unknown>[];
  onStreamReturn?: () => void; // called if the stream iterator is closed early (break/throw)
}

function fakeClient(calls: Call[], opts: FakeOpts = {}): Client {
  return {
    execute: async (query: string, params: unknown[], options?: Call['options']) => {
      calls.push({ query, params, options });
      if (opts.executeThrow) await opts.executeThrow();
      return { rows: opts.rows ?? [], wasApplied: () => opts.applied ?? true };
    },
    stream: (query: string, params: unknown[], options?: Call['options']) => {
      calls.push({ query, params, options });
      const rows = opts.streamRows ?? [];
      // A hand-rolled async iterable whose return() (invoked by `for await` on break/throw) is observable —
      // this is the stream-disposal path the real Node Readable cleanup relies on.
      return {
        [Symbol.asyncIterator]() {
          let i = 0;
          return {
            next: () =>
              Promise.resolve(
                i < rows.length
                  ? { value: rows[i++], done: false }
                  : { value: undefined, done: true },
              ),
            return: (value?: unknown) => {
              opts.onStreamReturn?.();
              return Promise.resolve({ value, done: true });
            },
          };
        },
      };
    },
  } as unknown as Client;
}

const REF: ChunkRef = { segment: 's', chunkKey: 3 };
const KS = { keyspace: 'ks' };
const mk = (calls: Call[], opts: FakeOpts = {}, extra: Record<string, unknown> = {}) =>
  new CassandraWarmDriver({ client: fakeClient(calls, opts), ...KS, ...extra });

describe('CassandraWarmDriver construction + validation', () => {
  it('rejects a bad keyspace/table identifier and a bad listPageSize', () => {
    expect(() => new CassandraWarmDriver({ client: fakeClient([]), keyspace: 'a;b' })).toThrow(
      ValidationError,
    );
    expect(
      () => new CassandraWarmDriver({ client: fakeClient([]), keyspace: 'ks', table: 'a-b' }),
    ).toThrow(ValidationError);
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      expect(() => mk([], {}, { listPageSize: bad })).toThrow(ValidationError);
    }
  });

  it('rejects out-of-range chunk keys / bad names before touching the client', async () => {
    const calls: Call[] = [];
    const d = mk(calls);
    for (const bad of [70_000, -1, 1.5, Number.NaN]) {
      await expect(d.get({ segment: 's', chunkKey: bad })).rejects.toBeInstanceOf(ValidationError);
    }
    await expect(d.get({ segment: '../x', chunkKey: 0 })).rejects.toBeInstanceOf(ValidationError);
    expect(calls).toHaveLength(0);
  });
});

describe('CassandraWarmDriver LWT dispatch (fake client, cassandra-independent)', () => {
  it('get returns null then a decoded row', async () => {
    expect(await mk([], { rows: [] }).get(REF)).toBeNull();
    const row = await mk([], { rows: [{ tok: 'tok-1', payload: Buffer.from([9, 8]) }] }).get(REF);
    expect(row!.token).toBe('tok-1');
    expect([...row!.bytes]).toEqual([9, 8]);
  });

  it('create-if-absent → INSERT … IF NOT EXISTS; not applied ⇒ WriteConflictError', async () => {
    const calls: Call[] = [];
    const { token } = await mk(calls, { applied: true }).putConditional(
      REF,
      new Uint8Array([1, 2]),
      NO_ROW,
    );
    expect(token.length).toBeGreaterThan(0);
    expect(calls[0]!.query).toContain('IF NOT EXISTS');
    expect(calls[0]!.params.slice(0, 5)).toEqual(['', '_default', 's', 3, token]);
    expect(calls[0]!.params[5]).toBeInstanceOf(Buffer);

    await expect(
      mk([], { applied: false }).putConditional(REF, new Uint8Array([1]), NO_ROW),
    ).rejects.toBeInstanceOf(WriteConflictError);
  });

  it('token-fenced update → UPDATE … IF token=?; not applied ⇒ WriteConflictError', async () => {
    const calls: Call[] = [];
    const { token } = await mk(calls, { applied: true }).putConditional(
      REF,
      new Uint8Array([5]),
      'old',
    );
    expect(token).not.toBe('old');
    expect(calls[0]!.query).toMatch(/UPDATE .* IF tok = \?/s);
    // params: token, payload, kp, ns, seg, ck, expected
    expect(calls[0]!.params[0]).toBe(token);
    expect(calls[0]!.params[6]).toBe('old');

    await expect(
      mk([], { applied: false }).putConditional(REF, new Uint8Array([5]), 'old'),
    ).rejects.toBeInstanceOf(WriteConflictError);
  });

  it('fenced delete → DELETE … IF token=?; not applied ⇒ WriteConflictError', async () => {
    const calls: Call[] = [];
    await mk(calls, { applied: true }).deleteConditional(REF, 'tok');
    expect(calls[0]!.query).toMatch(/^DELETE .* IF tok = \?/s);
    expect(calls[0]!.params).toEqual(['', '_default', 's', 3, 'tok']);

    await expect(mk([], { applied: false }).deleteConditional(REF, 'tok')).rejects.toBeInstanceOf(
      WriteConflictError,
    );
  });

  it('mints a distinct random token per write', async () => {
    const d = mk([], { applied: true });
    const a = await d.putConditional(REF, new Uint8Array([1]), NO_ROW);
    const b = await d.putConditional(REF, new Uint8Array([1]), NO_ROW);
    expect(a.token).not.toBe(b.token);
  });

  it('maps a transient Cassandra fault to TransientError', async () => {
    const d = mk([], {
      executeThrow: () =>
        Promise.reject(Object.assign(new Error(), { name: 'NoHostAvailableError' })),
    });
    await expect(d.get(REF)).rejects.toBeInstanceOf(TransientError);
  });

  it('listChunks streams the partition (ordered by ck) and rejects a non-numeric ck', async () => {
    const good = mk([], {
      streamRows: [
        { ck: 0, tok: 't0', payload: Buffer.from([0]) },
        { ck: 9, tok: 't9', payload: Buffer.from([9]) },
      ],
    });
    const seen: number[] = [];
    for await (const row of good.listChunks({ segment: 's' })) seen.push(row.chunkKey);
    expect(seen).toEqual([0, 9]);

    const corrupt = mk([], { streamRows: [{ ck: 'x', tok: 't', payload: Buffer.from([1]) }] });
    await expect(async () => {
      for await (const _row of corrupt.listChunks({ segment: 's' })) void _row;
    }).rejects.toBeInstanceOf(IntegrityError);
  });

  it('closes (disposes) the stream when listChunks is broken out of early', async () => {
    let returned = false;
    const d = mk([], {
      streamRows: [
        { ck: 0, tok: 't0', payload: Buffer.from([0]) },
        { ck: 1, tok: 't1', payload: Buffer.from([1]) },
      ],
      onStreamReturn: () => {
        returned = true;
      },
    });
    for await (const row of d.listChunks({ segment: 's' })) {
      expect(row.chunkKey).toBe(0);
      break; // early exit after one row
    }
    expect(returned).toBe(true); // the underlying stream iterator's return() ran → no leaked paging
  });

  it('get rejects a corrupt row missing its token (untrusted-data posture)', async () => {
    const d = mk([], { rows: [{ payload: Buffer.from([1]) }] }); // no `tok`
    await expect(d.get(REF)).rejects.toBeInstanceOf(IntegrityError);
  });

  it('reads at LOCAL_SERIAL by default and LOCAL_ONE when consistent:false', async () => {
    const c1: Call[] = [];
    await mk(c1, { rows: [] }).get(REF);
    expect(c1[0]!.options?.consistency).toBe(9); // LOCAL_SERIAL — linearizable read-your-writes

    const c2: Call[] = [];
    await mk(c2, { rows: [] }).get(REF, { consistent: false });
    expect(c2[0]!.options?.consistency).toBe(10); // LOCAL_ONE — fast, possibly stale

    const c3: Call[] = [];
    for await (const _row of mk(c3, { streamRows: [] }).listChunks({ segment: 's' })) void _row;
    expect(c3[0]!.options?.consistency).toBe(9); // listChunks strong by default too
  });
});
