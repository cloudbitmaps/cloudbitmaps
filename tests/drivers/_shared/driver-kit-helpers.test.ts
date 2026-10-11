import {
  TransientError,
  ValidationError,
  concatBytes,
  isTransportFault,
  refuseUnknownOptions,
  requireBool,
  requirePositiveInt,
  toTransient,
} from '@cloudbitmaps/core/driver-kit';

/** The option checks, fault classification and byte helper the driver kit shares with every driver. */
describe('refuseUnknownOptions', () => {
  const KEYS = ['bucket', 'prefix'] as const;

  it('takes a bag of known keys, a spread of one, and an empty one', () => {
    expect(() => refuseUnknownOptions('Store', { bucket: 'b' }, KEYS)).not.toThrow();
    expect(() =>
      refuseUnknownOptions('Store', { ...{ bucket: 'b', prefix: 'p' } }, KEYS),
    ).not.toThrow();
    expect(() => refuseUnknownOptions('Store', {}, KEYS)).not.toThrow();
  });

  it('refuses a value that is not an object, naming what it got', () => {
    for (const [bad, got] of [
      [null, 'null'],
      [undefined, 'undefined'],
      ['b', 'string'],
      [5, 'number'],
    ] as const) {
      expect(() => refuseUnknownOptions('Store', bad, KEYS)).toThrow(
        new ValidationError(`Store needs an options object — got ${got}`),
      );
    }
  });

  it('names every unknown key in order, then the keys it takes, then the hint when there is one', () => {
    expect(() => refuseUnknownOptions('Store', { buckt: 'b', extra: 1 }, KEYS)).toThrow(
      new ValidationError('Store does not take `buckt`, `extra`. It takes `bucket`, `prefix`.'),
    );
    expect(() =>
      refuseUnknownOptions('Store', { client: {} }, KEYS, 'a client goes in `client`'),
    ).toThrow(
      new ValidationError(
        'Store does not take `client`. It takes `bucket`, `prefix`; a client goes in `client`.',
      ),
    );
  });

  it('refuses an unknown key whose value is undefined: a key present is a key given', () => {
    expect(() => refuseUnknownOptions('Store', { bucket: 'b', other: undefined }, KEYS)).toThrow(
      ValidationError,
    );
  });
});

describe('requirePositiveInt', () => {
  it('passes a positive safe integer through, and an absent value as undefined', () => {
    for (const ok of [1, 2, 8 * 1024 * 1024, Number.MAX_SAFE_INTEGER]) {
      expect(requirePositiveInt('partBytes', ok)).toBe(ok);
    }
    expect(requirePositiveInt('partBytes', undefined)).toBeUndefined();
  });

  it('refuses everything else by name with ValidationError, never another error', () => {
    for (const bad of [
      0,
      -0,
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      2 ** 53,
      '8',
      null,
      true,
      {},
      [],
      8n,
      Symbol('eight'),
    ]) {
      expect(() => requirePositiveInt('partBytes', bad), String(bad)).toThrow(ValidationError);
      expect(() => requirePositiveInt('partBytes', bad)).toThrow(
        /^partBytes must be a positive safe integer; got /,
      );
    }
  });

  it('quotes a string, so a "200" is not mistaken for a 200', () => {
    expect(() => requirePositiveInt('maxSockets', '200')).toThrow(
      'maxSockets must be a positive safe integer; got "200"',
    );
    expect(() => requirePositiveInt('maxSockets', -2)).toThrow(
      'maxSockets must be a positive safe integer; got -2',
    );
  });
});

describe('requireBool', () => {
  it('passes a boolean through, and an absent value as undefined', () => {
    expect(requireBool('conditionalDelete', true)).toBe(true);
    expect(requireBool('conditionalDelete', false)).toBe(false);
    expect(requireBool('conditionalDelete', undefined)).toBeUndefined();
  });

  it('refuses everything else by name with ValidationError, a truthy string or a 1 included', () => {
    for (const bad of ['true', 'yes', '', 1, 0, null, {}, Symbol('t')]) {
      expect(() => requireBool('conditionalDelete', bad), String(bad)).toThrow(ValidationError);
      expect(() => requireBool('conditionalDelete', bad)).toThrow(
        /^conditionalDelete must be a boolean; got /,
      );
    }
  });
});

describe('isTransportFault', () => {
  const SHARED = [
    'ECONNRESET',
    'ECONNREFUSED',
    'ECONNABORTED',
    'ETIMEDOUT',
    'ENOTFOUND',
    'EAI_AGAIN',
    'EHOSTUNREACH',
    'ENETUNREACH',
    'EPIPE',
  ];

  it.each(SHARED)('is a transport fault: %s', (code) => {
    expect(isTransportFault(Object.assign(new Error(`connect ${code}`), { code }))).toBe(true);
    expect(isTransportFault({ code })).toBe(true);
  });

  it('is not a fault that would fail the same way again, nor one a driver adds of its own', () => {
    for (const code of [
      'ENOENT',
      'EACCES',
      'EPROTO',
      'CERT_HAS_EXPIRED',
      'ERR_STREAM_PREMATURE_CLOSE',
      'ESOCKETTIMEDOUT',
      'econnreset',
    ]) {
      expect(isTransportFault({ code }), code).toBe(false);
    }
  });

  it('reads only a string code', () => {
    for (const err of [null, undefined, 'ECONNRESET', {}, { code: 503 }, { name: 'ECONNRESET' }]) {
      expect(isTransportFault(err)).toBe(false);
    }
  });
});

describe('toTransient', () => {
  const transient = (err: unknown): boolean => (err as { code?: unknown }).code === 'SLOW';
  const message = (err: unknown): string => `transient Test fault: ${String((err as Error).name)}`;

  it('hands a transient fault on as TransientError, the fault as its cause', () => {
    const fault = Object.assign(new Error('slow down'), { code: 'SLOW', name: 'SlowDown' });
    const out = toTransient(fault, transient, message);
    expect(out).toBeInstanceOf(TransientError);
    expect((out as TransientError).message).toBe('transient Test fault: SlowDown');
    expect((out as TransientError).cause).toBe(fault);
  });

  it('hands any other error back as it is, without asking for a message', () => {
    const fault = Object.assign(new Error('denied'), { code: 'DENIED' });
    let asked = 0;
    const out = toTransient(fault, transient, (err) => {
      asked += 1;
      return message(err);
    });
    expect(out).toBe(fault);
    expect(asked).toBe(0);
  });
});

describe('concatBytes', () => {
  it('joins the parts in order into one buffer of their summed length', () => {
    expect([...concatBytes([Uint8Array.of(1, 2), new Uint8Array(0), Uint8Array.of(3)])]).toEqual([
      1, 2, 3,
    ]);
    expect(concatBytes([]).length).toBe(0);
  });

  it('owns its bytes: a plain Uint8Array that changing a part afterwards does not reach', () => {
    const part = Buffer.from([7, 8, 9]);
    const out = concatBytes([part]);
    part.fill(0);
    expect([...out]).toEqual([7, 8, 9]);
    expect(Object.getPrototypeOf(out)).toBe(Uint8Array.prototype);
  });
});
