import {
  ConditionalCheckFailedException,
  type AttributeValue,
  type DynamoDBClient,
} from '@aws-sdk/client-dynamodb';
import { DynamoDbRegistryDriver } from '@/drivers/dynamodb/registry';
import {
  IntegrityError,
  TransientError,
  UnsupportedError,
  WriteConflictError,
} from '@/core/errors';
import { REGISTRY_SCHEMA_VERSION } from '@/drivers/_shared/registry';
import type { RegistryRecord } from '@/core/ports';

function fakeClient(send: (command: unknown) => Promise<unknown>): DynamoDBClient {
  return { send } as unknown as DynamoDBClient;
}
const seg = { segment: 's' };
const driverWith = (send: (c: unknown) => Promise<unknown>, now = (): number => 1_000) =>
  new DynamoDbRegistryDriver({ client: fakeClient(send), tableName: 't', now });

/** A stored body (everything except the OCC token, which is the counter `v`). */
const body = (over: Partial<Omit<RegistryRecord, 'token'>> = {}): string =>
  JSON.stringify({
    segment: 's',
    currentGen: 3,
    dirtyChunkCount: 0,
    status: 'active',
    createdAt: 1,
    updatedAt: 1,
    ...over,
  });
const liveItem = (b = body(), v = '2'): { Item: Record<string, AttributeValue> } => ({
  Item: { v: { N: v }, r: { S: b }, del: { BOOL: false } },
});

describe('DynamoDbRegistryDriver (unit, fake client)', () => {
  it('advertises strongRead', () => {
    expect(driverWith(() => Promise.resolve({})).capabilities().strongRead).toBe(true);
  });

  describe('get', () => {
    it('returns null for an absent item or a tombstone', async () => {
      expect(await driverWith(() => Promise.resolve({})).get(seg)).toBeNull();
      const tomb = driverWith(() =>
        Promise.resolve({ Item: { v: { N: '3' }, del: { BOOL: true } } }),
      );
      expect(await tomb.get(seg)).toBeNull();
    });
    it('parses the body and derives the token from the counter', async () => {
      const d = driverWith(() =>
        Promise.resolve(liveItem(body({ currentGen: 7, keyId: 'k' }), '5')),
      );
      const rec = await d.get(seg);
      expect(rec).toMatchObject({ segment: 's', currentGen: 7, keyId: 'k', token: '5' });
    });
    it('rejects a live row missing its token or body (IntegrityError)', async () => {
      const noTok = driverWith(() =>
        Promise.resolve({ Item: { r: { S: body() }, del: { BOOL: false } } }),
      );
      await expect(noTok.get(seg)).rejects.toBeInstanceOf(IntegrityError);
      const noBody = driverWith(() =>
        Promise.resolve({ Item: { v: { N: '2' }, del: { BOOL: false } } }),
      );
      await expect(noBody.get(seg)).rejects.toBeInstanceOf(IntegrityError);
    });
    it('rejects a non-object retention/residency blob (IntegrityError, invariant 5)', async () => {
      // `JSON.stringify(null)` is 4 valid bytes, so a stored `"retention": null` round-trips through the size and
      // serializability checks. It matters because `retention.expiresAt` is read with an `in` test, which throws an
      // untyped `TypeError` on a non-object — and that would abort a whole fleet retention sweep instead of
      // becoming one ledger entry. The write boundary rejects it now; this is the read boundary, for a row edited
      // by hand or written before that check existed.
      for (const bad of ['null', '"nope"', '42', '[1,2]']) {
        const d = driverWith(() =>
          Promise.resolve(
            liveItem(
              `{"segment":"s","currentGen":3,"dirtyChunkCount":0,"status":"active","createdAt":1,"updatedAt":1,"retention":${bad}}`,
            ),
          ),
        );
        await expect(d.get(seg)).rejects.toBeInstanceOf(IntegrityError);
      }
    });

    it('rejects a corrupt (non-JSON) body (IntegrityError, invariant 5)', async () => {
      const d = driverWith(() =>
        Promise.resolve({ Item: { v: { N: '2' }, r: { S: '{not json' }, del: { BOOL: false } } }),
      );
      await expect(d.get(seg)).rejects.toBeInstanceOf(IntegrityError);
    });
    it('tolerates a legacy body with no schemaVersion (reads as v1, format freeze)', async () => {
      // body() emits no schemaVersion — a pre-freeze row must stay readable after the upgrade.
      const d = driverWith(() => Promise.resolve(liveItem(body(), '2')));
      expect(await d.get(seg)).toMatchObject({ segment: 's', token: '2' });
    });
    it('rejects a body with a newer schemaVersion (UnsupportedError, fail-closed)', async () => {
      const future = JSON.stringify({
        schemaVersion: REGISTRY_SCHEMA_VERSION + 1,
        segment: 's',
        currentGen: 3,
        dirtyChunkCount: 0,
        status: 'active',
        createdAt: 1,
        updatedAt: 1,
      });
      const d = driverWith(() => Promise.resolve(liveItem(future, '2')));
      await expect(d.get(seg)).rejects.toBeInstanceOf(UnsupportedError);
    });
  });

  describe('create', () => {
    it('returns the new token from UPDATED_NEW', async () => {
      const d = driverWith(() => Promise.resolve({ Attributes: { v: { N: '1' } } }));
      expect(await d.create(seg, { currentGen: 0 })).toEqual({ token: '1' });
    });
    it('maps a failed condition to WriteConflictError', async () => {
      const d = driverWith(() =>
        Promise.reject(new ConditionalCheckFailedException({ message: 'x', $metadata: {} })),
      );
      await expect(d.create(seg, { currentGen: 0 })).rejects.toBeInstanceOf(WriteConflictError);
    });
    it('reclassifies a throttle as TransientError', async () => {
      const d = driverWith(() => Promise.reject({ name: 'ThrottlingException' }));
      await expect(d.create(seg, { currentGen: 0 })).rejects.toBeInstanceOf(TransientError);
    });
  });

  describe('compareAndSwap', () => {
    it('is a conflict when the row is absent', async () => {
      const d = driverWith(() => Promise.resolve({})); // get → absent
      await expect(d.compareAndSwap(seg, '2', { currentGen: 4 })).rejects.toBeInstanceOf(
        WriteConflictError,
      );
    });
    it('is a conflict when the held token is stale', async () => {
      const d = driverWith(() => Promise.resolve(liveItem(body(), '9'))); // current token 9
      await expect(d.compareAndSwap(seg, '2', { currentGen: 4 })).rejects.toBeInstanceOf(
        WriteConflictError,
      );
    });

    it('success path: returns the new token and writes a merged body (createdAt preserved)', async () => {
      const sent: Array<Record<string, unknown>> = [];
      const d = driverWith((command) => {
        const input = (command as { input: Record<string, unknown> }).input;
        sent.push(input);
        // First call is the read (GetItem) → live row at token 2; second is the UpdateItem → new token 3.
        return Promise.resolve(
          'UpdateExpression' in input
            ? { Attributes: { v: { N: '3' } } }
            : liveItem(body({ currentGen: 3, createdAt: 111, updatedAt: 222 }), '2'),
        );
      });
      expect(await d.compareAndSwap(seg, '2', { currentGen: 4 })).toEqual({ token: '3' });
      const update = sent.find((i) => 'UpdateExpression' in i)!;
      const written = JSON.parse(
        (update.ExpressionAttributeValues as { ':r': { S: string } })[':r'].S,
      );
      expect(written.currentGen).toBe(4); // the patch applied
      expect(written.createdAt).toBe(111); // createdAt carried through from the read
      expect(written).not.toHaveProperty('token'); // token is the counter `v`, never in the body
      expect(written.schemaVersion).toBe(REGISTRY_SCHEMA_VERSION); // stamped on write (format freeze)
    });

    // The shared `registryConformance` R8 case covers this driver too, but only under LocalStack
    // (`test:integration`). Serialization is exactly where a null pointer gets silently dropped or coerced, so
    // the JSON body it writes and reads is pinned here, in the suite that runs on every commit.
    it('round-trips a null currentGen through the serialized body (R8)', async () => {
      const sent: Array<Record<string, unknown>> = [];
      const d = driverWith((command) => {
        const input = (command as { input: Record<string, unknown> }).input;
        sent.push(input);
        return Promise.resolve(
          'UpdateExpression' in input
            ? { Attributes: { v: { N: '3' } } }
            : liveItem(body({ currentGen: null }), '2'),
        );
      });
      // READ: a stored `null` parses as a live record with no Cold generation — not an IntegrityError, and not 0.
      expect(await d.get(seg)).toMatchObject({ segment: 's', currentGen: null, status: 'active' });
      // WRITE: clearing the pointer keeps the key in the body as an explicit `null`. `JSON.stringify` drops
      // `undefined` fields (that is how a cleared `keyId` vanishes above) — `null` must NOT go the same way,
      // or the merged body would silently re-read as whatever the previous generation was.
      await d.compareAndSwap(seg, '2', { currentGen: null });
      const update = sent.find((i) => 'UpdateExpression' in i)!;
      const written = JSON.parse(
        (update.ExpressionAttributeValues as { ':r': { S: string } })[':r'].S,
      ) as Record<string, unknown>;
      expect(written).toHaveProperty('currentGen');
      expect(written.currentGen).toBeNull();
    });

    it('a cleared keyId is omitted from the serialized body', async () => {
      const sent: Array<Record<string, unknown>> = [];
      const d = driverWith((command) => {
        const input = (command as { input: Record<string, unknown> }).input;
        sent.push(input);
        return Promise.resolve(
          'UpdateExpression' in input
            ? { Attributes: { v: { N: '3' } } }
            : liveItem(body({ keyId: 'k1' }), '2'),
        );
      });
      await d.compareAndSwap(seg, '2', { keyId: undefined });
      const update = sent.find((i) => 'UpdateExpression' in i)!;
      const written = JSON.parse(
        (update.ExpressionAttributeValues as { ':r': { S: string } })[':r'].S,
      );
      expect(written).not.toHaveProperty('keyId');
    });
  });

  describe('list (namespace scoping)', () => {
    it('scopes the Scan to a namespace via an exact PK prefix + del filter', async () => {
      let input!: Record<string, unknown>;
      const d = driverWith((command) => {
        input = (command as { input: Record<string, unknown> }).input;
        return Promise.resolve({ Items: [] });
      });
      for await (const _ of d.list('tenant')) void _;
      const values = input.ExpressionAttributeValues as Record<
        string,
        { S?: string; BOOL?: boolean }
      >;
      expect(values[':pk']!.S).toBe('ns#tenant|seg#'); // exact prefix — guards the scanPkPrefix slice
      expect(values[':reg']!.S).toBe('reg#');
      expect(values[':false']!.BOOL).toBe(false);
      expect(input.FilterExpression).toContain('#del = :false');
    });

    it('an unscoped list (no namespace, no keyPrefix) omits the PK filter', async () => {
      let input!: Record<string, unknown>;
      const d = driverWith((command) => {
        input = (command as { input: Record<string, unknown> }).input;
        return Promise.resolve({ Items: [] });
      });
      for await (const _ of d.list()) void _;
      const values = input.ExpressionAttributeValues as Record<string, unknown>;
      expect(values).not.toHaveProperty(':pk');
      expect(input.FilterExpression).not.toContain('begins_with');
    });
  });

  // Same wire-grammar guard as the warm driver (regression for the 4a class of bug): every declared
  // #name / :value placeholder must be referenced, and every referenced one declared.
  describe('well-formed expression placeholders', () => {
    const assertWellFormed = (input: Record<string, unknown>): void => {
      const expr = [input.ConditionExpression, input.UpdateExpression, input.FilterExpression]
        .filter((e): e is string => typeof e === 'string')
        .join(' ');
      const names = (input.ExpressionAttributeNames ?? {}) as Record<string, string>;
      const values = (input.ExpressionAttributeValues ?? {}) as Record<string, unknown>;
      const used = (sigil: string): Set<string> =>
        new Set(expr.match(new RegExp(`${sigil}[A-Za-z0-9_]+`, 'g')) ?? []);
      for (const n of Object.keys(names)) expect(used('#'), `unused ${n}`).toContain(n);
      for (const v of Object.keys(values)) expect(used(':'), `unused ${v}`).toContain(v);
      for (const n of used('#')) expect(names, `undeclared ${n}`).toHaveProperty([n]);
      for (const v of used(':')) expect(values, `undeclared ${v}`).toHaveProperty([v]);
    };
    const capture = async (run: (d: DynamoDbRegistryDriver) => Promise<unknown>): Promise<void> => {
      const inputs: Array<Record<string, unknown>> = [];
      const d = driverWith((command) => {
        inputs.push((command as { input: Record<string, unknown> }).input);
        // Reply so both the get (CAS reads first) and the update resolve.
        return Promise.resolve({ ...liveItem(), Attributes: { v: { N: '3' } } });
      });
      await run(d);
      inputs.forEach(assertWellFormed);
    };

    it('create / compareAndSwap / delete declare only the placeholders they use', async () => {
      await capture((d) => d.create(seg, { currentGen: 0 }));
      await capture((d) => d.compareAndSwap(seg, '2', { currentGen: 4 }));
      await capture((d) => d.delete(seg));
    });
  });
});
