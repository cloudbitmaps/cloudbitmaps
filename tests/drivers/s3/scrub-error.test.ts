import { scrubCredentials } from '@/s3/scrub-error';

const VALUE = ['placeholder', 'session', 'value'].join('-');

describe('S3 scrubCredentials', () => {
  it('drops the raw transport, redacts credential headers, and keeps status, code, message and request id', () => {
    const request = {
      _header: `GET /k HTTP/1.1\r\nx-amz-security-token: ${VALUE}\r\nhost: h\r\n\r\n`,
      rawHeaders: ['x-amz-security-token', VALUE, 'host', 'h'],
    };
    const response = { statusCode: 403, body: { req: request, statusCode: 403 } };
    const err = Object.assign(new Error('refused'), {
      name: 'Refused',
      $metadata: { httpStatusCode: 403, requestId: 'r1' },
    });
    // As the SDK defines it: neither writable nor configurable.
    Object.defineProperty(err, '$response', {
      value: response,
      writable: false,
      configurable: false,
    });
    const clean = scrubCredentials(err);
    const text = JSON.stringify(clean, Object.getOwnPropertyNames(clean));
    expect(text).not.toContain(VALUE);
    // The original and its live transport are untouched: a socket still closing reads them.
    expect(response.body.req).toBe(request);
    expect('$response' in clean).toBe(false);
    expect(clean).toBeInstanceOf(Error);
    expect(clean.name).toBe('Refused');
    expect(clean.message).toBe('refused');
    expect(clean.stack).toBe(err.stack);
    expect(clean.$metadata).toEqual({ httpStatusCode: 403, requestId: 'r1' });
  });

  it('redacts a credential header held in a symbol-keyed map and in a flat header list', () => {
    const key = Symbol('headers');
    const holder = {
      [key]: { 'x-amz-security-token': ['x-amz-security-token', VALUE] },
      list: ['X-Amz-Security-Token', VALUE],
    };
    const clean = scrubCredentials(holder);
    expect(JSON.stringify(clean)).not.toContain(VALUE);
    expect(JSON.stringify(clean[key])).not.toContain(VALUE);
  });

  it('survives a cycle and leaves other values alone', () => {
    const err: Record<string, unknown> = { note: 'fine', code: 'X' };
    err.self = err;
    const clean = scrubCredentials(err) as Record<string, unknown>;
    expect(clean.note).toBe('fine');
    expect(clean.code).toBe('X');
    expect(scrubCredentials('text')).toBe('text');
  });
});
