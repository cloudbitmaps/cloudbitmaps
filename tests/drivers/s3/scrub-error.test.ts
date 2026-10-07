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
    scrubCredentials(err);
    const text = JSON.stringify(err, Object.getOwnPropertyNames(err));
    expect(text).not.toContain(VALUE);
    expect(JSON.stringify(response.body)).not.toContain('req');
    expect(err.message).toBe('refused');
    expect(err.$metadata).toEqual({ httpStatusCode: 403, requestId: 'r1' });
  });

  it('redacts a credential header held in a symbol-keyed map and in a flat header list', () => {
    const key = Symbol('headers');
    const holder = {
      [key]: { 'x-amz-security-token': ['x-amz-security-token', VALUE] },
      list: ['X-Amz-Security-Token', VALUE],
    };
    scrubCredentials(holder);
    expect(JSON.stringify(holder)).not.toContain(VALUE);
    expect(JSON.stringify(holder[key])).not.toContain(VALUE);
  });

  it('survives a cycle and leaves other values alone', () => {
    const err: Record<string, unknown> = { note: 'fine', code: 'X' };
    err.self = err;
    expect(() => scrubCredentials(err)).not.toThrow();
    expect(err.note).toBe('fine');
    expect(scrubCredentials('text')).toBe('text');
  });
});
