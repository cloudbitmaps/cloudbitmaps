import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Storage } from '@google-cloud/storage';
import { GcsStorage } from '@/gcs/backend';
import { MAX_NAMED_RULES, checkGcsLifecycle } from '@/gcs/lifecycle';
import { storageObjectKey } from '@/drivers/_shared/object-keys';
import { registryObjectKey } from '@/drivers/_shared/object-registry-keys';
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
    [
      'deletes where the number of newer versions is 0, which a live object meets',
      del({ numNewerVersions: 0, age: 30 }),
    ],
    ['deletes with a numNewerVersions of 0 alone', del({ numNewerVersions: 0 })],
    [
      'deletes names whose second suffix is the one ours end in',
      del({ age: 30, matchesSuffix: ['.tmp', '.crbm'] }),
    ],
    [
      'deletes names whose second suffix is .reg',
      del({ age: 30, matchesSuffix: ['.tmp', '.reg'] }),
    ],
    [
      'has an action the check does not know',
      { action: { type: 'Archive' }, condition: { age: 30 } },
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
    ['deletes by days since noncurrent, at 0', del({ daysSinceNoncurrentTime: 0 })],
    ['deletes by number of newer versions, at 1', del({ numNewerVersions: 1 })],
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

  it('names the action it does not know, as a problem', async () => {
    const out = await verdict([{ action: { type: 'Archive' }, condition: { age: 30 } }]);
    expect(out.status).toBe('problem');
    expect(out.detail).toContain('Archive');
  });

  it('keeps a rule with an unknown action on another prefix safe', async () => {
    const rule = { action: { type: 'Archive' }, condition: { matchesPrefix: ['other/'] } };
    expect((await verdict([rule])).status).toBe('ok');
  });

  it('shows a rule condition cut at 120 characters', async () => {
    const out = await verdict([del({ matchesPattern: 'p'.repeat(500) })]);
    const lead = '{"matchesPattern":"'.length;
    expect(out.status).toBe('problem');
    expect(out.detail).toMatch(new RegExp(`p{${120 - lead}}`));
    expect(out.detail).not.toMatch(new RegExp(`p{${120 - lead + 1}}`));
  });

  it('names at most MAX_NAMED_RULES problem rules, then says how many more', async () => {
    const out = await verdict(Array.from({ length: 10 }, (_, i) => del({ age: i + 1 })));
    expect(out.status).toBe('problem');
    expect(MAX_NAMED_RULES).toBe(3);
    expect(out.detail).toContain('"age":1}');
    expect(out.detail).toContain('"age":3}');
    expect(out.detail).not.toContain('"age":4}');
    expect(out.detail).toContain('and 7 more');
  });

  it('keeps the whole detail short on a thousand long rules', async () => {
    const out = await verdict(
      Array.from({ length: 1000 }, () => del({ matchesPattern: 'p'.repeat(1000) })),
    );
    expect(out.detail.length).toBeLessThan(1000);
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

describe('GcsStorage.checkLifecycle: the suffixes are the ones core gives its keys', () => {
  const extension = (key: string): string => key.slice(key.lastIndexOf('.'));
  const generationKey = storageObjectKey('cr', { namespace: 'n', segment: 's', generation: 3 });
  const registryKey = registryObjectKey('cr', { namespace: 'n', segment: 's' });

  it.each([
    ['a generation key', generationKey],
    ['a registry key', registryKey],
  ])('reports a rule scoped to the extension of %s', async (_name, key) => {
    const out = await verdict([del({ age: 30, matchesSuffix: [extension(key)] })]);
    expect(out.status).toBe('problem');
  });

  it('builds keys whose extensions are different from each other', () => {
    expect(extension(generationKey)).not.toBe(extension(registryKey));
  });
});

describe('GcsStorage.checkLifecycle: the read honours readTimeoutMs', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });
  function stalled(readTimeoutMs?: number) {
    vi.spyOn(Storage.prototype, 'bucket').mockImplementation((() => ({
      getMetadata: () => new Promise(() => undefined),
    })) as never);
    return new GcsStorage({
      bucket: 'b',
      client: service.client(),
      ...(readTimeoutMs === undefined ? {} : { readTimeoutMs }),
    });
  }
  it('is unchecked, saying the read got no answer in time and to run again', async () => {
    const out = await stalled(5).checkLifecycle();
    expect(out.status).toBe('unchecked');
    expect(out.detail).toContain('no answer in time');
    expect(out.detail).toContain('run the check again');
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
  it('does not read a 401 as a missing permission: the credentials were not accepted', async () => {
    const out = await failing({ status: 401, reason: 'required' });
    expect(out.status).toBe('unchecked');
    expect(out.detail).toContain('401');
    expect(out.detail).not.toContain('storage.buckets.get');
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

  it('cuts the message it shows at exactly 200 characters', async () => {
    service.bucketFault = { status: 400, reason: 'invalid', message: 'x'.repeat(5000) };
    const out = await new GcsStorage({ bucket: 'b', client: service.client() }).checkLifecycle();
    expect(out.detail).toMatch(/x{200}/);
    expect(out.detail).not.toMatch(/x{201}/);
  });

  const failWith = (thrown: unknown) =>
    ({ bucket: () => ({ getMetadata: () => Promise.reject(thrown) }) }) as never;

  it('names the error and its code', async () => {
    const out = await checkGcsLifecycle(failWith({ name: 'CustomName', code: 400 }), 'b', 'cr/');
    expect(out.detail).toContain('(CustomName 400)');
  });

  it('cuts the error name it shows at 64 characters', async () => {
    const out = await checkGcsLifecycle(
      failWith({ name: 'n'.repeat(5000), code: 400 }),
      'b',
      'cr/',
    );
    expect(out.detail).toMatch(/n{64}/);
    expect(out.detail).not.toMatch(/n{65}/);
  });

  it('scrubs a credential in the message of a thrown plain object', async () => {
    const out = await checkGcsLifecycle(
      failWith({
        code: 400,
        message: ['Authorization:', 'Bearer', ACCESS_TOKEN].join(' '),
      }),
      'b',
      'cr/',
    );
    expect(out.status).toBe('unchecked');
    expect(out.detail).not.toContain(ACCESS_TOKEN);
  });

  it('resolves unchecked when reading the thrown error itself throws', async () => {
    const refuse = (): never => {
      throw new Error('no reading this');
    };
    const hostile = new Proxy(
      {},
      { get: refuse, has: refuse, ownKeys: refuse, getPrototypeOf: refuse },
    );
    expect(await checkGcsLifecycle(failWith(hostile), 'b', 'cr/')).toEqual({
      status: 'unchecked',
      detail: 'could not read the bucket metadata',
    });
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
