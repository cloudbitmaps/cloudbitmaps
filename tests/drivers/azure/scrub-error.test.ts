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
});
