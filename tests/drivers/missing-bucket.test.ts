import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { S3Client } from '@aws-sdk/client-s3';
import { ContainerClient, StorageSharedKeyCredential } from '@azure/storage-blob';
import { AzureBlobStorage } from '@/azure-blob/backend';
import { GcsStorage } from '@/gcs/backend';
import { S3Storage } from '@/s3/backend';
import type { StorageBackend } from '@cloudbitmaps/core';
import {
  expectMissingLocationFails,
  expectMissingObjectIsAbsent,
} from '../helpers/missing-location';

/**
 * A bucket or container that does not exist is a wiring fault, not an empty store. Each driver, over its real SDK,
 * against a loopback server that answers every request as the service answers for a missing bucket, must let the
 * service's error reach the caller: a read that answered "absent" would report an empty segment where the store
 * is misconfigured. The control answers every request as a missing object in a bucket that exists, which must
 * still read as absent.
 */
const LIMIT = { timeout: 30_000 };

type Mode = 'bucket' | 'object';
type Answer = (req: IncomingMessage, res: ServerResponse, mode: Mode) => void;

const xml = (
  res: ServerResponse,
  req: IncomingMessage,
  status: number,
  code: string,
  message: string,
): void => {
  res.writeHead(status, { 'content-type': 'application/xml', 'x-ms-error-code': code });
  res.end(
    req.method === 'HEAD'
      ? undefined
      : `<Error><Code>${code}</Code><Message>${message}</Message></Error>`,
  );
};

const s3Answer: Answer = (req, res, mode) => {
  if (mode === 'bucket')
    return xml(res, req, 404, 'NoSuchBucket', 'The specified bucket does not exist');
  // S3 answers a delete of an absent key as done.
  if (req.method === 'DELETE') return void res.writeHead(204).end();
  xml(res, req, 404, 'NoSuchKey', 'The specified key does not exist.');
};

const azureAnswer: Answer = (req, res, mode) =>
  mode === 'bucket'
    ? xml(res, req, 404, 'ContainerNotFound', 'The specified container does not exist.')
    : xml(res, req, 404, 'BlobNotFound', 'The specified blob does not exist.');

/** GCS answers a missing bucket and a missing object with the same status and reason; only the message differs. */
const gcsAnswer =
  (body: 'json' | 'text'): Answer =>
  (req, res, mode) => {
    // In a bucket that exists, a listing answers; only the bucket's absence makes one a 404.
    if (
      mode === 'object' &&
      req.method === 'GET' &&
      /\/b\/[^/]+\/o$/.test(new URL(req.url ?? '/', 'http://x').pathname)
    ) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ kind: 'storage#objects', items: [] }));
      return;
    }
    const message =
      mode === 'bucket'
        ? 'The specified bucket does not exist.'
        : 'No such object: missing/registry/_default/s.reg';
    if (body === 'text') {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end(message);
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        error: { code: 404, message, errors: [{ message, domain: 'global', reason: 'notFound' }] },
      }),
    );
  };

interface Service {
  readonly name: string;
  readonly answer: Answer;
  backend(url: string): StorageBackend;
}

const SERVICES: Service[] = [
  {
    name: 'S3',
    answer: s3Answer,
    backend: (url) =>
      new S3Storage({
        bucket: 'missing',
        client: new S3Client({
          endpoint: url,
          region: 'us-east-1',
          forcePathStyle: true,
          maxAttempts: 1,
          credentials: { accessKeyId: 'stand-in', secretAccessKey: 'stand-in' },
        }),
      }),
  },
  {
    name: 'GCS (JSON error body)',
    answer: gcsAnswer('json'),
    backend: (url) => new GcsStorage({ bucket: 'missing', apiEndpoint: url, projectId: 'test' }),
  },
  {
    name: 'GCS (plain-text error body)',
    answer: gcsAnswer('text'),
    backend: (url) => new GcsStorage({ bucket: 'missing', apiEndpoint: url, projectId: 'test' }),
  },
  {
    name: 'Azure',
    answer: azureAnswer,
    backend: (url) =>
      new AzureBlobStorage({
        containerClient: new ContainerClient(
          `${url}/missing`,
          new StorageSharedKeyCredential(
            'stand-in',
            Buffer.from('stand-in-key').toString('base64'),
          ),
          { retryOptions: { maxTries: 1 } },
        ),
      }),
  },
];

for (const service of SERVICES) {
  describe(`${service.name}: a missing bucket is an error, not an empty store`, LIMIT, () => {
    let server: Server;
    let url: string;
    let mode: Mode;

    beforeEach(async () => {
      mode = 'bucket';
      server = createServer((req, res) => {
        req.resume();
        req.on('end', () => service.answer(req, res, mode));
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });
    afterEach(async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    it('every read, and a delete, fails rather than answering absent', async () => {
      await expectMissingLocationFails(() => service.backend(url));
    });

    it('control: a missing object in a bucket that exists still reads as absent', async () => {
      mode = 'object';
      await expectMissingObjectIsAbsent(() => service.backend(url));
    });
  });
}
