import { types } from 'node:util';
import { RestError } from '@azure/storage-blob';
import { scrubCredentials } from '@/azure-blob/scrub-error';

const SIGNED = 'SharedKey acct:SIGNATUREVALUE=';
const URL_WITH_SIG = 'https://acct.blob.core.windows.net/c/b?sv=2022-11-02&sig=SECRETSIG%3D&se=1';

/** An error shaped as the SDK's `RestError`: the request and response on hidden properties. */
type Rest = Error & { request: object; response: object; details: unknown };
function restError(): Rest {
  const request = { url: URL_WITH_SIG, headers: new Map([['authorization', SIGNED]]) };
  const err = Object.assign(new Error(`refused ${URL_WITH_SIG}`), {
    name: 'RestError',
    code: 'AuthenticationFailed',
    statusCode: 403,
    details: { errorCode: 'AuthenticationFailed', raw: `Authorization: ${SIGNED}\r\nhost: h` },
  });
  Object.defineProperty(err, 'request', { value: request, enumerable: false });
  Object.defineProperty(err, 'response', {
    value: { status: 403, request },
    enumerable: false,
  });
  return err as unknown as Rest;
}

describe('scrubCredentials (Azure)', () => {
  it('copies a RestError: the transport goes, the fields classification reads stay', () => {
    const err = restError();
    const out = scrubCredentials(err) as unknown as Record<string, unknown>;
    expect(out).not.toBe(err);
    expect(Object.getPrototypeOf(out)).toBe(Object.getPrototypeOf(err));
    expect(out['name']).toBe('RestError');
    expect(out['code']).toBe('AuthenticationFailed');
    expect(out['statusCode']).toBe(403);
    expect(String(out['stack'])).toContain('refused');
    expect('request' in out).toBe(false);
    expect('response' in out).toBe(false);
    expect((out['details'] as { errorCode: string }).errorCode).toBe('AuthenticationFailed');
    expect((out['details'] as { raw: string }).raw).toContain('host: h');
  });

  it('redacts a SAS signature and an Authorization value from message, stack and details', () => {
    const out = scrubCredentials(restError());
    const text = [out.message, out.stack, JSON.stringify(out.details)].join('\n');
    expect(text).not.toContain('SECRETSIG');
    expect(text).not.toContain('SIGNATUREVALUE');
    expect(out.message).toContain('sig=[redacted]');
    expect(out.message).toContain('se=1');
  });

  it('never changes the live error or its request', () => {
    const err = restError();
    const request = err.request as { url: string; headers: Map<string, string> };
    scrubCredentials(err);
    expect(err.request).toBe(request);
    expect(request.headers.get('authorization')).toBe(SIGNED);
    expect(request.url).toBe(URL_WITH_SIG);
    expect(err.message).toContain('SECRETSIG');
    // The copy is deep: what the live error's `details` holds is the original text, not the redacted one.
    expect((err.details as { raw: string }).raw).toBe(`Authorization: ${SIGNED}\r\nhost: h`);
    expect(err.stack).toContain('SECRETSIG');
  });

  it('copies the cause chain and survives a cycle', () => {
    const outer = Object.assign(new Error('outer'), { cause: restError() });
    const loop: Record<string, unknown> = { statusCode: 1 };
    loop['self'] = loop;
    Object.assign(outer, { loop });
    const out = scrubCredentials(outer);
    const cause = out.cause as unknown as Record<string, unknown>;
    expect(cause).not.toBe(outer.cause);
    expect('request' in cause).toBe(false);
    expect(cause['statusCode']).toBe(403);
    expect(String((cause as unknown as Error).message)).not.toContain('SECRETSIG');
  });

  it('returns an error with no transport as it is, and anything else untouched', () => {
    const plain = new Error('plain');
    expect(scrubCredentials(plain)).toBe(plain);
    expect(scrubCredentials('text')).toBe('text');
    expect(scrubCredentials(undefined)).toBeUndefined();
  });

  it('returns an error that holds neither a transport nor a credential as it is', () => {
    const err = Object.assign(new Error('refused'), { details: { errorCode: 'Refused' } });
    expect(scrubCredentials(err)).toBe(err);
  });

  it('copies a credential-bearing error that has no transport, and leaves the live one alone', () => {
    const err = Object.assign(new Error('x'), { details: { note: `url ${URL_WITH_SIG}` } });
    const out = scrubCredentials(err);
    expect(out).not.toBe(err);
    expect(JSON.stringify(out.details)).not.toContain('SECRETSIG');
    expect(JSON.stringify(err.details)).toContain('SECRETSIG');
  });

  it('the copy is a native error with the original prototype', () => {
    const err = new RestError('refused', { statusCode: 403, code: 'AuthenticationFailed' });
    Object.defineProperty(err, 'request', { value: { url: URL_WITH_SIG }, enumerable: false });
    const out = scrubCredentials(err);
    expect(out).not.toBe(err);
    expect(types.isNativeError(out)).toBe(true);
    expect(out).toBeInstanceOf(RestError);
    expect(Object.prototype.toString.call(out)).toBe('[object Error]');
    expect(out.message).toBe('refused');
    expect(String(out.stack)).toContain('refused');
    expect(out.statusCode).toBe(403);
    expect(out.code).toBe('AuthenticationFailed');
  });

  describe('a cause chain', () => {
    const chainOf = (links: number): Error => {
      let err: Error = restError();
      for (let i = 0; i < links; i++) err = Object.assign(new Error(`link ${i}`), { cause: err });
      return err;
    };
    /** Whether the raw transport of the innermost error is reachable by walking `cause`. */
    const reachesRaw = (err: unknown): boolean => {
      const seen = new Set<unknown>();
      for (let e = err; typeof e === 'object' && e !== null && !seen.has(e);) {
        seen.add(e);
        if ('request' in e) return true;
        e = (e as { cause?: unknown }).cause;
      }
      return false;
    };

    it('keeps no raw cause past the depth limit', () => {
      const err = chainOf(30);
      expect(reachesRaw(err)).toBe(true);
      expect(reachesRaw(scrubCredentials(err))).toBe(false);
    });

    it('keeps no raw cause on a cycle, and the copy keeps the cycle', () => {
      const a = restError();
      const b = Object.assign(new Error('b'), { cause: a });
      (a as { cause?: unknown }).cause = b;
      const out = scrubCredentials(a) as unknown as { cause: { cause: unknown } };
      expect(out).not.toBe(a);
      expect(out.cause.cause).toBe(out);
      expect(reachesRaw(out)).toBe(false);
      expect(out.cause).not.toBe(b);
    });
  });

  it('copies and scrubs errors nested in an array (AggregateError.errors)', () => {
    const agg = new AggregateError([restError(), new Error('plain')], 'many');
    const out = scrubCredentials(agg);
    expect(out).not.toBe(agg);
    expect(out).toBeInstanceOf(AggregateError);
    const [first, second] = out.errors as Error[];
    expect('request' in (first as object)).toBe(false);
    expect(first?.message).not.toContain('SECRETSIG');
    expect(second?.message).toBe('plain');
    expect('request' in (agg.errors[0] as object)).toBe(true);
  });

  it('drops a function or accessor, a string-keyed one included', () => {
    const err = restError();
    const request = err.request;
    Object.defineProperty(err, 'toJSON', { value: () => request, enumerable: true });
    Object.defineProperty(err, 'peek', { get: () => request, enumerable: true });
    const out = scrubCredentials(err) as unknown as Record<string, unknown>;
    expect('toJSON' in out).toBe(false);
    expect('peek' in out).toBe(false);
    expect(JSON.stringify(out)).not.toContain('SECRETSIG');
  });

  it('drops a symbol-keyed function', () => {
    const err = restError();
    const hook = Symbol('inspect');
    Object.defineProperty(err, hook, { value: () => err.request, enumerable: false });
    const out = scrubCredentials(err);
    expect(Object.getOwnPropertySymbols(out)).toEqual([]);
  });

  it('copies maps, sets and plain data nested in details', () => {
    const err = restError();
    err.details = {
      map: new Map([
        ['authorization', 'x'],
        ['note', URL_WITH_SIG],
      ]),
      set: new Set([URL_WITH_SIG]),
    };
    const out = scrubCredentials(err);
    const { map, set } = out.details as { map: Map<string, string>; set: Set<string> };
    expect(map.get('authorization')).toBe('[redacted]');
    expect(map.get('note')).not.toContain('SECRETSIG');
    expect([...set].join()).not.toContain('SECRETSIG');
    expect((err.details as { map: Map<string, string> }).map.get('authorization')).toBe('x');
  });

  describe('credential key names', () => {
    it.each([
      'authorization',
      'Proxy-Authorization',
      'cookie',
      'signature',
      'x-ms-encryption-key',
      'x-identity-header',
      'sig',
    ])('redacts the value under %s', (name) => {
      const err = restError();
      err.details = { [name]: 'SECRETVALUE', keep: 'visible' };
      const out = scrubCredentials(err);
      expect(out.details).toEqual({ [name]: '[redacted]', keep: 'visible' });
    });

    it('redacts the value after a credential name in a flat header list', () => {
      const err = restError();
      err.details = { rawHeaders: ['host', 'h', 'Authorization', 'SECRETVALUE', 'accept', '*/*'] };
      const out = scrubCredentials(err);
      expect(out.details).toEqual({
        rawHeaders: ['host', 'h', 'Authorization', '[redacted]', 'accept', '*/*'],
      });
    });
  });

  describe('credential text', () => {
    const SIG = 'AAAAbbbbCCCCdddd%2BeeFF%3D';
    /** Each form a credential takes in text, with the part that must not survive. */
    const forms: [string, string, string][] = [
      ['sig first in a query', `https://h/c?sig=${SIG}&sv=1`, SIG],
      ['sig in the middle', `https://h/c?sv=1&sig=${SIG}&se=2`, SIG],
      ['sig last, capitalised', `https://h/c?sv=1&Sig=${SIG}`, SIG],
      ['html-escaped ampersand', `<a href="https://h/c?sv=1&amp;sig=${SIG}">`, 'AAAAbbbbCCCC'],
      [
        'url inside a query, percent-encoded',
        `https://p/?u=${encodeURIComponent('https://h/c?sv=1&sig=AAAAbbbbCCCC+/=&se=2')}`,
        'AAAAbbbbCCCC',
      ],
      [
        'url inside a query, sig first',
        `https://p/?u=${encodeURIComponent('https://h/c?sig=AAAAbbbb&sv=1')}`,
        'AAAAbbbb',
      ],
      ['sig at the start of the text', `sig=${SIG}&sv=1`, SIG],
      ['sig after a comma', `q:sv=1,sig=${SIG}`, SIG],
      [
        'json-escaped ampersand',
        `{"u":"https://h/c?sv=1\\u0026sig=${SIG}\\u0026se=2"}`,
        'AAAAbbbbCCCC',
      ],
      ['quoted value', `sig="${SIG}"`, SIG],
      [
        'SharedKey value',
        'Authorization: SharedKey acct:SIGSIGSIGSIGSIGSIGSIGSIGSIG=',
        'SIGSIGSIGSIG',
      ],
      [
        'lowercase bearer',
        ['x=', 'bear', 'er STANDINTOKENVALUE0123456789'].join(''),
        'STANDINTOKENVALUE',
      ],
      [
        'the MAC signature Azure echoes',
        "The MAC signature found in the HTTP request 'AAA+/x=' is not the same as any computed signature.",
        'AAA+/x=',
      ],
    ];
    const lookAlikes = [
      'Bearer token authentication is not permitted for non-TLS protected (non-https) URLs.',
      'Signature did not match. String to sign used was r',
      'signature=abc design',
      'x_sig=keep',
      'The specified blob does not exist.',
    ];
    const through = (text: string): string => scrubCredentials(restErrorWith(text)).message;
    function restErrorWith(text: string): Error {
      return Object.assign(restError(), { message: text });
    }

    it.each(forms)('redacts %s', (_name, text, secret) => {
      const out = through(text);
      expect(out).not.toContain(secret);
      expect(out).toContain('[redacted]');
    });

    it('keeps the rest of a url around a redacted signature', () => {
      expect(through(`https://h/c?sv=1&sig=${SIG}&se=2`)).toBe(
        'https://h/c?sv=1&sig=[redacted]&se=2',
      );
    });

    it.each(lookAlikes)('leaves %s alone', (text) => {
      expect(through(text)).toBe(text);
    });

    it('leaves an error with only a look-alike as it is', () => {
      const err = new Error('Bearer token authentication is not permitted for non-https URLs.');
      expect(scrubCredentials(err)).toBe(err);
    });
  });
});
