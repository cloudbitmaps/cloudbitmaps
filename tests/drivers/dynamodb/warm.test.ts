import {
  ConditionalCheckFailedException,
  type AttributeValue,
  type DynamoDBClient,
} from '@aws-sdk/client-dynamodb';
import { DynamoDbWarmDriver } from '@/drivers/dynamodb/warm';
import { IntegrityError, TransientError, ValidationError, WriteConflictError } from '@/core/errors';
import { NO_ROW } from '@/core/ports';

/** A DynamoDBClient stand-in whose `send` returns/throws a canned value — exercises the driver's pure
 * response-parsing + error-mapping logic with no DynamoDB-Local (that's the integration lane). */
function fakeClient(send: (command: unknown) => Promise<unknown>): DynamoDBClient {
  return { send } as unknown as DynamoDBClient;
}

const ref = (chunkKey: number) => ({ segment: 's', chunkKey });
const driverWith = (send: (c: unknown) => Promise<unknown>): DynamoDbWarmDriver =>
  new DynamoDbWarmDriver({ client: fakeClient(send), tableName: 't' });
const item = (attrs: Record<string, AttributeValue>): { Item: Record<string, AttributeValue> } => ({
  Item: attrs,
});

describe('DynamoDbWarmDriver (unit, fake client)', () => {
  describe('keyPrefix validation', () => {
    const make = (keyPrefix: string): DynamoDbWarmDriver =>
      new DynamoDbWarmDriver({
        client: fakeClient(() => Promise.resolve({})),
        tableName: 't',
        keyPrefix,
      });
    it('rejects a prefix containing PK delimiters or control chars', () => {
      for (const bad of ['a|b', 'a#b', 'a\tb', 'a\nb']) {
        expect(() => make(bad)).toThrow(ValidationError);
      }
    });
    it('accepts a clean prefix or none', () => {
      expect(() => make('tenantA')).not.toThrow();
      expect(() => make('')).not.toThrow();
      expect(
        () =>
          new DynamoDbWarmDriver({ client: fakeClient(() => Promise.resolve({})), tableName: 't' }),
      ).not.toThrow();
    });
  });

  describe('get', () => {
    it('returns null for an absent item', async () => {
      expect(await driverWith(() => Promise.resolve({})).get(ref(1))).toBeNull();
    });
    it('returns null for a tombstone (del=true)', async () => {
      const d = driverWith(() => Promise.resolve(item({ v: { N: '2' }, del: { BOOL: true } })));
      expect(await d.get(ref(1))).toBeNull();
    });
    it('returns {token,bytes} for a live row', async () => {
      const d = driverWith(() =>
        Promise.resolve(
          item({ v: { N: '3' }, b: { B: Uint8Array.of(1, 2) }, del: { BOOL: false } }),
        ),
      );
      const row = await d.get(ref(1));
      expect(row).toEqual({ token: '3', bytes: Uint8Array.of(1, 2) });
    });
    it('rejects a live row missing its payload (IntegrityError, invariant 5)', async () => {
      const d = driverWith(() => Promise.resolve(item({ v: { N: '3' }, del: { BOOL: false } })));
      await expect(d.get(ref(1))).rejects.toBeInstanceOf(IntegrityError);
    });
    it('rejects an out-of-range chunk key before any send', async () => {
      await expect(
        driverWith(() => Promise.reject(new Error('should not call'))).get(ref(70_000)),
      ).rejects.toBeInstanceOf(ValidationError);
    });
  });

  describe('putConditional error mapping', () => {
    it('maps a ConditionalCheckFailedException to WriteConflictError', async () => {
      const d = driverWith(() =>
        Promise.reject(new ConditionalCheckFailedException({ message: 'no', $metadata: {} })),
      );
      await expect(d.putConditional(ref(1), Uint8Array.of(1), NO_ROW)).rejects.toBeInstanceOf(
        WriteConflictError,
      );
    });
    it('maps a re-wrapped conflict (name only) to WriteConflictError', async () => {
      const d = driverWith(() => Promise.reject({ name: 'ConditionalCheckFailedException' }));
      await expect(d.putConditional(ref(1), Uint8Array.of(1), '4')).rejects.toBeInstanceOf(
        WriteConflictError,
      );
    });
    it('reclassifies a throttle as a retryable TransientError, preserving the cause', async () => {
      const throttle = Object.assign(new Error('throttled'), { name: 'ThrottlingException' });
      const d = driverWith(() => Promise.reject(throttle));
      await expect(d.putConditional(ref(1), Uint8Array.of(1), NO_ROW)).rejects.toBeInstanceOf(
        TransientError,
      );
      await expect(d.putConditional(ref(1), Uint8Array.of(1), NO_ROW)).rejects.toMatchObject({
        cause: throttle,
      });
    });
    it('passes a genuinely unknown (non-conflict, non-transient) error through unchanged', async () => {
      const weird = Object.assign(new Error('huh'), { name: 'SomethingUnexpected' });
      const d = driverWith(() => Promise.reject(weird));
      await expect(d.putConditional(ref(1), Uint8Array.of(1), NO_ROW)).rejects.toBe(weird);
    });
    it('returns the new token from UPDATED_NEW', async () => {
      const d = driverWith(() => Promise.resolve({ Attributes: { v: { N: '5' } } }));
      expect(await d.putConditional(ref(1), Uint8Array.of(1), NO_ROW)).toEqual({ token: '5' });
    });
    it('rejects a response missing the token (IntegrityError)', async () => {
      const d = driverWith(() => Promise.resolve({ Attributes: {} }));
      await expect(d.putConditional(ref(1), Uint8Array.of(1), NO_ROW)).rejects.toBeInstanceOf(
        IntegrityError,
      );
    });
  });

  describe('deleteConditional', () => {
    it('maps a failed condition to WriteConflictError', async () => {
      const d = driverWith(() =>
        Promise.reject(new ConditionalCheckFailedException({ message: 'no', $metadata: {} })),
      );
      await expect(d.deleteConditional(ref(1), '2')).rejects.toBeInstanceOf(WriteConflictError);
    });
  });

  // DynamoDB rejects two symmetric mismatches the fake client can't surface as a 4xx:
  //   • a #name declared in ExpressionAttributeNames but not referenced ("unused in expressions"), and
  //   • a :value referenced in an expression but not declared in ExpressionAttributeValues ("not defined").
  // Assert both invariants directly against each command's input so neither can pass the unit lane again.
  describe('well-formed expression placeholders (regression: PR #16)', () => {
    const capture = async (
      run: (d: DynamoDbWarmDriver) => Promise<unknown>,
      reply: unknown = { Attributes: { v: { N: '1' } }, Items: [] },
    ): Promise<Array<Record<string, unknown>>> => {
      const inputs: Array<Record<string, unknown>> = [];
      const d = driverWith((command) => {
        inputs.push((command as { input: Record<string, unknown> }).input);
        return Promise.resolve(reply);
      });
      await run(d);
      return inputs;
    };
    const expressionsOf = (input: Record<string, unknown>): string =>
      [
        input.ConditionExpression,
        input.UpdateExpression,
        input.KeyConditionExpression,
        input.FilterExpression,
        input.ProjectionExpression,
      ]
        .filter((e): e is string => typeof e === 'string')
        .join(' ');
    // Match #name / :value tokens as DynamoDB's parser would (it ignores those embedded in attribute paths,
    // but our expressions never nest placeholders, so a word-boundary scan is exact here).
    const refsIn = (expr: string, sigil: '#' | ':'): Set<string> =>
      new Set(expr.match(new RegExp(`${sigil}[A-Za-z0-9_]+`, 'g')) ?? []);
    const assertWellFormed = (input: Record<string, unknown>): void => {
      const expr = expressionsOf(input);
      const names = input.ExpressionAttributeNames as Record<string, string> | undefined;
      const values = input.ExpressionAttributeValues as Record<string, unknown> | undefined;
      const usedNames = refsIn(expr, '#');
      const usedValues = refsIn(expr, ':');
      // No declared placeholder goes unused (rejected: "...unused in expressions").
      for (const n of Object.keys(names ?? {})) expect(usedNames, `unused name ${n}`).toContain(n);
      for (const v of Object.keys(values ?? {}))
        expect(usedValues, `unused value ${v}`).toContain(v);
      // No referenced placeholder goes undeclared (rejected: "...is not defined").
      for (const n of usedNames) expect(names ?? {}, `undeclared name ${n}`).toHaveProperty([n]);
      for (const v of usedValues) expect(values ?? {}, `undeclared value ${v}`).toHaveProperty([v]);
    };

    it('putConditional (create-if-absent) uses well-formed placeholders', async () => {
      const inputs = await capture((d) => d.putConditional(ref(1), Uint8Array.of(1), NO_ROW));
      inputs.forEach(assertWellFormed);
    });
    it('putConditional (token-fenced update) uses well-formed placeholders', async () => {
      const inputs = await capture((d) => d.putConditional(ref(1), Uint8Array.of(1), '3'));
      inputs.forEach(assertWellFormed);
    });
    it('deleteConditional uses well-formed placeholders', async () => {
      const inputs = await capture((d) => d.deleteConditional(ref(1), '3'));
      inputs.forEach(assertWellFormed);
    });
    it('listChunks uses well-formed placeholders', async () => {
      const inputs = await capture(async (d) => {
        for await (const _ of d.listChunks({ segment: 's' })) void _;
      });
      inputs.forEach(assertWellFormed);
    });
  });

  describe('read consistency (gap #9)', () => {
    const inputOf = async (
      run: (d: DynamoDbWarmDriver) => Promise<unknown>,
    ): Promise<Record<string, unknown>> => {
      let captured: Record<string, unknown> = {};
      const d = driverWith((command) => {
        captured = (command as { input: Record<string, unknown> }).input;
        return Promise.resolve({ Items: [] });
      });
      await run(d);
      return captured;
    };
    it('get is strongly consistent by default and when consistent:true', async () => {
      expect((await inputOf((d) => d.get(ref(1)))).ConsistentRead).toBe(true);
      expect((await inputOf((d) => d.get(ref(1), { consistent: true }))).ConsistentRead).toBe(true);
    });
    it('get is eventually consistent when consistent:false', async () => {
      expect((await inputOf((d) => d.get(ref(1), { consistent: false }))).ConsistentRead).toBe(
        false,
      );
    });
    it('listChunks maps the consistency flag to ConsistentRead', async () => {
      const strong = await inputOf(async (d) => {
        for await (const _ of d.listChunks({ segment: 's' })) void _;
      });
      expect(strong.ConsistentRead).toBe(true);
      const eventual = await inputOf(async (d) => {
        for await (const _ of d.listChunks({ segment: 's' }, { consistent: false })) void _;
      });
      expect(eventual.ConsistentRead).toBe(false);
    });
  });
});
