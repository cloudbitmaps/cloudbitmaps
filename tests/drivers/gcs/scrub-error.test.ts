import { scrubCredentials } from '@/gcs/scrub-error';

/** What the auth client puts in the header. */
const SIGNED = `Bearer ${'SECRET'}`;

describe('scrubCredentials', () => {
  it('copies an error that holds the SDK request: status, code and message stay, the transport and credentials go', () => {
    const live = {
      socket: { _httpMessage: { _header: `GET /o\r\nauthorization: ${SIGNED}\r\n\r\n` } },
    };
    const headers = new Headers({ Authorization: SIGNED, 'x-goog-api-client': 'gl-node' });
    const err = Object.assign(new Error('refused'), {
      code: 503,
      errors: [{ reason: 'backendError', message: 'try again' }],
      response: {
        status: 503,
        statusText: 'Service Unavailable',
        request: { headers: { Authorization: SIGNED }, agent: live },
        config: { headers },
        data: 'x',
      },
      config: { headers },
      raw: `GET /o HTTP/1.1\r\nauthorization: ${SIGNED}\r\nhost: h\r\n\r\n`,
    });
    const out = scrubCredentials(err);
    expect(out).not.toBe(err);
    expect(out).toBeInstanceOf(Error);
    const text = JSON.stringify(out, Object.getOwnPropertyNames(out));
    expect(text).not.toContain('SECRET');
    expect(out.message).toBe('refused');
    expect(out.stack).toBe(err.stack);
    expect(out.code).toBe(503);
    expect(out.errors).toEqual([{ reason: 'backendError', message: 'try again' }]);
    expect(out.response).toEqual({ status: 503, statusText: 'Service Unavailable' });
    expect(out.raw).toContain('host: h');
    // The originals are only read.
    expect(err.response.request.agent).toBe(live);
    expect(headers.get('authorization')).toBe(SIGNED);
  });

  it('copies the cause chain too, and survives a cycle and a throwing getter', () => {
    const inner: Record<string, unknown> = {
      code: 503,
      response: { status: 503, request: { agent: {} } },
    };
    inner.self = inner;
    Object.defineProperty(inner, 'boom', {
      enumerable: true,
      get() {
        throw new Error('no');
      },
    });
    const outer = new Error('outer', { cause: inner });
    const out = scrubCredentials(outer);
    expect(out).not.toBe(outer);
    const cause = out.cause as Record<string, unknown>;
    expect(cause.code).toBe(503);
    expect(cause.response).toEqual({ status: 503 });
    expect(cause.self).toBe(cause);
    expect(scrubCredentials('text')).toBe('text');
    expect(scrubCredentials(null)).toBe(null);
  });

  it('leaves an error with no transport as it is, so its identity holds', () => {
    const err = Object.assign(new Error('permanent'), { code: 'ENOENT' });
    expect(scrubCredentials(err)).toBe(err);
  });
});
