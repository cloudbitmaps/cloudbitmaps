import { types } from 'node:util';
import { NoSuchKey, S3ServiceException } from '@aws-sdk/client-s3';
import { ValidationError, isValidationError } from '@cloudbitmaps/core/driver-kit';
import { scrubCredentials } from '@/s3/scrub-error';

// Every credential-looking value is built at run time, so the leak scan never reads one in this file.
const VALUE = ['placeholder', 'session', 'value'].join('-');
const TOKEN = ['stand', 'in', 'session', 'token', '0123456789'].join('-');
const SIG = 'ab01'.repeat(16);
const KEY_ID = ['STAND', 'IN', 'KEYID'].join('');
const AUTH = [
  'AWS4-HMAC-SHA256 ',
  `Credential=${KEY_ID}/20261016/us-east-1/s3/aws4_request, `,
  'SignedHeaders=host;x-amz-date;x-amz-security-token, ',
  `Signature=${SIG}`,
].join('');
const hex = (text: string): string =>
  [...Buffer.from(text)].map((b) => b.toString(16).padStart(2, '0')).join(' ');

/** What a socket holds of the request the SDK sent: the signed header and the session token. */
const rawRequest = (): Record<string, unknown> => ({
  _header: `GET /b/k HTTP/1.1\r\nauthorization: ${AUTH}\r\nx-amz-security-token: ${TOKEN}\r\n\r\n`,
  rawHeaders: ['x-amz-security-token', TOKEN, 'host', 'h'],
});

type Sdk = S3ServiceException & Record<string, unknown>;
/** An error shaped as the SDK raises one: the response on a hidden, read-only property, the body's fields on the error. */
function sdkError(fields: Record<string, unknown> = {}): Sdk {
  const err = new NoSuchKey({
    message: 'The specified key does not exist.',
    $metadata: { httpStatusCode: 404, requestId: 'r1', attempts: 1, totalRetryDelay: 0 },
  }) as Sdk;
  Object.assign(err, { Code: 'NoSuchKey', RequestId: 'r1', ...fields });
  Object.defineProperty(err, '$response', {
    value: { statusCode: 404, headers: { 'x-amz-request-id': 'r1' }, body: { req: rawRequest() } },
    writable: false,
    configurable: false,
  });
  return err;
}

/** Every object reachable from `root`: own properties of any kind, map and set entries, in a set. */
function objectsIn(root: unknown): Set<object> {
  const found = new Set<object>();
  const visit = (value: unknown): void => {
    if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return;
    if (found.has(value)) return;
    found.add(value);
    if (value instanceof Map) {
      for (const [k, v] of value) {
        visit(k);
        visit(v);
      }
    }
    if (value instanceof Set) for (const v of value) visit(v);
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      visit(descriptor?.value);
      visit(descriptor?.get);
    }
  };
  visit(root);
  return found;
}

/** Every string reachable from `root`, keys included. */
function stringsIn(root: unknown): string[] {
  const strings: string[] = [];
  for (const value of objectsIn(root)) {
    if (value instanceof Map) for (const [k, v] of value) strings.push(String(k), String(v));
    if (value instanceof Set) for (const v of value) strings.push(String(v));
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key === 'string') strings.push(key);
      const held = Object.getOwnPropertyDescriptor(value, key)?.value as unknown;
      if (typeof held === 'string') strings.push(held);
    }
  }
  return strings;
}

/** Whether the copy holds an object of the original's: then the original, or a part of it, is reachable raw. */
const sharesAnObject = (original: unknown, copy: unknown): boolean => {
  const before = objectsIn(original);
  return [...objectsIn(copy)].some((value) => before.has(value) && typeof value !== 'function');
};

const leaks = (value: unknown): string[] =>
  stringsIn(value).filter(
    (text) =>
      text.includes(TOKEN) ||
      text.includes(SIG) ||
      text.includes(VALUE) ||
      text.includes(hex(TOKEN)),
  );

describe('S3 scrubCredentials', () => {
  it('copies an SDK error: the transport goes, the fields classification reads stay', () => {
    const err = sdkError();
    const out = scrubCredentials(err);
    expect(out).not.toBe(err);
    expect(Object.getPrototypeOf(out)).toBe(Object.getPrototypeOf(err));
    expect(out).toBeInstanceOf(NoSuchKey);
    expect(out).toBeInstanceOf(S3ServiceException);
    expect(out.name).toBe('NoSuchKey');
    expect(out.message).toBe('The specified key does not exist.');
    expect(out.stack).toBe(err.stack);
    expect(out.$fault).toBe('client');
    expect(out.$metadata).toEqual(err.$metadata);
    expect(out.$metadata).not.toBe(err.$metadata);
    expect(out['Code']).toBe('NoSuchKey');
    expect(out['RequestId']).toBe('r1');
    expect('$response' in out).toBe(false);
    expect(leaks(out)).toEqual([]);
  });

  it('the copy is a native error with the original prototype', () => {
    const out = scrubCredentials(sdkError());
    expect(types.isNativeError(out)).toBe(true);
    expect(Object.prototype.toString.call(out)).toBe('[object Error]');
    expect(String(out)).toBe('NoSuchKey: The specified key does not exist.');
    expect(Object.getPrototypeOf(structuredClone(out))).toBe(Error.prototype);
  });

  it('never changes the live error, its plain data or its transport', () => {
    const err = sdkError({ Detail: { note: `x-amz-security-token: ${TOKEN}` } });
    const response = err['$response'] as { body: { req: Record<string, unknown> } };
    const request = response.body.req;
    const header = request['_header'];
    const metadata = err.$metadata;
    scrubCredentials(err);
    expect(err['$response']).toBe(response);
    expect(response.body.req).toBe(request);
    expect(request['_header']).toBe(header);
    expect(request['rawHeaders']).toEqual(['x-amz-security-token', TOKEN, 'host', 'h']);
    expect(err.$metadata).toBe(metadata);
    // The copy is deep: what the live error's field holds is the original text, not the redacted one.
    expect(err['Detail']).toEqual({ note: `x-amz-security-token: ${TOKEN}` });
  });

  it('returns an error with no transport as it is, and anything else untouched', () => {
    const plain = new Error('plain');
    expect(scrubCredentials(plain)).toBe(plain);
    expect(scrubCredentials('text')).toBe('text');
    expect(scrubCredentials(undefined)).toBeUndefined();
    const typed = new ValidationError('the S3 bucket does not exist: b');
    expect(scrubCredentials(typed)).toBe(typed);
    class Other {
      readonly request = rawRequest();
    }
    const other = new Other();
    expect(scrubCredentials(other)).toBe(other);
  });

  it('returns an error that holds neither a transport nor a credential as it is', () => {
    const err = Object.assign(new Error('refused'), {
      name: 'Refused',
      $metadata: { httpStatusCode: 403 },
      $retryable: { throttling: true },
    });
    expect(scrubCredentials(err)).toBe(err);
  });

  it('copies a credential-bearing error that has no transport, and leaves the live one alone', () => {
    const err = Object.assign(new Error(`refused ${AUTH}`), {
      detail: { list: ['Cookie', VALUE] },
    });
    const out = scrubCredentials(err);
    expect(out).not.toBe(err);
    expect(leaks(out)).toEqual([]);
    expect(err.message).toContain(SIG);
    expect(err.detail.list).toEqual(['Cookie', VALUE]);
  });

  it('copies a typed error whose text quotes a credential, and it stays classifiable', () => {
    const err = new ValidationError(`no segment x-amz-security-token=${TOKEN}`);
    const out = scrubCredentials(err);
    expect(out).not.toBe(err);
    expect(isValidationError(out)).toBe(true);
    expect(out).toBeInstanceOf(ValidationError);
    expect(out.message).toBe('no segment x-amz-security-token=[redacted]');
  });

  it('is idempotent: a copy scrubbed again is returned as it is', () => {
    const once = scrubCredentials(sdkError({ SignatureProvided: SIG }));
    expect(scrubCredentials(once)).toBe(once);
  });

  it('redacts what S3 quotes of a request whose signature it refused, and keeps the rest', () => {
    const canonical = `GET\n/b/k\n\nhost:h\nx-amz-security-token:${TOKEN}\n\nhost;x-amz-security-token\nUNSIGNED-PAYLOAD`;
    const toSign = 'AWS4-HMAC-SHA256\n20261016T120000Z\n20261016/us-east-1/s3/aws4_request\nabc';
    const err = sdkError({
      Code: 'SignatureDoesNotMatch',
      AWSAccessKeyId: KEY_ID,
      StringToSign: toSign,
      SignatureProvided: SIG,
      StringToSignBytes: hex(toSign),
      CanonicalRequest: canonical,
      CanonicalRequestBytes: hex(canonical),
    });
    const out = scrubCredentials(err);
    expect(leaks(out)).toEqual([]);
    expect(out['SignatureProvided']).toBe('[redacted]');
    expect(out['CanonicalRequest']).toBe('[redacted]');
    expect(out['CanonicalRequestBytes']).toBe('[redacted]');
    expect(out['StringToSign']).toBe(toSign);
    expect(out['StringToSignBytes']).toBe(hex(toSign));
    expect(out['AWSAccessKeyId']).toBe(KEY_ID);
    expect(out['Code']).toBe('SignatureDoesNotMatch');
  });

  it('drops the unparsed body the SDK keeps as text', () => {
    const err = sdkError({ $responseBodyText: `{"x-amz-security-token":"${TOKEN}"}` });
    const out = scrubCredentials(err);
    expect('$responseBodyText' in out).toBe(false);
    expect(err['$responseBodyText']).toContain(TOKEN);
  });

  it('copies the cause chain and survives a cycle in plain data', () => {
    const outer = Object.assign(new Error('outer'), { cause: sdkError() });
    const loop: Record<string, unknown> = { statusCode: 1 };
    loop['self'] = loop;
    Object.assign(outer, { loop });
    const out = scrubCredentials(outer) as Error & { loop: Record<string, unknown> };
    const cause = out.cause as Sdk;
    expect(cause).not.toBe(outer.cause);
    expect('$response' in cause).toBe(false);
    expect(cause.$metadata.httpStatusCode).toBe(404);
    expect(out.loop['self']).toBe(out.loop);
    expect(sharesAnObject(outer, out)).toBe(false);
  });

  describe('a cause chain', () => {
    const chainOf = (links: number): Error => {
      let err: Error = sdkError();
      for (let i = 0; i < links; i++) err = Object.assign(new Error(`link ${i}`), { cause: err });
      return err;
    };
    /** Whether the raw transport of the innermost error is reachable by walking `cause`. */
    const reachesRaw = (err: unknown): boolean => {
      const seen = new Set<unknown>();
      for (let e = err; typeof e === 'object' && e !== null && !seen.has(e);) {
        seen.add(e);
        if ('$response' in e) return true;
        e = (e as { cause?: unknown }).cause;
      }
      return false;
    };

    it.each([5, 6, 7, 9, 10, 11, 12, 20, 30])(
      'keeps no raw object from a chain of %i links',
      (links) => {
        const err = chainOf(links);
        expect(reachesRaw(err)).toBe(true);
        const out = scrubCredentials(err);
        expect(out).not.toBe(err);
        expect(reachesRaw(out)).toBe(false);
        expect(sharesAnObject(err, out)).toBe(false);
        expect(leaks(out)).toEqual([]);
      },
    );

    it('keeps the links above the depth limit, each a native copy', () => {
      const out = scrubCredentials(chainOf(30));
      let e: unknown = out;
      for (let i = 29; i >= 25; i--) {
        expect(types.isNativeError(e)).toBe(true);
        expect((e as Error).message).toBe(`link ${i}`);
        e = (e as Error).cause;
      }
    });

    it('keeps no raw cause on a cycle, and the copy keeps the cycle', () => {
      const a = sdkError();
      const b = Object.assign(new Error('b'), { cause: a });
      (a as { cause?: unknown }).cause = b;
      const out = scrubCredentials(a) as unknown as { cause: { cause: unknown } };
      expect(out).not.toBe(a);
      expect(out.cause.cause).toBe(out);
      expect(out.cause).not.toBe(b);
      expect(reachesRaw(out)).toBe(false);
      expect(sharesAnObject(a, out)).toBe(false);
    });

    it('keeps no raw cause on a self-cycle', () => {
      const a = sdkError();
      (a as { cause?: unknown }).cause = a;
      const out = scrubCredentials(a);
      expect(out.cause).toBe(out);
      expect(sharesAnObject(a, out)).toBe(false);
    });

    it('copies a cycle entered from an error that holds nothing', () => {
      const clean = new Error('clean');
      const raw = Object.assign(sdkError(), { cause: clean });
      (clean as { cause?: unknown }).cause = raw;
      const out = scrubCredentials(clean);
      expect(out).not.toBe(clean);
      expect(sharesAnObject(clean, out)).toBe(false);
    });

    it('drops an SDK error nested in plain data below the depth limit', () => {
      let holder: Record<string, unknown> = { err: sdkError() };
      for (let i = 0; i < 15; i++) holder = { inner: holder };
      const err = Object.assign(new Error('deep'), { holder });
      const out = scrubCredentials(err);
      expect(out).not.toBe(err);
      expect(sharesAnObject(err, out)).toBe(false);
      expect(leaks(out)).toEqual([]);
    });
  });

  it('copies and scrubs errors nested in an array (AggregateError.errors)', () => {
    const agg = new AggregateError([sdkError(), new Error('plain')], 'many');
    const out = scrubCredentials(agg);
    expect(out).not.toBe(agg);
    expect(out).toBeInstanceOf(AggregateError);
    expect(types.isNativeError(out)).toBe(true);
    const [first, second] = out.errors as Error[];
    expect('$response' in (first as object)).toBe(false);
    expect(second?.message).toBe('plain');
    expect('$response' in (agg.errors[0] as object)).toBe(true);
    expect(sharesAnObject(agg, out)).toBe(false);
  });

  it('drops a function or accessor, a string-keyed one included', () => {
    const err = sdkError();
    const response = err['$response'];
    Object.defineProperty(err, 'toJSON', { value: () => response, enumerable: true });
    Object.defineProperty(err, 'peek', { get: () => response, enumerable: true });
    const out = scrubCredentials(err) as unknown as Record<string, unknown>;
    expect('toJSON' in out).toBe(false);
    expect('peek' in out).toBe(false);
    expect(leaks(out)).toEqual([]);
  });

  it('drops a symbol-keyed function', () => {
    const err = sdkError();
    const hook = Symbol('inspect');
    Object.defineProperty(err, hook, { value: () => err['$response'], enumerable: false });
    const out = scrubCredentials(err);
    expect(Object.getOwnPropertySymbols(out)).toEqual([]);
  });

  it('copies an error that has only a function on it, without the function', () => {
    const response = { body: { req: rawRequest() } };
    const err = Object.assign(new Error('x'), { toJSON: () => response });
    const out = scrubCredentials(err);
    expect(out).not.toBe(err);
    expect('toJSON' in out).toBe(false);
  });

  it('drops a class instance other than an error, such as a stream or a buffer', () => {
    const err = sdkError({ Body: Buffer.from(TOKEN), stream: new (class Stream {})() });
    const out = scrubCredentials(err);
    expect('Body' in out).toBe(false);
    expect('stream' in out).toBe(false);
  });

  it('copies maps, sets and plain data nested in a field', () => {
    const err = sdkError({
      detail: {
        map: new Map([
          ['x-amz-security-token', TOKEN],
          ['note', `see x-amz-security-token=${TOKEN}`],
        ]),
        set: new Set([`Signature=${SIG}`]),
      },
    });
    const out = scrubCredentials(err);
    const { map, set } = out['detail'] as { map: Map<string, string>; set: Set<string> };
    expect(map.get('x-amz-security-token')).toBe('[redacted]');
    expect(map.get('note')).toBe('see x-amz-security-token=[redacted]');
    expect([...set]).toEqual(['Signature=[redacted]']);
    const live = err['detail'] as { map: Map<string, string> };
    expect(live.map.get('x-amz-security-token')).toBe(TOKEN);
  });

  it('copies a list, a map or a set with a named property of its own, without that property', () => {
    const list = Object.assign(['a'], { request: rawRequest() });
    const map = Object.assign(new Map([['a', 1]]), { request: rawRequest() });
    const set = Object.assign(new Set(['a']), { request: rawRequest() });
    for (const held of [list, map, set]) {
      const err = Object.assign(new Error('x'), { held });
      const out = scrubCredentials(err);
      expect(out).not.toBe(err);
      expect(Object.keys(out.held as object)).not.toContain('request');
      expect(leaks(out)).toEqual([]);
    }
  });

  it('redacts a key that quotes a credential', () => {
    const err = Object.assign(new Error('x'), { [`x-amz-security-token: ${TOKEN}`]: 1 });
    const out = scrubCredentials(err);
    expect(Object.keys(out)).toEqual(['x-amz-security-token: [redacted]']);
  });

  it('keeps a DOMException readable in a copy', () => {
    const abort = new DOMException('This operation was aborted', 'AbortError');
    const err = Object.assign(sdkError(), { cause: abort });
    const out = scrubCredentials(err);
    const copy = out.cause as DOMException;
    expect(copy).not.toBe(abort);
    expect(copy.name).toBe('AbortError');
    expect(copy.message).toBe('This operation was aborted');
    expect(copy.code).toBe(abort.code);
    expect(String(copy)).toBe('AbortError: This operation was aborted');
  });

  it('survives a getter that throws, and a frozen error', () => {
    const err = sdkError();
    Object.defineProperty(err, 'boom', {
      get: () => {
        throw new Error('no');
      },
      enumerable: true,
    });
    Object.freeze(err);
    const out = scrubCredentials(err);
    expect('boom' in out).toBe(false);
    expect(out.name).toBe('NoSuchKey');
  });

  it('survives a cycle and leaves other values alone', () => {
    const err: Record<string, unknown> = { note: 'fine', code: 'X' };
    err['self'] = err;
    expect(scrubCredentials(err)).toBe(err);
  });

  describe('credential key names', () => {
    it.each([
      'authorization',
      'Proxy-Authorization',
      'cookie',
      'set-cookie',
      'x-api-key',
      'x-amz-security-token',
      'X-Amz-S3session-Token',
      'x-amz-credential',
      'X-Amz-Signature',
      'x-amz-server-side-encryption-customer-key',
      'x-amz-copy-source-server-side-encryption-customer-key',
      'SSECustomerKey',
      'CopySourceSSECustomerKey',
      'secretAccessKey',
      'sessionToken',
      'SignatureProvided',
      'CanonicalRequest',
      'CanonicalRequestBytes',
    ])('redacts the value under %s', (name) => {
      const err = sdkError({ detail: { [name]: VALUE, keep: 'visible' } });
      const out = scrubCredentials(err);
      expect(out['detail']).toEqual({ [name]: '[redacted]', keep: 'visible' });
    });

    it.each([
      'x-amz-server-side-encryption-customer-key-MD5',
      'accessKeyId',
      'StringToSign',
      'x-amz-date',
      'RequestId',
    ])('keeps the value under %s', (name) => {
      const err = sdkError({ detail: { [name]: 'visible' } });
      expect(scrubCredentials(err)['detail']).toEqual({ [name]: 'visible' });
    });

    it('redacts the value after a credential name in a flat header list', () => {
      const err = sdkError({
        detail: { rawHeaders: ['host', 'h', 'X-Amz-Security-Token', VALUE, 'accept', '*/*'] },
      });
      const out = scrubCredentials(err);
      expect(out['detail']).toEqual({
        rawHeaders: ['host', 'h', 'X-Amz-Security-Token', '[redacted]', 'accept', '*/*'],
      });
    });

    it('redacts a credential header held under a symbol key', () => {
      const key = Symbol('headers');
      const holder = { [key]: { 'x-amz-security-token': ['x-amz-security-token', VALUE] } };
      const out = scrubCredentials(holder);
      expect(out).not.toBe(holder);
      expect(out[key]).toEqual({ 'x-amz-security-token': '[redacted]' });
      expect(holder[key]['x-amz-security-token']).toEqual(['x-amz-security-token', VALUE]);
    });
  });

  describe('credential text', () => {
    /** Each form a credential takes in text, with the part that must not survive. */
    const forms: [string, string, string][] = [
      ['an Authorization header line', `Authorization: ${AUTH}\r\nhost: h`, SIG],
      ['a session token header line', `host: h\nx-amz-security-token: ${TOKEN}\n`, TOKEN],
      ['a directory bucket session header line', `x-amz-s3session-token: ${TOKEN}`, TOKEN],
      ['an SSE-C key header line', `x-amz-server-side-encryption-customer-key: ${TOKEN}`, TOKEN],
      ['an Authorization value inside a line', `<body> inline ${AUTH}</body>`, SIG],
      ['a lowercase signature', `got authorization ${AUTH.toLowerCase()}`, SIG],
      ['a presigned url', `https://b.s3.amazonaws.com/k?X-Amz-Signature=${SIG}&X-Amz-Date=1`, SIG],
      [
        'a presigned url, percent-encoded',
        `https://p/?u=${encodeURIComponent(`https://h/k?X-Amz-Signature=${SIG}&X-Amz-Expires=60`)}`,
        SIG,
      ],
      ['a session token in a url', `https://h/k?X-Amz-Security-Token=${TOKEN}&a=1`, TOKEN],
      [
        'a session token in a url, percent-encoded',
        `https://p/?u=${encodeURIComponent(`https://h/k?X-Amz-Security-Token=${TOKEN}`)}`,
        TOKEN,
      ],
      [
        'a signature in a url inside a url',
        `https://p/?u=${encodeURIComponent(`https://h/k?Signature=${SIG}`)}`,
        SIG,
      ],
      ['a session token in json', `{"x-amz-security-token":"${TOKEN}","host":"h"}`, TOKEN],
      ['a session token in quoted json', `{'x-amz-security-token': '${TOKEN}'}`, TOKEN],
      ['a session token inside a line', `got x-amz-security-token: ${TOKEN} back`, TOKEN],
    ];
    const lookAlikes = [
      'The request signature we calculated does not match the signature you provided. Check your key and signing method.',
      'The provided token has expired.',
      "Unsupported header 'x-amz-security-token' received for this API call.",
      'SignedHeaders=host;x-amz-date;x-amz-security-token',
      'AWS4-HMAC-SHA256\n20261016T120000Z\n20261016/us-east-1/s3/aws4_request\nabc',
      'Signature=abc design',
      'x-amz-server-side-encryption-customer-key-MD5: abc',
      'The specified key does not exist.',
    ];
    const through = (text: string): string => scrubCredentials(sdkError({ message: text })).message;

    it.each(forms)('redacts %s', (_name, text, secret) => {
      const out = through(text);
      expect(out).not.toContain(secret);
      expect(out).toContain('[redacted]');
    });

    it('keeps the rest of an Authorization value around a redacted signature', () => {
      expect(through(`inline ${AUTH} end`)).toBe(`inline ${AUTH.replace(SIG, '[redacted]')} end`);
    });

    it('keeps the rest of a url around a redacted token', () => {
      expect(through(`https://h/k?X-Amz-Security-Token=${TOKEN}&a=1`)).toBe(
        'https://h/k?X-Amz-Security-Token=[redacted]&a=1',
      );
    });

    it.each(lookAlikes)('leaves %s alone', (text) => {
      expect(through(text)).toBe(text);
    });

    it('leaves an error with only a look-alike as it is', () => {
      const err = new Error('The provided token has expired.');
      expect(scrubCredentials(err)).toBe(err);
    });

    it('redacts the stack as the message', () => {
      const err = Object.assign(new Error(`got ${AUTH}`), { $response: {} });
      const out = scrubCredentials(err);
      expect(String(out.stack)).not.toContain(SIG);
      expect(String(err.stack)).toContain(SIG);
    });

    it('replaces a text too large for its patterns whole, and still classifies', () => {
      const huge = ['Signature', '='].join('') + 'a'.repeat(16 * 2 ** 20);
      const out = scrubCredentials(sdkError({ message: huge }));
      expect(out.message).toBe('[redacted]');
      expect(out).toBeInstanceOf(NoSuchKey);
      expect(out.name).toBe('NoSuchKey');
      expect(out.$metadata.httpStatusCode).toBe(404);
    });
  });
});
