import { S3Client } from '@aws-sdk/client-s3';
import { Storage } from '@google-cloud/storage';
import { ContainerClient } from '@azure/storage-blob';
import { S3Storage } from '@cloudbitmaps/s3';
import { GcsStorage } from '@cloudbitmaps/gcs';
import { AzureBlobStorage } from '@cloudbitmaps/azure-blob';
import { S3StorageDriver } from '@/s3/storage';
import { S3RegistryDriver } from '@/s3/registry';
import { GcsStorageDriver } from '@/gcs/storage';
import { GcsRegistryDriver } from '@/gcs/registry';
import { AzureBlobStorageDriver } from '@/azure-blob/storage';
import { AzureBlobRegistryDriver } from '@/azure-blob/registry';
import { ValidationError } from '@/core/errors';

// Azurite's fixed, publicly-documented dev account + key (not a secret — the same value ships in every SDK).
// Constructing a client parses this string but talks to nothing, which is all these wiring tests need.
const AZURITE_CONN =
  'DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;' +
  'AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==;' +
  'BlobEndpoint=http://127.0.0.1:10000/devstoreaccount1;';

/**
 * The size and switch options of the three cloud backends, and of each half built alone, go through the driver kit's
 * shared checks. Every value that is not a positive safe integer, or not a boolean, is refused by name with
 * `ValidationError`, never read as a default and never a `TypeError` from building the message.
 */
const NOT_SIZES: readonly unknown[] = [
  0,
  -1,
  1.5,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  2 ** 53,
  '8',
  null,
  true,
  {},
  8n,
  Symbol('size'),
];
const NOT_SWITCHES: readonly unknown[] = ['yes', 'true', 1, 0, null, {}, Symbol('switch')];

const s3Client = (): S3Client => new S3Client({ region: 'us-east-1' });
const gcsClient = (): Storage => new Storage({ projectId: 'p', apiEndpoint: 'http://127.0.0.1:9' });
const azureContainer = (): ContainerClient => new ContainerClient(AZURITE_CONN, 'c');

type Build = (value: unknown) => unknown;

const SIZES: ReadonlyArray<readonly [string, string, Build]> = [
  ['S3Storage', 'partBytes', (v) => new S3Storage({ bucket: 'b', partBytes: v as number })],
  [
    'S3Storage',
    'maxObjectBytes',
    (v) => new S3Storage({ bucket: 'b', maxObjectBytes: v as number }),
  ],
  ['S3Storage', 'maxSockets', (v) => new S3Storage({ bucket: 'b', maxSockets: v as number })],
  [
    'GcsStorage',
    'maxObjectBytes',
    (v) =>
      new GcsStorage({
        bucket: 'b',
        apiEndpoint: 'http://127.0.0.1:9',
        maxObjectBytes: v as number,
      }),
  ],
  [
    'GcsStorage',
    'simpleUploadThresholdBytes',
    (v) =>
      new GcsStorage({
        bucket: 'b',
        apiEndpoint: 'http://127.0.0.1:9',
        simpleUploadThresholdBytes: v as number,
      }),
  ],
  [
    'AzureBlobStorage',
    'blockBytes',
    (v) =>
      new AzureBlobStorage({
        connectionString: AZURITE_CONN,
        container: 'c',
        blockBytes: v as number,
      }),
  ],
  [
    'AzureBlobStorage',
    'maxObjectBytes',
    (v) =>
      new AzureBlobStorage({
        connectionString: AZURITE_CONN,
        container: 'c',
        maxObjectBytes: v as number,
      }),
  ],
];

const SWITCHES: ReadonlyArray<readonly [string, Build]> = [
  ['S3Storage', (v) => new S3Storage({ bucket: 'b', conditionalDelete: v as boolean })],
  [
    'GcsStorage',
    (v) =>
      new GcsStorage({
        bucket: 'b',
        apiEndpoint: 'http://127.0.0.1:9',
        conditionalDelete: v as boolean,
      }),
  ],
  [
    'AzureBlobStorage',
    (v) =>
      new AzureBlobStorage({
        connectionString: AZURITE_CONN,
        container: 'c',
        conditionalDelete: v as boolean,
      }),
  ],
  [
    'S3StorageDriver',
    (v) =>
      new S3StorageDriver({ client: s3Client(), bucket: 'b', conditionalDelete: v as boolean }),
  ],
  [
    'S3RegistryDriver',
    (v) =>
      new S3RegistryDriver({ client: s3Client(), bucket: 'b', conditionalDelete: v as boolean }),
  ],
  [
    'GcsStorageDriver',
    (v) =>
      new GcsStorageDriver({ storage: gcsClient(), bucket: 'b', conditionalDelete: v as boolean }),
  ],
  [
    'GcsRegistryDriver',
    (v) =>
      new GcsRegistryDriver({ storage: gcsClient(), bucket: 'b', conditionalDelete: v as boolean }),
  ],
  [
    'AzureBlobStorageDriver',
    (v) =>
      new AzureBlobStorageDriver({
        containerClient: azureContainer(),
        conditionalDelete: v as boolean,
      }),
  ],
  [
    'AzureBlobRegistryDriver',
    (v) =>
      new AzureBlobRegistryDriver({
        containerClient: azureContainer(),
        conditionalDelete: v as boolean,
      }),
  ],
];

describe.each(SIZES)(
  '%s refuses a `%s` that is not a positive safe integer',
  (_backend, name, build) => {
    it.each(NOT_SIZES.map((v) => [String(v), v] as const))('%s', (_label, value) => {
      expect(() => build(value)).toThrow(ValidationError);
      expect(() => build(value)).toThrow(
        new RegExp(`^${name} must be an integer of at least 1; got `),
      );
    });

    it('takes a positive safe integer', () => {
      expect(() => build(8 * 1024 * 1024)).not.toThrow();
    });
  },
);

describe.each(SWITCHES)(
  '%s refuses a `conditionalDelete` that is not a boolean',
  (_half, build) => {
    it.each(NOT_SWITCHES.map((v) => [String(v), v] as const))('%s', (_label, value) => {
      expect(() => build(value)).toThrow(ValidationError);
      expect(() => build(value)).toThrow(/^conditionalDelete must be a boolean; got /);
    });

    it('takes true, false and absence', () => {
      for (const ok of [true, false, undefined]) expect(() => build(ok)).not.toThrow();
    });
  },
);

const PREFIXED: ReadonlyArray<readonly [string, (prefix: unknown) => unknown]> = [
  ['S3Storage', (v) => new S3Storage({ bucket: 'b', prefix: v as string })],
  [
    'GcsStorage',
    (v) => new GcsStorage({ bucket: 'b', apiEndpoint: 'http://127.0.0.1:9', prefix: v as string }),
  ],
  [
    'AzureBlobStorage',
    (v) =>
      new AzureBlobStorage({ connectionString: AZURITE_CONN, container: 'c', prefix: v as string }),
  ],
];

describe.each(PREFIXED)('%s refuses a `prefix` that is not a string', (_backend, build) => {
  it.each([[5], [null], [true], [{}], [['a']]])('%j', (value) => {
    expect(() => build(value)).toThrow(ValidationError);
    expect(() => build(value)).toThrow(/^prefix must be a string; got /);
  });

  it('takes a string and absence', () => {
    for (const ok of ['', 'p/', 'a/b', undefined]) expect(() => build(ok)).not.toThrow();
  });
});

describe('S3Storage refuses a `region` that is not a non-empty string', () => {
  it.each([[''], ['   '], [5], [null], [true], [{}]])('%j', (value) => {
    const make = (): S3Storage => new S3Storage({ bucket: 'b', region: value as string });
    expect(make).toThrow(ValidationError);
    expect(make).toThrow("S3Storage's `region` must be a non-empty string such as 'us-east-1'");
  });

  it('takes a region and absence, and still refuses one beside a client', () => {
    expect(() => new S3Storage({ bucket: 'b', region: 'eu-west-1' })).not.toThrow();
    expect(() => new S3Storage({ bucket: 'b' })).not.toThrow();
    expect(() => new S3Storage({ bucket: 'b', client: s3Client(), region: 'eu-west-1' })).toThrow(
      ValidationError,
    );
  });
});

describe('AzureBlobStorage refuses a connection string it cannot use', () => {
  const FAKE_KEY = 'AccountKey=FAKEKEYFAKEKEYFAKEKEY';
  const make = (connectionString: unknown): AzureBlobStorage =>
    new AzureBlobStorage({ connectionString: connectionString as string, container: 'c' });

  it.each([
    ['an empty string', ''],
    ['whitespace', '   '],
    ['text that is not a connection string', 'garbage'],
    ['an account name alone', 'AccountName=a'],
    ['a number', 5],
    ['null', null],
    ['an object', {}],
  ])('%s', (_label, value) => {
    expect(() => make(value)).toThrow(ValidationError);
    expect(() => make(value)).toThrow(/^AzureBlobStorage: `connectionString` /);
  });

  it('never puts the string, or a cause that could hold it, in the error', () => {
    for (const bad of [`${FAKE_KEY};AccountName=a`, `${FAKE_KEY};BlobEndpoint=not a url`]) {
      let thrown: unknown;
      try {
        make(bad);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(ValidationError);
      expect((thrown as Error).message).not.toContain('FAKEKEY');
      expect((thrown as Error & { cause?: unknown }).cause).toBeUndefined();
    }
  });

  it('takes a valid connection string', () => {
    expect(() => make(AZURITE_CONN)).not.toThrow();
  });
});

describe('an endpoint that is empty or not a string is refused, and no request is made', () => {
  const s3 = (endpoint: unknown): S3Storage =>
    new S3Storage({ bucket: 'b', region: 'us-east-1', endpoint: endpoint as string });
  const gcs = (apiEndpoint: unknown): GcsStorage =>
    new GcsStorage({ bucket: 'b', apiEndpoint: apiEndpoint as string });

  it.each([[''], ['  '], [5], [null], [true]])('S3Storage endpoint %j', (v) => {
    expect(() => s3(v)).toThrow(ValidationError);
    expect(() => s3(v)).toThrow(/^S3Storage: `endpoint` must be a non-empty string/);
  });
  it.each([[''], ['  '], [5], [null], [true]])('GcsStorage apiEndpoint %j', (v) => {
    expect(() => gcs(v)).toThrow(ValidationError);
    expect(() => gcs(v)).toThrow(/^GcsStorage: `apiEndpoint` must be a non-empty string/);
  });
  it('takes a URL, and none', () => {
    expect(() => s3('http://localhost:9000')).not.toThrow();
    expect(() => s3(undefined)).not.toThrow();
    expect(() => gcs('http://127.0.0.1:9')).not.toThrow();
  });
  it('takes a host with no scheme, as the clients do', () => {
    expect(() => gcs('storage.googleapis.com')).not.toThrow();
  });
});

describe('the other client settings are refused when they cannot be used', () => {
  const s3 = (o: object): S3Storage =>
    new S3Storage({ bucket: 'b', region: 'us-east-1', ...o } as never);

  it.each([['true'], [1], [null]])('S3Storage pathStyle %j', (v) => {
    expect(() => s3({ pathStyle: v })).toThrow('S3Storage: `pathStyle` must be a boolean');
  });
  it.each([
    ['a string', 'x', /credentials needs an options object/],
    ['an empty object', {}, /`credentials.accessKeyId` is required/],
    ['no secret', { accessKeyId: 'a' }, /`credentials.secretAccessKey` is required/],
    [
      'a numeric id',
      { accessKeyId: 5, secretAccessKey: 's' },
      /`credentials.accessKeyId` must be a non-empty string/,
    ],
    [
      'an empty secret',
      { accessKeyId: 'a', secretAccessKey: '' },
      /`credentials.secretAccessKey` must be a non-empty string/,
    ],
    [
      'a misspelt key',
      { accessKeyId: 'a', secretAccessKey: 's', sessionTkn: 't' },
      /does not take `sessionTkn`/,
    ],
    [
      'a numeric token',
      { accessKeyId: 'a', secretAccessKey: 's', sessionToken: 5 },
      /`credentials.sessionToken` must be a non-empty string/,
    ],
  ])('S3Storage credentials %s', (_label, credentials, message) => {
    expect(() => s3({ credentials })).toThrow(ValidationError);
    expect(() => s3({ credentials })).toThrow(message);
  });
  it('never puts a credential value in a message', () => {
    expect(() => s3({ credentials: { accessKeyId: 'AKIAFAKEVALUE', secretAccessKey: 5 } })).toThrow(
      /^(?!.*AKIAFAKEVALUE)/,
    );
  });
  it('takes a credentials object the SDK has already stamped, or a provider returned', () => {
    const used = { accessKeyId: 'a', secretAccessKey: 's' };
    s3({ credentials: used });
    s3({ credentials: used });
    expect(() =>
      s3({ credentials: { ...used, $source: 'x', accountId: '1', expiration: new Date() } }),
    ).not.toThrow();
  });
  it('takes complete credentials', () => {
    expect(() => s3({ credentials: { accessKeyId: 'a', secretAccessKey: 's' } })).not.toThrow();
    expect(() =>
      s3({ credentials: { accessKeyId: 'a', secretAccessKey: 's', sessionToken: 't' } }),
    ).not.toThrow();
  });
  it.each([[''], ['  '], [5], [null]])('GcsStorage projectId %j', (v) => {
    expect(
      () =>
        new GcsStorage({ bucket: 'b', apiEndpoint: 'http://127.0.0.1:9', projectId: v as string }),
    ).toThrow('GcsStorage: `projectId` must be a non-empty string');
  });
  it.each([[null], [''], ['  '], [5], [{}]])('AzureBlobStorage container %j', (v) => {
    const make = (): AzureBlobStorage =>
      new AzureBlobStorage({ connectionString: AZURITE_CONN, container: v as string });
    expect(make).toThrow(ValidationError);
    expect(make).toThrow('AzureBlobStorage: `container` must be a non-empty string');
  });
});
