import { PassThrough } from 'node:stream';
import { types } from 'node:util';
import { createRequire } from 'node:module';
import { ApiError } from '@google-cloud/storage';
import { TransientError, ValidationError, isTransientError } from '@cloudbitmaps/core/driver-kit';
import { scrubCredentials } from '@/gcs/scrub-error';
import { isMissingBucket, isTransient } from '@/gcs/gcs-errors';
import { ReadTimedOut } from '@/gcs/read-timeout';

// Every credential-looking value is built at run time, so the leak scan never reads one in this file.
const TOKEN = ['ya29', 'stand-in-access-token-0123456789'].join('.');
const VALUE = ['placeholder', 'credential', 'value'].join('-');
const AUTHORIZATION = ['Author', 'ization'].join('');
const BEARER_WORD = ['Bear', 'er'].join('');
const BEARER = `${BEARER_WORD} ${TOKEN}`;
const BASIC = ['Ba', 'sic'].join('');
const KEY = Buffer.alloc(32, 7).toString('base64');
const SIG = 'ab01'.repeat(32);
const PEM_BODY = ['MIIEvQIBADANBgkqhkiG9w0BAQEFAASC', 'BKcwggSjAgEAAoIBAQC7'].join('');
const PEM_LINE = (edge: string, kind = ''): string =>
  `-----${edge} ${kind}${['PRIVATE', 'KEY'].join(' ')}-----`;
const PEM_BEGIN = PEM_LINE('BEGIN');
const PEM_END = PEM_LINE('END');
const PEM = [PEM_BEGIN, PEM_BODY, PEM_END, ''].join('\n');
const SA_EMAIL = ['sa', 'p.iam.gserviceaccount.com'].join('@');
const b64u = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');
const JWT = [
  b64u({ alg: 'RS256', typ: 'JWT' }),
  b64u({ iss: SA_EMAIL }),
  Buffer.from('stand-in-signature-0123456789').toString('base64url'),
].join('.');

const nodeRequire = createRequire(import.meta.url);
const { GaxiosError } = nodeRequire(
  nodeRequire.resolve('gaxios', { paths: [nodeRequire.resolve('@google-cloud/storage')] }),
) as { GaxiosError: new (message: string, config: object, response?: object) => Error };

/** What the HTTP layer keeps of the request it sent: its headers, and an agent whose socket holds the raw text. */
const liveRequest = (): Record<string, unknown> => ({
  headers: { [AUTHORIZATION]: BEARER, 'x-goog-api-client': 'gl-node' },
  agent: {
    sockets: {
      h: [{ _httpMessage: { _header: `GET /o HTTP/1.1\r\n${AUTHORIZATION}: ${BEARER}\r\n` } }],
    },
  },
  href: 'https://storage.googleapis.com/storage/v1/b/b/o',
});

/** The response an `ApiError` holds: the response stream itself, with the status and the request laid on it. */
function streamResponse(status: number): PassThrough {
  return Object.assign(new PassThrough(), {
    statusCode: status,
    statusMessage: 'Service Unavailable',
    request: liveRequest(),
    headers: { 'content-type': 'application/json' },
    body: '{}',
    toJSON: () => ({ headers: {} }),
  });
}

type Sdk = ApiError & Record<string, unknown>;
/** An error shaped as the SDK raises one for a JSON API call: the code and errors from the body, the live response. */
function apiError(code = 503, fields: Record<string, unknown> = {}): Sdk {
  const errors = [{ message: 'backend', domain: 'global', reason: 'backendError' }];
  const response = streamResponse(code) as never;
  const err = new ApiError({ code, message: 'backend', errors, response }) as Sdk;
  return Object.assign(err, fields);
}

/** An error shaped as gaxios raises one for a resumable upload: the request's config, and a response that holds it. */
function gaxiosError(status = 503): Error & Record<string, unknown> {
  const config = {
    url: 'https://storage.googleapis.com/upload',
    headers: { [AUTHORIZATION]: BEARER },
  };
  return new GaxiosError('Request failed with status code 503', config, {
    config,
    data: { error: { code: status } },
    headers: {},
    status,
    statusText: 'Service Unavailable',
    request: { responseURL: config.url },
  }) as Error & Record<string, unknown>;
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

const SECRETS = [TOKEN, VALUE, KEY, SIG, PEM_BODY, JWT];
const leaks = (value: unknown): string[] =>
  stringsIn(value).filter((text) => SECRETS.some((secret) => text.includes(secret)));

describe('GCS scrubCredentials', () => {
  it('copies an ApiError: the transport goes, the fields classification reads stay', () => {
    const err = apiError(503);
    const live = err.response;
    const out = scrubCredentials(err);
    expect(out).not.toBe(err);
    expect(Object.getPrototypeOf(out)).toBe(ApiError.prototype);
    expect(out).toBeInstanceOf(ApiError);
    expect(out.message).toBe('backend');
    expect(out.stack).toBe(err.stack);
    expect(out.code).toBe(503);
    expect(out.errors).toEqual([{ message: 'backend', domain: 'global', reason: 'backendError' }]);
    expect(out.errors).not.toBe(err.errors);
    expect(out.response).toEqual({ statusCode: 503, statusMessage: 'Service Unavailable' });
    expect(leaks(out)).toEqual([]);
    expect(err.response).toBe(live);
  });

  it('copies a GaxiosError: config goes, the status and the response status stay, and so does instanceof', () => {
    const err = gaxiosError(412);
    const out = scrubCredentials(err);
    expect(out).not.toBe(err);
    expect(out).toBeInstanceOf(GaxiosError);
    expect('config' in out).toBe(false);
    expect(out['status']).toBe(412);
    expect(out['response']).toEqual({ status: 412, statusText: 'Service Unavailable' });
    expect(leaks(out)).toEqual([]);
    expect(leaks(err)).not.toEqual([]);
  });

  it('reads a response status a getter holds, and keeps nothing else of the response', () => {
    class FetchLike {
      readonly request = liveRequest();
      get status(): number {
        return 429;
      }
      get statusText(): string {
        return 'Too Many Requests';
      }
    }
    const err = Object.assign(new Error('throttled'), { response: new FetchLike() });
    const out = scrubCredentials(err);
    expect(out.response).toEqual({ status: 429, statusText: 'Too Many Requests' });
    expect(leaks(out)).toEqual([]);
  });

  it('the copy is a native error with the original prototype', () => {
    const out = scrubCredentials(apiError());
    expect(types.isNativeError(out)).toBe(true);
    expect(Object.prototype.toString.call(out)).toBe('[object Error]');
    expect(String(out)).toBe('Error: backend');
    expect(Object.getPrototypeOf(structuredClone(out))).toBe(Error.prototype);
  });

  it('never changes the live error, its plain data or its transport', () => {
    const err = apiError(503, {
      detail: { note: `${AUTHORIZATION}: ${BEARER}` },
      headers: { list: [AUTHORIZATION, BEARER], map: new Map([[AUTHORIZATION, BEARER]]) },
      auth: { [AUTHORIZATION]: BEARER, client_secret: VALUE },
      pair: { name: AUTHORIZATION, value: BEARER },
    });
    const response = err.response as unknown as { request: Record<string, unknown> };
    const request = response.request;
    const headers = request['headers'];
    const errors = err.errors;
    scrubCredentials(err);
    expect(err.response).toBe(response);
    expect(response.request).toBe(request);
    expect(request['headers']).toBe(headers);
    expect(request['headers']).toEqual({ [AUTHORIZATION]: BEARER, 'x-goog-api-client': 'gl-node' });
    expect(err.errors).toBe(errors);
    expect(err['detail']).toEqual({ note: `${AUTHORIZATION}: ${BEARER}` });
    expect(err['headers']).toEqual({
      list: [AUTHORIZATION, BEARER],
      map: new Map([[AUTHORIZATION, BEARER]]),
    });
    expect(err['auth']).toEqual({ [AUTHORIZATION]: BEARER, client_secret: VALUE });
    expect(err['pair']).toEqual({ name: AUTHORIZATION, value: BEARER });
  });

  it.each(['request', 'agent', 'socket', '_httpMessage', 'connection', 'req', 'res', 'config'])(
    'leaves out %s, whatever it holds',
    (key) => {
      const err = Object.assign(new Error('x'), { [key]: { note: VALUE }, kept: 'k' });
      const out = scrubCredentials(err) as Error & Record<string, unknown>;
      expect(out).not.toBe(err);
      expect(key in out).toBe(false);
      expect(out['kept']).toBe('k');
      expect(leaks(out)).toEqual([]);
    },
  );

  it('returns an error with no transport and no credential as it is, and anything else untouched', () => {
    const plain = Object.assign(new Error('permanent'), { code: 'ENOENT' });
    expect(scrubCredentials(plain)).toBe(plain);
    expect(scrubCredentials('text')).toBe('text');
    expect(scrubCredentials(null)).toBe(null);
    expect(scrubCredentials(undefined)).toBeUndefined();
    const typed = new ValidationError('the GCS bucket does not exist: b');
    expect(scrubCredentials(typed)).toBe(typed);
    class Other {
      readonly request = liveRequest();
    }
    const other = new Other();
    expect(scrubCredentials(other)).toBe(other);
  });

  it('copies a credential-bearing error that has no transport, and leaves the live one alone', () => {
    const err = Object.assign(new Error(`refused\n${AUTHORIZATION}: ${BEARER}`), {
      detail: { list: [AUTHORIZATION, VALUE] },
    });
    const out = scrubCredentials(err);
    expect(out).not.toBe(err);
    expect(leaks(out)).toEqual([]);
    expect(err.message).toContain(TOKEN);
    expect(err.detail.list).toEqual([AUTHORIZATION, VALUE]);
  });

  it('copies a typed error of the driver whose cause holds a transport, and it stays what it was', () => {
    const transient = new TransientError('transient GCS fault: 503', { cause: apiError(503) });
    const out = scrubCredentials(transient);
    expect(out).not.toBe(transient);
    expect(isTransientError(out)).toBe(true);
    expect(out).toBeInstanceOf(TransientError);
    expect(leaks(out)).toEqual([]);
    const timedOut = new ReadTimedOut('tail read of s.1', 50, apiError(503));
    const copy = scrubCredentials(timedOut);
    expect(copy).not.toBe(timedOut);
    expect(copy).toBeInstanceOf(ReadTimedOut);
    expect(copy.code).toBe('ETIMEDOUT');
    expect(leaks(copy)).toEqual([]);
  });

  it('is idempotent: a copy scrubbed again is returned as it is', () => {
    for (const err of [apiError(), gaxiosError()]) {
      const once = scrubCredentials(err);
      expect(scrubCredentials(once)).toBe(once);
    }
  });

  describe('a cause chain', () => {
    const chainOf = (links: number): Error => {
      let err: Error = apiError();
      for (let i = 0; i < links; i++) err = Object.assign(new Error(`link ${i}`), { cause: err });
      return err;
    };
    /** Whether the live response of the innermost error is reachable by walking `cause`. */
    const reachesRaw = (err: unknown): boolean => {
      const seen = new Set<unknown>();
      for (let e = err; typeof e === 'object' && e !== null && !seen.has(e);) {
        seen.add(e);
        if ((e as { response?: unknown }).response instanceof PassThrough) return true;
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

    it('copies a chain of 20,000 links without running out of stack', () => {
      const err = chainOf(20_000);
      const out = scrubCredentials(err);
      expect(out).not.toBe(err);
      expect(out.message).toBe('link 19999');
      expect(reachesRaw(out)).toBe(false);
    });

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
      const a = apiError();
      const b = Object.assign(new Error('b'), { cause: a });
      (a as { cause?: unknown }).cause = b;
      const out = scrubCredentials(a) as unknown as { cause: { cause: unknown } };
      expect(out).not.toBe(a);
      expect(out.cause.cause).toBe(out);
      expect(out.cause).not.toBe(b);
      expect(sharesAnObject(a, out)).toBe(false);
    });

    it('keeps no raw cause on a self-cycle', () => {
      const a = apiError();
      (a as { cause?: unknown }).cause = a;
      const out = scrubCredentials(a);
      expect(out.cause).toBe(out);
      expect(sharesAnObject(a, out)).toBe(false);
    });

    it('copies a cycle entered from an error that holds nothing', () => {
      const clean = new Error('clean');
      const raw = Object.assign(apiError(), { cause: clean });
      (clean as { cause?: unknown }).cause = raw;
      const out = scrubCredentials(clean);
      expect(out).not.toBe(clean);
      expect(sharesAnObject(clean, out)).toBe(false);
    });

    it('drops an SDK error nested in plain data below the depth limit', () => {
      let holder: Record<string, unknown> = { err: apiError() };
      for (let i = 0; i < 15; i++) holder = { inner: holder };
      const err = Object.assign(new Error('deep'), { holder });
      const out = scrubCredentials(err);
      expect(out).not.toBe(err);
      expect(sharesAnObject(err, out)).toBe(false);
      expect(leaks(out)).toEqual([]);
    });
  });

  it('copies and scrubs errors nested in an array (AggregateError.errors)', () => {
    const agg = new AggregateError([apiError(), gaxiosError(), new Error('plain')], 'many');
    const out = scrubCredentials(agg);
    expect(out).not.toBe(agg);
    expect(out).toBeInstanceOf(AggregateError);
    expect(types.isNativeError(out)).toBe(true);
    const [first, second, third] = out.errors as Array<Record<string, unknown>>;
    expect(first?.['response']).toEqual({ statusCode: 503, statusMessage: 'Service Unavailable' });
    expect('config' in (second as object)).toBe(false);
    expect(third?.['message']).toBe('plain');
    expect(sharesAnObject(agg, out)).toBe(false);
    expect(leaks(out)).toEqual([]);
  });

  it('drops a function or accessor, a string-keyed one included', () => {
    const err = apiError();
    const response = err.response;
    Object.defineProperty(err, 'toJSON', { value: () => response, enumerable: true });
    Object.defineProperty(err, 'peek', { get: () => response, enumerable: true });
    const out = scrubCredentials(err) as unknown as Record<string, unknown>;
    expect('toJSON' in out).toBe(false);
    expect('peek' in out).toBe(false);
    expect(leaks(out)).toEqual([]);
  });

  it('drops a symbol-keyed function', () => {
    const err = apiError();
    const hook = Symbol('inspect');
    Object.defineProperty(err, hook, { value: () => err.response, enumerable: false });
    const out = scrubCredentials(err);
    expect(Object.getOwnPropertySymbols(out)).toEqual([]);
  });

  it('copies an error that has only a function on it, without the function', () => {
    const request = liveRequest();
    const err = Object.assign(new Error('x'), { toJSON: () => request });
    const out = scrubCredentials(err);
    expect(out).not.toBe(err);
    expect('toJSON' in out).toBe(false);
  });

  it('drops a class instance other than an error, such as a stream or a buffer', () => {
    const err = apiError(503, { body: Buffer.from(TOKEN), stream: new PassThrough() });
    const out = scrubCredentials(err);
    expect('body' in out).toBe(false);
    expect('stream' in out).toBe(false);
  });

  it('copies maps, sets and plain data nested in a field', () => {
    const err = apiError(503, {
      detail: {
        map: new Map([
          [AUTHORIZATION, BEARER],
          ['note', 'kept'],
        ]),
        set: new Set(['kept']),
      },
    });
    const out = scrubCredentials(err);
    const { map, set } = out['detail'] as { map: Map<string, string>; set: Set<string> };
    expect(map.get(AUTHORIZATION)).toBe('[redacted]');
    expect(map.get('note')).toBe('kept');
    expect([...set]).toEqual(['kept']);
    const live = err['detail'] as { map: Map<string, string> };
    expect(live.map.get(AUTHORIZATION)).toBe(BEARER);
  });

  it('copies a list, a map or a set with a named property of its own, without that property', () => {
    const list = Object.assign(['a'], { request: liveRequest() });
    const map = Object.assign(new Map([['a', 1]]), { request: liveRequest() });
    const set = Object.assign(new Set(['a']), { request: liveRequest() });
    for (const held of [list, map, set]) {
      const err = Object.assign(new Error('x'), { held });
      const out = scrubCredentials(err);
      expect(out).not.toBe(err);
      expect(Object.keys(out.held as object)).not.toContain('request');
      expect(leaks(out)).toEqual([]);
    }
  });

  it('copies a sparse list with as many named properties as holes, without them', () => {
    // eslint-disable-next-line no-sparse-arrays
    const list = Object.assign([, 'a'], { held: { authorization: VALUE } });
    const err = Object.assign(new Error('x'), { list });
    const out = scrubCredentials(err);
    expect(out).not.toBe(err);
    expect(Object.keys(out.list)).not.toContain('held');
    expect(leaks(out)).toEqual([]);
  });

  it('copies a sparse list as sparse, reading only the indexes it holds', () => {
    const list: unknown[] = [];
    list[2 ** 31] = 'last';
    list[0] = AUTHORIZATION;
    list[1] = VALUE;
    const err = Object.assign(apiError(), { list });
    const out = scrubCredentials(err);
    const copy = out['list'] as unknown[];
    expect(copy.length).toBe(2 ** 31 + 1);
    expect(Object.keys(copy)).toEqual(['0', '1', String(2 ** 31)]);
    expect(copy[1]).toBe('[redacted]');
    expect(copy[2 ** 31]).toBe('last');
  });

  it('redacts the value after a credential name in a flat header list, and not after a hole', () => {
    const err = apiError(503, {
      detail: { rawHeaders: ['host', 'h', AUTHORIZATION, BEARER, 'accept', '*/*'] },
    });
    expect(scrubCredentials(err)['detail']).toEqual({
      rawHeaders: ['host', 'h', AUTHORIZATION, '[redacted]', 'accept', '*/*'],
    });
    // eslint-disable-next-line no-sparse-arrays
    const holed = apiError(503, { detail: [AUTHORIZATION, , 'kept'] });
    expect((scrubCredentials(holed)['detail'] as unknown[])[2]).toBe('kept');
  });

  it('redacts a key that quotes a credential', () => {
    const err = Object.assign(new Error('x'), { [`${AUTHORIZATION}: ${BEARER}`]: 1 });
    const out = scrubCredentials(err);
    expect(Object.keys(out)).toEqual([`${AUTHORIZATION}: [redacted]`]);
  });

  it('keeps a DOMException readable in a copy', () => {
    const abort = new DOMException('This operation was aborted', 'AbortError');
    const err = Object.assign(apiError(), { cause: abort });
    const out = scrubCredentials(err);
    const copy = out.cause as DOMException;
    expect(copy).not.toBe(abort);
    expect(copy.name).toBe('AbortError');
    expect(copy.message).toBe('This operation was aborted');
    expect(copy.code).toBe(abort.code);
    expect(String(copy)).toBe('AbortError: This operation was aborted');
  });

  it('survives a getter that throws, and a frozen error', () => {
    const err = apiError();
    Object.defineProperty(err, 'boom', {
      get: () => {
        throw new Error('no');
      },
      enumerable: true,
    });
    Object.freeze(err);
    const out = scrubCredentials(err);
    expect('boom' in out).toBe(false);
    expect(out.code).toBe(503);
  });

  it('survives a cycle in plain data and leaves it alone when it holds nothing', () => {
    const err: Record<string, unknown> = { note: 'fine', code: 'X' };
    err['self'] = err;
    expect(scrubCredentials(err)).toBe(err);
  });

  describe('a credential name beside its value in a record', () => {
    const ENC = ['x-goog', 'encryption', 'key'].join('-');
    /** A page that lists the request headers as a table, as a parser would hand it on. */
    const table = (rows: [string, unknown][]): Record<string, unknown> => ({
      table: { tr: rows.map(([th, td]) => ({ th, td })) },
    });

    it('redacts the value cell of a header table row, and keeps the other rows', () => {
      const err = apiError(502, {
        body: table([
          ['host', 'h'],
          [AUTHORIZATION, BEARER],
          [` ${ENC}: `, { '#text': KEY, class: 'v' }],
        ]),
      });
      const out = scrubCredentials(err);
      expect(out['body']).toEqual(
        table([
          ['host', 'h'],
          [AUTHORIZATION, '[redacted]'],
          [` ${ENC}: `, '[redacted]'],
        ]),
      );
      expect(leaks(out)).toEqual([]);
      expect(leaks(err)).not.toEqual([]);
    });

    it('redacts the value of a name and value pair', () => {
      const err = apiError(503, {
        headers: [
          { name: 'Cookie', value: VALUE },
          { name: ENC, value: KEY },
          { name: 'x-goog-generation', value: '5' },
        ],
      });
      expect(scrubCredentials(err)['headers']).toEqual([
        { name: 'Cookie', value: '[redacted]' },
        { name: ENC, value: '[redacted]' },
        { name: 'x-goog-generation', value: '5' },
      ]);
    });

    it('keeps a Google error item that names the header it refused, and what classification reads of it', () => {
      const item = {
        message: 'Invalid Credentials',
        domain: 'global',
        reason: 'authError',
        locationType: 'header',
        location: AUTHORIZATION,
      };
      const out = scrubCredentials(apiError(401, { errors: [item] }));
      expect(out.errors).toEqual([item]);
      const missing = {
        message: 'The specified bucket does not exist.',
        reason: 'notFound',
        location: 'token',
      };
      const notFound = scrubCredentials(apiError(404, { message: 'x', errors: [missing] }));
      expect(notFound.errors).toEqual([missing]);
      expect(isMissingBucket(notFound)).toBe(true);
    });

    it('keeps the status of a response whose text spells a credential name', () => {
      const err = Object.assign(new Error('x'), { response: { status: 503, statusText: 'token' } });
      expect(isTransient(err)).toBe(true);
      const out = scrubCredentials(Object.assign(err, { request: liveRequest() }));
      expect(out.response).toEqual({ status: 503, statusText: 'token' });
      expect(isTransient(out)).toBe(true);
    });

    it('keeps the code and message of an error whose code spells a credential name', () => {
      const err = apiError(503, { code: 'token', message: 'cookie' });
      const out = scrubCredentials(err);
      expect(out.code).toBe('token');
      expect(out.message).toBe('cookie');
    });

    it.each([ENC, AUTHORIZATION, 'refresh_token'])(
      'redacts the ...Value beside a ...Name of %s on an error, and keeps what classification reads',
      (name) => {
        const err = apiError(400, {
          HeaderName: name,
          HeaderValue: VALUE,
          reason: 'invalid',
          detail: 'kept',
        });
        const out = scrubCredentials(err);
        expect(out.errors).toEqual(err.errors);
        expect(out.response).toEqual({ statusCode: 400, statusMessage: 'Service Unavailable' });
        expect(out['detail']).toBe('kept');
        expect(out['HeaderValue']).toBe('[redacted]');
        expect(out['HeaderName']).toBe(name);
        expect(out.code).toBe(400);
        expect(out.message).toBe('backend');
        expect(out['reason']).toBe('invalid');
      },
    );

    it('keeps a value beside a name that is not a credential', () => {
      const err = apiError(503, { HeaderName: 'x-goog-generation', HeaderValue: '5' });
      expect(scrubCredentials(err)['HeaderValue']).toBe('5');
    });

    it('keeps the fields of a record that names no credential', () => {
      const err = new Error('x') as Error & Record<string, unknown>;
      Object.assign(err, { body: table([['host', 'h']]), meta: { name: 'request', value: 'v' } });
      expect(scrubCredentials(err)).toBe(err);
    });
  });

  describe('credential text', () => {
    const ENC = ['x-goog', 'encryption', 'key'].join('-');
    /** Each form a credential takes in text, with the part that must not survive. */
    const forms: [string, string, string][] = [
      ['an Authorization header line', `${AUTHORIZATION}: ${BEARER}\r\nhost: h`, TOKEN],
      [
        'a header line on a later line',
        `GET /o HTTP/1.1\r\nhost: h\r\n${AUTHORIZATION}: ${BEARER}\r\n`,
        TOKEN,
      ],
      [
        'a proxy credential on a later line',
        `host: h\r\nproxy-${AUTHORIZATION}: ${BASIC} ${VALUE}`,
        VALUE,
      ],
      ['a cookie on a later line', `host: h\r\ncookie: s=${VALUE}\r\n`, VALUE],
      ['a cookie inside a line', `got cookie: a=1; s=${VALUE}; b=2 back`, VALUE],
      ['a cookie in json', `{"headers":{"cookie":"a=1; s=${VALUE}","host":"h"}}`, VALUE],
      [
        'a cookie in json inside json',
        JSON.stringify({ body: `{"cookie":"a=1; s=${VALUE}"}` }),
        VALUE,
      ],
      ['an encryption key header line', `${ENC}: ${KEY}`, KEY],
      [
        'a bearer token inside a line',
        `<p>upstream refused ${AUTHORIZATION} ${BEARER} for /o</p>`,
        TOKEN,
      ],
      ['a bearer token, lower case', `got ${BEARER.toLowerCase()} back`, TOKEN.toLowerCase()],
      ['a bearer token, percent-encoded', `u=${encodeURIComponent(BEARER)}`, TOKEN],
      ['an opaque bearer token inside a line', `refused ${BEARER_WORD} ${VALUE} for /o`, VALUE],
      [
        'an opaque bearer token, lower case',
        `got ${BEARER_WORD.toLowerCase()} ${VALUE} back`,
        VALUE,
      ],
      [
        'an opaque bearer token, percent-encoded',
        `u=${encodeURIComponent(`${BEARER_WORD} ${VALUE}`)}&v=1`,
        VALUE,
      ],
      ['an access token alone', `token ${TOKEN} back`, TOKEN],
      ['an Authorization value inside a line', `x ${AUTHORIZATION}: ${BASIC} ${VALUE} y`, VALUE],
      [
        'an Authorization value in json',
        `{"headers":{"${AUTHORIZATION}":"${BASIC} ${VALUE}"}}`,
        VALUE,
      ],
      [
        'an Authorization value in json inside json',
        JSON.stringify({ body: `{"${AUTHORIZATION}":"${BASIC} ${VALUE}"}` }),
        VALUE,
      ],
      ['an encryption key inside a line', `got ${ENC}: ${KEY} back`, KEY],
      ['an encryption key in json', `{"${ENC}":"${KEY}"}`, KEY],
      [
        'an encryption key in json inside json',
        JSON.stringify({ body: `{"${ENC}":"${KEY}"}` }),
        KEY,
      ],
      ['an access token in a url', `https://h/o?access_token=${VALUE}&a=1`, VALUE],
      [
        'a refresh token and client secret in a form',
        `refresh_token=${VALUE}&client_secret=${KEY}`,
        KEY,
      ],
      ['a refresh token in a form', `refresh_token=${VALUE}&client_id=1`, VALUE],
      [
        'a V4 signed url',
        `https://storage.googleapis.com/b/k?X-Goog-Signature=${SIG}&X-Goog-Date=1`,
        SIG,
      ],
      [
        'a V4 signed url, percent-encoded',
        `https://p/?u=${encodeURIComponent(`https://h/k?X-Goog-Expires=60&X-Goog-Signature=${SIG}`)}`,
        SIG,
      ],
      [
        'a V2 signed url',
        `https://h/b/k?GoogleAccessId=sa&Expires=1&Signature=${encodeURIComponent(KEY)}`,
        KEY,
      ],
      ['a signed url credential', `?X-Goog-Credential=${VALUE}%2F20261017&X-Goog-Date=1`, VALUE],
      ['a JWT', `assertion=${JWT}`, JWT],
      ['a JWT alone', `got ${JWT} back`, JWT],
      ['a private key', `key ${PEM}`, PEM_BODY],
      [
        'a private key in json',
        JSON.stringify({ private_key: PEM, client_email: 'sa@p' }),
        PEM_BODY,
      ],
      ['a private key with no end', `${PEM_LINE('BEGIN', 'RSA ')}\n${PEM_BODY}`, PEM_BODY],
      ['a header table row', `<tr><th>${ENC}</th><td>${KEY}</td></tr>`, KEY],
      [
        'a header table row, in code',
        `<th><code>${ENC}</code></th><td><code>${KEY}</code></td>`,
        KEY,
      ],
      ['a definition list', `<dl><dt>${AUTHORIZATION}:</dt><dd>${BASIC} ${VALUE}</dd></dl>`, VALUE],
      ['an element named for a credential', `<${ENC}>${KEY}</${ENC}>`, KEY],
      [
        'a canonical request a service quotes back',
        `<Error><CanonicalRequest>GET\n/b/k\n\n${ENC}:${KEY}\nhost:h</CanonicalRequest></Error>`,
        KEY,
      ],
    ];
    const lookAlikes = [
      'Invalid Credentials',
      'Anonymous caller does not have storage.objects.get access to the Google Cloud Storage object.',
      'The specified bucket does not exist.',
      'No such object: b/s.1',
      'Request failed with status code 503',
      'Bearer token authentication is not permitted for non-TLS protected (non-https) URLs.',
      'Request is missing required authentication credential. Expected OAuth 2 access token.',
      'The request signature we calculated does not match the signature you provided.',
      'Signature=abc design',
      'x-goog-encryption-key-sha256: abc',
      'X-Goog-SignedHeaders=host;x-goog-date',
      `${'page'}Token=${'abc123def456'}ghi789jkl`,
      'invalid_grant',
      'The provided encryption key is incorrect.',
      `client_email: ${SA_EMAIL}`,
      'GOOG4-RSA-SHA256\n20261017T000000Z\n20261017/auto/storage/goog4_request\nabc',
      '<tr><th>host</th><td>storage.googleapis.com</td></tr>',
      '<tr><th>cookie</th><td> </td></tr>',
      [
        '-----BEGIN CERTIFICATE-----',
        'MIIBszCCAVmgAwIBAgIUStandIn',
        '-----END CERTIFICATE-----',
      ].join('\n'),
      `-----BEGIN ${['PUBLIC', 'KEY'].join(' ')}-----\nMFkwEwYHKoZIzj0CAQYIStandIn\n-----END PUBLIC KEY-----`,
      '<StringToSign>GOOG4-HMAC-SHA256</StringToSign>',
      'request to http://127.0.0.1:1/storage/v1/b/b/o?prefix=p failed, reason: socket hang up',
      'At least one of the pre-conditions you specified did not hold.',
      'Multiple errors occurred during the request. Please see the `errors` array for complete details.\n',
    ];
    const through = (text: string): string =>
      scrubCredentials(apiError(503, { message: text })).message;

    it.each(forms)('redacts %s', (_name, text, secret) => {
      const out = through(text);
      expect(out).not.toContain(secret);
      expect(out).toContain('[redacted]');
      // What is left is already clean: the copy's text is a fixed point.
      expect(through(out)).toBe(out);
    });

    it.each(lookAlikes)('leaves %s alone', (text) => {
      expect(through(text)).toBe(text);
    });

    describe('a header table or list after another element', () => {
      const API_KEY = ['AIza', 'Sy', 'StandIn', '0123456789abcdefghijklmn'].join('');
      /** Credential rows first, none of them a bearer token, which the bearer rule redacts in any layout. */
      const headers: [string, string][] = [
        ['cookie', `sid=${VALUE}`],
        ['x-goog-api-key', API_KEY],
        [ENC, KEY],
        ['host', 'h'],
      ];
      const rows = headers
        .map(([name, value]) => `<tr><th>${name}</th><td>${value}</td></tr>`)
        .join('');
      const items = headers.map(([name, value]) => `<dt>${name}</dt><dd>${value}</dd>`).join('');
      it.each([
        [
          'a short heading before the table',
          `<html><body><h1>Request headers</h1><table>${rows}</table></body></html>`,
        ],
        ['a caption', `<table><caption>Headers</caption>${rows}</table>`],
        ['a heading before a definition list', `<h2>Headers</h2><dl>${items}</dl>`],
        [
          'two short elements before the table',
          `<title>502</title><h1>Bad Gateway</h1><table>${rows}</table>`,
        ],
        ['the table alone', `<table>${rows}</table>`],
      ])('redacts every credential cell after %s', (_name, page) => {
        const out = through(page);
        for (const secret of [VALUE, API_KEY, KEY]) expect(out).not.toContain(secret);
        expect(out).toMatch(/host<\/(?:th|dt)><(?:td|dd)>h</);
        expect(through(out)).toBe(out);
      });
    });

    it('redacts a whole credential header line, its value spaces and all', () => {
      for (const name of [ENC, 'x-goog-api-key', 'cookie']) {
        expect(through(`host: h\r\n${name}: ${VALUE} ${VALUE}\r\naccept: */*`)).toBe(
          `host: h\r\n${name}: [redacted]\r\naccept: */*`,
        );
      }
    });

    it('keeps the rest of a line around a redacted value', () => {
      expect(through(`https://h/o?access_token=${VALUE}&a=1`)).toBe(
        'https://h/o?access_token=[redacted]&a=1',
      );
      expect(through(`refused ${BEARER} for /o`)).toBe('refused Bearer [redacted] for /o');
      expect(through(`x ${AUTHORIZATION}: ${BASIC} ${VALUE} y`)).toBe(
        `x ${AUTHORIZATION}: [redacted] y`,
      );
      expect(
        through(`<tr><th>${ENC}</th><td>${KEY}</td></tr><tr><th>host</th><td>h</td></tr>`),
      ).toBe(`<tr><th>${ENC}</th><td>[redacted]</td></tr><tr><th>host</th><td>h</td></tr>`);
      expect(through(JSON.stringify({ private_key: PEM, client_email: 'sa@p' }))).toBe(
        JSON.stringify({
          private_key: `${PEM_BEGIN}[redacted]${PEM_END}\n`,
          client_email: 'sa@p',
        }),
      );
    });

    it('leaves an error with only a look-alike as it is', () => {
      const err = new Error('Bearer token authentication is not permitted');
      expect(scrubCredentials(err)).toBe(err);
    });

    it('redacts the stack as the message, and the errors a body lists', () => {
      const err = apiError(400, { message: `bad ${BEARER}` });
      Object.defineProperty(err, 'stack', {
        value: `Error: bad ${BEARER}\n    at x`,
        configurable: true,
      });
      err.errors = [{ message: `bad ${BEARER}`, reason: 'invalid' }] as never;
      const out = scrubCredentials(err);
      expect(String(out.stack)).not.toContain(TOKEN);
      expect(String(err.stack)).toContain(TOKEN);
      expect(out.errors).toEqual([{ message: 'bad Bearer [redacted]', reason: 'invalid' }]);
    });

    it('a resumable upload that failed keeps the body it quotes, redacted', () => {
      const err = Object.assign(new Error('Upload failed'), {
        name: 'Upload failed',
        code: 502,
        errors: [`<html><p>refused ${BEARER}</p></html>`],
      });
      const out = scrubCredentials(err);
      expect(out).not.toBe(err);
      expect(out.errors).toEqual(['<html><p>refused Bearer [redacted]</p></html>']);
      expect(out.code).toBe(502);
    });

    it('redacts a credential of 16 MiB in place, and the error still classifies', () => {
      // Every step runs in linear time and in constant stack on these, so none is cut short and nothing is lost.
      const huge = 'a'.repeat(16 * 2 ** 20);
      const MiB = 2 ** 20;
      const cases: [string, string][] = [
        [`refused Bearer ${huge} end`, 'refused Bearer [redacted] end'],
        [`?Signature=${huge}&x=1`, '?Signature=[redacted]&x=1'],
        [`token ya29.${huge} end`, 'token [redacted] end'],
        [`${PEM_BEGIN}${huge}${PEM_END}`, `${PEM_BEGIN}[redacted]${PEM_END}`],
        [`x-goog-encryption-key=${huge} end`, 'x-goog-encryption-key=[redacted] end'],
        // A run that a pattern with an alternation in its loop would read one step at a time, on the engine's stack.
        [`${PEM_BEGIN}${'-a'.repeat(8 * MiB)}`, `${PEM_BEGIN}[redacted]`],
        [`?Signature=${'%25'.repeat(Math.floor((16 * MiB) / 3))} end`, '?Signature=[redacted] end'],
        [`?Signature=${'%2B'.repeat(16)}%26x=1`, '?Signature=[redacted]%26x=1'],
      ];
      for (const [text, redacted] of cases) {
        const out = scrubCredentials(apiError(503, { message: text }));
        expect(out.message).toBe(redacted);
        expect(out.code).toBe(503);
      }
      for (const tail of [
        `Signature=${huge}`,
        `${PEM_BEGIN}${'-a'.repeat(8 * MiB)}`,
        `Signature=${'%25'.repeat(Math.floor((16 * MiB) / 3))}`,
      ]) {
        const missing = apiError(404, { message: `The specified bucket does not exist. ${tail}` });
        expect(isMissingBucket(missing)).toBe(true);
        const copy = scrubCredentials(missing);
        expect(copy.message).toMatch(/^The specified bucket does not exist\. .*\[redacted\]$/);
        expect(isMissingBucket(copy)).toBe(true);
      }
    }, 30_000);

    it.each([
      ['repeated JWT starts', 'eyJ'.repeat(2 ** 17)],
      ['a JWT start with no dot', `eyJ${'a'.repeat(4 * 2 ** 20)}`],
      ['repeated table cells', '<th>x</th><td>'.repeat(2 ** 18)],
      ['tags around long runs of spaces', `<a>${' '.repeat(100)}`.repeat(2 ** 14)],
      ['a name run of spaces', `<a> x${' '.repeat(60)}y`.repeat(2 ** 14)],
      ['repeated names with no value', 'access_token='.repeat(2 ** 18)],
      ['a name and a long run of spaces', `${AUTHORIZATION}${' '.repeat(4 * 2 ** 20)}`],
      ['repeated key openings', `${PEM_BEGIN}x`.repeat(2 ** 16)],
      ['repeated key openings with no end', `${PEM_BEGIN}${'-'.repeat(64)}`.repeat(2 ** 14)],
      ['repeated signatures', 'Signature=%2'.repeat(2 ** 18)],
    ])('takes linear time on %s', (_name, text) => {
      const started = performance.now();
      scrubCredentials(apiError(503, { message: text }));
      expect(performance.now() - started).toBeLessThan(5_000);
    });
  });

  describe('credential key names', () => {
    it.each([
      'authorization',
      'Proxy-Authorization',
      'cookie',
      'set-cookie',
      'x-api-key',
      'X-Goog-Api-Key',
      'x-goog-encryption-key',
      'x-goog-copy-source-encryption-key',
      'encryptionKey',
      'encryptionKeyBase64',
      'X-Goog-Signature',
      'x-goog-credential',
      'Signature',
      'SignatureProvided',
      'CanonicalRequest',
      'token',
      'access_token',
      'accessToken',
      'refresh_token',
      'refreshToken',
      'id_token',
      'subject_token',
      'client_secret',
      'clientSecret',
      'private_key',
      'privateKey',
      'assertion',
      ' Authorization: ',
    ])('redacts the value under %s', (name) => {
      const err = apiError(503, { detail: { [name]: VALUE, keep: 'visible' } });
      const out = scrubCredentials(err);
      expect(out['detail']).toEqual({ [name]: '[redacted]', keep: 'visible' });
      expect(out).not.toBe(err);
    });

    it.each([
      'x-goog-api-client',
      'x-goog-generation',
      'x-goog-encryption-key-sha256',
      'x-goog-encryption-algorithm',
      'encryptionKeyHash',
      'kmsKeyName',
      'pageToken',
      'nextPageToken',
      'client_email',
      'client_id',
      'private_key_id',
      'token_uri',
      'tokenType',
      'location',
      'key',
      'StringToSign',
    ])('keeps the value under %s', (name) => {
      const err = apiError(503, { detail: { [name]: 'visible' } });
      expect(scrubCredentials(err)['detail']).toEqual({ [name]: 'visible' });
    });

    it('redacts the secrets of a service-account key and an OAuth client, and keeps what names them', () => {
      const key = {
        type: 'service_account',
        project_id: 'p',
        private_key_id: 'k1',
        private_key: VALUE,
        client_email: SA_EMAIL,
        client_id: '1',
        token_uri: 'https://oauth2.googleapis.com/token',
      };
      const user = {
        type: 'authorized_user',
        client_id: '2',
        client_secret: VALUE,
        refresh_token: VALUE,
      };
      const out = scrubCredentials(Object.assign(new Error('x'), { key, user }));
      expect(out.key).toEqual({ ...key, private_key: '[redacted]' });
      expect(out.user).toEqual({
        ...user,
        client_secret: '[redacted]',
        refresh_token: '[redacted]',
      });
      expect(leaks(out)).toEqual([]);
    });

    it.each(['x-goog-encryption-key', 'access_token', 'Cookie'])(
      'redacts the value after %s in a flat list and under it in a map',
      (name) => {
        const err = apiError(503, {
          list: ['host', 'h', name, VALUE],
          map: new Map([[name, VALUE]]),
        });
        const out = scrubCredentials(err);
        expect(out['list']).toEqual(['host', 'h', name, '[redacted]']);
        expect((out['map'] as Map<string, string>).get(name)).toBe('[redacted]');
      },
    );
  });
});
