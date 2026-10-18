import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { GcsStorage } from '@/gcs/backend';
import { checkGcsLifecycle } from '@/gcs/lifecycle';
import { StubGcsService } from '../../helpers/gcs-stub';
import { guardLoopback } from '../../helpers/loopback-guard';
import { ACCESS_TOKEN, CLIENT_SECRET } from '../../helpers/gcs-error-answers';

/**
 * `GcsStorage.checkLifecycle` reads the bucket's metadata with one request and judges each lifecycle rule against the
 * store's name prefix. The requests go to a real `@google-cloud/storage` client and a stub of the JSON API on
 * 127.0.0.1; the loopback guard shows no connection went anywhere else.
 */

let guard: ReturnType<typeof guardLoopback>;
const service = new StubGcsService();
beforeAll(async () => {
  guard = guardLoopback();
  await service.start();
});
afterAll(async () => {
  await service.stop();
  guard.restore();
  expect(guard.attempts).toEqual([]);
});
beforeEach(() => {
  service.bucketMetadata = {};
  service.bucketFault = undefined;
  service.sent.length = 0;
});

const del = (condition: Record<string, unknown>) => ({ action: { type: 'Delete' }, condition });

async function verdict(rules: unknown[] | undefined, prefix: string | null = 'cr') {
  service.sent.length = 0;
  service.bucketMetadata = rules === undefined ? {} : { lifecycle: { rule: rules } };
  const store = new GcsStorage({
    bucket: 'b',
    client: service.client(),
    ...(prefix === null ? {} : { prefix }),
  });
  const out = await store.checkLifecycle();
  expect(service.count('bucket')).toBe(1);
  return out;
}

describe('GcsStorage.checkLifecycle: a rule that must be a problem, and its safe look-alike', () => {
  const problems: Array<[string, unknown]> = [
    ['deletes by age, with no prefix or suffix', del({ age: 30 })],
    ['deletes by creation date', del({ createdBefore: '2030-01-01' })],
    ['deletes live objects explicitly', del({ age: 30, isLive: true })],
    ['deletes on our prefix', del({ age: 30, matchesPrefix: ['cr/'] })],
    ['deletes on a prefix of ours (shorter)', del({ age: 30, matchesPrefix: ['c'] })],
    [
      'deletes on a prefix inside ours (longer): the registry',
      del({ age: 30, matchesPrefix: ['cr/registry/'] }),
    ],
    [
      'deletes where one of several prefixes is ours',
      del({ age: 30, matchesPrefix: ['other/', 'cr/'] }),
    ],
    ['deletes names ending .crbm', del({ age: 30, matchesSuffix: ['.crbm'] })],
    ['deletes names ending .reg', del({ age: 30, matchesSuffix: ['.reg'] })],
    ['deletes names ending in a part of .crbm', del({ age: 30, matchesSuffix: ['bm'] })],
    [
      'deletes names ending in something that ends .crbm',
      del({ age: 30, matchesSuffix: ['1.crbm'] }),
    ],
    [
      'deletes by prefix and suffix that both can match',
      del({ age: 30, matchesPrefix: ['cr/'], matchesSuffix: ['.crbm'] }),
    ],
    [
      'deletes by a name pattern this check does not interpret',
      del({ age: 30, matchesPattern: '^x$' }),
    ],
    [
      'deletes by a storage class this check does not interpret',
      del({ age: 30, matchesStorageClass: ['ARCHIVE'] }),
    ],
  ];
  it.each(problems)('problem: a rule that %s', async (_name, rule) => {
    const out = await verdict([rule]);
    expect(out.status).toBe('problem');
    expect(out.detail).toContain('Delete');
  });

  const safe: Array<[string, unknown]> = [
    ['deletes only noncurrent versions (isLive false)', del({ age: 30, isLive: false })],
    ['deletes by number of newer versions', del({ numNewerVersions: 3 })],
    ['deletes by days since noncurrent', del({ daysSinceNoncurrentTime: 30 })],
    ['deletes by noncurrent time', del({ noncurrentTimeBefore: '2030-01-01' })],
    ['deletes on another prefix', del({ age: 30, matchesPrefix: ['other/'] })],
    [
      'deletes on a sibling that shares only its first letters',
      del({ age: 30, matchesPrefix: ['crx/'] }),
    ],
    ['deletes a suffix our names never end in', del({ age: 30, matchesSuffix: ['.tmp'] })],
    [
      'has our prefix but a suffix our names never end in',
      del({ age: 30, matchesPrefix: ['cr/'], matchesSuffix: ['.log'] }),
    ],
    [
      'has our suffix but another prefix',
      del({ age: 30, matchesPrefix: ['other/'], matchesSuffix: ['.crbm'] }),
    ],
    [
      'changes the storage class to ARCHIVE',
      { action: { type: 'SetStorageClass', storageClass: 'ARCHIVE' }, condition: { age: 30 } },
    ],
    [
      'aborts incomplete multipart uploads',
      { action: { type: 'AbortIncompleteMultipartUpload' }, condition: { age: 7 } },
    ],
  ];
  it.each(safe)('ok: a rule that %s', async (_name, rule) => {
    expect((await verdict([rule])).status).toBe('ok');
  });

  it('is a problem when one rule among safe ones is', async () => {
    const out = await verdict([del({ age: 30, matchesPrefix: ['other/'] }), del({ age: 30 })]);
    expect(out.status).toBe('problem');
  });

  it('judges a store at the bucket root against every prefix rule: it may use any namespace', async () => {
    expect((await verdict([del({ age: 30, matchesPrefix: ['other/'] })], null)).status).toBe(
      'problem',
    );
  });

  it('reads the prefix as the key builders do', async () => {
    expect((await verdict([del({ age: 1, matchesPrefix: ['cr/'] })], '/cr//')).status).toBe(
      'problem',
    );
    expect((await verdict([del({ age: 1, matchesPrefix: ['crx/'] })], '/cr//')).status).toBe('ok');
  });

  it('is ok with no lifecycle at all, and with an empty rule list', async () => {
    expect((await verdict(undefined)).status).toBe('ok');
    expect((await verdict([])).status).toBe('ok');
  });

  it('reads a malformed rule as no threat rather than throwing', async () => {
    expect((await verdict([null, 7, 'x', {}, { action: 3 }])).status).toBe('ok');
  });
});

describe('GcsStorage.checkLifecycle: when the request fails', () => {
  async function failing(fault: { status: number; reason: string; message?: string }) {
    service.bucketFault = fault;
    return new GcsStorage({ bucket: 'b', client: service.client() }).checkLifecycle();
  }
  it('names storage.buckets.get when access is denied', async () => {
    const out = await failing({ status: 403, reason: 'forbidden' });
    expect(out.status).toBe('unchecked');
    expect(out.detail).toContain('storage.buckets.get');
  });
  it.each([
    [404, 'notFound'],
    [400, 'invalid'],
  ] as const)('is unchecked, with the status, for a %s', async (status, reason) => {
    const out = await failing({ status, reason });
    expect(out.status).toBe('unchecked');
    expect(out.detail).toContain(String(status));
    expect(out.detail).not.toContain('storage.buckets.get');
  });
});

describe('GcsStorage.checkLifecycle: a detail never carries a credential, and the check never throws', () => {
  it('scrubs a credential an error body quotes', async () => {
    service.bucketFault = {
      status: 400,
      reason: 'invalid',
      message: [
        'bad request',
        ['Authorization:', 'Bearer', ACCESS_TOKEN].join(' '),
        ['client_secret', CLIENT_SECRET].join('='),
      ].join('\n'),
    };
    const out = await new GcsStorage({ bucket: 'b', client: service.client() }).checkLifecycle();
    expect(out.status).toBe('unchecked');
    for (const secret of [ACCESS_TOKEN, CLIENT_SECRET]) expect(out.detail).not.toContain(secret);
  });

  it('bounds the message it shows', async () => {
    service.bucketFault = { status: 400, reason: 'invalid', message: 'x'.repeat(5000) };
    const out = await new GcsStorage({ bucket: 'b', client: service.client() }).checkLifecycle();
    expect(out.detail.length).toBeLessThan(600);
  });

  it.each([
    ['a string', 'boom'],
    ['null', null],
    ['undefined', undefined],
    ['a number', 7],
  ])('resolves unchecked when the client throws %s', async (_name, thrown) => {
    const client = { bucket: () => ({ getMetadata: () => Promise.reject(thrown) }) } as never;
    expect((await checkGcsLifecycle(client, 'b', 'cr/')).status).toBe('unchecked');
  });

  it('resolves unchecked when the client throws synchronously', async () => {
    const client = {
      bucket: () => {
        throw new Error('nope');
      },
    } as never;
    expect((await checkGcsLifecycle(client, 'b', 'cr/')).status).toBe('unchecked');
  });
});
