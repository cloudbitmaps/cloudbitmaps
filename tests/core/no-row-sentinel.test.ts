import { NO_ROW } from '@/core/ports';

/**
 * Regression for the cross-bundle `NO_ROW` identity bug (found by the T7 LocalStack load harness).
 *
 * The package ships multiple bundles — the core entry (`dist/index.cjs`) and the `./dynamodb` / `./s3`
 * subpaths — and the builder inlines `core/ports` into each. A plain `Symbol('no-row')` is a DISTINCT instance
 * per bundle, so the engine's `NO_ROW` would not `===` the one the DynamoDb warm driver compares against; every
 * warm-row **create** (`expected === NO_ROW`) would misroute to the token-fenced path and fail against a real
 * DynamoDB (an empty-`:expected` `ValidationException`). It was invisible to the whole test suite, which runs a
 * single source module graph with one symbol instance. Making it a **global-registry** symbol (`Symbol.for`)
 * keeps the identity stable across bundles.
 *
 * `Symbol.keyFor` returns a key ONLY for registry symbols (`undefined` for a plain `Symbol()`), so this fails
 * loudly if anyone reverts to `Symbol('no-row')`.
 */
describe('NO_ROW sentinel', () => {
  it('is a global-registry symbol (identity stable across separately-bundled entrypoints)', () => {
    expect(Symbol.keyFor(NO_ROW)).toBe('cloud-roaring.no-row');
    expect(NO_ROW).toBe(Symbol.for('cloud-roaring.no-row'));
  });
});
