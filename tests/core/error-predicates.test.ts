import {
  BudgetExceededError,
  CapabilityError,
  CloudRoaringError,
  IntegrityError,
  KeyUnavailableError,
  NotFoundError,
  TransientError,
  ValidationError,
  WriteConflictError,
  isBudgetExceededError,
  isCapabilityError,
  isCloudRoaringError,
  isIntegrityError,
  isKeyUnavailableError,
  isNotFoundError,
  isTransientError,
  isValidationError,
  isWriteConflictError,
} from '@/core/errors';

/**
 * Bundle-safe error predicates. This pins the classification LOGIC (brand + name matching);
 * the actual cross-bundle behaviour against the built bundles is guarded by `scripts/smoke.cjs`.
 */

describe('the error brands are GLOBALLY REGISTERED symbols', () => {
  // `Symbol.for` vs `Symbol` is the entire mechanism, and this is the test that pins it.
  //
  // `scripts/smoke.cjs` looks as if it could, since it classifies errors across the built packages. It
  // cannot: every package leaves `@cloudbitmaps/core` external, so there is ONE copy of core, and the brand
  // is a single module-level constant shared by the class that sets it and the predicate that reads it.
  // Symbol identity is then trivially satisfied whether or not the symbol is registered, and every smoke
  // assertion stays green.
  //
  // What registration actually buys is the cases a build cannot reproduce — a consumer's bundler inlining
  // core twice, two majors resolved side by side, an error crossing a worker or vm realm. In all three the
  // classes differ and only a GLOBAL symbol key still matches. So the property has to be asserted directly,
  // against the registry, rather than inferred from a same-realm comparison that cannot fail.
  it.each([
    ['cloudbitmaps.error', new ValidationError('x')],
    ['cloudbitmaps.error.transient', new TransientError('x')],
  ])('%s is on the thrown error and resolves through the global registry', (key, err) => {
    const global = Symbol.for(key);
    // `Symbol.keyFor(global) === key` is TAUTOLOGICAL — `global` was just created here by `Symbol.for`, so
    // it says nothing about errors.ts. It is kept only to document what "registered" means. The assertion
    // that actually bites is the next one: the thrown error must carry a property under the symbol looked
    // up from the GLOBAL registry, which a module-local `Symbol('cloudbitmaps.error')` never would.
    expect(Symbol.keyFor(global)).toBe(key);
    expect((err as unknown as Record<symbol, unknown>)[global]).toBe(true);
  });

  it('a foreign copy of the class is still classified — the whole point of a registered brand', () => {
    // Stands in for a second bundled copy of core: a different class object, same registered brand, and
    // `instanceof` against our class is false. The predicate must still say yes.
    class ForeignValidationError extends Error {
      override name = 'ValidationError';
    }
    const foreign = new ForeignValidationError('from another copy');
    // Set through the registry rather than as a class field: a computed class property needs a
    // `unique symbol`, and the point here is precisely that the key is the GLOBAL one, looked up by string.
    Object.defineProperty(foreign, Symbol.for('cloudbitmaps.error'), { value: true });
    expect(foreign instanceof ValidationError).toBe(false);
    expect(isCloudRoaringError(foreign)).toBe(true);
    expect(isValidationError(foreign)).toBe(true);
  });
});
describe('error predicates', () => {
  it('classify each error by kind, and reject other kinds', () => {
    expect(isWriteConflictError(new WriteConflictError('x'))).toBe(true);
    expect(isNotFoundError(new NotFoundError('x'))).toBe(true);
    expect(isIntegrityError(new IntegrityError('x'))).toBe(true);
    expect(isValidationError(new ValidationError('x'))).toBe(true);
    // A different kind is not misclassified.
    expect(isWriteConflictError(new NotFoundError('x'))).toBe(false);
    expect(isValidationError(new IntegrityError('x'))).toBe(false);
  });

  it('isTransientError matches a TransientError, by brand', () => {
    expect(isTransientError(new TransientError('x'))).toBe(true);
    expect(isTransientError(new WriteConflictError('x'))).toBe(false);
  });

  it('isCloudRoaringError matches any of ours and nothing else', () => {
    expect(isCloudRoaringError(new WriteConflictError('x'))).toBe(true);
    expect(isCloudRoaringError(new CloudRoaringError('x'))).toBe(true);
    for (const foreign of [
      new Error('x'),
      new TypeError('x'),
      null,
      undefined,
      'x',
      {},
      { name: 'WriteConflictError' },
    ]) {
      expect(isCloudRoaringError(foreign)).toBe(false);
    }
    // A plain object merely NAMED like our error is not branded → not misclassified.
    expect(isWriteConflictError({ name: 'WriteConflictError' })).toBe(false);
  });
});

describe('the capability, budget and key predicates', () => {
  const brand = Symbol.for('cloudbitmaps.error');
  /** A plain object a foreign copy of the package could throw: branded, with the class's name. */
  const branded = (name: string): Error =>
    Object.defineProperty(Object.assign(new Error('x'), { name }), brand, { value: true });
  const every: Array<[string, (e: unknown) => boolean, new (m: string) => Error]> = [
    ['CapabilityError', isCapabilityError, CapabilityError],
    ['BudgetExceededError', isBudgetExceededError, BudgetExceededError],
    ['KeyUnavailableError', isKeyUnavailableError, KeyUnavailableError],
  ];
  const others: Error[] = [
    new CloudRoaringError('x'),
    new ValidationError('x'),
    new TransientError('x'),
    new WriteConflictError('x'),
    new NotFoundError('x'),
    new IntegrityError('x'),
    ...every.map(([, , Class]) => new Class('x')),
  ];

  it.each(every)('%s is matched for its own class and for no other', (name, predicate, Class) => {
    for (const err of others) expect(predicate(err)).toBe(err instanceof Class);
  });

  it.each(every)(
    '%s is matched for a branded object with its name, across a bundle',
    (name, predicate) => {
      expect(predicate(branded(name))).toBe(true);
      expect(predicate(branded('SomethingElse'))).toBe(false);
    },
  );

  it.each(every)(
    '%s is not matched for an unbranded error with its name, or a non-error',
    (name, predicate) => {
      expect(predicate(Object.assign(new Error('x'), { name }))).toBe(false);
      expect(predicate({ name })).toBe(false);
      for (const value of [null, undefined, 'x', 1]) expect(predicate(value)).toBe(false);
    },
  );
});
