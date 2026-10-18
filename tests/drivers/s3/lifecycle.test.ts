import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { S3Storage } from '@/s3/backend';
import { MAX_NAMED_RULES, checkS3Lifecycle } from '@/s3/lifecycle';
import { StubBucket } from '../../helpers/stub-s3-bucket';
import { guardLoopback } from '../../helpers/loopback-guard';

/**
 * `S3Storage.checkLifecycle` reads the bucket's lifecycle configuration with one request and judges each rule against
 * the store's key prefix. The requests go to a real `S3Client` over the in-repo bucket stub, which answers from
 * a transport seam, so nothing leaves the process; the loopback guard shows no socket was tried.
 */

let guard: ReturnType<typeof guardLoopback>;
beforeAll(() => {
  guard = guardLoopback();
});
afterAll(() => {
  guard.restore();
  expect(guard.attempts).toEqual([]);
});

const rule = (inner: string, status: string | null = 'Enabled', id = 'r1'): string =>
  `<Rule><ID>${id}</ID>${status === null ? '' : `<Status>${status}</Status>`}${inner}</Rule>`;
const transition = (storageClass: string, d = 7): string =>
  `<Transition><Days>${d}</Days><StorageClass>${storageClass}</StorageClass></Transition>`;
const prefixed = (prefix: string, rest = ''): string =>
  `<Filter><Prefix>${prefix}</Prefix></Filter>${rest}`;
const days = (n = 30): string => `<Expiration><Days>${n}</Days></Expiration>`;

async function verdict(rules: string[], prefix: string | null = 'cr') {
  const bucket = new StubBucket();
  bucket.lifecycleXml = `<LifecycleConfiguration>${rules.join('')}</LifecycleConfiguration>`;
  const store = new S3Storage({
    bucket: 'b',
    client: bucket.client(),
    ...(prefix === null ? {} : { prefix }),
  });
  const out = await store.checkLifecycle();
  expect(bucket.count('GetBucketLifecycleConfiguration')).toBe(1);
  return out;
}

const ABORT =
  '<AbortIncompleteMultipartUpload><DaysAfterInitiation>3</DaysAfterInitiation></AbortIncompleteMultipartUpload>';

describe('S3Storage.checkLifecycle: a rule that must be a problem, and its safe look-alike', () => {
  const problems: Array<[string, string]> = [
    ['expires current objects by days, on our prefix', rule(prefixed('cr/', days()))],
    [
      'expires current objects by date',
      rule(prefixed('cr/', '<Expiration><Date>2030-01-01T00:00:00.000Z</Date></Expiration>')),
    ],
    ['covers the whole bucket (an empty prefix)', rule(prefixed('', days()))],
    ['covers the whole bucket (an empty filter)', rule(`<Filter></Filter>${days()}`)],
    [
      'covers the whole bucket (the legacy rule-level prefix, empty)',
      rule(`<Prefix></Prefix>${days()}`),
    ],
    ['is on the legacy rule-level prefix, ours', rule(`<Prefix>cr/</Prefix>${days()}`)],
    ['is on a prefix of ours (shorter)', rule(prefixed('c', days()))],
    ['is on a prefix of ours, without the slash', rule(prefixed('cr', days()))],
    ['is on a prefix inside ours (longer): the registry', rule(prefixed('cr/registry/', days()))],
    ['is on a prefix inside ours (longer): a namespace', rule(prefixed('cr/ns/segments/', days()))],
    [
      'transitions current objects to GLACIER',
      rule(
        prefixed(
          'cr/',
          '<Transition><Days>7</Days><StorageClass>GLACIER</StorageClass></Transition>',
        ),
      ),
    ],
    [
      'transitions current objects to DEEP_ARCHIVE',
      rule(
        prefixed(
          'cr/',
          '<Transition><Days>7</Days><StorageClass>DEEP_ARCHIVE</StorageClass></Transition>',
        ),
      ),
    ],
    [
      'has a size filter only (no tag): not interpreted, so reported',
      rule(
        `<Filter><And><Prefix>cr/</Prefix><ObjectSizeGreaterThan>1</ObjectSizeGreaterThan></And></Filter>${days()}`,
      ),
    ],
    ['expires and aborts uploads in one rule', rule(prefixed('cr/', days() + ABORT))],
    [
      'has two transitions and only the second archives',
      rule(prefixed('cr/', transition('STANDARD_IA', 30) + transition('GLACIER', 90))),
    ],
    [
      'has two transitions and only the second goes to DEEP_ARCHIVE',
      rule(prefixed('cr/', transition('STANDARD_IA', 30) + transition('DEEP_ARCHIVE', 90))),
    ],
    ['archives to GLACIER on day 0', rule(prefixed('cr/', transition('GLACIER', 0)))],
    ['has no Status at all, so it is read as enabled', rule(prefixed('cr/', days()), null)],
  ];
  it.each(problems)('problem: a rule that %s', async (_name, xml) => {
    const out = await verdict([xml]);
    expect(out.status).toBe('problem');
    expect(out.detail).toMatch(/expires current objects|moves current objects/);
  });

  it.each([
    [
      'the second of two transitions',
      transition('STANDARD_IA', 30) + transition('GLACIER', 90),
      'GLACIER',
    ],
    ['a transition on day 0', transition('GLACIER', 0), 'GLACIER'],
    ['a transition to DEEP_ARCHIVE on day 0', transition('DEEP_ARCHIVE', 0), 'DEEP_ARCHIVE'],
  ])('names the archive class of %s, as one it knows', async (_name, inner, storageClass) => {
    const out = await verdict([rule(prefixed('cr/', inner))]);
    expect(out.status).toBe('problem');
    expect(out.detail).toContain(`moves current objects to ${storageClass}`);
    expect(out.detail).not.toContain('does not know');
  });

  it('names the class of a transition it does not know, as a problem', async () => {
    const out = await verdict([rule(prefixed('cr/', transition('COLD_ARCHIVE_X')))]);
    expect(out.status).toBe('problem');
    expect(out.detail).toContain('COLD_ARCHIVE_X');
    expect(out.detail).toContain('does not know');
  });

  const safe: Array<[string, string]> = [
    ['is disabled', rule(prefixed('cr/', days()), 'Disabled')],
    ['is on the legacy rule-level prefix, another one', rule(`<Prefix>other/</Prefix>${days()}`)],
    [
      'is on another prefix inside And, with a size filter',
      rule(
        `<Filter><And><Prefix>other/</Prefix><ObjectSizeGreaterThan>1</ObjectSizeGreaterThan></And></Filter>${days()}`,
      ),
    ],
    ['has a tag filter', rule(`<Filter><Tag><Key>k</Key><Value>v</Value></Tag></Filter>${days()}`)],
    [
      'has a tag filter inside And, with our prefix',
      rule(
        `<Filter><And><Prefix>cr/</Prefix><Tag><Key>k</Key><Value>v</Value></Tag></And></Filter>${days()}`,
      ),
    ],
    ['is on another prefix', rule(prefixed('other/', days()))],
    ['is on a sibling that shares only its first letters', rule(prefixed('crx/', days()))],
    ['is on a sibling of a shorter shape', rule(prefixed('c-other/', days()))],
    [
      'only expires noncurrent versions',
      rule(
        prefixed(
          'cr/',
          '<NoncurrentVersionExpiration><NoncurrentDays>30</NoncurrentDays></NoncurrentVersionExpiration>',
        ),
      ),
    ],
    [
      'only moves noncurrent versions to GLACIER',
      rule(
        prefixed(
          'cr/',
          '<NoncurrentVersionTransition><NoncurrentDays>30</NoncurrentDays><StorageClass>GLACIER</StorageClass></NoncurrentVersionTransition>',
        ),
      ),
    ],
    [
      'only removes expired delete markers',
      rule(
        prefixed(
          'cr/',
          '<Expiration><ExpiredObjectDeleteMarker>true</ExpiredObjectDeleteMarker></Expiration>',
        ),
      ),
    ],
    ['only aborts incomplete uploads', rule(prefixed('cr/', ABORT))],
    [
      'moves current objects to STANDARD_IA',
      rule(
        prefixed(
          'cr/',
          '<Transition><Days>7</Days><StorageClass>STANDARD_IA</StorageClass></Transition>',
        ),
      ),
    ],
    [
      'moves current objects to GLACIER_IR, which stays readable',
      rule(
        prefixed(
          'cr/',
          '<Transition><Days>7</Days><StorageClass>GLACIER_IR</StorageClass></Transition>',
        ),
      ),
    ],
  ];
  it.each(safe)('ok: a rule that %s', async (_name, xml) => {
    const out = await verdict([xml]);
    expect(out.status).toBe('ok');
  });

  it('is a problem when one rule among safe ones is', async () => {
    const out = await verdict([
      rule(prefixed('other/', days())),
      rule(prefixed('cr/', days())),
      rule(prefixed('cr/', ABORT)),
    ]);
    expect(out.status).toBe('problem');
  });

  it('names every problem rule, joined, when there are a few', async () => {
    const out = await verdict([
      rule(prefixed('cr/', days()), 'Enabled', 'first'),
      rule(prefixed('c', days()), 'Enabled', 'second'),
    ]);
    expect(out.detail).toContain('"first"');
    expect(out.detail).toContain('"second"');
    expect(out.detail).toMatch(/"first" .*; rule "second"/);
  });

  it('cuts a rule id at 64 characters', async () => {
    const out = await verdict([rule(prefixed('cr/', days()), 'Enabled', 'i'.repeat(200))]);
    expect(out.detail).toMatch(/i{64}/);
    expect(out.detail).not.toMatch(/i{65}/);
  });

  it('cuts a rule prefix at 64 characters', async () => {
    const out = await verdict([rule(prefixed(`cr/${'p'.repeat(200)}`, days()))]);
    expect(out.status).toBe('problem');
    expect(out.detail).toMatch(/p{61}/);
    expect(out.detail).not.toMatch(/p{62}/);
  });

  it('names at most MAX_NAMED_RULES problem rules, then says how many more', async () => {
    const many = Array.from({ length: 10 }, (_, i) =>
      rule(prefixed('cr/', days()), 'Enabled', `rule-${i}`),
    );
    const out = await verdict(many);
    expect(out.status).toBe('problem');
    expect(MAX_NAMED_RULES).toBe(3);
    for (const i of [0, 1, 2]) expect(out.detail).toContain(`"rule-${i}"`);
    expect(out.detail).not.toContain('"rule-3"');
    expect(out.detail).toContain('and 7 more');
  });

  it('keeps the whole detail short on a thousand rules with long prefixes', async () => {
    const many = Array.from({ length: 1000 }, (_, i) =>
      rule(prefixed(`cr/${'p'.repeat(1000)}`, days()), 'Enabled', `rule-${i}`),
    );
    const out = await verdict(many);
    expect(out.detail.length).toBeLessThan(2000);
  });

  it('judges a store at the bucket root against every rule: it may use any namespace', async () => {
    expect((await verdict([rule(prefixed('other/', days()))], null)).status).toBe('problem');
  });

  it('tells a store with no prefix to give it one, without an empty exclude', async () => {
    const out = await verdict([rule(prefixed('other/', days()))], null);
    expect(out.status).toBe('problem');
    expect(out.detail).not.toContain('exclude ""');
    expect(out.detail).toContain('The store has no prefix');
    expect(out.detail).toContain('give the store a prefix');
  });

  it('reads the prefix as the key builders do', async () => {
    expect((await verdict([rule(prefixed('cr/', days()))], '/cr//')).status).toBe('problem');
    expect((await verdict([rule(prefixed('crx/', days()))], '/cr//')).status).toBe('ok');
  });

  it('is ok with no lifecycle configuration at all', async () => {
    const bucket = new StubBucket();
    const out = await new S3Storage({ bucket: 'b', client: bucket.client() }).checkLifecycle();
    expect(out.status).toBe('ok');
  });

  it('is ok with a configuration that has no rule over our prefix', async () => {
    expect((await verdict([])).status).toBe('ok');
  });
});

describe('S3Storage.checkLifecycle: the abort-incomplete-upload rule is advice, never a problem', () => {
  it('advises when no rule aborts incomplete uploads, and stays ok', async () => {
    const out = await verdict([
      rule(
        prefixed(
          'cr/',
          '<NoncurrentVersionExpiration><NoncurrentDays>3</NoncurrentDays></NoncurrentVersionExpiration>',
        ),
      ),
    ]);
    expect(out.status).toBe('ok');
    expect(out.detail).toContain('AbortIncompleteMultipartUpload');
  });
  it('advises with no configuration at all', async () => {
    const bucket = new StubBucket();
    const out = await new S3Storage({ bucket: 'b', client: bucket.client() }).checkLifecycle();
    expect(out.detail).toContain('AbortIncompleteMultipartUpload');
  });
  it('does not advise when a rule over our prefix aborts them', async () => {
    const out = await verdict([rule(prefixed('cr/', ABORT))]);
    expect(out.status).toBe('ok');
    expect(out.detail).not.toContain('AbortIncompleteMultipartUpload');
  });
  it('does not take an abort rule on another prefix for ours', async () => {
    const out = await verdict([rule(prefixed('other/', ABORT))], 'cr');
    expect(out.detail).toContain('AbortIncompleteMultipartUpload');
  });
  it('advises when the only abort rule covers just the registry rows', async () => {
    const out = await verdict([rule(prefixed('cr/registry/', ABORT))]);
    expect(out.status).toBe('ok');
    expect(out.detail).toContain('AbortIncompleteMultipartUpload');
  });
  it('does not advise when an abort rule covers the generation keys under a namespace', async () => {
    const out = await verdict([rule(prefixed('cr/ns/segments/', ABORT))]);
    expect(out.detail).not.toContain('AbortIncompleteMultipartUpload');
  });
  it('does not advise when an abort rule covers a shorter prefix, the whole bucket included', async () => {
    expect((await verdict([rule(prefixed('', ABORT))])).detail).not.toContain(
      'AbortIncompleteMultipartUpload',
    );
    expect((await verdict([rule(prefixed('c', ABORT))])).detail).not.toContain(
      'AbortIncompleteMultipartUpload',
    );
  });
  it('still advises when the only abort rule is disabled', async () => {
    const out = await verdict([rule(prefixed('cr/', ABORT), 'Disabled')]);
    expect(out.status).toBe('ok');
    expect(out.detail).toContain('AbortIncompleteMultipartUpload');
  });
  it('keeps the advice beside a problem, in the same detail', async () => {
    const out = await verdict([rule(prefixed('cr/', days()))]);
    expect(out.status).toBe('problem');
    expect(out.detail).toContain('AbortIncompleteMultipartUpload');
  });
});

describe('S3Storage.checkLifecycle: advice on a transition that stays readable, never a problem', () => {
  it('says INTELLIGENT_TIERING archive tiers need a restore before a read, and stays ok', async () => {
    const out = await verdict([
      rule(prefixed('cr/', transition('INTELLIGENT_TIERING', 0) + ABORT)),
    ]);
    expect(out.status).toBe('ok');
    expect(out.detail).toContain('INTELLIGENT_TIERING');
    expect(out.detail).toContain('restore');
  });
  it.each(['STANDARD_IA', 'ONEZONE_IA', 'GLACIER_IR'])(
    'says %s has a minimum duration and a retrieval fee, and stays ok',
    async (storageClass) => {
      const out = await verdict([rule(prefixed('cr/', transition(storageClass) + ABORT))]);
      expect(out.status).toBe('ok');
      expect(out.detail).toContain('minimum storage duration');
      expect(out.detail).toContain('retrieval fee');
      expect(out.detail).not.toContain('INTELLIGENT_TIERING');
    },
  );
  it('gives no such advice for a tag-filtered rule, which never matches', async () => {
    const out = await verdict([
      rule(
        `<Filter><Tag><Key>k</Key><Value>v</Value></Tag></Filter>${transition('STANDARD_IA')}${transition('INTELLIGENT_TIERING')}`,
      ),
    ]);
    expect(out.detail).not.toContain('retrieval fee');
    expect(out.detail).not.toContain('INTELLIGENT_TIERING');
  });
  it('keeps the advice beside a problem', async () => {
    const out = await verdict([
      rule(prefixed('cr/', transition('STANDARD_IA', 30) + transition('GLACIER', 90))),
    ]);
    expect(out.status).toBe('problem');
    expect(out.detail).toContain('retrieval fee');
  });
});

describe('S3Storage.checkLifecycle: the read honours readTimeoutMs', () => {
  function stalled(readTimeoutMs?: number) {
    const bucket = new StubBucket();
    const client = bucket.client();
    // A request that never answers, and never settles on an abort either.
    client.send = (() => new Promise(() => undefined)) as never;
    return new S3Storage({
      bucket: 'b',
      client,
      ...(readTimeoutMs === undefined ? {} : { readTimeoutMs }),
    });
  }
  it('is unchecked, saying the read got no answer in time and to run again', async () => {
    const out = await stalled(5).checkLifecycle();
    expect(out.status).toBe('unchecked');
    expect(out.detail).toContain('no answer in time');
    expect(out.detail).toContain('run the check again');
  });
  it('passes an abort signal to the request when a timeout is set, and none when it is off', async () => {
    const seen: unknown[] = [];
    const client = {
      send: (_cmd: unknown, options: unknown) => {
        seen.push(options);
        return Promise.resolve({ Rules: [] });
      },
    } as never;
    await checkS3Lifecycle(client, 'b', 'cr/', 1000);
    await checkS3Lifecycle(client, 'b', 'cr/');
    expect((seen[0] as { abortSignal?: AbortSignal }).abortSignal).toBeInstanceOf(AbortSignal);
    expect(seen[1]).toBeUndefined();
  });
});

describe('S3Storage.checkLifecycle: when the request fails', () => {
  async function failing(arm: (b: StubBucket) => void) {
    const bucket = new StubBucket();
    arm(bucket);
    return new S3Storage({
      bucket: 'b',
      client: bucket.client({ maxAttempts: 1 }),
    }).checkLifecycle();
  }
  it('names s3:GetLifecycleConfiguration when access is denied', async () => {
    const out = await failing((b) =>
      b.answerWith('GetBucketLifecycleConfiguration', 403, 'AccessDenied'),
    );
    expect(out.status).toBe('unchecked');
    expect(out.detail).toContain('s3:GetLifecycleConfiguration');
  });
  it.each([
    [503, 'SlowDown'],
    [404, 'NoSuchBucket'],
    [403, 'SignatureDoesNotMatch'],
    [500, 'InternalError'],
  ] as const)('is unchecked, with the error named, for a %s %s', async (status, code) => {
    const out = await failing((b) => b.answerWith('GetBucketLifecycleConfiguration', status, code));
    expect(out.status).toBe('unchecked');
    expect(out.detail).toContain(code);
    expect(out.detail).not.toContain('s3:GetLifecycleConfiguration');
  });
  it('is unchecked when the connection drops', async () => {
    const out = await failing((b) => b.failBeforeApplying('GetBucketLifecycleConfiguration'));
    expect(out.status).toBe('unchecked');
  });
});

describe('S3Storage.checkLifecycle: a detail never carries a credential, and the check never throws', () => {
  const SECRET = 'placeholder-secret-access-key-0123456789';
  const SESSION = 'placeholder-session-token-0123456789';
  const SIGNATURE = 'a'.repeat(64);
  const fake = (thrown: unknown) => ({ send: () => Promise.reject(thrown) }) as never;

  it('scrubs a credential an error message quotes', async () => {
    const err = Object.assign(
      new Error(
        `refused\nAuthorization: AWS4-HMAC-SHA256 Credential=STANDINACCESSKEYID/20260101/us-east-1/s3/aws4_request, SignedHeaders=host, Signature=${SIGNATURE}\nx-amz-security-token: ${SESSION}`,
      ),
      { name: 'SomethingOdd', $response: { headers: { authorization: SECRET } } },
    );
    const out = await checkS3Lifecycle(fake(err), 'b', 'cr/');
    expect(out.status).toBe('unchecked');
    for (const text of [SECRET, SESSION, SIGNATURE]) expect(out.detail).not.toContain(text);
    expect(out.detail).toContain('SomethingOdd');
  });

  it('cuts the message it shows at exactly 200 characters', async () => {
    const out = await checkS3Lifecycle(fake(new Error('x'.repeat(5000))), 'b', 'cr/');
    expect(out.detail).toMatch(/x{200}/);
    expect(out.detail).not.toMatch(/x{201}/);
  });

  it('cuts the error name it shows at 64 characters', async () => {
    const out = await checkS3Lifecycle(
      fake(Object.assign(new Error('m'), { name: 'n'.repeat(5000) })),
      'b',
      'cr/',
    );
    expect(out.detail).toMatch(/n{64}/);
    expect(out.detail).not.toMatch(/n{65}/);
  });

  it('scrubs a credential in the message of a thrown plain object', async () => {
    const out = await checkS3Lifecycle(
      fake({ name: 'Odd', message: `x-amz-security-token: ${SESSION}` }),
      'b',
      'cr/',
    );
    expect(out.status).toBe('unchecked');
    expect(out.detail).not.toContain(SESSION);
    expect(out.detail).toContain('Odd');
  });

  it('names the error and drops a message that is not text', async () => {
    const out = await checkS3Lifecycle(fake({ name: 'Odd', message: 7 }), 'b', 'cr/');
    expect(out.detail).toContain('(Odd)');
  });

  it('resolves unchecked when reading the thrown error itself throws', async () => {
    const hostile = {
      get name(): string {
        throw new Error('no name for you');
      },
      get message(): string {
        throw new Error('no message either');
      },
    };
    const out = await checkS3Lifecycle(fake(hostile), 'b', 'cr/');
    expect(out).toEqual({
      status: 'unchecked',
      detail: 'could not read the bucket lifecycle configuration',
    });
  });

  it.each([
    ['a string', 'boom'],
    ['null', null],
    ['undefined', undefined],
    ['a number', 7],
  ])('resolves unchecked when the client throws %s', async (_name, thrown) => {
    const out = await checkS3Lifecycle(fake(thrown), 'b', 'cr/');
    expect(out.status).toBe('unchecked');
  });

  it('resolves unchecked when the answer is not a configuration', async () => {
    const out = await checkS3Lifecycle(
      { send: () => Promise.resolve({ Rules: 'nope' }) } as never,
      'b',
      'cr/',
    );
    expect(out.status).toBe('unchecked');
  });
});
