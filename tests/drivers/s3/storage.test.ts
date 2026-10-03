import type { S3Client } from '@aws-sdk/client-s3';
import { S3StorageDriver } from '@/s3/storage';
import { ValidationError } from '@/core/errors';
import { storageObjectKey } from '@/s3/keys';

// Constructor-level checks need no network (the client is never called), so they run on the normal lane.
const fakeClient = {} as unknown as S3Client;

describe('S3StorageDriver construction', () => {
  it('accepts a clean prefix (or none) and advertises conditional-put + range-read', () => {
    for (const prefix of [undefined, '', 'cloudbitmaps', 'a/b/c', '/leading/trailing/']) {
      const driver = new S3StorageDriver({ client: fakeClient, bucket: 'b', prefix });
      const caps = driver.capabilities();
      expect(caps.rangeRead).toBe(true);
      expect(caps.conditionalPut).toBe(true);
      expect(caps.maxObjectBytes).toBeGreaterThan(0);
    }
  });

  it('rejects a prefix with `..` / `.` path segments (containment)', () => {
    for (const prefix of ['..', 'a/../b', './x', 'a/./b', '../escape']) {
      expect(() => new S3StorageDriver({ client: fakeClient, bucket: 'b', prefix })).toThrow(
        ValidationError,
      );
    }
  });

  it('rejects a prefix with control characters', () => {
    for (const prefix of ['a\tb', 'a\nb']) {
      expect(() => new S3StorageDriver({ client: fakeClient, bucket: 'b', prefix })).toThrow(
        ValidationError,
      );
    }
  });
});

// Collecting by name deletes one generation without knowing whether an object is there, so a delete is one request, a
// `DeleteObject`, which S3 answers the same for a key that is absent (204) and one that was present.
describe('S3StorageDriver — what a delete costs', () => {
  it('sends one DeleteObject for the generation named, and nothing else, so an absent key is no error', async () => {
    const sent: { name: string; input: { Bucket?: string; Key?: string } }[] = [];
    const client = {
      send: async (command: { constructor: { name: string }; input: object }) => {
        sent.push({ name: command.constructor.name, input: command.input });
        return {};
      },
    } as unknown as S3Client;
    const driver = new S3StorageDriver({ client, bucket: 'b', prefix: 'p' });
    await expect(driver.delete({ segment: 's', generation: 3 })).resolves.toBeUndefined();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.name).toBe('DeleteObjectCommand');
    expect(sent[0]?.input.Bucket).toBe('b');
    expect(sent[0]?.input.Key).toBe(storageObjectKey('p', { segment: 's', generation: 3 }));
  });
});
