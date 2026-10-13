import { ContainerClient } from '@azure/storage-blob';
import { Storage } from '@google-cloud/storage';
import { AzureBlobStorageDriver } from '@/azure-blob/storage';
import { GcsStorageDriver } from '@/gcs/storage';
import { S3StorageDriver } from '@/s3/storage';
import { S3Client } from '@aws-sdk/client-s3';
import { ValidationError } from '@/core/errors';

/**
 * One prefix check for every driver: the storage drivers refuse what the registries and S3 refuse, however the driver is
 * built, so a prefix cannot reach outside its own space through a spelling only the weaker check let by.
 */
const REFUSED = ['%2e%2e/x', 'a/%2E%2E/b', 'a\\b', 'a/..\\b', 'a\u007fb', 'a/../b', 'a\nb'];
const FINE = ['cloudbitmaps/', 'a/b/c', 'tenant-1/', 'a%20b/'];

const azure = (prefix: string): AzureBlobStorageDriver =>
  new AzureBlobStorageDriver({
    containerClient: new ContainerClient('http://127.0.0.1:1/c'),
    prefix,
  });
const gcs = (prefix: string): GcsStorageDriver =>
  new GcsStorageDriver({ storage: new Storage({ projectId: 'p' }), bucket: 'b', prefix });
const s3 = (prefix: string): S3StorageDriver =>
  new S3StorageDriver({ client: new S3Client({ region: 'us-east-1' }), bucket: 'b', prefix });

describe.each([
  ['Azure', azure],
  ['GCS', gcs],
  ['S3', s3],
] as const)('%s storage driver: the prefix check', (_name, build) => {
  it.each(REFUSED)('refuses %j', (prefix) => {
    expect(() => build(prefix)).toThrow(ValidationError);
  });

  it.each(FINE)('accepts %j', (prefix) => {
    expect(() => build(prefix)).not.toThrow();
  });
});
