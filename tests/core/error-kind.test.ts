import * as errors from '@/core/errors';
import {
  BudgetExceededError,
  CloudRoaringError,
  LeaseExpiredError,
  StaleOperandError,
  TransientError,
  ValidationError,
  errorKind,
  isBudgetExceededError,
  isCapabilityError,
  isCloudRoaringError,
  isIntegrityError,
  isKeyUnavailableError,
  isLeaseExpiredError,
  isLeaseLimitError,
  isNotFoundError,
  isStaleOperandError,
  isTransientError,
  isUnsupportedError,
  isValidationError,
  isWriteConflictError,
} from '@/core/errors';
import type { ErrorKind } from '@/core/errors';

/**
 * `errorKind` classifies by brand and name. This pins the classification LOGIC; the behaviour across the built
 * bundles is guarded by `scripts/smoke.cjs`.
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
    // `instanceof` against our class is false. `errorKind` must still name it.
    class ForeignValidationError extends Error {
      override name = 'ValidationError';
    }
    const foreign = new ForeignValidationError('from another copy');
    // Set through the registry rather than as a class field: a computed class property needs a
    // `unique symbol`, and the point here is precisely that the key is the GLOBAL one, looked up by string.
    Object.defineProperty(foreign, Symbol.for('cloudbitmaps.error'), { value: true });
    expect(foreign instanceof ValidationError).toBe(false);
    expect(errorKind(foreign)).toBe('ValidationError');
  });
});

type ErrorClass = new (...args: never[]) => Error;

/** Every error class the module exports, found from its exports, so a class added later is covered at once. */
const classes = (Object.entries(errors) as Array<[string, unknown]>).filter(
  (entry): entry is [string, ErrorClass] =>
    typeof entry[1] === 'function' && entry[1].prototype instanceof Error,
);

/** One instance of a class, whatever its constructor takes. */
function instanceOf(Class: ErrorClass): Error {
  if (Class === BudgetExceededError) {
    return new BudgetExceededError('x', { option: 'maxBufferedBytes', limit: 1, spent: 2 });
  }
  if (Class === LeaseExpiredError) return new LeaseExpiredError('x', 1, 'expired');
  if (Class === StaleOperandError) return new StaleOperandError('x', 'a', 'moved');
  return new (Class as new (message: string) => Error)('x');
}

/** What each class's old predicate said, to hold `errorKind` to it. */
const predicates: Record<ErrorKind, (e: unknown) => boolean> = {
  CloudRoaringError: isCloudRoaringError,
  ValidationError: isValidationError,
  WriteConflictError: isWriteConflictError,
  IntegrityError: isIntegrityError,
  NotFoundError: isNotFoundError,
  UnsupportedError: isUnsupportedError,
  CapabilityError: isCapabilityError,
  TransientError: isTransientError,
  KeyUnavailableError: isKeyUnavailableError,
  BudgetExceededError: isBudgetExceededError,
  LeaseExpiredError: isLeaseExpiredError,
  LeaseLimitError: isLeaseLimitError,
  StaleOperandError: isStaleOperandError,
};

const brand = Symbol.for('cloudbitmaps.error');
/** What a foreign copy of the package could throw: branded, with the class's name. */
const branded = (name: string): Error =>
  Object.defineProperty(Object.assign(new Error('x'), { name }), brand, { value: true });

describe('errorKind', () => {
  it('finds every error class the module exports', () => {
    expect(classes.length).toBeGreaterThanOrEqual(13);
  });

  it.each(classes)(
    '%s is named by errorKind, and so is a class added without a kind',
    (name, Class) => {
      // A new class not added to the kinds comes back as 'CloudRoaringError', which is not its own name.
      expect(errorKind(instanceOf(Class))).toBe(name);
    },
  );

  it('has a kind for exactly the classes the module exports', () => {
    expect(new Set(classes.map(([name]) => name))).toEqual(new Set(Object.keys(predicates)));
  });

  it.each(classes)('%s: each predicate says what errorKind says', (_name, Class) => {
    const err = instanceOf(Class);
    for (const [kind, predicate] of Object.entries(predicates)) {
      // isCloudRoaringError is true for any of ours; every other predicate names one class.
      const expected =
        kind === 'CloudRoaringError' ? errorKind(err) !== undefined : errorKind(err) === kind;
      expect(predicate(err), `${kind} on ${_name}`).toBe(expected);
    }
  });

  it.each([
    ['a branded clone', branded('ValidationError'), 'ValidationError'],
    ['a branded clone of an unknown name', branded('SomethingElse'), 'CloudRoaringError'],
    [
      'an application subclass of ValidationError',
      new (class Refused extends ValidationError {})('x'),
      'CloudRoaringError',
    ],
    [
      'an application subclass of CloudRoaringError',
      new (class Mine extends CloudRoaringError {})('x'),
      'CloudRoaringError',
    ],
    [
      'an application subclass of TransientError',
      new (class Slow extends TransientError {})('x'),
      'TransientError',
    ],
  ] as const)('%s', (_what, err, kind) => {
    expect(errorKind(err)).toBe(kind);
    expect(predicates[kind](err)).toBe(true);
  });

  it.each([
    [
      'an unbranded clone with an error name',
      Object.assign(new Error('x'), { name: 'ValidationError' }),
    ],
    ['a plain object with an error name', { name: 'ValidationError' }],
    ['an Error', new Error('x')],
    ['a TypeError', new TypeError('x')],
    ['null', null],
    ['undefined', undefined],
    ['a string', 'x'],
    ['a number', 1],
    ['an empty object', {}],
  ])('%s has no kind', (_what, value) => {
    expect(errorKind(value)).toBeUndefined();
    for (const predicate of Object.values(predicates)) expect(predicate(value)).toBe(false);
  });

  it('classifies a branded clone whose name is not a string as a CloudRoaringError', () => {
    const odd = Object.defineProperty({ name: 7 }, brand, { value: true });
    expect(errorKind(odd)).toBe('CloudRoaringError');
    expect(isCloudRoaringError(odd)).toBe(true);
  });
});
