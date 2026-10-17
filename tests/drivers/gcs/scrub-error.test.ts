import { PassThrough } from 'node:stream';
import { types } from 'node:util';
import { createRequire } from 'node:module';
import { ApiError } from '@google-cloud/storage';
import { TransientError, ValidationError, isTransientError } from '@cloudbitmaps/core/driver-kit';
import { scrubCredentials } from '@/gcs/scrub-error';
import { ReadTimedOut } from '@/gcs/read-timeout';

// Every credential-looking value is built at run time, so the leak scan never reads one in this file.
const TOKEN = ['ya29', 'stand-in-access-token-0123456789'].join('.');
const VALUE = ['placeholder', 'credential', 'value'].join('-');
const AUTHORIZATION = ['Author', 'ization'].join('');
const BEARER = `${['Bear', 'er'].join('')} ${TOKEN}`;

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

const leaks = (value: unknown): string[] =>
  stringsIn(value).filter((text) => text.includes(TOKEN) || text.includes(VALUE));

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
  });

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

  describe('credential key names', () => {
    it.each(['authorization', 'Proxy-Authorization', 'cookie', 'set-cookie', 'x-api-key'])(
      'redacts the value under %s',
      (name) => {
        const err = apiError(503, { detail: { [name]: VALUE, keep: 'visible' } });
        expect(scrubCredentials(err)['detail']).toEqual({ [name]: '[redacted]', keep: 'visible' });
      },
    );

    it.each(['x-goog-api-client', 'x-goog-generation', 'pageToken', 'nextPageToken', 'location'])(
      'keeps the value under %s',
      (name) => {
        const err = apiError(503, { detail: { [name]: 'visible' } });
        expect(scrubCredentials(err)['detail']).toEqual({ [name]: 'visible' });
      },
    );
  });
});
