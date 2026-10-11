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
