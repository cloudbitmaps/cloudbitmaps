import { scrubCredentials } from '@/gcs/scrub-error';

describe('scrubCredentials', () => {
  it('redacts a credential header wherever the SDK keeps the request, and keeps every other field', () => {
    const headers = new Headers({ Authorization: 'Bearer SECRET', 'x-goog-api-client': 'gl-node' });
    const err = Object.assign(new Error('refused'), {
      code: 503,
      response: {
        status: 503,
        request: { headers: { Authorization: 'Bearer SECRET', Accept: '*/*' } },
        config: { headers },
      },
      raw: 'GET /o HTTP/1.1\r\nauthorization: Bearer SECRET\r\nhost: h\r\n\r\n',
    });
    const out = scrubCredentials(err);
    expect(out).toBe(err);
    const text = JSON.stringify(out, Object.getOwnPropertyNames(out));
    expect(text).not.toContain('SECRET');
    expect(out.code).toBe(503);
    expect(out.message).toBe('refused');
    expect(out.response.status).toBe(503);
    expect(out.response.request.headers.Accept).toBe('*/*');
    expect(headers.get('x-goog-api-client')).toBe('gl-node');
    expect(out.raw).toContain('host: h');
  });

  it('survives a cycle, a throwing getter and a frozen object', () => {
    const err: Record<string, unknown> = { Authorization: 'Bearer SECRET' };
    err.self = err;
    Object.defineProperty(err, 'boom', {
      enumerable: true,
      get() {
        throw new Error('no');
      },
    });
    err.frozen = Object.freeze({ authorization: 'Bearer SECRET' });
    expect(() => scrubCredentials(err)).not.toThrow();
    expect(err.Authorization).toBe('[redacted]');
    expect(scrubCredentials('text')).toBe('text');
    expect(scrubCredentials(null)).toBe(null);
  });

  it('leaves look-alike names alone', () => {
    const err = {
      authorizationUrl: 'u',
      headers: { 'content-type': 'x' },
      note: 'authorization is required',
    };
    expect(scrubCredentials({ ...err })).toEqual(err);
  });
});
